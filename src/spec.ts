import type { FixtureKind, FixtureSpec, Point2D, RoomSpec, ValidationIssue } from './types'

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
    wall_thickness_mm: 100,
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

export function cloneSpec(spec: RoomSpec): RoomSpec {
  return structuredClone(spec)
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
  return issues
}
