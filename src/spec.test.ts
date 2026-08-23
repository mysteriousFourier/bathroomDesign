import { describe, expect, it } from 'vitest'
import { clientValidate, cloneSpec, dimensionChainParts, finishedRoomBoundary, fixtureBoundWallIndex, fixturePointShape, fixturePointUsage, generateDryWetZones, generateWallFinishProfiles, hiddenWallIndexesForCutaway, imagePointToRoom, manualRoom, nearestWallIndex, polylineLength, polylineSegmentLength, rebindOpeningsToImageBoundary, repairPendingOpeningImageBindings, resizePolylineSegment, roomBounds, roomPointToImage, setOpeningOnWall, sliceWallQuadByDistance, snapPointToNearestWall, structuralInnerBoundary, syncOpeningBindings, toiletPlacementFromDrain, toiletRotationForWall, updateOpeningFromLine, wallLayerPolygons, wallOutwardNormal, wetZoneBoundaryValid } from './spec'

describe('plan line dimensions', () => {
  it('resizes one segment in millimetres while preserving the following shape', () => {
    const points = [{ x_mm: 100, z_mm: 200 }, { x_mm: 500, z_mm: 200 }, { x_mm: 500, z_mm: 700 }]
    expect(polylineSegmentLength(points, 0)).toBe(400)
    expect(polylineLength(points)).toBe(900)
    const resized = resizePolylineSegment(points, 0, 600)
    expect(resized).toEqual([{ x_mm: 100, z_mm: 200 }, { x_mm: 700, z_mm: 200 }, { x_mm: 700, z_mm: 700 }])
    expect(polylineLength(resized)).toBe(1100)
  })
})

