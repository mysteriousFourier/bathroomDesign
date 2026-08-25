import type { FixtureSpec, Point2D, RoomSpec } from './types'
import { finishedRoomBoundary, roomBounds, wallInwardNormal } from './spec'

export type PipeTemperature = 'cold' | 'hot'
export type PipePoint = Point2D & { y_mm: number }
export type PipeSegment = { id: string; temperature: PipeTemperature; from: PipePoint; to: PipePoint; length_mm: number; fixture_id?: string }
export type PlumbingRoute = {
  supply_origin: PipePoint
  inlet: PipePoint
  /** Cold-water manifold on the finished-ceiling plane. */
  cold_manifold: PipePoint
  /** Hot-water manifold on the finished-ceiling plane, when a hot source exists. */
  hot_manifold: PipePoint | null
  /** Kept as a compatibility alias for older consumers; never wall-mounted. */
  manifold: PipePoint
  manifold_wall_index: null
  segments: PipeSegment[]
  total_mm: number
  imbalance_mm: number
  warnings: string[]
}

const PIPE_MM = 26
const LIGHT_CLEARANCE_MM = 75
const isHot = (fixture: FixtureSpec) => /热水|热角阀|hot/i.test(`${fixture.label} ${fixture.id}`) && !/冷水|进水|cold|inlet/i.test(`${fixture.label} ${fixture.id}`)
const isHeaterOutlet = (fixture: FixtureSpec) => fixture.kind === 'water' && /热水器.*(?:热水|出水)|heater.*(?:hot|outlet)/i.test(`${fixture.label} ${fixture.id}`)
const length = (a: PipePoint, b: PipePoint) => Math.abs(a.x_mm - b.x_mm) + Math.abs(a.y_mm - b.y_mm) + Math.abs(a.z_mm - b.z_mm)
const segment = (id: string, temperature: PipeTemperature, from: PipePoint, to: PipePoint, fixture_id?: string): PipeSegment | null => {
  const length_mm = length(from, to)
  return length_mm ? { id, temperature, from, to, length_mm, fixture_id } : null
}

function doorPenetration(spec: RoomSpec, y_mm: number) {
  const boundary = finishedRoomBoundary(spec)
  const door = spec.openings.filter((item) => item.kind === 'door' && boundary[item.wall_index]).sort((a, b) => a.wall_index - b.wall_index || a.label.localeCompare(b.label))[0]
  if (!door) {
    const bounds = roomBounds(boundary)
    const inlet = { x_mm: bounds.minX, z_mm: Math.round((bounds.minZ + bounds.maxZ) / 2), y_mm }
    return { supplyOrigin: { ...inlet, x_mm: inlet.x_mm - 300 }, inlet, inside: { ...inlet, x_mm: inlet.x_mm + 300 } }
  }
  const start = boundary[door.wall_index]
  const end = boundary[(door.wall_index + 1) % boundary.length]
  const wallLength = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
  const offset = Math.min(wallLength, Math.max(0, door.offset_mm + door.width_mm / 2))
  const inlet = { x_mm: Math.round(start.x_mm + (end.x_mm - start.x_mm) * offset / wallLength), z_mm: Math.round(start.z_mm + (end.z_mm - start.z_mm) * offset / wallLength), y_mm }
  const inward = wallInwardNormal(boundary, door.wall_index)
  // Keep an explicit straight run on both sides of the door wall. This makes
  // the first visible pipe cross the door plane on its normal, rather than
  // turning sideways at the wall as the previous inlet-only route did.
  return {
    supplyOrigin: { x_mm: Math.round(inlet.x_mm - inward.x * 300), z_mm: Math.round(inlet.z_mm - inward.z * 300), y_mm },
    inlet,
    inside: { x_mm: Math.round(inlet.x_mm + inward.x * 300), z_mm: Math.round(inlet.z_mm + inward.z * 300), y_mm },
  }
}

