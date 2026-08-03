import type { DryWetZone, FixtureKind, FixturePointUsage, FixtureSpec, OpeningSpec, Point2D, RoomSpec, ValidationIssue, WallFinishProfile } from './types'

export const defaultWallThicknessMm = 200
export const defaultFinishSurfaceOffsetMm = 20
export const defaultWallFinishThicknessMm = 20
export const wallBindingSnapDistanceMm = 100
export const toiletDrainRoughInMm = 305

export const fixtureLabels: Record<FixtureKind, string> = {
  toilet: '马桶',
  vanity: '台盆 / 浴室柜',
  shower: '淋浴区',
  floor_drain: '地漏',
  drain: '排水',
  water: '给水',
  electric: '电点',
  pipe: '管道',
  column: '柱 / 包管',
  radiator: '暖气',
  other: '其他设施',
}

export const fixtureDefaults: Record<FixtureKind, Pick<FixtureSpec, 'width_mm' | 'depth_mm' | 'height_mm'>> = {
  toilet: { width_mm: 380, depth_mm: 700, height_mm: 760 },
  vanity: { width_mm: 800, depth_mm: 520, height_mm: 850 },
  shower: { width_mm: 900, depth_mm: 900, height_mm: 2000 },
  floor_drain: { width_mm: 120, depth_mm: 120, height_mm: 10 },
  drain: { width_mm: 60, depth_mm: 60, height_mm: 10 },
  water: { width_mm: 40, depth_mm: 40, height_mm: 10 },
  electric: { width_mm: 40, depth_mm: 40, height_mm: 10 },
  pipe: { width_mm: 110, depth_mm: 110, height_mm: 2400 },
  column: { width_mm: 400, depth_mm: 400, height_mm: 2600 },
  radiator: { width_mm: 500, depth_mm: 120, height_mm: 800 },
  other: { width_mm: 500, depth_mm: 500, height_mm: 800 },
}

export function fixturePointShape(kind: FixtureKind): 'circle' | 'square' | null {
  if (kind === 'floor_drain') return 'square'
  if (kind === 'drain' || kind === 'water') return 'circle'
  return null
}

export const fixturePointUsageLabels: Record<FixturePointUsage, string> = {
  general: '通用',
  toilet: '马桶',
  shower: '花洒',
  basin: '台盆 / 水池',
}

export function fixturePointUsage(fixture: FixtureSpec): FixturePointUsage | null {
  if (fixture.kind !== 'floor_drain' && fixture.kind !== 'drain' && fixture.kind !== 'water') return null
  if (fixture.point_usage) return fixture.point_usage
  if (/马桶|坐便/.test(fixture.label)) return 'toilet'
  if (/花洒|淋浴/.test(fixture.label)) return 'shower'
  if (/台盆|面盆|洗手盆|水池|龙头/.test(fixture.label)) return 'basin'
  return 'general'
}

export function manualRoom(widthMm: number, depthMm: number, heightMm: number): RoomSpec {
  return {
    schema_version: '1.0',
    name: '卫生间',
    boundary: [
      { x_mm: 0, z_mm: 0 },
      { x_mm: widthMm, z_mm: 0 },
      { x_mm: widthMm, z_mm: depthMm },
      { x_mm: 0, z_mm: depthMm },
    ],
    height_mm: heightMm,
    wall_thickness_mm: defaultWallThicknessMm,
    strip_existing_finish: true,
    finish_surface_offset_mm: defaultFinishSurfaceOffsetMm,
    wall_finish_thickness_mm: defaultWallFinishThicknessMm,
    openings: [],
    fixtures: [],
    observations: [
      { field: 'boundary', value: `${widthMm} x ${depthMm} mm`, source: 'user', confidence: 1, confirmed: true, note: '用户手动创建' },
      { field: 'height_mm', value: `${heightMm}`, source: 'user', confidence: 1, confirmed: true, note: '用户手动创建' },
    ],
    issues: [],
    confirmed: false,
  }
}

export function roomBounds(points: Point2D[]) {
  const xs = points.map((point) => point.x_mm)
  const zs = points.map((point) => point.z_mm)
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...zs) - Math.min(...zs),
  }
}

export function roomCentroid(points: Point2D[]) {
  const bounds = roomBounds(points)
  return { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 }
}

export function hiddenWallIndexesForCutaway(points: Point2D[], cameraPoint: Point2D, maxHidden = 2) {
  if (points.length < 2 || maxHidden <= 0) return []
  const center = roomCentroid(points)
  const cameraVector = { x: cameraPoint.x_mm - center.x, z: cameraPoint.z_mm - center.z }
  const cameraDistance = Math.hypot(cameraVector.x, cameraVector.z)
  if (cameraDistance < 1) return []
  const view = { x: cameraVector.x / cameraDistance, z: cameraVector.z / cameraDistance }
  const scored = points.map((_, index) => {
    const normal = wallOutwardNormal(points, index)
    return { index, score: normal.x * view.x + normal.z * view.z }
  }).filter((item) => item.score > 0.05).sort((left, right) => right.score - left.score)
  const strongest = scored[0]?.score ?? 0
  const threshold = Math.max(0.32, strongest * 0.68)
  return scored
    .filter((item) => item.score >= threshold)
    .slice(0, maxHidden)
    .map((item) => item.index)
    .sort((left, right) => left - right)
}

export function wallLength(points: Point2D[], index: number) {
  const start = points[index]
  const end = points[(index + 1) % points.length]
  return Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm)
}

