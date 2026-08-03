import type { Observation, RoomSpec } from './types'

export function observationId(observation: Observation) {
  return observation.field.startsWith('ocr:') ? observation.field.slice(4) : observation.field
}

function compact(value: string) {
  return value.toUpperCase().replace(/[^0-9A-Z\u4E00-\u9FFF]+/g, '')
}

function bboxIoU(left: NonNullable<Observation['bbox']>, right: NonNullable<Observation['bbox']>) {
  const width = Math.max(0, Math.min(left.x_max, right.x_max) - Math.max(left.x_min, right.x_min))
  const height = Math.max(0, Math.min(left.y_max, right.y_max) - Math.max(left.y_min, right.y_min))
  const intersection = width * height
  const union = (left.x_max - left.x_min) * (left.y_max - left.y_min)
    + (right.x_max - right.x_min) * (right.y_max - right.y_min) - intersection
  return union > 0 ? intersection / union : 0
}

function codedOpeningRow(value: string) {
  const code = value.match(/\b([DW]\d+)\b/i)?.[1].toUpperCase() ?? null
  const field = (name: 'CG' | 'CK' | 'CH') => {
    const match = value.match(new RegExp(`\\b${name}\\s*[:：=]?\\s*(\\d+)`, 'i'))
    return match ? Number(match[1]) : null
  }
  const sill = field('CG'), width = field('CK'), height = field('CH')
  return sill === null || width === null || height === null ? null : { code, sill, width, height }
}

function openingAlreadyApplied(spec: RoomSpec, observation: Observation) {
  const row = codedOpeningRow(observation.value)
  if (!row) return false
  const id = observationId(observation)
  return spec.openings.some((opening) => (
    (opening.evidence_ids?.includes(id) || !row.code || opening.label.toUpperCase() === row.code)
    && opening.sill_mm === row.sill
    && opening.width_mm === row.width
    && opening.height_mm === row.height
  ))
}

function isActionable(spec: RoomSpec, observation: Observation, edgeEvidenceIds: Set<string>) {
  if (!observation.field.startsWith('ocr:') || !observation.bbox || observation.confirmed || !observation.review_required) return false
  const role = observation.semantic_role ?? 'other'
  const value = compact(observation.value)
  if (role === 'other') return false
  if (role === 'wall_segment' || role === 'room_dimension' || role === 'wall_thickness') {
    return edgeEvidenceIds.has(observationId(observation))
  }
  if (role === 'door_size') return codedOpeningRow(observation.value) !== null && !openingAlreadyApplied(spec, observation)
  if (role === 'room_height') return /净高|层高|室内高/.test(observation.value)
  if (role === 'ceiling_height') return observation.value.includes('吊顶') && !observation.value.includes('整屋')
  if (role === 'drain_position') return /地漏|排水|下水|排污/.test(observation.value)
  if (role === 'fixture_dimension' || role === 'fixture_label') return false
  return Boolean(observation.target_id)
}

function preference(observation: Observation) {
  const value = compact(observation.value)
  return (observation.target_id ? 20 : 0)
    + (value.includes('CG') && value.includes('CK') && value.includes('CH') ? 10 : 0)
    + observation.confidence * 5
    + (observation.field.startsWith('ocr:TV') ? 1 : 0)
}

export function reviewEvidence(spec: RoomSpec, assetId?: string) {
  const edgeEvidenceIds = new Set(
    (spec.plan_annotation?.edge_chain ?? []).flatMap((edge) => edge.evidence_ids),
  )
  const candidates = spec.observations
    .filter((observation) => (!assetId || observation.asset_id === assetId) && isActionable(spec, observation, edgeEvidenceIds))
    .sort((left, right) => preference(right) - preference(left))
  const selected: Observation[] = []
  for (const candidate of candidates) {
    const duplicate = selected.some((existing) => (
      existing.semantic_role === candidate.semantic_role
      && existing.bbox && candidate.bbox
      && bboxIoU(existing.bbox, candidate.bbox) >= 0.22
    ))
    if (!duplicate) selected.push(candidate)
  }
  return selected
}

export function drawableEvidence(spec: RoomSpec, assetId?: string) {
  const reviewIds = new Set(reviewEvidence(spec, assetId).map(observationId))
  const edgeEvidenceIds = new Set(
    (spec.plan_annotation?.edge_chain ?? []).flatMap((edge) => edge.evidence_ids),
  )
  return spec.observations.filter((observation) => (
    observation.field.startsWith('ocr:')
    && observation.bbox
    && (!assetId || observation.asset_id === assetId)
    && observation.semantic_role !== 'other'
    && (reviewIds.has(observationId(observation)) || edgeEvidenceIds.has(observationId(observation)) || observation.confirmed)
  ))
}