function crossesObstacle(from: PipePoint, to: PipePoint, fixture: FixtureSpec) {
  const halfX = fixture.width_mm / 2 + LIGHT_CLEARANCE_MM + PIPE_MM / 2
  const halfZ = fixture.depth_mm / 2 + LIGHT_CLEARANCE_MM + PIPE_MM / 2
  if (from.z_mm === to.z_mm) return from.z_mm >= fixture.z_mm - halfZ && from.z_mm <= fixture.z_mm + halfZ && Math.max(from.x_mm, to.x_mm) >= fixture.x_mm - halfX && Math.min(from.x_mm, to.x_mm) <= fixture.x_mm + halfX
  if (from.x_mm === to.x_mm) return from.x_mm >= fixture.x_mm - halfX && from.x_mm <= fixture.x_mm + halfX && Math.max(from.z_mm, to.z_mm) >= fixture.z_mm - halfZ && Math.min(from.z_mm, to.z_mm) <= fixture.z_mm + halfZ
  return false
}

function orthogonalRoute(id: string, temperature: PipeTemperature, from: PipePoint, to: PipePoint, obstacles: FixtureSpec[], fixtureId?: string) {
  const candidates = [
    [from, { x_mm: to.x_mm, z_mm: from.z_mm, y_mm: from.y_mm }, to],
    [from, { x_mm: from.x_mm, z_mm: to.z_mm, y_mm: from.y_mm }, to],
  ]
  let points = candidates.find((candidate) => candidate.slice(1).every((point, index) => obstacles.every((obstacle) => !crossesObstacle(candidate[index], point, obstacle))))
  if (!points) {
    const bounds = roomBounds(obstacles.flatMap((item) => [
      { x_mm: item.x_mm - item.width_mm / 2 - LIGHT_CLEARANCE_MM, z_mm: item.z_mm - item.depth_mm / 2 - LIGHT_CLEARANCE_MM },
      { x_mm: item.x_mm + item.width_mm / 2 + LIGHT_CLEARANCE_MM, z_mm: item.z_mm + item.depth_mm / 2 + LIGHT_CLEARANCE_MM },
    ]))
    const detourZ = Number.isFinite(bounds.maxZ) ? Math.round(bounds.maxZ + PIPE_MM) : from.z_mm
    points = [from, { x_mm: from.x_mm, z_mm: detourZ, y_mm: from.y_mm }, { x_mm: to.x_mm, z_mm: detourZ, y_mm: from.y_mm }, to]
  }
  return points.slice(1).map((point, index) => segment(`${id}-${index}`, temperature, points![index], point, fixtureId)).filter((item): item is PipeSegment => !!item)
}

function projectToSegment(point: Point2D, start: Point2D, end: Point2D) {
  const dx = end.x_mm - start.x_mm
  const dz = end.z_mm - start.z_mm
  const denominator = dx * dx + dz * dz
  const ratio = denominator ? Math.max(0, Math.min(1, ((point.x_mm - start.x_mm) * dx + (point.z_mm - start.z_mm) * dz) / denominator)) : 0
  return { x_mm: Math.round(start.x_mm + dx * ratio), z_mm: Math.round(start.z_mm + dz * ratio) }
}

function pointInsideRoom(point: Point2D, boundary: Point2D[]) {
  let inside = false
  for (let index = 0, previous = boundary.length - 1; index < boundary.length; previous = index++) {
    const current = boundary[index]
    const prior = boundary[previous]
    if (((current.z_mm > point.z_mm) !== (prior.z_mm > point.z_mm)) && point.x_mm < ((prior.x_mm - current.x_mm) * (point.z_mm - current.z_mm)) / (prior.z_mm - current.z_mm) + current.x_mm) inside = !inside
  }
  return inside
}

function distanceToBoundary(point: Point2D, boundary: Point2D[]) {
  return Math.min(...boundary.map((start, index) => {
    const end = boundary[(index + 1) % boundary.length]
    const projection = projectToSegment(point, start, end)
    return Math.hypot(point.x_mm - projection.x_mm, point.z_mm - projection.z_mm)
  }))
}

/**
 * Generate points on the ceiling plane, never on a finished wall. A ceiling
 * manifold is a service point above the room, so wall projections are not
 * valid candidates even though they were used by the old wall-mounted route.
 */