export function openingLine(spec: RoomSpec, opening: OpeningSpec) {
  if (opening.line?.start && opening.line.end) return { start: { ...opening.line.start }, end: { ...opening.line.end } }
  const wallIndex = Math.max(0, Math.min(spec.boundary.length - 1, Math.round(opening.wall_index)))
  const start = spec.boundary[wallIndex]
  const end = spec.boundary[(wallIndex + 1) % spec.boundary.length]
  if (!start || !end) return { start: { x_mm: 0, z_mm: 0 }, end: { x_mm: opening.width_mm, z_mm: 0 } }
  const length = Math.max(1, wallLength(spec.boundary, wallIndex))
  const startRatio = opening.offset_mm / length
  const endRatio = (opening.offset_mm + opening.width_mm) / length
  return {
    start: { x_mm: start.x_mm + (end.x_mm - start.x_mm) * startRatio, z_mm: start.z_mm + (end.z_mm - start.z_mm) * startRatio },
    end: { x_mm: start.x_mm + (end.x_mm - start.x_mm) * endRatio, z_mm: start.z_mm + (end.z_mm - start.z_mm) * endRatio },
  }
}

export function centeredOpeningLine(spec: RoomSpec, widthMm: number) {
  const center = roomCentroid(spec.boundary)
  const wallIndex = spec.boundary.reduce((best, _point, index) => wallLength(spec.boundary, index) > wallLength(spec.boundary, best) ? index : best, 0)
  const wallStart = spec.boundary[wallIndex]
  const wallEnd = spec.boundary[(wallIndex + 1) % spec.boundary.length]
  const length = Math.max(1, wallLength(spec.boundary, wallIndex))
  const ux = (wallEnd.x_mm - wallStart.x_mm) / length
  const uz = (wallEnd.z_mm - wallStart.z_mm) / length
  const half = Math.max(5, widthMm) / 2
  return { start: { x_mm: Math.round(center.x - ux * half), z_mm: Math.round(center.z - uz * half) }, end: { x_mm: Math.round(center.x + ux * half), z_mm: Math.round(center.z + uz * half) } }
}

export function syncOpeningBindings(next: RoomSpec, previous?: RoomSpec | null) {
  if (next.boundary.length < 2) return next
  for (const opening of next.openings) {
    const previousOpening = previous?.openings.find((item) => item.id === opening.id)
    const boundaryChanged = !!previous && (previous.boundary.length !== next.boundary.length || previous.boundary.some((point, index) => point.x_mm !== next.boundary[index]?.x_mm || point.z_mm !== next.boundary[index]?.z_mm))
    const manuallyChangedWall = !!previousOpening && opening.wall_index !== previousOpening.wall_index
    let wallIndex = Math.max(0, Math.min(next.boundary.length - 1, Math.round(opening.wall_index)))
    let startRatio = Number.isFinite(opening.offset_mm) ? opening.offset_mm / Math.max(1, wallLength(next.boundary, wallIndex)) : 0.5
    let endRatio = startRatio + Math.max(1, opening.width_mm) / Math.max(1, wallLength(next.boundary, wallIndex))
    if (previousOpening && !manuallyChangedWall && boundaryChanged) {
      const previousWallIndex = Math.max(0, Math.min(previous.boundary.length - 1, Math.round(previousOpening.wall_index)))
      const previousWallStart = previous.boundary[previousWallIndex]
      const previousWallEnd = previous.boundary[(previousWallIndex + 1) % previous.boundary.length]
      const previousLine = previousOpening.line ?? openingLine(previous, previousOpening)
      const center = { x_mm: (previousLine.start.x_mm + previousLine.end.x_mm) / 2, z_mm: (previousLine.start.z_mm + previousLine.end.z_mm) / 2 }
      const previousLength = Math.max(1, wallLength(previous.boundary, previousWallIndex))
      const previousStartRatio = Math.max(0, Math.min(1, ((previousLine.start.x_mm - previousWallStart.x_mm) * (previousWallEnd.x_mm - previousWallStart.x_mm) + (previousLine.start.z_mm - previousWallStart.z_mm) * (previousWallEnd.z_mm - previousWallStart.z_mm)) / (previousLength * previousLength)))
      const previousEndRatio = Math.max(previousStartRatio, Math.min(1, ((previousLine.end.x_mm - previousWallStart.x_mm) * (previousWallEnd.x_mm - previousWallStart.x_mm) + (previousLine.end.z_mm - previousWallStart.z_mm) * (previousWallEnd.z_mm - previousWallStart.z_mm)) / (previousLength * previousLength)))
      const candidates = next.boundary.map((start, index) => {
        const end = next.boundary[(index + 1) % next.boundary.length]
        const dx = end.x_mm - start.x_mm, dz = end.z_mm - start.z_mm
        const lengthSq = Math.max(1, dx * dx + dz * dz)
        const ratio = Math.max(0, Math.min(1, ((center.x_mm - start.x_mm) * dx + (center.z_mm - start.z_mm) * dz) / lengthSq))
        const px = start.x_mm + dx * ratio, pz = start.z_mm + dz * ratio
        const distance = Math.hypot(center.x_mm - px, center.z_mm - pz)
        return { index, distance, ratio, length: Math.sqrt(lengthSq) }
      }).sort((left, right) => left.distance - right.distance)
      const candidate = candidates[0]
      if (candidate) {
        wallIndex = candidate.index
        const candidateStart = next.boundary[candidate.index]
        const candidateEnd = next.boundary[(candidate.index + 1) % next.boundary.length]
        const candidateDx = candidateEnd.x_mm - candidateStart.x_mm, candidateDz = candidateEnd.z_mm - candidateStart.z_mm
        const candidateLengthSq = Math.max(1, candidateDx * candidateDx + candidateDz * candidateDz)
        startRatio = Math.max(0, Math.min(1, ((previousLine.start.x_mm - candidateStart.x_mm) * candidateDx + (previousLine.start.z_mm - candidateStart.z_mm) * candidateDz) / candidateLengthSq))
        endRatio = Math.max(startRatio + 0.005, Math.min(1, ((previousLine.end.x_mm - candidateStart.x_mm) * candidateDx + (previousLine.end.z_mm - candidateStart.z_mm) * candidateDz) / candidateLengthSq))
      }
    }
    const start = next.boundary[wallIndex]
    const end = next.boundary[(wallIndex + 1) % next.boundary.length]
    if (!start || !end) continue
    const length = Math.max(1, wallLength(next.boundary, wallIndex))
    const width = Math.max(1, Math.round(opening.width_mm || 1))
    const maxWidthRatio = width / length
    endRatio = Math.max(startRatio + 0.005, Math.min(1, Math.max(endRatio, startRatio + maxWidthRatio)))
    startRatio = Math.max(0, Math.min(1 - (endRatio - startRatio), startRatio))
    opening.wall_index = wallIndex
    opening.offset_mm = Math.round(startRatio * length)
    opening.width_mm = Math.max(1, Math.round((endRatio - startRatio) * length))
    opening.line = {
      start: { x_mm: Math.round(start.x_mm + (end.x_mm - start.x_mm) * startRatio), z_mm: Math.round(start.z_mm + (end.z_mm - start.z_mm) * startRatio) },
      end: { x_mm: Math.round(start.x_mm + (end.x_mm - start.x_mm) * endRatio), z_mm: Math.round(start.z_mm + (end.z_mm - start.z_mm) * endRatio) },
    }
    opening.wall_binding = { wall_index: wallIndex, start_ratio: startRatio, end_ratio: endRatio, wall_start: { ...start }, wall_end: { ...end } }
  }
  return next
}

