import { describe, expect, it } from 'vitest'
import { applyLayoutSolution, generateDeterministicLayoutSolutions } from './layoutEngine'
import { bathroomVanityInstallationRules, clientValidate, generateDryWetZones, manualRoom, wetZoneBoundaryValid } from './spec'
import { routePlumbing } from './plumbing'

function measuredSteppedRoom() {
  const room = manualRoom(4105, 2160, 2200)
  room.boundary = [
    { x_mm: 0, z_mm: 320 }, { x_mm: 0, z_mm: 2160 }, { x_mm: 1255, z_mm: 2160 },
    { x_mm: 1255, z_mm: 1840 }, { x_mm: 4105, z_mm: 1840 }, { x_mm: 4105, z_mm: 0 },
    { x_mm: 2515, z_mm: 0 }, { x_mm: 2515, z_mm: 610 }, { x_mm: 1900, z_mm: 610 },
    { x_mm: 1900, z_mm: 0 }, { x_mm: 260, z_mm: 0 }, { x_mm: 260, z_mm: 320 },
  ]
  room.fixtures.push(
    { id: 'shower-drain', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 3775, z_mm: 276, width_mm: 75, depth_mm: 75, height_mm: 10, rotation_deg: 0, source: 'measured', confidence: 1 },
    { id: 'washer-drain', kind: 'floor_drain', point_usage: 'washer', label: '洗衣机地漏', x_mm: 1330, z_mm: 220, width_mm: 75, depth_mm: 75, height_mm: 10, rotation_deg: 0, source: 'measured', confidence: 1 },
    { id: 'toilet-drain', kind: 'drain', point_usage: 'toilet', label: '马桶排水', x_mm: 3596, z_mm: 1455, width_mm: 110, depth_mm: 110, height_mm: 10, rotation_deg: 0, source: 'measured', confidence: 1 },
  )
  return room
}

function measuredNotchedRoom() {
  const room = manualRoom(2855, 1840, 2200)
  room.boundary = [
    { x_mm: 0, z_mm: 1840 }, { x_mm: 182, z_mm: 1840 }, { x_mm: 182, z_mm: 1588 },
    { x_mm: 2855, z_mm: 1588 }, { x_mm: 2855, z_mm: 491 }, { x_mm: 2755, z_mm: 491 },
    { x_mm: 2755, z_mm: 0 }, { x_mm: 323, z_mm: 0 }, { x_mm: 323, z_mm: 336 }, { x_mm: 0, z_mm: 336 },
  ]
  room.fixtures.push(
    { id: 'washer-drain', kind: 'floor_drain', point_usage: 'washer', label: '洗衣机地漏', x_mm: 1398, z_mm: 225, width_mm: 75, depth_mm: 75, height_mm: 20, rotation_deg: 0, source: 'measured', confidence: 1 },
    { id: 'shower-drain', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 2537, z_mm: 511, width_mm: 75, depth_mm: 75, height_mm: 20, rotation_deg: 0, source: 'measured', confidence: 1 },
  )
  return room
}

