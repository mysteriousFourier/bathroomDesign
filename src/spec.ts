import type { FixtureKind, FixtureSpec, Point2D, RoomSpec, ValidationIssue } from './types'

export const fixtureLabels: Record<FixtureKind, string> = {
  toilet: '马桶',
  vanity: '台盆 / 浴室柜',
  shower: '淋浴区',
  floor_drain: '地漏',
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

export function clientValidate(spec: RoomSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (spec.boundary.length < 3) issues.push({ id: 'boundary', severity: 'error', code: 'invalid_boundary', message: '房间轮廓未闭合' })
  if (!spec.height_mm || spec.height_mm < 1000) issues.push({ id: 'height', severity: 'error', code: 'missing_height', message: '缺少有效层高' })
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
    if (left.kind === 'floor_drain' || left.kind === 'pipe') return
    spec.fixtures.slice(index + 1).forEach((right) => {
      if (right.kind === 'floor_drain' || right.kind === 'pipe') return
      const overlapsX = Math.abs(left.x_mm - right.x_mm) * 2 < left.width_mm + right.width_mm
      const overlapsZ = Math.abs(left.z_mm - right.z_mm) * 2 < left.depth_mm + right.depth_mm
      if (overlapsX && overlapsZ) issues.push({ id: `collision-${left.id}-${right.id}`, severity: 'warning', code: 'fixture_collision', message: `${left.label} 与 ${right.label} 的占地范围重叠`, target_id: left.id })
    })
  })
  return issues
}