export function wallThickness(spec: RoomSpec, index: number) {
  return spec.wall_profiles?.find((profile) => profile.wall_index === index)?.thickness_mm ?? spec.wall_thickness_mm
}

export function finishSurfaceOffset(spec: RoomSpec) {
  return spec.finish_surface_offset_mm ?? defaultFinishSurfaceOffsetMm
}

export function stripsExistingFinish(spec: RoomSpec) {
  return spec.strip_existing_finish ?? true
}

export function wallFinishBaseThickness(spec: RoomSpec) {
  return spec.wall_finish_thickness_mm ?? defaultWallFinishThicknessMm
}

export function polygonSignedArea(points: Point2D[]) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + point.x_mm * next.z_mm - next.x_mm * point.z_mm
  }, 0) / 2
}

export function wallOutwardNormal(points: Point2D[], index: number) {
  const start = points[index]
  const end = points[(index + 1) % points.length]
  const dx = end.x_mm - start.x_mm
  const dz = end.z_mm - start.z_mm
  const length = Math.hypot(dx, dz) || 1
  const clockwiseInScreenSpace = polygonSignedArea(points) > 0
  const normal = clockwiseInScreenSpace
    ? { x: dz / length, z: -dx / length }
    : { x: -dz / length, z: dx / length }
  return {
    x: Math.abs(normal.x) < 1e-9 ? 0 : normal.x,
    z: Math.abs(normal.z) < 1e-9 ? 0 : normal.z,
  }
}

export function wallInwardNormal(points: Point2D[], index: number) {
  const normal = wallOutwardNormal(points, index)
  return { x: -normal.x, z: -normal.z }
}

export function wallFinishThickness(spec: RoomSpec, index: number) {
  return spec.wall_finish_profiles?.find((profile) => profile.wall_index === index)?.thickness_mm ?? wallFinishBaseThickness(spec)
}

export function structuralInnerBoundary(spec: RoomSpec) {
  return offsetBoundary(spec.boundary, stripsExistingFinish(spec) ? finishSurfaceOffset(spec) : 0)
}

export function finishedRoomBoundary(spec: RoomSpec) {
  const structural = structuralInnerBoundary(spec)
  return offsetBoundaryByWall(structural, spec.boundary.map((_, index) => -wallFinishThickness(spec, index)))
}

export function fixtureCanBindWall(kind: FixtureKind) {
  return ['floor_drain', 'drain', 'water', 'electric', 'pipe'].includes(kind)
}

export function projectPointToSegment(point: Point2D, start: Point2D, end: Point2D) {
  const dx = end.x_mm - start.x_mm
  const dz = end.z_mm - start.z_mm
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared === 0) return { point: { ...start }, distance_mm: Math.hypot(point.x_mm - start.x_mm, point.z_mm - start.z_mm) }
  const ratio = Math.max(0, Math.min(1, ((point.x_mm - start.x_mm) * dx + (point.z_mm - start.z_mm) * dz) / lengthSquared))
  const projected = { x_mm: Math.round(start.x_mm + ratio * dx), z_mm: Math.round(start.z_mm + ratio * dz) }
  return { point: projected, distance_mm: Math.hypot(point.x_mm - projected.x_mm, point.z_mm - projected.z_mm) }
}