describe('core bathroom placement rules', () => {
  it('keeps the current stepped room valid when measured drains are not explicitly locked', { timeout: 30000 }, () => {
    const room = measuredSteppedRoom()
    room.openings.push({ id:'door', kind:'door', wall_index:1, offset_mm:400, width_mm:800, height_mm:2055, sill_mm:0, label:'D1', source:'measured', confidence:1 })
    const washerDrain = room.fixtures.find((fixture) => fixture.point_usage === 'washer')!
    washerDrain.x_mm = 1450
    washerDrain.z_mm = 250
    room.fixtures.push({ id:'basin-drain', kind:'drain', point_usage:'basin', label:'排水', x_mm:670, z_mm:250, width_mm:60, depth_mm:60, height_mm:10, rotation_deg:0, source:'user', confidence:1 })
    const solutions = generateDeterministicLayoutSolutions(room)
    expect(solutions.map((solution) => solution.checks.filter((check) => check.severity === 'error' && !check.passed).map((check) => `${check.code}: ${check.message}`))).toEqual([[], [], []])
    const applied = applyLayoutSolution(room, solutions[0])
    expect(clientValidate(applied).filter((issue) => issue.severity === 'error')).toEqual([])
    const plumbing = routePlumbing(applied)!
    expect(plumbing.warnings).toEqual([])
    const hotTargetIds = applied.fixtures.filter((fixture) => fixture.kind === 'water' && /热水/.test(fixture.label) && !/热水器/.test(fixture.label)).map((fixture) => fixture.id).sort()
    const hotDropIds = plumbing.segments.filter((segment) => segment.temperature === 'hot' && segment.id.endsWith('-drop')).map((segment) => segment.fixture_id).sort()
    expect(hotDropIds).toEqual(hotTargetIds)
    const heaterOutlet = applied.fixtures.find((fixture) => fixture.kind === 'water' && /热水器.*热水.*出水/.test(fixture.label))!
    const hotPenetration = plumbing.segments.find((segment) => segment.id === 'hot-source-rise-out')!
    const hotRiser = plumbing.segments.find((segment) => segment.id === 'hot-source-rise')!
    expect([hotPenetration.from.x_mm, hotPenetration.from.z_mm]).toEqual([heaterOutlet.x_mm, heaterOutlet.z_mm])
    expect(hotPenetration.to).toEqual(hotRiser.from)
    expect([hotRiser.from.x_mm, hotRiser.from.z_mm]).not.toEqual([heaterOutlet.x_mm, heaterOutlet.z_mm])
    expect([hotRiser.from.x_mm, hotRiser.from.z_mm]).toEqual([hotRiser.to.x_mm, hotRiser.to.z_mm])
    expect(hotRiser.to.y_mm).toBeGreaterThan(room.height_mm!)
  })

  it('keeps all three stepped-room tiers valid with a fixed wall-mounted vanity', { timeout: 30000 }, () => {
    const room = measuredSteppedRoom()
    const solutions = generateDeterministicLayoutSolutions(room)
    expect(solutions).toHaveLength(3)
    for (const solution of solutions) {
      const vanity = solution.fixtures.find((fixture) => fixture.kind === 'vanity')!
      expect([vanity.width_mm, vanity.depth_mm, vanity.height_mm]).toEqual([
        bathroomVanityInstallationRules.width_mm,
        bathroomVanityInstallationRules.depth_mm,
        bathroomVanityInstallationRules.height_mm,
      ])
      expect(vanity.bound_wall_index).not.toBeNull()
      expect(solution.checks.find((check) => check.code === 'CABINET-RULES')).toMatchObject({ passed: true, severity: 'error' })
      expect(solution.checks.filter((check) => check.severity === 'error' && !check.passed)).toEqual([])
      expect(solution.fixtures.find((fixture) => fixture.label.includes('洗衣机'))?.model_asset?.format).toBe('glb')
      expect(solution.fixtures.find((fixture) => fixture.label === '自动洗衣机进水点')?.elevation_mm).toBe(1050)
    }
    const applied = applyLayoutSolution(room, solutions[0])
    expect(clientValidate(applied).filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('generates one rectangular wet zone from the measured shower drain', () => {
    const room = measuredSteppedRoom()
    const [zone] = generateDryWetZones(room)
    expect(zone?.kind).toBe('wet')
    expect(zone?.boundary).toHaveLength(4)
    expect(new Set(zone?.boundary.map((point) => point.x_mm)).size).toBe(2)
    expect(new Set(zone?.boundary.map((point) => point.z_mm)).size).toBe(2)
    expect((zone?.boundary[1].x_mm ?? 0) - (zone?.boundary[0].x_mm ?? 0)).toBeGreaterThanOrEqual(900)
    expect((zone?.boundary[2].z_mm ?? 0) - (zone?.boundary[1].z_mm ?? 0)).toBeGreaterThanOrEqual(900)
  })

  it('does not bind a wall-mounted shower to a short notch return', { timeout: 30000 }, () => {
    const solutions = generateDeterministicLayoutSolutions(measuredNotchedRoom())
    expect(solutions).toHaveLength(3)
    for (const solution of solutions) {
      expect(solution.checks.find((check) => check.code === 'G06-WALL-ATTACH')).toMatchObject({ passed: true, severity: 'error' })
      expect(solution.checks.filter((check) => check.severity === 'error' && !check.passed)).toEqual([])
      const shower = solution.fixtures.find((fixture) => /花洒/.test(fixture.label) && !/扶手/.test(fixture.label))!
      expect(shower.bound_wall_index).toBe(6)
    }
  })
})
