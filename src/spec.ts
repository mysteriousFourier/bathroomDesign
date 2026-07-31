import type { DryWetZone, FixtureKind, FixtureSpec, Point2D, RoomSpec, ValidationIssue, WallFinishProfile } from './types'

export const defaultWallThicknessMm = 200
export const defaultFinishSurfaceOffsetMm = 20
export const defaultWallFinishThicknessMm = 20
export const wallBindingSnapDistanceMm = 100

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

export function wallLength(points: Point2D[], index: number) {
  const start = points[index]
  const end = points[(index + 1) % points.length]
  return Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm)
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
  const drains = spec.fixtures.filter((fixture) => fixture.kind === 'floor_drain' || fixture.kind === 'drain')
  if (!drains.length) return []
  const parents = drains.map((_, index) => index)
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]))
  const join = (left: number, right: number) => { const leftRoot = find(left), rightRoot = find(right); if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot }
  drains.forEach((left, index) => drains.slice(index + 1).forEach((right, offset) => {
    if (Math.hypot(left.x_mm - right.x_mm, left.z_mm - right.z_mm) <= 1200) join(index, index + offset + 1)
  }))
  const clusters = new Map<number, FixtureSpec[]>()
  drains.forEach((drain, index) => { const root = find(index); clusters.set(root, [...(clusters.get(root) ?? []), drain]) })
  const wetRects = [...clusters.values()].map((cluster): ZoneRect => {
    const x = fittedRange(Math.min(...cluster.map((fixture) => fixture.x_mm)) - 320, Math.max(...cluster.map((fixture) => fixture.x_mm)) + 320, bounds.minX, bounds.maxX, 900)
    const z = fittedRange(Math.min(...cluster.map((fixture) => fixture.z_mm)) - 320, Math.max(...cluster.map((fixture) => fixture.z_mm)) + 320, bounds.minZ, bounds.maxZ, 900)
    return { kind: 'wet', minX: Math.round(x.minimum), minZ: Math.round(z.minimum), maxX: Math.round(x.maximum), maxZ: Math.round(z.maximum) }
  })
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
  return rectangles.map((rectangle) => {
    const index = rectangles.indexOf(rectangle) + 1
    return rectZone(`wet-auto-${index}`, 'wet', rectangles.length > 1 ? `湿区 ${index}` : '湿区', rectangle.minX, rectangle.minZ, rectangle.maxX, rectangle.maxZ)
  })
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