export function nearestWallIndex(points: Point2D[], point: Point2D) {
  if (points.length < 2) return null
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  points.forEach((start, index) => {
    const distance = projectPointToSegment(point, start, points[(index + 1) % points.length]).distance_mm
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index }
  })
  return bestIndex
}

export function projectPointToWall(points: Point2D[], wallIndex: number, point: Point2D) {
  if (wallIndex < 0 || wallIndex >= points.length) return null
  return projectPointToSegment(point, points[wallIndex], points[(wallIndex + 1) % points.length])
}

export function snapPointToNearestWall(points: Point2D[], point: Point2D, maxDistanceMm = wallBindingSnapDistanceMm) {
  const wallIndex = nearestWallIndex(points, point)
  if (wallIndex === null) return null
  const projection = projectPointToWall(points, wallIndex, point)
  if (!projection || projection.distance_mm > maxDistanceMm) return null
  return { wall_index: wallIndex, point: projection.point, distance_mm: projection.distance_mm }
}

export function fixtureBoundWallIndex(spec: RoomSpec, fixture: FixtureSpec) {
  const wallIndex = fixture.bound_wall_index
  if (wallIndex === undefined || wallIndex === null || !fixtureCanBindWall(fixture.kind)) return null
  const projection = projectPointToWall(finishedRoomBoundary(spec), wallIndex, fixture)
  return projection && projection.distance_mm <= 1 ? wallIndex : null
}

export function toiletRotationForWall(points: Point2D[], wallIndex: number) {
  const normal = wallInwardNormal(points, wallIndex)
  const degrees = Math.round(Math.atan2(normal.x, normal.z) * 180 / Math.PI)
  if (Object.is(degrees, -0)) return 0
  return degrees === -180 ? 180 : degrees
}

export function toiletPlacementFromDrain(spec: RoomSpec, drain: FixtureSpec) {
  const roomBoundary = finishedRoomBoundary(spec)
  const wallIndex = drain.bound_wall_index ?? nearestWallIndex(roomBoundary, drain)
  const defaults = fixtureDefaults.toilet
  if (wallIndex === null) return {
    x_mm: drain.x_mm,
    z_mm: drain.z_mm,
    rotation_deg: drain.rotation_deg,
    bound_wall_index: null,
  }
  const projection = projectPointToWall(roomBoundary, wallIndex, drain)
  const wallDistance = projection?.distance_mm ?? 0
  const inward = wallInwardNormal(roomBoundary, wallIndex)
  const offsetMm = Math.max(0, defaults.depth_mm / 2 - toiletDrainRoughInMm - wallDistance)
  return {
    x_mm: Math.round(drain.x_mm + inward.x * offsetMm),
    z_mm: Math.round(drain.z_mm + inward.z * offsetMm),
    rotation_deg: toiletRotationForWall(roomBoundary, wallIndex),
    bound_wall_index: wallIndex,
  }
}

export function syncToiletWithDrain(spec: RoomSpec, drainId: string, toiletId = `toilet-for-${drainId}`) {
  const drain = spec.fixtures.find((fixture) => fixture.id === drainId)
  if (!drain || drain.kind !== 'drain' || fixturePointUsage(drain) !== 'toilet') return null
  const placement = toiletPlacementFromDrain(spec, drain)
  const linkedEvidenceId = `toilet-drain:${drain.id}`
  let toilet = spec.fixtures.find((fixture) => fixture.kind === 'toilet' && fixture.evidence_ids?.includes(linkedEvidenceId))
    ?? spec.fixtures.find((fixture) => fixture.id === toiletId)
  if (!toilet) {
    toilet = {
      id: toiletId,
      kind: 'toilet',
      label: fixtureLabels.toilet,
      x_mm: placement.x_mm,
      z_mm: placement.z_mm,
      ...fixtureDefaults.toilet,
      rotation_deg: placement.rotation_deg,
      source: 'derived',
      confidence: Math.min(0.92, drain.confidence),
      evidence_ids: [linkedEvidenceId],
    }
    spec.fixtures.push(toilet)
  } else {
    toilet.x_mm = placement.x_mm
    toilet.z_mm = placement.z_mm
    toilet.rotation_deg = placement.rotation_deg
    toilet.source = drain.source === 'user' ? 'derived' : drain.source
    toilet.confidence = Math.min(0.92, Math.max(0.6, drain.confidence))
    toilet.evidence_ids = [...new Set([...(toilet.evidence_ids ?? []), linkedEvidenceId])]
  }
  return toilet.id
}

function coordinateBounds(spec: RoomSpec) {
  const imageBoundary = spec.plan_annotation?.boundary ?? []
  if (!imageBoundary.length || !spec.boundary.length) return null
  return {
    imageMinX: Math.min(...imageBoundary.map((point) => point.x)), imageMaxX: Math.max(...imageBoundary.map((point) => point.x)),
    imageMinY: Math.min(...imageBoundary.map((point) => point.y)), imageMaxY: Math.max(...imageBoundary.map((point) => point.y)),
    roomMinX: Math.min(...spec.boundary.map((point) => point.x_mm)), roomMaxX: Math.max(...spec.boundary.map((point) => point.x_mm)),
    roomMinZ: Math.min(...spec.boundary.map((point) => point.z_mm)), roomMaxZ: Math.max(...spec.boundary.map((point) => point.z_mm)),
  }
}

