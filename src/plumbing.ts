import type { FixtureSpec, Point2D, RoomSpec } from './types'
import { finishedRoomBoundary, roomBounds, wallFinishGap, wallFinishThickness, wallInwardNormal } from './spec'

export type PipeTemperature = 'cold' | 'hot'
export type PipePoint = Point2D & { y_mm: number }
export type PipeSegment = { id: string; temperature: PipeTemperature; from: PipePoint; to: PipePoint; length_mm: number; fixture_id?: string }
export type PlumbingRoute = {
  supply_origin: PipePoint
  inlet: PipePoint
  /** Cold-water manifold: the only point where the cold main splits. */
  cold_manifold: PipePoint
  /** Hot manifold rail, only needed when one heater supplies multiple hot outlets. */
  hot_manifold: PipePoint | null
  /** Kept as a compatibility alias for older consumers; never wall-mounted. */
  manifold: PipePoint
  manifold_wall_index: null
  /** Port count of the single ceiling manifold: 6 or 8 (null when unused). */
  manifold_ports: 6 | 8 | null
  segments: PipeSegment[]
  total_mm: number
  imbalance_mm: number
  warnings: string[]
}

const PIPE_MM = 26
const LIGHT_CLEARANCE_MM = 75
const PIPE_LAYER_GAP_MM = 100
const MANIFOLD_PORT_SPACING_MM = 45
const MANIFOLD_DEPTH_MM = 90
const MANIFOLD_BRANCH_LEAD_MM = 80
const PIPE_LANE_SPACING_MM = 65
const isHot = (fixture: FixtureSpec) => /热水|热角阀|hot/i.test(`${fixture.label} ${fixture.id}`) && !/冷水|cold/i.test(`${fixture.label} ${fixture.id}`)
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
  const { halfX, halfZ } = obstacleHalfExtents(fixture)
  if (from.z_mm === to.z_mm) return from.z_mm >= fixture.z_mm - halfZ && from.z_mm <= fixture.z_mm + halfZ && Math.max(from.x_mm, to.x_mm) >= fixture.x_mm - halfX && Math.min(from.x_mm, to.x_mm) <= fixture.x_mm + halfX
  if (from.x_mm === to.x_mm) return from.x_mm >= fixture.x_mm - halfX && from.x_mm <= fixture.x_mm + halfX && Math.max(from.z_mm, to.z_mm) >= fixture.z_mm - halfZ && Math.min(from.z_mm, to.z_mm) <= fixture.z_mm + halfZ
  return false
}

