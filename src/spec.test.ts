import { describe, expect, it } from 'vitest'
import { clientValidate, cloneSpec, finishedRoomBoundary, fixtureBoundWallIndex, generateDryWetZones, generateWallFinishProfiles, imagePointToRoom, manualRoom, nearestWallIndex, roomBounds, roomPointToImage, snapPointToNearestWall, structuralInnerBoundary, wallLayerPolygons, wallOutwardNormal, wetZoneBoundaryValid } from './spec'

describe('room boundary validation', () => {
  it('accepts a closed orthogonal room', () => {
    expect(clientValidate(manualRoom(2400, 1800, 2600)).filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('rejects diagonal edges before modeling', () => {
    const spec = manualRoom(2400, 1800, 2600)
    spec.boundary[1].z_mm = 100

    expect(clientValidate(spec).map((issue) => issue.code)).toContain('non_orthogonal_boundary')
  })

  it('rejects repeated points and self-intersection', () => {
    const repeated = manualRoom(2400, 1800, 2600)
    repeated.boundary.splice(2, 0, { ...repeated.boundary[1] })
    const crossed = manualRoom(2400, 1800, 2600)
    crossed.boundary = [
      { x_mm: 0, z_mm: 0 }, { x_mm: 2400, z_mm: 0 },
      { x_mm: 2400, z_mm: 1800 }, { x_mm: 0, z_mm: 1800 },
      { x_mm: 0, z_mm: 900 }, { x_mm: 1200, z_mm: 900 },
      { x_mm: 1200, z_mm: 1800 }, { x_mm: 0, z_mm: 1800 },
    ]

    expect(clientValidate(repeated).map((issue) => issue.code)).toContain('zero_length_boundary')
    expect(clientValidate(crossed).map((issue) => issue.code)).toContain('self_intersection')
  })
})

describe('dry wet zones and wall finishes', () => {
  it('round trips room points through the annotated image scale', () => {
    const spec = manualRoom(2400, 3200, 2600)
    spec.plan_annotation = {
      rotation_degrees: 0, confirmed: true,
      boundary: [{ x: 100, y: 200 }, { x: 900, y: 200 }, { x: 900, y: 800 }, { x: 100, y: 800 }],
    }
    expect(roomPointToImage(spec, { x_mm: 600, z_mm: 1600 })).toEqual({ x: 300, y: 500 })
    expect(imagePointToRoom(spec, 300, 500)).toEqual({ x_mm: 600, z_mm: 1600 })
  })

  it('points every wall normal outside the finished room boundary', () => {
    const spec = manualRoom(2400, 3200, 2600)
    expect(spec.boundary.map((_, index) => wallOutwardNormal(spec.boundary, index))).toEqual([
      { x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 },
    ])
  })

  it('generates dry and wet zones from drain points', () => {
    const spec = manualRoom(3600, 2400, 2600)
    spec.fixtures.push(
      { id: 'd1', kind: 'floor_drain', label: '洗衣机地漏', x_mm: 2600, z_mm: 1200, width_mm: 80, depth_mm: 80, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'd2', kind: 'drain', label: '淋浴地漏', x_mm: 3000, z_mm: 1500, width_mm: 60, depth_mm: 60, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
    )

    const zones = generateDryWetZones(spec)

    expect(zones.length).toBeGreaterThan(0)
    expect(zones.every((zone) => zone.kind === 'wet')).toBe(true)
    expect(zones.every((zone) => zone.boundary.length === 4)).toBe(true)
    const wetArea = zones.reduce((sum, zone) => sum + (zone.boundary[1].x_mm - zone.boundary[0].x_mm) * (zone.boundary[2].z_mm - zone.boundary[1].z_mm), 0)
    expect(wetArea).toBeLessThan(3600 * 2400)
    expect(wetArea).toBeGreaterThanOrEqual(900 * 900)
  })

  it('keeps distant drain groups as separate wet zones', () => {
    const spec = manualRoom(4000, 2600, 2600)
    spec.fixtures.push(
      { id: 'd1', kind: 'floor_drain', label: '淋浴地漏', x_mm: 500, z_mm: 500, width_mm: 80, depth_mm: 80, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'd2', kind: 'floor_drain', label: '洗衣机地漏', x_mm: 3500, z_mm: 2100, width_mm: 80, depth_mm: 80, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
    )

    const zones = generateDryWetZones(spec)

    expect(zones.filter((zone) => zone.kind === 'wet')).toHaveLength(2)
    expect(zones.every((zone) => zone.kind === 'wet')).toBe(true)
  })

  it('treats dry space as the complement and rejects invalid wet-zone movement', () => {
    const spec = manualRoom(3000, 2200, 2600)
    spec.dry_wet_zones = [
      { id: 'wet-1', kind: 'wet', label: '湿区 1', source: 'user', confidence: 1, boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 900, z_mm: 0 }, { x_mm: 900, z_mm: 900 }, { x_mm: 0, z_mm: 900 }] },
      { id: 'wet-2', kind: 'wet', label: '湿区 2', source: 'user', confidence: 1, boundary: [{ x_mm: 1000, z_mm: 0 }, { x_mm: 1900, z_mm: 0 }, { x_mm: 1900, z_mm: 900 }, { x_mm: 1000, z_mm: 900 }] },
      { id: 'legacy-dry', kind: 'dry', label: '旧干区', source: 'derived', confidence: 1, boundary: [{ x_mm: 0, z_mm: 900 }, { x_mm: 3000, z_mm: 900 }, { x_mm: 3000, z_mm: 2200 }, { x_mm: 0, z_mm: 2200 }] },
    ]

    expect(wetZoneBoundaryValid(spec, 'wet-2', [{ x_mm: 900, z_mm: 0 }, { x_mm: 1800, z_mm: 0 }, { x_mm: 1800, z_mm: 900 }, { x_mm: 900, z_mm: 900 }])).toBe(true)
    expect(wetZoneBoundaryValid(spec, 'wet-2', [{ x_mm: 700, z_mm: 0 }, { x_mm: 1600, z_mm: 0 }, { x_mm: 1600, z_mm: 900 }, { x_mm: 700, z_mm: 900 }])).toBe(false)
    expect(wetZoneBoundaryValid(spec, 'wet-2', [{ x_mm: 2500, z_mm: 1600 }, { x_mm: 3200, z_mm: 1600 }, { x_mm: 3200, z_mm: 2200 }, { x_mm: 2500, z_mm: 2200 }])).toBe(false)
    expect(cloneSpec(spec).dry_wet_zones?.map((zone) => zone.kind)).toEqual(['wet', 'wet'])
    const overlapping = cloneSpec(spec)
    overlapping.dry_wet_zones![1].boundary = [{ x_mm: 700, z_mm: 0 }, { x_mm: 1600, z_mm: 0 }, { x_mm: 1600, z_mm: 900 }, { x_mm: 700, z_mm: 900 }]
    expect(clientValidate(overlapping).map((issue) => issue.code)).toContain('wet_zone_geometry')
  })

  it('only binds nearby points and snaps them onto the finished wall surface', () => {
    const spec = manualRoom(2400, 3200, 2600)
    expect(nearestWallIndex(spec.boundary, { x_mm: 1200, z_mm: 80 })).toBe(0)
    expect(nearestWallIndex(spec.boundary, { x_mm: 2360, z_mm: 1600 })).toBe(1)
    expect(snapPointToNearestWall(spec.boundary, { x_mm: 1200, z_mm: 80 })).toEqual({ wall_index: 0, point: { x_mm: 1200, z_mm: 0 }, distance_mm: 80 })
    expect(snapPointToNearestWall(spec.boundary, { x_mm: 1200, z_mm: 1600 })).toBeNull()

    spec.fixtures.push(
      { id: 'drain-1', kind: 'drain', label: '排水', x_mm: 1200, z_mm: 0, width_mm: 60, depth_mm: 60, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1, bound_wall_index: 0 },
      { id: 'water-1', kind: 'water', label: '给水', x_mm: 2400, z_mm: 1600, width_mm: 40, depth_mm: 40, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1, bound_wall_index: 1 },
      { id: 'electric-1', kind: 'electric', label: '电点', x_mm: 0, z_mm: 1600, width_mm: 40, depth_mm: 40, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1, bound_wall_index: 3 },
    )

    const finishes = generateWallFinishProfiles(spec)

    expect(finishes.map((finish) => finish.thickness_mm)).toEqual([20, 20, 20, 20])
    expect(spec.fixtures.map((fixture) => fixtureBoundWallIndex(spec, fixture))).toEqual([0, 1, 3])
    expect(clientValidate({ ...spec, wall_finish_profiles: finishes })).toEqual([])
  })

  it('builds continuous finish and structural rings outside the measured finished surface', () => {
    const layers = wallLayerPolygons(manualRoom(2400, 3200, 2600))

    expect(layers[0].finish).toEqual([
      { x_mm: 0, z_mm: 0 }, { x_mm: 2400, z_mm: 0 },
      { x_mm: 2420, z_mm: -20 }, { x_mm: -20, z_mm: -20 },
    ])
    expect(layers[0].finish[2]).toEqual(layers[1].finish[3])
    expect(layers[0].wall[2]).toEqual(layers[1].wall[3])
    expect(layers[0].wall[0]).toEqual({ x_mm: -20, z_mm: -20 })
    expect(layers[0].wall[3]).toEqual({ x_mm: -220, z_mm: -220 })
  })

  it('separates stripping the measured finish from adding the new finish', () => {
    const spec = manualRoom(3000, 2000, 2600)
    expect(roomBounds(structuralInnerBoundary(spec))).toMatchObject({ width: 3040, depth: 2040 })
    expect(roomBounds(finishedRoomBoundary(spec))).toMatchObject({ width: 3000, depth: 2000 })

    spec.strip_existing_finish = false
    expect(roomBounds(structuralInnerBoundary(spec))).toMatchObject({ width: 3000, depth: 2000 })
    expect(roomBounds(finishedRoomBoundary(spec))).toMatchObject({ width: 2960, depth: 1960 })

    spec.strip_existing_finish = true
    spec.finish_surface_offset_mm = 30
    spec.wall_finish_thickness_mm = 10
    expect(roomBounds(structuralInnerBoundary(spec))).toMatchObject({ width: 3060, depth: 2060 })
    expect(roomBounds(finishedRoomBoundary(spec))).toMatchObject({ width: 3040, depth: 2040 })
  })

  it('reports invalid wall bindings', () => {
    const spec = manualRoom(2400, 3200, 2600)
    spec.fixtures.push({ id: 'bad', kind: 'toilet', label: '马桶', x_mm: 600, z_mm: 800, width_mm: 380, depth_mm: 700, height_mm: 760, rotation_deg: 0, source: 'user', confidence: 1, bound_wall_index: 99 })
    spec.fixtures.push({ id: 'floating', kind: 'water', label: '给水', x_mm: 1200, z_mm: 1600, width_mm: 40, depth_mm: 40, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1, bound_wall_index: 0 })

    expect(clientValidate(spec).map((issue) => issue.code)).toEqual(expect.arrayContaining(['fixture_bind_kind', 'fixture_wall_binding', 'fixture_wall_not_snapped']))
  })
})