export function imagePointToRoom(spec: RoomSpec, x: number, y: number): Point2D {
  const bounds = coordinateBounds(spec)
  if (!bounds) return { x_mm: 0, z_mm: 0 }
  return {
    x_mm: Math.round(bounds.roomMinX + (x - bounds.imageMinX) * (bounds.roomMaxX - bounds.roomMinX) / Math.max(1, bounds.imageMaxX - bounds.imageMinX)),
    z_mm: Math.round(bounds.roomMinZ + (y - bounds.imageMinY) * (bounds.roomMaxZ - bounds.roomMinZ) / Math.max(1, bounds.imageMaxY - bounds.imageMinY)),
  }
}

export function roomPointToImage(spec: RoomSpec, point: Point2D) {
  const bounds = coordinateBounds(spec)
  if (!bounds) return null
  return {
    x: Math.round(bounds.imageMinX + (point.x_mm - bounds.roomMinX) * (bounds.imageMaxX - bounds.imageMinX) / Math.max(1, bounds.roomMaxX - bounds.roomMinX)),
    y: Math.round(bounds.imageMinY + (point.z_mm - bounds.roomMinZ) * (bounds.imageMaxY - bounds.imageMinY) / Math.max(1, bounds.roomMaxZ - bounds.roomMinZ)),
  }
}

function rectZone(id: string, kind: DryWetZone['kind'], label: string, minX: number, minZ: number, maxX: number, maxZ: number): DryWetZone {
  return { id, kind, label, source: 'derived', confidence: 0.86, boundary: [
    { x_mm: Math.round(minX), z_mm: Math.round(minZ) }, { x_mm: Math.round(maxX), z_mm: Math.round(minZ) },
    { x_mm: Math.round(maxX), z_mm: Math.round(maxZ) }, { x_mm: Math.round(minX), z_mm: Math.round(maxZ) },
  ] }
}

type ZoneRect = { kind: DryWetZone['kind']; minX: number; minZ: number; maxX: number; maxZ: number }

function fittedRange(minimum: number, maximum: number, roomMinimum: number, roomMaximum: number, minimumSize: number) {
  const available = roomMaximum - roomMinimum
  const size = Math.min(available, Math.max(maximum - minimum, minimumSize))
  const center = (minimum + maximum) / 2
  let start = center - size / 2
  start = Math.max(roomMinimum, Math.min(roomMaximum - size, start))
  return { minimum: start, maximum: start + size }
}

function pointInPolygon(points: Point2D[], point: Point2D) {
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const current = points[index]
    const before = points[previous]
    const crosses = (current.z_mm > point.z_mm) !== (before.z_mm > point.z_mm)
      && point.x_mm < (before.x_mm - current.x_mm) * (point.z_mm - current.z_mm) / (before.z_mm - current.z_mm) + current.x_mm
    if (crosses) inside = !inside
  }
  return inside
}

function mergeZoneCells(rows: ZoneRect[][]) {
  const merged: ZoneRect[] = []
  let active = new Map<string, ZoneRect>()
  for (const row of rows) {
    const next = new Map<string, ZoneRect>()
    for (const run of row) {
      const key = `${run.kind}:${run.minX}:${run.maxX}`
      const previous = active.get(key)
      if (previous && previous.maxZ === run.minZ) {
        previous.maxZ = run.maxZ
        next.set(key, previous)
      } else {
        next.set(key, { ...run })
      }
    }
    for (const [key, rectangle] of active) if (!next.has(key)) merged.push(rectangle)
    active = next
  }
  merged.push(...active.values())
  return merged
}

export function generateDryWetZones(spec: RoomSpec): DryWetZone[] {
  const roomBoundary = finishedRoomBoundary(spec)
  const bounds = roomBounds(roomBoundary)
  const showerDrain = spec.fixtures.find((fixture) => fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'shower')
  if (!showerDrain) return []
  const x = fittedRange(showerDrain.x_mm - 320, showerDrain.x_mm + 320, bounds.minX, bounds.maxX, 900)
  const z = fittedRange(showerDrain.z_mm - 320, showerDrain.z_mm + 320, bounds.minZ, bounds.maxZ, 900)
  const wetRects: ZoneRect[] = [{ kind: 'wet', minX: Math.round(x.minimum), minZ: Math.round(z.minimum), maxX: Math.round(x.maximum), maxZ: Math.round(z.maximum) }]
  const xStops = [...new Set([...roomBoundary.map((point) => point.x_mm), ...wetRects.flatMap((rectangle) => [rectangle.minX, rectangle.maxX])])].sort((left, right) => left - right)
  const zStops = [...new Set([...roomBoundary.map((point) => point.z_mm), ...wetRects.flatMap((rectangle) => [rectangle.minZ, rectangle.maxZ])])].sort((left, right) => left - right)
  const rows: ZoneRect[][] = []
  for (let zIndex = 0; zIndex < zStops.length - 1; zIndex += 1) {
    const row: ZoneRect[] = []
    let current: ZoneRect | null = null
    for (let xIndex = 0; xIndex < xStops.length - 1; xIndex += 1) {
      const minX = xStops[xIndex], maxX = xStops[xIndex + 1], minZ = zStops[zIndex], maxZ = zStops[zIndex + 1]
      const middle = { x_mm: (minX + maxX) / 2, z_mm: (minZ + maxZ) / 2 }
      if (!pointInPolygon(roomBoundary, middle)) { if (current) row.push(current); current = null; continue }
      const kind: DryWetZone['kind'] = wetRects.some((rectangle) => middle.x_mm >= rectangle.minX && middle.x_mm <= rectangle.maxX && middle.z_mm >= rectangle.minZ && middle.z_mm <= rectangle.maxZ) ? 'wet' : 'dry'
      const active = current as ZoneRect | null
      if (active && active.kind === kind && active.maxX === minX) active.maxX = maxX
      else { if (current) row.push(current); current = { kind, minX, minZ, maxX, maxZ } }
    }
    if (current) row.push(current)
    rows.push(row)
  }
  const rectangles = mergeZoneCells(rows).filter((rectangle) => rectangle.kind === 'wet' && (rectangle.maxX - rectangle.minX) * (rectangle.maxZ - rectangle.minZ) >= 10_000)
  const rectangle = rectangles.find((candidate) => showerDrain.x_mm >= candidate.minX && showerDrain.x_mm <= candidate.maxX && showerDrain.z_mm >= candidate.minZ && showerDrain.z_mm <= candidate.maxZ)
    ?? rectangles.sort((left, right) => (right.maxX - right.minX) * (right.maxZ - right.minZ) - (left.maxX - left.minX) * (left.maxZ - left.minZ))[0]
  return rectangle ? [rectZone('wet-auto-1', 'wet', '湿区', rectangle.minX, rectangle.minZ, rectangle.maxX, rectangle.maxZ)] : []
}