/** Conservative axis-aligned envelope for a rotated appliance. */
function obstacleHalfExtents(fixture: FixtureSpec, extra = LIGHT_CLEARANCE_MM + PIPE_MM / 2) {
  const angle = ((fixture.rotation_deg ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  return {
    halfX: cos * fixture.width_mm / 2 + sin * fixture.depth_mm / 2 + extra,
    halfZ: sin * fixture.width_mm / 2 + cos * fixture.depth_mm / 2 + extra,
  }
}

/** Service terminals (valves, sockets, drains) are connection points, not collision obstacles. */
function isServicePoint(fixture: FixtureSpec) {
  return ['floor_drain', 'drain', 'water', 'electric'].includes(fixture.kind)
}

/** A device that owns the terminal; the terminal may connect at its edge. */
function servesTarget(obstacle: FixtureSpec, target: FixtureSpec) {
  if (obstacle.id === target.id) return true
  // Wall terminals are recorded on the finished wall face while the owning
  // appliance centre sits behind that face. Include the pipe clearance when
  // matching a terminal to its host, otherwise a valid vertical drop is
  // mistaken for a collision with the very appliance it serves.
  const { halfX, halfZ } = obstacleHalfExtents(obstacle, LIGHT_CLEARANCE_MM + PIPE_MM / 2)
  const insideFootprint = Math.abs(target.x_mm - obstacle.x_mm) <= halfX && Math.abs(target.z_mm - obstacle.z_mm) <= halfZ
  return insideFootprint
}

function wallCavityPoint(spec: RoomSpec, target: FixtureSpec) {
  const wallIndex = target.bound_wall_index
  if (wallIndex === undefined || wallIndex === null || wallIndex < 0 || wallIndex >= spec.boundary.length) return null
  const inward = wallInwardNormal(finishedRoomBoundary(spec), wallIndex)
  const offset = wallFinishThickness(spec, wallIndex) + wallFinishGap(spec, wallIndex) / 2
  return {
    x_mm: Math.round(target.x_mm - inward.x * offset),
    z_mm: Math.round(target.z_mm - inward.z * offset),
  }
}

function physicalTerminalPoint(spec: RoomSpec, target: FixtureSpec, obstacles: FixtureSpec[]) {
  // Markers stay on the finished face. The vertical pipe centre belongs behind
  // that face, halfway through the panel-to-structure service cavity.
  const cavity = wallCavityPoint(spec, target)
  if (cavity) return cavity
  const host = obstacles.find((obstacle) => !isServicePoint(obstacle) && servesTarget(obstacle, target))
  if (!host) return { x_mm: target.x_mm, z_mm: target.z_mm }
  const { halfX, halfZ } = obstacleHalfExtents(host, 0)
  const dx = target.x_mm - host.x_mm
  const dz = target.z_mm - host.z_mm
  if (Math.abs(dx) > halfX || Math.abs(dz) > halfZ) return { x_mm: target.x_mm, z_mm: target.z_mm }
  const gapX = halfX - Math.abs(dx)
  const gapZ = halfZ - Math.abs(dz)
  return gapX < gapZ
    ? { x_mm: Math.round(host.x_mm + (dx >= 0 ? halfX + PIPE_MM / 2 : -halfX - PIPE_MM / 2)), z_mm: target.z_mm }
    : { x_mm: target.x_mm, z_mm: Math.round(host.z_mm + (dz >= 0 ? halfZ + PIPE_MM / 2 : -halfZ - PIPE_MM / 2)) }
}

/** Keep a vertical drop outside solid appliances, then make the final edge connection. */
function dropPath(spec: RoomSpec, id: string, temperature: PipeTemperature, above: PipePoint, target: FixtureSpec, obstacles: FixtureSpec[]) {
  const terminal = physicalTerminalPoint(spec, target, obstacles)
  const connectionAbove = { x_mm: terminal.x_mm, z_mm: terminal.z_mm, y_mm: above.y_mm }
  const targetPoint = { ...terminal, y_mm: Math.max(0, target.elevation_mm ?? 0) }
  const direct = segment(`${id}-drop`, temperature, connectionAbove, targetPoint, target.id)
  // The wall connection is a strict vertical drop. The owning appliance is
  // exempt at the terminal edge, but another piece of furniture may not be
  // bypassed by adding a horizontal segment at appliance height (that would
  // put a pipe through the furniture in the rendered model).
  const blocked = obstacles.some((obstacle) => !isServicePoint(obstacle)
    && !servesTarget(obstacle, target)
    && crossesObstacle(connectionAbove, targetPoint, obstacle))
  const facePoint = { x_mm: target.x_mm, z_mm: target.z_mm, y_mm: targetPoint.y_mm }
  const penetration = segment(`${id}-penetration`, temperature, targetPoint, facePoint, target.id)
  return !direct || blocked
    ? { above: connectionAbove, segments: [] }
    : { above: connectionAbove, segments: [direct, penetration].filter((item): item is PipeSegment => !!item) }
}

function safeSourceLayerPoint(source: PipePoint, layer: PipePoint, sourceFixture: FixtureSpec, obstacles: FixtureSpec[]) {
  if (!crossesObstacle(source, layer, sourceFixture)) return layer
  const { halfX, halfZ } = obstacleHalfExtents(sourceFixture, LIGHT_CLEARANCE_MM + PIPE_MM / 2 + PIPE_MM)
  const offsets = [
    { x_mm: sourceFixture.x_mm - halfX - PIPE_MM, z_mm: source.z_mm },
    { x_mm: sourceFixture.x_mm + halfX + PIPE_MM, z_mm: source.z_mm },
    { x_mm: source.x_mm, z_mm: sourceFixture.z_mm - halfZ - PIPE_MM },
    { x_mm: source.x_mm, z_mm: sourceFixture.z_mm + halfZ + PIPE_MM },
  ]
  return offsets
    .map((point) => ({ ...point, y_mm: layer.y_mm }))
    .filter((point) => !obstacles.some((obstacle) => obstacle.id !== sourceFixture.id && !isServicePoint(obstacle) && crossesObstacle(source, point, obstacle)))
    .filter((point) => !obstacles.some((obstacle) => !isServicePoint(obstacle) && crossesObstacle(point, point, obstacle)))
    .sort((left, right) => Math.abs(left.x_mm - source.x_mm) + Math.abs(left.z_mm - source.z_mm) - Math.abs(right.x_mm - source.x_mm) - Math.abs(right.z_mm - source.z_mm))[0]
    ?? null
}

function sourceRisePath(id: string, temperature: PipeTemperature, source: PipePoint, layer: PipePoint, sourceFixture: FixtureSpec, obstacles: FixtureSpec[]) {
  const riseStart = { x_mm: layer.x_mm, z_mm: layer.z_mm, y_mm: source.y_mm }
  const horizontal = segment(`${id}-out`, temperature, source, riseStart, sourceFixture.id)
  const direct = segment(id, temperature, riseStart, layer, sourceFixture.id)
  // Both legs are inside the wall assembly (penetration plus cavity riser), so
  // room-side furniture footprints do not block them. Collision checks resume
  // once the route reaches the ceiling distribution plane.
  if (!direct) return []
  return [horizontal, direct].filter((item): item is PipeSegment => !!item)
}

function segmentsFromPoints(id: string, temperature: PipeTemperature, points: PipePoint[], fixtureId?: string) {
  return points.slice(1).map((point, index) => segment(`${id}-${index}`, temperature, points[index], point, fixtureId)).filter((item): item is PipeSegment => !!item)
}

/**
 * Orthogonal ceiling route that treats every device footprint as an obstacle.
 * Walls are NOT obstacles: pipes may cross them. When both L-shaped options
 * collide, detour around the device envelope on the first clear outside rail.
 */
function pipeConflict(points: PipePoint[], routed: PipeSegment[]) {
  const candidateSegments = points.slice(1).map((to, index) => ({ from: points[index], to })).filter(({ from, to }) => length(from, to) > 0)
  return candidateSegments.reduce((count, candidate) => count + routed.filter((existing) => {
    if (candidate.from.y_mm !== candidate.to.y_mm || existing.from.y_mm !== existing.to.y_mm || candidate.from.y_mm !== existing.from.y_mm) return false
    const candidateAlongX = candidate.from.z_mm === candidate.to.z_mm
    const existingAlongX = existing.from.z_mm === existing.to.z_mm
    if (candidateAlongX && existingAlongX) {
      if (candidate.from.z_mm !== existing.from.z_mm) return false
      return Math.min(Math.max(candidate.from.x_mm, candidate.to.x_mm), Math.max(existing.from.x_mm, existing.to.x_mm)) > Math.max(Math.min(candidate.from.x_mm, candidate.to.x_mm), Math.min(existing.from.x_mm, existing.to.x_mm))
    }
    if (!candidateAlongX && !existingAlongX) {
      if (candidate.from.x_mm !== existing.from.x_mm) return false
      return Math.min(Math.max(candidate.from.z_mm, candidate.to.z_mm), Math.max(existing.from.z_mm, existing.to.z_mm)) > Math.max(Math.min(candidate.from.z_mm, candidate.to.z_mm), Math.min(existing.from.z_mm, existing.to.z_mm))
    }
    const horizontal = candidateAlongX ? candidate : existing
    const vertical = candidateAlongX ? existing : candidate
    return vertical.from.x_mm > Math.min(horizontal.from.x_mm, horizontal.to.x_mm)
      && vertical.from.x_mm < Math.max(horizontal.from.x_mm, horizontal.to.x_mm)
      && horizontal.from.z_mm > Math.min(vertical.from.z_mm, vertical.to.z_mm)
      && horizontal.from.z_mm < Math.max(vertical.from.z_mm, vertical.to.z_mm)
  }).length, 0)
}

function orthogonalRoute(id: string, temperature: PipeTemperature, from: PipePoint, to: PipePoint, obstacles: FixtureSpec[], fixtureId?: string, routed: PipeSegment[] = [], targetFixture?: FixtureSpec, sourceFixtureId?: string) {
  // Service points are deliberately omitted from `obstacles`; carry the
  // target through explicitly so its owning appliance can be exempted at the
  // final approach without allowing any unrelated furniture intersection.
  const target = targetFixture ?? (fixtureId ? obstacles.find((item) => item.id === fixtureId) : undefined)
  const lShapes = [
    [from, { x_mm: to.x_mm, z_mm: from.z_mm, y_mm: from.y_mm }, to] as PipePoint[],
    [from, { x_mm: from.x_mm, z_mm: to.z_mm, y_mm: from.y_mm }, to] as PipePoint[],
  ]
  const clearRoute = (points: PipePoint[]) => points.slice(1).every((point, index) => obstacles.every((obstacle) => obstacle.id === sourceFixtureId || (target && servesTarget(obstacle, target)) || !crossesObstacle(points[index], point, obstacle)))
  const zRails: number[] = []
  const xRails: number[] = []
  const collectZ = (value: number) => { if (Number.isFinite(value)) zRails.push(Math.round(value)) }
  const collectX = (value: number) => { if (Number.isFinite(value)) xRails.push(Math.round(value)) }
  obstacles.forEach((item) => {
    const { halfX, halfZ } = obstacleHalfExtents(item)
    collectZ(item.z_mm + halfZ + PIPE_MM); collectZ(item.z_mm - halfZ - PIPE_MM)
    collectX(item.x_mm + halfX + PIPE_MM); collectX(item.x_mm - halfX - PIPE_MM)
  })
  routed.forEach((item) => {
    collectZ(item.from.z_mm + PIPE_LANE_SPACING_MM); collectZ(item.from.z_mm - PIPE_LANE_SPACING_MM)
    collectX(item.from.x_mm + PIPE_LANE_SPACING_MM); collectX(item.from.x_mm - PIPE_LANE_SPACING_MM)
  })
  if (obstacles.length) {
    const bounds = roomBounds(obstacles.flatMap((item) => [
      (() => { const { halfX, halfZ } = obstacleHalfExtents(item); return { x_mm: item.x_mm - halfX, z_mm: item.z_mm - halfZ } })(),
      (() => { const { halfX, halfZ } = obstacleHalfExtents(item); return { x_mm: item.x_mm + halfX, z_mm: item.z_mm + halfZ } })(),
    ]))
    collectZ(bounds.maxZ + PIPE_MM); collectZ(bounds.minZ - PIPE_MM)
    collectX(bounds.maxX + PIPE_MM); collectX(bounds.minX - PIPE_MM)
  }
  for (let offset = PIPE_LANE_SPACING_MM; offset <= PIPE_LANE_SPACING_MM * Math.max(4, routed.length + 1); offset += PIPE_LANE_SPACING_MM) {
    collectZ(from.z_mm + offset); collectZ(from.z_mm - offset)
    collectX(from.x_mm + offset); collectX(from.x_mm - offset)
  }
  const candidates: PipePoint[][] = [
    ...lShapes,
    ...[...new Set(zRails)].map((z): PipePoint[] => [from, { x_mm: from.x_mm, z_mm: z, y_mm: from.y_mm }, { x_mm: to.x_mm, z_mm: z, y_mm: from.y_mm }, to]),
    ...[...new Set(xRails)].map((x): PipePoint[] => [from, { x_mm: x, z_mm: from.z_mm, y_mm: from.y_mm }, { x_mm: x, z_mm: to.z_mm, y_mm: from.y_mm }, to]),
  ].filter(clearRoute)
  const selected = candidates.sort((left, right) => pipeConflict(left, routed) - pipeConflict(right, routed) || left.slice(1).reduce((sum, point, index) => sum + length(left[index], point), 0) - right.slice(1).reduce((sum, point, index) => sum + length(right[index], point), 0))[0]
  return selected ? segmentsFromPoints(id, temperature, selected, fixtureId) : []
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
    const manifoldWidth = targets.length <= 6 ? 320 : 420
    const manifoldDepth = 90
    // The manifold body and its port face are solid hardware too: keep the
    // chosen center outside every furniture footprint, not just ceiling lamps.
    if (spec.fixtures.some((fixture) => {
      if (isServicePoint(fixture) || (fixture.kind === 'pipe' && fixture.mounting_surface === 'ceiling')) return false
      const { halfX, halfZ } = obstacleHalfExtents(fixture, 100)
      return Math.abs(fixture.x_mm - point.x_mm) <= halfX + manifoldWidth / 2 && Math.abs(fixture.z_mm - point.z_mm) <= halfZ + manifoldDepth / 2
    })) return
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

function evaluateManifold(spec: RoomSpec, id: string, temperature: PipeTemperature, source: PipePoint, targets: FixtureSpec[], candidates: Point2D[], obstacles: FixtureSpec[], sourceFixtureId?: string) {
  if (!targets.length || !candidates.length) return null
  const evaluated = candidates.map((point) => {
    const manifold = { ...point, y_mm: source.y_mm }
    const manifoldWidth = targets.length <= 6 ? 320 : 420
    const inlet = { ...manifold, x_mm: manifold.x_mm + (source.x_mm <= manifold.x_mm ? -manifoldWidth / 2 : manifoldWidth / 2) }
    const trunk = orthogonalRoute(`${id}-trunk`, temperature, source, inlet, obstacles, undefined, [], undefined, sourceFixtureId)
    const trunkLength = trunk.reduce((sum, item) => sum + item.length_mm, 0)
    const segments = [...trunk]
    const routedBranches: PipeSegment[] = []
    const branchLengths: number[] = []
    let invalid = !trunk.length && (source.x_mm !== inlet.x_mm || source.z_mm !== inlet.z_mm)
    const outletSide = targets.reduce((sum, target) => sum + target.z_mm - manifold.z_mm, 0) >= 0 ? 1 : -1
    targets.forEach((target, index) => {
      const above = { x_mm: target.x_mm, z_mm: target.z_mm, y_mm: source.y_mm }
      const port = {
        ...manifold,
        x_mm: manifold.x_mm + Math.round((index - (targets.length - 1) / 2) * MANIFOLD_PORT_SPACING_MM),
        z_mm: manifold.z_mm + outletSide * MANIFOLD_DEPTH_MM / 2,
      }
      const lead = { ...port, z_mm: port.z_mm + outletSide * MANIFOLD_BRANCH_LEAD_MM }
      // Pipes must not cross other devices; the branch destination (and the
      // device carrying that outlet) is exempt so drops can land on it.
      const branchObstacles = obstacles
      const departure = segment(`${id}-branch-${index}-port`, temperature, port, lead, target.id)
      const approach = dropPath(spec, `${id}-${index}`, temperature, above, target, branchObstacles)
      if (!approach.segments.length) {
        invalid = true
        return
      }
      const branch = orthogonalRoute(`${id}-branch-${index}`, temperature, lead, approach.above, branchObstacles, target.id, routedBranches, target)
      if (!branch.length && (lead.x_mm !== approach.above.x_mm || lead.z_mm !== approach.above.z_mm)) {
        invalid = true
        return
      }
      if (departure) branch.unshift(departure)
      branch.push(...approach.segments)
      segments.push(...branch)
      routedBranches.push(...branch.filter((item) => item.from.y_mm === item.to.y_mm))
      branchLengths.push(trunkLength + branch.reduce((sum, item) => sum + item.length_mm, 0))
    })
    if (invalid || !branchLengths.length) return null
    const imbalance_mm = Math.max(...branchLengths) - Math.min(...branchLengths)
    const total_mm = segments.reduce((sum, item) => sum + item.length_mm, 0)
    return { manifold, segments, total_mm, imbalance_mm }
  })
  const valid = evaluated.filter((item): item is NonNullable<typeof item> => !!item)
  // Lexicographic objective: minimize source-to-device length spread first,
  // then minimize the total pipe length among equally balanced layouts.
  return valid.sort((left, right) => left.imbalance_mm - right.imbalance_mm || left.total_mm - right.total_mm)[0] ?? null
}

/**
 * Pure, non-throwing route derivation: malformed/incomplete hot-water input can never blank the 3D view.
 *
 * A single cold main reaches the manifold, then one dedicated port serves each
 * cold outlet (including the heater inlet). The heater outlet becomes the hot
 * source. One hot outlet is direct; multiple hot outlets use the lower rail of
 * the same manifold assembly. Every device footprint is a pipe obstacle.
 */
export function routePlumbing(spec: RoomSpec): PlumbingRoute | null {
  const targets = spec.fixtures.filter((item) => item.kind === 'water')
  if (!targets.length) return null
  const roomHeight = spec.height_mm ?? 2600
  const heaterBody = spec.fixtures.find((item) => item.kind !== 'water' && /热水器|heater/i.test(`${item.label} ${item.id}`))
  const heaterTop = heaterBody ? (heaterBody.elevation_mm ?? 0) + heaterBody.height_mm : roomHeight
  // Horizontal distribution belongs above the finished ceiling. In low rooms
  // the heater may occupy a ceiling recess, so both rails also clear its top.
  const hotLayerY = Math.max(roomHeight + 60, heaterTop + PIPE_MM / 2 + 25)
  const coldLayerY = hotLayerY + PIPE_LAYER_GAP_MM
  const penetration = doorPenetration(spec, coldLayerY)
  const { supplyOrigin, inlet, inside } = penetration
  const coldTargets = targets.filter((item) => !isHot(item) && !isHeaterOutlet(item))
  const hotTargets = targets.filter((item) => isHot(item) && !isHeaterOutlet(item))
  const heaterOutlet = targets.find(isHeaterOutlet)
  const hotSourceFixture = heaterOutlet ?? heaterBody
  const warnings: string[] = []
  if (hotTargets.length && !hotSourceFixture) warnings.push('存在热水点位但没有热水器出水角阀，热水管暂不生成')
  // Pipes dodge every device footprint (walls excluded — crossing them is
  // allowed). Small wall terminals (valves, sockets, drains) are connection
  // points rather than devices, and the ceiling manifold fixture itself is
  // the route's destination, so neither may block the network.
  const obstacles = spec.fixtures.filter((item) => !isServicePoint(item) && !(item.kind === 'pipe' && item.mounting_surface === 'ceiling'))
  // Once above the finished ceiling, floor and wall-mounted furniture are
  // below the pipe volume. Keep only other ceiling hardware as route blockers.
  const ceilingObstacles = obstacles.filter((item) => item.mounting_surface === 'ceiling')
  const candidates = ceilingManifoldCandidates(spec, [...coldTargets, ...hotTargets].length ? [...coldTargets, ...hotTargets] : targets)
  const fallback = { x_mm: Math.round((roomBounds(finishedRoomBoundary(spec)).minX + roomBounds(finishedRoomBoundary(spec)).maxX) / 2), z_mm: Math.round((roomBounds(finishedRoomBoundary(spec)).minZ + roomBounds(finishedRoomBoundary(spec)).maxZ) / 2) }
  const available = candidates.length ? candidates : [fallback]
  const coldSource = inside
  const coldSelected = evaluateManifold(spec, 'cold', 'cold', coldSource, coldTargets, available, obstacles)
  if (coldTargets.length && !coldSelected) warnings.push('冷水吊顶分水器无法在家具碰撞约束下完成布管')
  const coldManifold = coldSelected?.manifold ?? { ...fallback, y_mm: coldLayerY }
  const hotSource = hotSourceFixture ? { x_mm: hotSourceFixture.x_mm, z_mm: hotSourceFixture.z_mm, y_mm: hotLayerY } : null
  const hotSolidFixture = heaterBody ?? hotSourceFixture
  // The hot riser must stay on the heater outlet's projected x/z. Any
  // horizontal movement belongs to the ceiling route after the riser, never
  // to the wall-height portion of the installation.
  const hotTerminal = hotSourceFixture ? physicalTerminalPoint(spec, hotSourceFixture, obstacles) : null
  const hotNetworkSource = hotTerminal && hotSource
    ? (heaterOutlet
      ? { ...hotTerminal, y_mm: hotLayerY }
      : safeSourceLayerPoint({ ...hotTerminal, y_mm: hotLayerY }, { ...hotTerminal, y_mm: hotLayerY }, hotSolidFixture!, obstacles))
    : null
  const hotSelected = hotNetworkSource && hotTargets.length > 1
    ? (evaluateManifold(spec, 'hot', 'hot', hotNetworkSource, hotTargets, [{ x_mm: coldManifold.x_mm, z_mm: coldManifold.z_mm }], obstacles, hotSolidFixture?.id)
      ?? evaluateManifold(spec, 'hot', 'hot', hotNetworkSource, hotTargets, [{ x_mm: coldManifold.x_mm, z_mm: coldManifold.z_mm }], ceilingObstacles, hotSolidFixture?.id))
    : null
  const segments: PipeSegment[] = [
    segment('cold-door-penetration-outside', 'cold', supplyOrigin, inlet),
    segment('cold-door-penetration-inside', 'cold', inlet, inside),
    ...(coldSelected?.segments ?? []),
  ].filter((item): item is PipeSegment => !!item)
  if (hotSourceFixture && hotSource && hotNetworkSource && hotTargets.length) {
    // Start at the physical edge connection, never at the appliance centre.
    // The centre coordinate identifies the host heater, but a pipe beginning
    // there would visibly tunnel through its body before rising.
    const sourceAtFixture = { x_mm: hotSourceFixture.x_mm, z_mm: hotSourceFixture.z_mm, y_mm: Math.max(0, hotSourceFixture.elevation_mm ?? 0) }
    segments.push(...sourceRisePath('hot-source-rise', 'hot', sourceAtFixture, hotNetworkSource, hotSolidFixture ?? hotSourceFixture, obstacles))
    if (!segments.some((item) => item.id === 'hot-source-rise')) warnings.push('热水器出水口无法沿墙安全上翻至吊顶')
    if (hotSelected) segments.push(...hotSelected.segments)
    else hotTargets.forEach((target, index) => {
      const above = { x_mm: target.x_mm, z_mm: target.z_mm, y_mm: hotLayerY }
      const branchObstacles = obstacles
      const approach = dropPath(spec, `hot-${index}`, 'hot', above, target, branchObstacles)
      const routedBranch = orthogonalRoute(`hot-run-${index}`, 'hot', hotNetworkSource, approach.above, branchObstacles, target.id, [], target, hotSolidFixture?.id)
      const branch = routedBranch.length || (hotNetworkSource.x_mm === approach.above.x_mm && hotNetworkSource.z_mm === approach.above.z_mm)
        ? routedBranch
        : orthogonalRoute(`hot-run-${index}-ceiling`, 'hot', hotNetworkSource, approach.above, ceilingObstacles, target.id, [], target, hotSolidFixture?.id)
      if (!approach.segments.length || (!branch.length && (hotNetworkSource.x_mm !== approach.above.x_mm || hotNetworkSource.z_mm !== approach.above.z_mm))) {
        warnings.push(`热水点位 ${target.label} 无法生成无碰撞吊顶支路`)
        return
      }
      branch.push(...approach.segments)
      segments.push(...branch)
    })
  }
  const uniqueMap = new Map<string, PipeSegment>()
  segments.forEach((item) => {
    const ends = [`${item.from.x_mm},${item.from.y_mm},${item.from.z_mm}`, `${item.to.x_mm},${item.to.y_mm},${item.to.z_mm}`].sort()
    const key = `${item.temperature}:${ends.join('|')}`
    if (!uniqueMap.has(key)) uniqueMap.set(key, item)
  })
  const uniqueSegments = [...uniqueMap.values()]
  const total_mm = uniqueSegments.reduce((sum, item) => sum + item.length_mm, 0)
  const imbalance_mm = Math.max(coldSelected?.imbalance_mm ?? 0, hotSelected?.imbalance_mm ?? 0)
  const requiredPorts = Math.max(coldTargets.length, hotTargets.length > 1 ? hotTargets.length : 0)
  const manifold_ports: 6 | 8 | null = coldSelected && requiredPorts ? (requiredPorts <= 6 ? 6 : 8) : null
  return { supply_origin: supplyOrigin, inlet, cold_manifold: coldManifold, hot_manifold: hotSelected?.manifold ?? null, manifold: coldManifold, manifold_wall_index: null, manifold_ports, segments: uniqueSegments, total_mm, imbalance_mm, warnings }
}