function ceilingManifoldCandidates(spec: RoomSpec, targets: FixtureSpec[]) {
  const boundary = finishedRoomBoundary(spec)
  const bounds = roomBounds(boundary)
  const candidates: Point2D[] = []
  const add = (point: Point2D) => {
    if (!pointInsideRoom(point, boundary) || distanceToBoundary(point, boundary) < 100) return
    if (spec.fixtures.some((fixture) => fixture.mounting_surface === 'ceiling' && Math.hypot(fixture.x_mm - point.x_mm, fixture.z_mm - point.z_mm) < Math.max(fixture.width_mm, fixture.depth_mm) / 2 + 100)) return
    candidates.push({ x_mm: Math.round(point.x_mm), z_mm: Math.round(point.z_mm) })
  }
  add({ x_mm: (bounds.minX + bounds.maxX) / 2, z_mm: (bounds.minZ + bounds.maxZ) / 2 })
  const xs = targets.map((target) => target.x_mm)
  const zs = targets.map((target) => target.z_mm)
  ;[...xs, (bounds.minX + bounds.maxX) / 2].forEach((x) => [...zs, (bounds.minZ + bounds.maxZ) / 2].forEach((z) => add({ x_mm: x, z_mm: z })))
  const step = 200
  for (let x = bounds.minX + step; x < bounds.maxX; x += step) for (let z = bounds.minZ + step; z < bounds.maxZ; z += step) add({ x_mm: x, z_mm: z })
  const unique = new Map<string, Point2D>()
  candidates.forEach((point) => unique.set(`${point.x_mm},${point.z_mm}`, point))
  return [...unique.values()]
}

function evaluateManifold(id: string, temperature: PipeTemperature, source: PipePoint, targets: FixtureSpec[], candidates: Point2D[], obstacles: FixtureSpec[], avoid?: Point2D) {
  if (!targets.length || !candidates.length) return null
  const evaluated = candidates.map((point) => {
    const manifold = { ...point, y_mm: source.y_mm }
    const trunk = orthogonalRoute(`${id}-trunk`, temperature, source, manifold, obstacles)
    const trunkLength = trunk.reduce((sum, item) => sum + item.length_mm, 0)
    const segments = [...trunk]
    const branchLengths: number[] = []
    targets.forEach((target, index) => {
      const above = { x_mm: target.x_mm, z_mm: target.z_mm, y_mm: source.y_mm }
      const branch = orthogonalRoute(`${id}-branch-${index}`, temperature, manifold, above, obstacles, target.id)
      const drop = segment(`${id}-${index}-drop`, temperature, above, { ...above, y_mm: Math.max(0, target.elevation_mm ?? 0) }, target.id)
      if (drop) branch.push(drop)
      segments.push(...branch)
      branchLengths.push(trunkLength + branch.reduce((sum, item) => sum + item.length_mm, 0))
    })
    const imbalance_mm = Math.max(...branchLengths) - Math.min(...branchLengths)
    const total_mm = segments.reduce((sum, item) => sum + item.length_mm, 0)
    const separationPenalty = avoid ? Math.max(0, 250 - Math.hypot(point.x_mm - avoid.x_mm, point.z_mm - avoid.z_mm)) * 20 : 0
    return { manifold, segments, total_mm, imbalance_mm, objective: imbalance_mm * 100 + total_mm + separationPenalty }
  })
  return evaluated.sort((left, right) => left.objective - right.objective || left.total_mm - right.total_mm)[0]
}