export function generateWallFinishProfiles(spec: RoomSpec): WallFinishProfile[] {
  return spec.boundary.map((_, wallIndex) => ({
    wall_index: wallIndex,
    thickness_mm: wallFinishBaseThickness(spec),
    source: 'derived',
    confidence: 0.9,
    generated_from_bound_point: false,
  }))
}

type OffsetLine = { start: Point2D; end: Point2D }

function offsetLine(points: Point2D[], index: number, distanceMm: number): OffsetLine {
  const start = points[index]
  const end = points[(index + 1) % points.length]
  const normal = wallOutwardNormal(points, index)
  return {
    start: { x_mm: start.x_mm + normal.x * distanceMm, z_mm: start.z_mm + normal.z * distanceMm },
    end: { x_mm: end.x_mm + normal.x * distanceMm, z_mm: end.z_mm + normal.z * distanceMm },
  }
}

function intersectLines(first: OffsetLine, second: OffsetLine): Point2D | null {
  const x1 = first.start.x_mm
  const z1 = first.start.z_mm
  const x2 = first.end.x_mm
  const z2 = first.end.z_mm
  const x3 = second.start.x_mm
  const z3 = second.start.z_mm
  const x4 = second.end.x_mm
  const z4 = second.end.z_mm
  const denominator = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4)
  if (Math.abs(denominator) < 1e-9) return null
  const firstCross = x1 * z2 - z1 * x2
  const secondCross = x3 * z4 - z3 * x4
  return {
    x_mm: (firstCross * (x3 - x4) - (x1 - x2) * secondCross) / denominator,
    z_mm: (firstCross * (z3 - z4) - (z1 - z2) * secondCross) / denominator,
  }
}

export function offsetBoundaryByWall(points: Point2D[], distanceMm: number[]): Point2D[] {
  if (points.length < 3 || distanceMm.every((distance) => distance === 0)) return points.map((point) => ({ ...point }))
  return points.map((point, index) => {
    const previousIndex = (index - 1 + points.length) % points.length
    const previousLine = offsetLine(points, previousIndex, distanceMm[previousIndex] ?? 0)
    const currentLine = offsetLine(points, index, distanceMm[index] ?? 0)
    const intersection = intersectLines(previousLine, currentLine)
    if (intersection) return {
      x_mm: Math.round(intersection.x_mm * 1000) / 1000,
      z_mm: Math.round(intersection.z_mm * 1000) / 1000,
    }
    const normal = wallOutwardNormal(points, index)
    const distance = distanceMm[index] ?? 0
    return { x_mm: point.x_mm + normal.x * distance, z_mm: point.z_mm + normal.z * distance }
  })
}

export function offsetBoundary(points: Point2D[], distanceMm: number): Point2D[] {
  return offsetBoundaryByWall(points, points.map(() => distanceMm))
}

export function wallLayerPolygons(spec: RoomSpec) {
  const structuralInner = structuralInnerBoundary(spec)
  const finishedInner = finishedRoomBoundary(spec)
  const structuralOuter = offsetBoundaryByWall(structuralInner, spec.boundary.map((_, index) => wallThickness(spec, index)))
  return spec.boundary.map((_, index) => {
    const next = (index + 1) % spec.boundary.length
    return {
      finish: [finishedInner[index], finishedInner[next], structuralInner[next], structuralInner[index]],
      wall: [structuralInner[index], structuralInner[next], structuralOuter[next], structuralOuter[index]],
    }
  })
}

export function sliceWallQuadByDistance(quad: Point2D[], referenceStart: Point2D, referenceEnd: Point2D, startMm: number, endMm: number) {
  if (quad.length !== 4) return quad.map((point) => ({ ...point }))
  const dx = referenceEnd.x_mm - referenceStart.x_mm
  const dz = referenceEnd.z_mm - referenceStart.z_mm
  const length = Math.hypot(dx, dz)
  if (length <= 1e-9) return quad.map((point) => ({ ...point }))
  const tangent = { x: dx / length, z: dz / length }
  const pointAtDistance = (edgeStart: Point2D, edgeEnd: Point2D, distanceMm: number) => {
    if (distanceMm <= 0) return { ...edgeStart }
    if (distanceMm >= length) return { ...edgeEnd }
    const edgeStartDistance = (edgeStart.x_mm - referenceStart.x_mm) * tangent.x + (edgeStart.z_mm - referenceStart.z_mm) * tangent.z
    const advance = distanceMm - edgeStartDistance
    return {
      x_mm: edgeStart.x_mm + tangent.x * advance,
      z_mm: edgeStart.z_mm + tangent.z * advance,
    }
  }
  return [
    pointAtDistance(quad[0], quad[1], startMm),
    pointAtDistance(quad[0], quad[1], endMm),
    pointAtDistance(quad[3], quad[2], endMm),
    pointAtDistance(quad[3], quad[2], startMm),
  ]
}

