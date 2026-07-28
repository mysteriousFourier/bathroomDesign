import type { BoundaryEdge, ImageBoundaryPoint, Point2D } from './types'

export const closureMinimumToleranceMm = 20
export const closureMaximumToleranceMm = 100

function closureTolerance(edges: BoundaryEdge[], signs: Record<string, number>) {
  const positive = edges.filter((edge) => signs[edge.direction] > 0).reduce((sum, edge) => sum + (edge.length_mm ?? 0), 0)
  const negative = edges.filter((edge) => signs[edge.direction] < 0).reduce((sum, edge) => sum + (edge.length_mm ?? 0), 0)
  return Math.max(closureMinimumToleranceMm, Math.min(closureMaximumToleranceMm, Math.round(Math.max(positive, negative) * 0.015)))
}

export interface MetricBoundaryResult {
  boundary: Point2D[]
  edges: BoundaryEdge[]
}

function imageSegmentKey(start: ImageBoundaryPoint, end: ImageBoundaryPoint) {
  return `${start.x},${start.y}->${end.x},${end.y}`
}

function imageEdgeDirection(start: ImageBoundaryPoint, end: ImageBoundaryPoint): BoundaryEdge['direction'] {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'down' : 'up'
}

export function reconcileBoundaryEdges(
  points: ImageBoundaryPoint[],
  previousPoints: ImageBoundaryPoint[] = [],
  previousEdges: BoundaryEdge[] = [],
): BoundaryEdge[] {
  const previousBySegment = new Map<string, BoundaryEdge>()
  if (previousPoints.length === previousEdges.length) {
    previousPoints.forEach((start, index) => {
      const end = previousPoints[(index + 1) % previousPoints.length]
      previousBySegment.set(imageSegmentKey(start, end), previousEdges[index])
    })
  }

  return points.map((start, index) => {
    const end = points[(index + 1) % points.length]
    const direction = imageEdgeDirection(start, end)
    const existing = previousBySegment.get(imageSegmentKey(start, end))
    return existing?.direction === direction
      ? { ...existing, evidence_ids: [...existing.evidence_ids] }
      : { direction, length_mm: null, role: 'wall', evidence_ids: [], confidence: 0.5 }
  })
}

export function solveBoundaryEdges(input: BoundaryEdge[]): BoundaryEdge[] | null {
  if (input.length < 3) return null
  const edges = input.map((edge) => ({
    ...edge,
    evidence_ids: [...edge.evidence_ids],
  }))
  const axes: Array<Record<string, number>> = [
    { right: 1, left: -1 },
    { down: 1, up: -1 },
  ]

  for (const signs of axes) {
    const relevant = edges
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => signs[edge.direction] !== undefined)
    const unknown = relevant.filter(({ edge }) => edge.length_mm === null)
    const balance = relevant.reduce(
      (sum, { edge }) => sum + signs[edge.direction] * (edge.length_mm ?? 0),
      0,
    )
    if (unknown.length > 1) return null
    if (unknown.length === 1) {
      const { edge } = unknown[0]
      const solved = -balance * signs[edge.direction]
      if (solved <= 0) return null
      edge.length_mm = solved
      edge.measured_length_mm = null
      edge.closure_adjustment_mm = 0
      edge.source = 'derived'
      continue
    }
    if (balance === 0) continue
    if (Math.abs(balance) > closureTolerance(relevant.map(({ edge }) => edge), signs)) return null

    let candidates = relevant
      .map(({ edge, index }) => ({
        edge,
        index,
        adjustment: -balance * signs[edge.direction],
      }))
      .filter(({ edge, adjustment }) => (edge.length_mm ?? 0) + adjustment > 0)
    const wallCandidates = candidates.filter(({ edge }) => edge.role === 'wall')
    if (wallCandidates.length) candidates = wallCandidates
    candidates.sort((a, b) => (
      a.edge.confidence - b.edge.confidence
      || Number(Boolean(a.edge.evidence_ids.length)) - Number(Boolean(b.edge.evidence_ids.length))
      || b.index - a.index
    ))
    const selected = candidates[0]
    if (!selected) return null
    selected.edge.measured_length_mm ??= selected.edge.length_mm
    selected.edge.length_mm = (selected.edge.length_mm ?? 0) + selected.adjustment
    selected.edge.closure_adjustment_mm = (selected.edge.closure_adjustment_mm ?? 0) + selected.adjustment
    selected.edge.source = 'derived'
  }
  return edges
}

export function metricBoundaryFromEdges(input: BoundaryEdge[]): MetricBoundaryResult | null {
  const edges = solveBoundaryEdges(input)
  if (!edges || edges.some((edge) => !edge.length_mm)) return null
  const points: Point2D[] = [{ x_mm: 0, z_mm: 0 }]
  let x = 0
  let z = 0
  for (const edge of edges) {
    const length = edge.length_mm!
    if (edge.direction === 'right') x += length
    else if (edge.direction === 'left') x -= length
    else if (edge.direction === 'down') z += length
    else z -= length
    points.push({ x_mm: x, z_mm: z })
  }
  if (x !== 0 || z !== 0) return null
  points.pop()
  const minX = Math.min(...points.map((point) => point.x_mm))
  const minZ = Math.min(...points.map((point) => point.z_mm))
  return {
    boundary: points.map((point) => ({ x_mm: point.x_mm - minX, z_mm: point.z_mm - minZ })),
    edges,
  }
}