/** Pure, non-throwing route derivation: malformed/incomplete hot-water input can never blank the 3D view. */
export function routePlumbing(spec: RoomSpec): PlumbingRoute | null {
  const targets = spec.fixtures.filter((item) => item.kind === 'water')
  if (!targets.length) return null
  const roomHeight = spec.height_mm ?? 2600
  // Both manifolds sit on the same finished-ceiling service plane. Branches
  // drop vertically from this plane to each measured terminal point.
  const ceilingY = Math.max(2100, roomHeight - 60)
  const penetration = doorPenetration(spec, ceilingY)
  const { supplyOrigin, inlet, inside } = penetration
  const coldTargets = targets.filter((item) => !isHot(item) && !isHeaterOutlet(item))
  const hotTargets = targets.filter((item) => isHot(item) && !isHeaterOutlet(item))
  const heaterOutlet = targets.find(isHeaterOutlet)
  const heaterBody = spec.fixtures.find((item) => item.kind !== 'water' && /热水器|heater/i.test(`${item.label} ${item.id}`))
  const hotSourceFixture = heaterOutlet ?? heaterBody
  const warnings: string[] = []
  if (hotTargets.length && !hotSourceFixture) warnings.push('存在热水点位但没有热水器出水角阀，热水管暂不生成')
  const obstacles = spec.fixtures.filter((item) => item.mounting_surface === 'ceiling')
  const candidates = ceilingManifoldCandidates(spec, [...coldTargets, ...hotTargets].length ? [...coldTargets, ...hotTargets] : targets)
  const fallback = { x_mm: Math.round((roomBounds(finishedRoomBoundary(spec)).minX + roomBounds(finishedRoomBoundary(spec)).maxX) / 2), z_mm: Math.round((roomBounds(finishedRoomBoundary(spec)).minZ + roomBounds(finishedRoomBoundary(spec)).maxZ) / 2) }
  const available = candidates.length ? candidates : [fallback]
  const coldSource = inside
  const coldSelected = evaluateManifold('cold', 'cold', coldSource, coldTargets, available, obstacles)
  const coldManifold = coldSelected?.manifold ?? { ...fallback, y_mm: ceilingY }
  const hotSource = hotSourceFixture ? { x_mm: hotSourceFixture.x_mm, z_mm: hotSourceFixture.z_mm, y_mm: ceilingY } : null
  const hotSelected = hotSource ? evaluateManifold('hot', 'hot', hotSource, hotTargets, available, obstacles, coldManifold) : null
  const segments: PipeSegment[] = [
    segment('cold-door-penetration-outside', 'cold', supplyOrigin, inlet),
    segment('cold-door-penetration-inside', 'cold', inlet, inside),
    ...(coldSelected?.segments ?? []),
  ].filter((item): item is PipeSegment => !!item)
  if (hotSourceFixture && hotSource && hotSelected) {
    const sourceAtFixture = { x_mm: hotSourceFixture.x_mm, z_mm: hotSourceFixture.z_mm, y_mm: Math.max(0, hotSourceFixture.elevation_mm ?? 0) }
    const rise = segment('hot-source-rise', 'hot', sourceAtFixture, hotSource, hotSourceFixture.id)
    if (rise) segments.push(rise)
    segments.push(...hotSelected.segments)
  }
  const uniqueMap = new Map<string, PipeSegment>()
  segments.forEach((item) => {
    const ends = [`${item.from.x_mm},${item.from.y_mm},${item.from.z_mm}`, `${item.to.x_mm},${item.to.y_mm},${item.to.z_mm}`].sort()
    const key = `${item.temperature}:${ends.join('|')}`
    if (!uniqueMap.has(key)) uniqueMap.set(key, item)
  })
  const uniqueSegments = [...uniqueMap.values()]
  const total_mm = uniqueSegments.reduce((sum, item) => sum + item.length_mm, 0)
  const branchImbalances = [coldSelected?.imbalance_mm, hotSelected?.imbalance_mm].filter((value): value is number => value !== undefined)
  const imbalance_mm = branchImbalances.length ? Math.max(...branchImbalances) : 0
  // Branch candidates intentionally reuse a same-temperature trunk. Render
  // that physical trunk once; duplicate meshes cause z-fighting and make a
  // modest network unnecessarily expensive in 3D.
  return { supply_origin: supplyOrigin, inlet, cold_manifold: coldManifold, hot_manifold: hotSelected?.manifold ?? null, manifold: coldManifold, manifold_wall_index: null, segments: uniqueSegments, total_mm, imbalance_mm, warnings }
}