export function cloneSpec(spec: RoomSpec): RoomSpec {
  const clone = structuredClone(spec)
  if (clone.dry_wet_zones) clone.dry_wet_zones = clone.dry_wet_zones.filter((zone) => zone.kind === 'wet')
  return clone
}

function orientation(a: Point2D, b: Point2D, c: Point2D) {
  const value = (b.z_mm - a.z_mm) * (c.x_mm - b.x_mm) - (b.x_mm - a.x_mm) * (c.z_mm - b.z_mm)
  return value === 0 ? 0 : value > 0 ? 1 : 2
}

function pointOnSegment(a: Point2D, b: Point2D, point: Point2D) {
  return point.x_mm >= Math.min(a.x_mm, b.x_mm) && point.x_mm <= Math.max(a.x_mm, b.x_mm)
    && point.z_mm >= Math.min(a.z_mm, b.z_mm) && point.z_mm <= Math.max(a.z_mm, b.z_mm)
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D) {
  const first = orientation(a, b, c)
  const second = orientation(a, b, d)
  const third = orientation(c, d, a)
  const fourth = orientation(c, d, b)
  if (first !== second && third !== fourth) return true
  return (first === 0 && pointOnSegment(a, b, c))
    || (second === 0 && pointOnSegment(a, b, d))
    || (third === 0 && pointOnSegment(c, d, a))
    || (fourth === 0 && pointOnSegment(c, d, b))
}

function hasSelfIntersection(points: Point2D[]) {
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === points.length - 1)) continue
      if (segmentsIntersect(
        points[first], points[(first + 1) % points.length],
        points[second], points[(second + 1) % points.length],
      )) return true
    }
  }
  return false
}

function pointOnPolygonBoundary(points: Point2D[], point: Point2D) {
  return points.some((start, index) => orientation(start, points[(index + 1) % points.length], point) === 0 && pointOnSegment(start, points[(index + 1) % points.length], point))
}

function pointStrictlyInsidePolygon(points: Point2D[], point: Point2D) {
  return !pointOnPolygonBoundary(points, point) && pointInPolygon(points, point)
}

function segmentsProperlyIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D) {
  const first = orientation(a, b, c), second = orientation(a, b, d), third = orientation(c, d, a), fourth = orientation(c, d, b)
  return first !== 0 && second !== 0 && third !== 0 && fourth !== 0 && first !== second && third !== fourth
}

function polygonsOverlap(left: Point2D[], right: Point2D[]) {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (segmentsProperlyIntersect(left[leftIndex], left[(leftIndex + 1) % left.length], right[rightIndex], right[(rightIndex + 1) % right.length])) return true
    }
  }
  const samples = (points: Point2D[]) => points.flatMap((point, index) => {
    const next = points[(index + 1) % points.length]
    return [point, { x_mm: (point.x_mm + next.x_mm) / 2, z_mm: (point.z_mm + next.z_mm) / 2 }]
  })
  if (samples(left).some((point) => pointStrictlyInsidePolygon(right, point)) || samples(right).some((point) => pointStrictlyInsidePolygon(left, point))) return true
  const leftCenter = { x_mm: left.reduce((sum, point) => sum + point.x_mm, 0) / left.length, z_mm: left.reduce((sum, point) => sum + point.z_mm, 0) / left.length }
  const rightCenter = { x_mm: right.reduce((sum, point) => sum + point.x_mm, 0) / right.length, z_mm: right.reduce((sum, point) => sum + point.z_mm, 0) / right.length }
  return pointStrictlyInsidePolygon(right, leftCenter) || pointStrictlyInsidePolygon(left, rightCenter)
}

export function wetZoneBoundaryValid(spec: RoomSpec, zoneId: string, boundary: Point2D[]) {
  if (boundary.length < 3 || hasSelfIntersection(boundary)) return false
  const roomBoundary = finishedRoomBoundary(spec)
  const samples = boundary.flatMap((start, index) => {
    const end = boundary[(index + 1) % boundary.length]
    return [start, ...[0.25, 0.5, 0.75].map((ratio) => ({ x_mm: start.x_mm + (end.x_mm - start.x_mm) * ratio, z_mm: start.z_mm + (end.z_mm - start.z_mm) * ratio }))]
  })
  if (samples.some((point) => !pointOnPolygonBoundary(roomBoundary, point) && !pointInPolygon(roomBoundary, point))) return false
  return !(spec.dry_wet_zones ?? []).some((zone) => zone.id !== zoneId && zone.kind === 'wet' && polygonsOverlap(boundary, zone.boundary))
}

