import { describe, expect, it } from 'vitest'
import { clientValidate, cloneSpec, finishedRoomBoundary, fixtureBoundWallIndex, fixturePointShape, fixturePointUsage, generateDryWetZones, generateWallFinishProfiles, hiddenWallIndexesForCutaway, imagePointToRoom, manualRoom, nearestWallIndex, roomBounds, roomPointToImage, sliceWallQuadByDistance, snapPointToNearestWall, structuralInnerBoundary, syncToiletWithDrain, toiletPlacementFromDrain, toiletRotationForWall, wallLayerPolygons, wallOutwardNormal, wetZoneBoundaryValid } from './spec'

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

  it('generates one wet zone from the shower floor drain only', () => {
    const spec = manualRoom(3600, 2400, 2600)
    spec.fixtures.push(
      { id: 'd1', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 2600, z_mm: 1200, width_mm: 80, depth_mm: 80, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'd2', kind: 'drain', point_usage: 'shower', label: '花洒排水', x_mm: 3000, z_mm: 1500, width_mm: 60, depth_mm: 60, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
    )

    const zones = generateDryWetZones(spec)

    expect(zones).toHaveLength(1)
    expect(zones.every((zone) => zone.kind === 'wet')).toBe(true)
    expect(zones.every((zone) => zone.boundary.length === 4)).toBe(true)
    const wetArea = zones.reduce((sum, zone) => sum + (zone.boundary[1].x_mm - zone.boundary[0].x_mm) * (zone.boundary[2].z_mm - zone.boundary[1].z_mm), 0)
    expect(wetArea).toBeLessThan(3600 * 2400)
    expect(wetArea).toBeGreaterThanOrEqual(900 * 900)
  })

  it('keeps the shower floor drain as a single standard even when other floor drains exist', () => {
    const spec = manualRoom(4000, 2600, 2600)
    spec.fixtures.push(
      { id: 'd1', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 500, z_mm: 500, width_mm: 80, depth_mm: 80, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'd2', kind: 'floor_drain', label: '洗衣机地漏', x_mm: 3500, z_mm: 2100, width_mm: 80, depth_mm: 80, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
    )

    const zones = generateDryWetZones(spec)

    expect(zones).toHaveLength(1)
    expect(zones.every((zone) => zone.kind === 'wet')).toBe(true)
    expect(roomBounds(zones[0].boundary).maxX).toBeLessThan(3500)
  })

  it('does not let supply, drainage, toilet, or basin points expand the shower floor-drain wet zone', () => {
    const spec = manualRoom(3600, 2400, 2600)
    spec.fixtures.push(
      { id: 'floor-1', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 2900, z_mm: 900, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'shower-water', kind: 'water', point_usage: 'shower', label: '花洒给水', x_mm: 3200, z_mm: 0, width_mm: 40, depth_mm: 40, height_mm: 1100, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'shower-drain', kind: 'drain', point_usage: 'shower', label: '花洒排水', x_mm: 3000, z_mm: 0, width_mm: 60, depth_mm: 60, height_mm: 100, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'toilet-drain', kind: 'drain', point_usage: 'toilet', label: '马桶排水', x_mm: 500, z_mm: 0, width_mm: 110, depth_mm: 110, height_mm: 100, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'basin-water', kind: 'water', point_usage: 'basin', label: '台盆给水', x_mm: 1200, z_mm: 0, width_mm: 40, depth_mm: 40, height_mm: 500, rotation_deg: 0, source: 'user', confidence: 1 },
    )

    const zones = generateDryWetZones(spec)
    const wetBounds = roomBounds(zones[0].boundary)

    expect(zones).toHaveLength(1)
    expect(wetBounds.minX).toBeGreaterThan(500)
    expect(wetBounds.minX).toBeLessThanOrEqual(2900)
    expect(wetBounds.maxX).toBeLessThan(3500)
    expect(wetBounds.minZ).toBeGreaterThan(0)
  })

  it('does not generate a wet zone without a shower floor drain', () => {
    const spec = manualRoom(3000, 2200, 2600)
    spec.fixtures.push(
      { id: 'floor-general', kind: 'floor_drain', point_usage: 'general', label: '洗衣机地漏', x_mm: 2200, z_mm: 1200, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'shower-water', kind: 'water', point_usage: 'shower', label: '花洒给水', x_mm: 2400, z_mm: 0, width_mm: 40, depth_mm: 40, height_mm: 1100, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'shower-drain', kind: 'drain', point_usage: 'shower', label: '花洒排水', x_mm: 2500, z_mm: 0, width_mm: 60, depth_mm: 60, height_mm: 100, rotation_deg: 0, source: 'user', confidence: 1 },
    )

    expect(generateDryWetZones(spec)).toEqual([])
  })

  it('rejects multiple wet zones and multiple shower floor-drain standards', () => {
    const spec = manualRoom(3000, 2200, 2600)
    spec.fixtures.push(
      { id: 'shower-floor-1', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 700, z_mm: 700, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'shower-floor-2', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 2300, z_mm: 1500, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 },
    )
    spec.dry_wet_zones = [
      { id: 'wet-1', kind: 'wet', label: '湿区 1', source: 'user', confidence: 1, boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 900, z_mm: 0 }, { x_mm: 900, z_mm: 900 }, { x_mm: 0, z_mm: 900 }] },
      { id: 'wet-2', kind: 'wet', label: '湿区 2', source: 'user', confidence: 1, boundary: [{ x_mm: 2000, z_mm: 1300 }, { x_mm: 2900, z_mm: 1300 }, { x_mm: 2900, z_mm: 2200 }, { x_mm: 2000, z_mm: 2200 }] },
    ]

    expect(clientValidate(spec).map((issue) => issue.code)).toEqual(expect.arrayContaining(['multiple_wet_zones', 'multiple_shower_floor_drains']))
    expect(generateDryWetZones(spec)).toHaveLength(1)
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

  it('cuts openings perpendicular to mitered wall faces', () => {
    const spec = manualRoom(2400, 3200, 2600)
    const wall = wallLayerPolygons(spec)[0].wall

    expect(sliceWallQuadByDistance(wall, spec.boundary[0], spec.boundary[1], 400, 1300)).toEqual([
      { x_mm: 400, z_mm: -20 }, { x_mm: 1300, z_mm: -20 },
      { x_mm: 1300, z_mm: -220 }, { x_mm: 400, z_mm: -220 },
    ])
    expect(sliceWallQuadByDistance(wall, spec.boundary[0], spec.boundary[1], 0, 400)[0]).toEqual(wall[0])
    expect(sliceWallQuadByDistance(wall, spec.boundary[0], spec.boundary[1], 0, 400)[3]).toEqual(wall[3])
  })

  it('hides the camera-side walls for cutaway preview', () => {
    const boundary = finishedRoomBoundary(manualRoom(2400, 3200, 2600))

    expect(hiddenWallIndexesForCutaway(boundary, { x_mm: 5200, z_mm: 6200 })).toEqual([1, 2])
    expect(hiddenWallIndexesForCutaway(boundary, { x_mm: -2600, z_mm: -3200 })).toEqual([0, 3])
    expect(hiddenWallIndexesForCutaway(boundary, { x_mm: 5200, z_mm: 1600 })).toEqual([1])
    expect(hiddenWallIndexesForCutaway(boundary, { x_mm: 1200, z_mm: 1600 })).toEqual([])
  })

  it('uses circles for supply and drainage points and a square for floor drains', () => {
    expect(fixturePointShape('water')).toBe('circle')
    expect(fixturePointShape('drain')).toBe('circle')
    expect(fixturePointShape('floor_drain')).toBe('square')
    expect(fixturePointShape('toilet')).toBeNull()
    expect(fixturePointUsage({ id: 'shower-floor', kind: 'floor_drain', label: '淋浴地漏', x_mm: 0, z_mm: 0, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 })).toBe('shower')
  })

  it('snaps a toilet model to the toilet drainage point and nearest wall direction', () => {
    const spec = manualRoom(2400, 3200, 2600)
    spec.fixtures.push({ id: 'toilet-drain-1', kind: 'drain', point_usage: 'toilet', label: '马桶排水', x_mm: 700, z_mm: 305, width_mm: 110, depth_mm: 110, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 })

    const toiletId = syncToiletWithDrain(spec, 'toilet-drain-1')
    const toilet = spec.fixtures.find((fixture) => fixture.id === toiletId)

    expect(toilet).toMatchObject({ kind: 'toilet', label: '马桶', x_mm: 700, z_mm: 305, rotation_deg: 0, source: 'derived' })
    expect(toilet?.evidence_ids).toContain('toilet-drain:toilet-drain-1')
    expect(toilet?.model_asset).toBeUndefined()
    expect(clientValidate(spec).filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('moves the linked toilet when the toilet drainage point changes wall', () => {
    const spec = manualRoom(2400, 3200, 2600)
    spec.fixtures.push({ id: 'toilet-drain-1', kind: 'drain', point_usage: 'toilet', label: '马桶排水', x_mm: 700, z_mm: 305, width_mm: 110, depth_mm: 110, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 })

    syncToiletWithDrain(spec, 'toilet-drain-1')
    const drain = spec.fixtures.find((fixture) => fixture.id === 'toilet-drain-1')!
    drain.x_mm = 2095
    drain.z_mm = 1200
    syncToiletWithDrain(spec, 'toilet-drain-1')
    const toilet = spec.fixtures.find((fixture) => fixture.kind === 'toilet')!

    expect(toilet.x_mm).toBe(2095)
    expect(toilet.z_mm).toBe(1200)
    expect(toilet.rotation_deg).toBe(-90)
    expect(toilet.evidence_ids).toEqual(['toilet-drain:toilet-drain-1'])
  })

  it('computes toilet orientation from each wall inward normal', () => {
    const spec = manualRoom(2400, 3200, 2600)

    expect(spec.boundary.map((_, index) => toiletRotationForWall(finishedRoomBoundary(spec), index))).toEqual([0, -90, 180, 90])
    expect(toiletPlacementFromDrain(spec, { id: 'free', kind: 'drain', point_usage: 'toilet', label: '马桶排水', x_mm: 300, z_mm: 1600, width_mm: 110, depth_mm: 110, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 })).toMatchObject({ rotation_deg: 90 })
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