describe('room boundary validation', () => {
  it('keeps openings bound to a wall while the wall geometry changes', () => {
    const previous = manualRoom(2400, 1800, 2600)
    previous.openings.push({ id: 'D1', kind: 'door', wall_index: 0, offset_mm: 400, width_mm: 800, height_mm: 2050, sill_mm: 0, label: 'D1', source: 'user', confidence: 1, wall_binding: { wall_index: 0, start_ratio: 400 / 2400, end_ratio: 1200 / 2400 } })
    const next = cloneSpec(previous)
    next.boundary[1].x_mm = 3000
    syncOpeningBindings(next, previous)
    expect(next.openings[0].wall_index).toBe(0)
    expect(next.openings[0].offset_mm).toBe(400)
    expect(next.openings[0].width_mm).toBe(800)
    expect(next.openings[0].wall_binding?.start_ratio).toBeCloseTo(400 / 3000)
  })

  it('clamps an opening when a wall becomes shorter than its width', () => {
    const spec = manualRoom(2400, 1800, 2600)
    spec.openings.push({ id: 'W1', kind: 'window', wall_index: 0, offset_mm: 1800, width_mm: 800, height_mm: 1200, sill_mm: 900, label: 'W1', source: 'user', confidence: 1 })
    spec.boundary[1].x_mm = 2000
    syncOpeningBindings(spec)
    expect(spec.openings[0].offset_mm).toBe(1800)
    expect(spec.openings[0].width_mm).toBe(200)
  })

  it('moves an opening off an impossible short wall on legacy project load', () => {
    const spec = manualRoom(2400, 1800, 2600)
    spec.boundary = [
      { x_mm: 0, z_mm: 0 }, { x_mm: 180, z_mm: 0 }, { x_mm: 180, z_mm: 1800 }, { x_mm: 2400, z_mm: 1800 }, { x_mm: 0, z_mm: 1800 },
    ]
    spec.openings.push({ id: 'D1', kind: 'door', wall_index: 0, offset_mm: 0, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'measured', confidence: 1 })
    syncOpeningBindings(spec)
    expect(spec.openings[0].wall_index).toBe(0)
    expect(spec.openings[0].width_mm).toBe(180)
    expect(spec.openings[0].wall_binding?.wall_index).toBe(0)
  })

  it('keeps the original wall when a new boundary segment shifts wall indexes', () => {
    const previous = manualRoom(2400, 1800, 2600)
    previous.openings.push({ id: 'W1', kind: 'window', wall_index: 1, offset_mm: 400, width_mm: 800, height_mm: 1200, sill_mm: 900, label: 'W1', source: 'user', confidence: 1 })
    syncOpeningBindings(previous)
    const next = cloneSpec(previous)
    next.boundary.splice(1, 0, { x_mm: 1200, z_mm: 0 })
    syncOpeningBindings(next, previous)
    expect(next.openings[0].wall_index).toBe(2)
    expect(next.openings[0].line?.start.x_mm).toBe(2400)
  })

  it('keeps photo-annotation openings on the same image segment when a new edge shifts indexes', () => {
    const current = manualRoom(1595, 1790, 2770)
    const previousPoints = [{ x: 260, y: 304 }, { x: 501, y: 304 }, { x: 501, y: 625 }, { x: 260, y: 625 }]
    const previousEdges = [
      { direction: 'right' as const, length_mm: 1595, role: 'wall' as const, evidence_ids: [], confidence: 0.9 },
      { direction: 'down' as const, length_mm: 1790, role: 'wall' as const, evidence_ids: [], confidence: 0.9 },
      { direction: 'left' as const, length_mm: 1570, role: 'wall' as const, evidence_ids: [], confidence: 0.9 },
      { direction: 'up' as const, length_mm: 1790, role: 'wall' as const, evidence_ids: [], confidence: 0.9 },
    ]
    current.plan_annotation = { rotation_degrees: 0, boundary: previousPoints, edge_chain: previousEdges, confirmed: false }
    current.openings = [
      { id: 'D1', kind: 'door', wall_index: 2, offset_mm: 770, width_mm: 800, height_mm: 2055, sill_mm: 0, label: 'D1', source: 'derived', confidence: 0.95 },
      { id: 'W1', kind: 'window', wall_index: 0, offset_mm: 330, width_mm: 475, height_mm: 1305, sill_mm: 735, label: 'W1', source: 'derived', confidence: 0.95 },
    ]
    const nextPoints = [previousPoints[0], previousPoints[1], { x: 501, y: 470 }, previousPoints[2], previousPoints[3]]
    current.plan_annotation = { ...current.plan_annotation, boundary: nextPoints, edge_chain: [], confirmed: false }

    rebindOpeningsToImageBoundary(current, previousPoints, nextPoints, previousEdges)

    expect(current.openings.find((item) => item.id === 'D1')).toMatchObject({ wall_index: 3, offset_mm: 770, width_mm: 800, line: null, wall_binding: { image_end: { x: 260, y: 625 } } })
    expect(current.openings.find((item) => item.id === 'D1')?.wall_binding?.image_start?.x).toBeCloseTo(382.8, 1)
    expect(current.openings.find((item) => item.id === 'W1')).toMatchObject({ wall_index: 0, offset_mm: 330, width_mm: 475, line: null, wall_binding: { image_end: { y: 304 } } })
    expect(current.openings.find((item) => item.id === 'W1')?.wall_binding?.image_start?.x).toBeCloseTo(309.9, 1)
    expect(current.openings.find((item) => item.id === 'W1')?.wall_binding?.image_end?.x).toBeCloseTo(381.6, 1)
  })

  it('preserves opening endpoints when its original image wall is split into new edges', () => {
    const previousPoints = [{ x: 260, y: 304 }, { x: 501, y: 304 }, { x: 501, y: 625 }, { x: 260, y: 625 }]
    const previousEdges = [
      { direction: 'right' as const, length_mm: 1595, measured_length_mm: 1595, role: 'wall' as const, evidence_ids: [], confidence: 1 },
      { direction: 'down' as const, length_mm: 1790, measured_length_mm: 1790, role: 'wall' as const, evidence_ids: [], confidence: 1 },
      { direction: 'left' as const, length_mm: 1570, measured_length_mm: 1570, role: 'wall' as const, evidence_ids: [], confidence: 1 },
      { direction: 'up' as const, length_mm: 1790, measured_length_mm: 1790, role: 'wall' as const, evidence_ids: [], confidence: 1 },
    ]
    const current = manualRoom(1595, 1790, 2770)
    current.plan_annotation = { rotation_degrees: 0, boundary: previousPoints, edge_chain: previousEdges, confirmed: false }
    current.openings = [{ id: 'D1', kind: 'door', wall_index: 2, offset_mm: 770, width_mm: 800, height_mm: 2055, sill_mm: 0, label: 'D1', source: 'derived', confidence: 0.95 }]
    const nextPoints = [previousPoints[0], previousPoints[1], previousPoints[2], { x: 410, y: 625 }, previousPoints[3]]
    current.plan_annotation = { ...current.plan_annotation, boundary: nextPoints, edge_chain: previousEdges.slice(0, 2).concat([
      { direction: 'left', length_mm: 620, measured_length_mm: 620, role: 'wall', evidence_ids: [], confidence: 1 },
      { direction: 'left', length_mm: 950, measured_length_mm: 950, role: 'wall', evidence_ids: [], confidence: 1 },
      previousEdges[3],
    ]), confirmed: false }

    rebindOpeningsToImageBoundary(current, previousPoints, nextPoints, previousEdges)

    const opening = current.openings[0]
    expect(opening.width_mm).toBe(800)
    expect(opening.wall_binding?.image_start?.x).toBeCloseTo(382.8, 1)
    expect(opening.wall_binding?.image_end).toEqual({ x: 260, y: 625 })
    expect(opening.line).toBeNull()
  })

  it('repairs a legacy opening whose original wall was split into measured runs', () => {
    const current = manualRoom(1595, 1790, 2770)
    current.boundary = []
    current.plan_annotation = {
      rotation_degrees: 0,
      confirmed: false,
      boundary: [
        { x: 260, y: 304 }, { x: 501, y: 304 }, { x: 502, y: 598 }, { x: 468, y: 600 },
        { x: 470, y: 627 }, { x: 364, y: 628 }, { x: 260, y: 625 },
      ],
      edge_chain: [
        { direction: 'right', length_mm: 1595, measured_length_mm: 1595, role: 'wall', evidence_ids: [], confidence: 1 },
        { direction: 'down', length_mm: 1600, measured_length_mm: 1600, role: 'wall', evidence_ids: [], confidence: 1 },
        { direction: 'left', length_mm: 480, measured_length_mm: 480, role: 'wall', evidence_ids: [], confidence: 1 },
        { direction: 'down', length_mm: 190, measured_length_mm: 190, role: 'wall', evidence_ids: [], confidence: 1 },
        { direction: 'left', length_mm: 290, measured_length_mm: 290, role: 'wall', evidence_ids: [], confidence: 1 },
        { direction: 'left', length_mm: 30, measured_length_mm: 30, role: 'wall', evidence_ids: [], confidence: 1 },
        { direction: 'up', length_mm: 1790, measured_length_mm: 1790, role: 'wall', evidence_ids: [], confidence: 1 },
      ],
    }
    current.openings = [{ id: 'D1', kind: 'door', wall_index: 2, offset_mm: 770, width_mm: 800, height_mm: 2055, sill_mm: 0, label: 'D1', source: 'user', confidence: 1, evidence_ids: ['TV027'] }]
    current.observations = [{ field: 'ocr:TV027', value: '800', source: 'derived', asset_id: null, bbox: null, confidence: 0.9, confirmed: false, alternatives: [], note: '', semantic_role: 'wall_segment', review_required: false }]

    repairPendingOpeningImageBindings(current)

    expect(current.openings[0]).toMatchObject({ wall_index: 5, offset_mm: 0, width_mm: 800, wall_binding: { start_ratio: 0, end_ratio: 800 / 830 } })
    const repairedEdges = current.plan_annotation!.edge_chain!
    expect(repairedEdges[5]).toMatchObject({ length_mm: 830, measured_length_mm: 830 })
    expect(dimensionChainParts(current, repairedEdges.map((edge) => edge.length_mm)).filter((part) => part.wall_index === 5).map((part) => ({ kind: part.kind, length: part.length_mm }))).toEqual([
      { kind: 'opening', length: 800 }, { kind: 'wall', length: 30 },
    ])
  })

  it('splits a host wall into independently named wall and opening runs', () => {
    const spec = manualRoom(3000, 1800, 2600)
    const opening = { id: 'door-1', kind: 'door' as const, wall_index: 0, offset_mm: 500, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user' as const, confidence: 1 }
    spec.openings.push(opening)
    setOpeningOnWall(spec, opening, 0, 500, 800)

    expect(dimensionChainParts(spec).slice(0, 3).map((part) => ({ label: part.label, kind: part.kind, length: part.length_mm }))).toEqual([
      { label: 'W1', kind: 'wall', length: 500 },
      { label: 'D1', kind: 'opening', length: 800 },
      { label: 'W2', kind: 'wall', length: 1700 },
    ])
  })

  it('uses the independent opening line to rebind a door onto another wall', () => {
    const previous = manualRoom(2400, 1800, 2600)
    const opening = { id: 'D1', kind: 'door' as const, wall_index: 0, offset_mm: 400, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user' as const, confidence: 1 }
    previous.openings.push(opening)
    syncOpeningBindings(previous)
    const next = cloneSpec(previous)
    next.openings[0].line = { start: { x_mm: 2400, z_mm: 300 }, end: { x_mm: 2400, z_mm: 1100 } }

    syncOpeningBindings(next, previous)

    expect(next.openings[0]).toMatchObject({ wall_index: 1, offset_mm: 300, width_mm: 800 })
    expect(next.openings[0].line).toEqual({ start: { x_mm: 2400, z_mm: 300 }, end: { x_mm: 2400, z_mm: 1100 } })
  })

  it('binds an independent opening line to a parallel wall instead of the closest perpendicular wall', () => {
    const spec = manualRoom(3000, 2000, 2600)
    const opening = { id: 'D1', kind: 'door' as const, wall_index: 1, offset_mm: 0, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user' as const, confidence: 1 }
    spec.openings.push(opening)
    const line = { start: { x_mm: 2800, z_mm: 260 }, end: { x_mm: 2980, z_mm: 260 } }

    updateOpeningFromLine(spec, opening, line)

    expect(opening.wall_index).toBe(0)
    expect(spec.openings[0].line).toEqual(line)
    expect(opening).toMatchObject({ offset_mm: 2800, width_mm: 180 })
  })

  it('keeps a freely edited opening line when derived wall values change with it', () => {
    const previous = manualRoom(3000, 2000, 2600)
    previous.openings.push({ id: 'D1', kind: 'door', wall_index: 1, offset_mm: 300, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user', confidence: 1 })
    syncOpeningBindings(previous)
    const next = cloneSpec(previous)
    const freeLine = { start: { x_mm: 2820, z_mm: 300 }, end: { x_mm: 2920, z_mm: 1180 } }
    updateOpeningFromLine(next, next.openings[0], freeLine, 1)

    syncOpeningBindings(next, previous)

    expect(next.openings[0].line).toEqual(freeLine)
    expect(next.openings[0].wall_index).toBe(1)
  })

  it('preserves left wall and opening lengths when only the right wall run changes', () => {
    const previous = manualRoom(3000, 1800, 2600)
    const opening = { id: 'D1', kind: 'door' as const, wall_index: 0, offset_mm: 500, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user' as const, confidence: 1 }
    previous.openings.push(opening)
    syncOpeningBindings(previous)
    const next = cloneSpec(previous)
    next.plan_annotation = { rotation_degrees: 0, boundary: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], confirmed: false, edge_chain: [
      { direction: 'right', length_mm: 3100, measured_length_mm: 3100, role: 'wall', evidence_ids: [], confidence: 1 },
      { direction: 'down', length_mm: 1800, measured_length_mm: 1800, role: 'wall', evidence_ids: [], confidence: 1 },
      { direction: 'left', length_mm: 3000, measured_length_mm: 3000, role: 'wall', evidence_ids: [], confidence: 1 },
      { direction: 'up', length_mm: 1800, measured_length_mm: 1800, role: 'wall', evidence_ids: [], confidence: 1 },
    ] }
    setOpeningOnWall(next, next.openings[0], 0, 500, 800, 3100)

    syncOpeningBindings(next, previous)

    expect(next.openings[0]).toMatchObject({ offset_mm: 500, width_mm: 800 })
    expect(dimensionChainParts(next, [3100, 1800, 3000, 1800]).slice(0, 3).map((part) => part.length_mm)).toEqual([500, 800, 1800])
  })

  it('preserves independent image endpoints for numeric edits on the same wall', () => {
    const spec = manualRoom(3000, 2000, 2700)
    const opening = { id: 'D1', kind: 'door' as const, wall_index: 0, offset_mm: 600, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user' as const, confidence: 1, wall_binding: {
      wall_index: 0,
      start_ratio: 0.2,
      end_ratio: 0.5,
      image_start: { x: 120, y: 240 },
      image_end: { x: 360, y: 240 },
    } }
    spec.openings.push(opening)

    setOpeningOnWall(spec, opening, 0, 700, 900, 3200)

    expect(opening).toMatchObject({ wall_index: 0, offset_mm: 700, width_mm: 900 })
    expect(opening.wall_binding).toMatchObject({
      wall_index: 0,
      image_start: { x: 120, y: 240 },
      image_end: { x: 360, y: 240 },
    })

    setOpeningOnWall(spec, opening, 1, 100, 700, 2000)
    expect(opening.wall_binding?.image_start).toBeUndefined()
    expect(opening.wall_binding?.image_end).toBeUndefined()
  })

  it('updates an opening on a pending image edge before the metric boundary exists', () => {
    const spec = manualRoom(3000, 2000, 2700)
    const opening = { id: 'D1', kind: 'door' as const, wall_index: 5, offset_mm: 0, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user' as const, confidence: 1, wall_binding: {
      wall_index: 5,
      start_ratio: 0,
      end_ratio: 800 / 830,
      image_start: { x: 120, y: 240 },
      image_end: { x: 360, y: 240 },
    } }
    spec.openings.push(opening)

    setOpeningOnWall(spec, opening, 5, 0, 810, 840)

    expect(opening).toMatchObject({ wall_index: 5, offset_mm: 0, width_mm: 810, line: null })
    expect(opening.wall_binding).toMatchObject({
      wall_index: 5,
      start_ratio: 0,
      end_ratio: 810 / 840,
      image_start: { x: 120, y: 240 },
      image_end: { x: 360, y: 240 },
    })
  })

  it('treats a persisted opening line as primary geometry on reload', () => {
    const spec = manualRoom(2400, 1800, 2600)
    spec.openings.push({ id: 'D1', kind: 'door', wall_index: 0, offset_mm: 50, width_mm: 100, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user', confidence: 1, line: { start: { x_mm: 500, z_mm: 0 }, end: { x_mm: 1300, z_mm: 0 } } })

    syncOpeningBindings(spec)

    expect(spec.openings[0]).toMatchObject({ wall_index: 0, offset_mm: 500, width_mm: 800 })
  })
  it('accepts a closed orthogonal room', () => {
    expect(clientValidate(manualRoom(2400, 1800, 2600)).filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('keeps a valid 2D room editable while missing height gates 3D', () => {
    const spec = manualRoom(2400, 1800, 2600)
    spec.height_mm = null

    const issues = clientValidate(spec)

    expect(issues).toEqual([
      expect.objectContaining({ code: 'missing_height', severity: 'error' }),
    ])
    expect(issues.some((issue) => issue.code === 'invalid_boundary')).toBe(false)
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

  it('splits a wall body into left and right jamb runs around a door', () => {
    const spec = manualRoom(3000, 2000, 2600)
    spec.openings.push({ id: 'D1', kind: 'door', wall_index: 0, offset_mm: 500, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'user', confidence: 1 })

    const runs = wallLayerPolygons(spec).filter((layer) => layer.wall_index === 0)

    expect(runs.map((run) => ({ start: run.start_mm, end: run.end_mm }))).toEqual([
      { start: 0, end: 500 },
      { start: 1300, end: 3000 },
    ])
    expect(runs[0].wall[1]).toEqual({ x_mm: 500, z_mm: -20 })
    expect(runs[1].wall[0]).toEqual({ x_mm: 1300, z_mm: -20 })
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
    expect(fixturePointUsage({ id: 'generated-wet-floor', kind: 'floor_drain', label: '湿区地漏 · 地漏', x_mm: 0, z_mm: 0, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'derived', confidence: 1 })).toBe('shower')
  })

  it('computes toilet orientation from each wall inward normal', () => {
    const spec = manualRoom(2400, 3200, 2600)

    // Wall 0=south, 1=east, 2=north, 3=west. Contract rotation is CCW viewed
    // from above, so a west-wall toilet (inward +x) faces east at r=-90 and an
    // east-wall toilet (inward -x) faces west at r=90.
    expect(spec.boundary.map((_, index) => toiletRotationForWall(finishedRoomBoundary(spec), index))).toEqual([0, 90, 180, -90])
    expect(toiletPlacementFromDrain(spec, { id: 'free', kind: 'drain', point_usage: 'toilet', label: '马桶排水', x_mm: 300, z_mm: 1600, width_mm: 110, depth_mm: 110, height_mm: 10, rotation_deg: 0, source: 'user', confidence: 1 })).toMatchObject({ rotation_deg: -90 })
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