export function clientValidate(spec: RoomSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const wetZones = (spec.dry_wet_zones ?? []).filter((zone) => zone.kind === 'wet')
  if (wetZones.length > 1) issues.push({ id: 'wet-zone-count', severity: 'error', code: 'multiple_wet_zones', message: '同一房间只能保留一个湿区' })
  const showerFloorDrains = spec.fixtures.filter((fixture) => fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'shower')
  if (showerFloorDrains.length > 1) issues.push({ id: 'shower-floor-drain-count', severity: 'error', code: 'multiple_shower_floor_drains', message: '同一房间只能指定一个淋浴地漏' })
  if (spec.boundary.length < 3) issues.push({ id: 'boundary', severity: 'error', code: 'invalid_boundary', message: '房间轮廓未闭合' })
  spec.boundary.forEach((start, index) => {
    const end = spec.boundary[(index + 1) % spec.boundary.length]
    const deltaX = end.x_mm - start.x_mm
    const deltaZ = end.z_mm - start.z_mm
    if (deltaX === 0 && deltaZ === 0) issues.push({ id: `boundary-zero-${index}`, severity: 'error', code: 'zero_length_boundary', message: `W${index + 1} 是零长度线段，请合并重复端点`, target_id: `wall:${index}` })
    else if (deltaX !== 0 && deltaZ !== 0) issues.push({ id: `boundary-orthogonal-${index}`, severity: 'error', code: 'non_orthogonal_boundary', message: `W${index + 1} 不是水平或垂直线段，禁止进入建模`, target_id: `wall:${index}` })
  })
  if (spec.boundary.length >= 3 && hasSelfIntersection(spec.boundary)) issues.push({ id: 'boundary-cross', severity: 'error', code: 'self_intersection', message: '房间轮廓存在自相交' })
  if (!spec.height_mm || spec.height_mm < 1000) issues.push({ id: 'height', severity: 'error', code: 'missing_height', message: '缺少有效净高' })
  for (const opening of spec.openings) {
    if (opening.wall_index >= spec.boundary.length) {
      issues.push({ id: `opening-wall-${opening.id}`, severity: 'error', code: 'opening_wall', message: `${opening.label} 未关联到有效墙面`, target_id: opening.id })
      continue
    }
    if (opening.offset_mm + opening.width_mm > wallLength(spec.boundary, opening.wall_index) + 1) {
      issues.push({ id: `opening-range-${opening.id}`, severity: 'error', code: 'opening_outside', message: `${opening.label} 超出所属墙面`, target_id: opening.id })
    }
  }
  for (const fixture of spec.fixtures) {
    if (fixture.confidence < 0.6 && fixture.source !== 'user') issues.push({ id: `confidence-${fixture.id}`, severity: 'warning', code: 'low_confidence', message: `${fixture.label} 为低置信度识别结果`, target_id: fixture.id })
    if (fixture.bound_wall_index !== undefined && fixture.bound_wall_index !== null) {
      if (!fixtureCanBindWall(fixture.kind)) issues.push({ id: `fixture-bind-kind-${fixture.id}`, severity: 'warning', code: 'fixture_bind_kind', message: `${fixture.label} 不属于可绑定墙段的点位`, target_id: fixture.id })
      if (fixture.bound_wall_index < 0 || fixture.bound_wall_index >= spec.boundary.length) issues.push({ id: `fixture-bind-wall-${fixture.id}`, severity: 'error', code: 'fixture_wall_binding', message: `${fixture.label} 绑定墙段无效`, target_id: fixture.id })
      else if (fixtureCanBindWall(fixture.kind) && fixtureBoundWallIndex(spec, fixture) === null) issues.push({ id: `fixture-bind-snap-${fixture.id}`, severity: 'warning', code: 'fixture_wall_not_snapped', message: `${fixture.label} 未落在 W${fixture.bound_wall_index + 1} 上，按未绑定处理`, target_id: fixture.id })
    }
  }
  spec.fixtures.forEach((left, index) => {
    if (['floor_drain', 'drain', 'water', 'electric', 'pipe'].includes(left.kind)) return
    spec.fixtures.slice(index + 1).forEach((right) => {
      if (['floor_drain', 'drain', 'water', 'electric', 'pipe'].includes(right.kind)) return
      const overlapsX = Math.abs(left.x_mm - right.x_mm) * 2 < left.width_mm + right.width_mm
      const overlapsZ = Math.abs(left.z_mm - right.z_mm) * 2 < left.depth_mm + right.depth_mm
      if (overlapsX && overlapsZ) issues.push({ id: `collision-${left.id}-${right.id}`, severity: 'warning', code: 'fixture_collision', message: `${left.label} 与 ${right.label} 的占地范围重叠`, target_id: left.id })
    })
  })
  for (const finish of spec.wall_finish_profiles ?? []) {
    if (finish.wall_index < 0 || finish.wall_index >= spec.boundary.length) issues.push({ id: `finish-wall-${finish.wall_index}`, severity: 'error', code: 'finish_wall', message: `饰面 W${finish.wall_index + 1} 未关联到有效墙段`, target_id: `wall:${finish.wall_index}` })
    if (finish.thickness_mm < 0) issues.push({ id: `finish-thickness-${finish.wall_index}`, severity: 'error', code: 'finish_thickness', message: `饰面 W${finish.wall_index + 1} 厚度无效`, target_id: `wall:${finish.wall_index}` })
  }
  for (const zone of spec.dry_wet_zones ?? []) {
    if (zone.kind === 'wet' && !wetZoneBoundaryValid(spec, zone.id, zone.boundary)) issues.push({ id: `wet-zone-${zone.id}`, severity: 'error', code: 'wet_zone_geometry', message: `${zone.label} 越出房间、自交或与其他湿区重叠`, target_id: zone.id })
  }
  return issues
}
