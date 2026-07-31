import { cloneSpec } from './spec'
import type { EvidenceRole, Observation, OpeningSpec, RoomSpec } from './types'

export function wallTarget(targetId: string | null) {
  const match = targetId?.match(/^wall:(\d+)(?:@(0(?:\.\d+)?|1(?:\.0+)?)(?::(0(?:\.\d+)?|1(?:\.0+)?))?)?$/)
  if (!match) return null
  return { wallIndex: Number(match[1]), startRatio: match[2] === undefined ? null : Number(match[2]), endRatio: match[3] === undefined ? null : Number(match[3]) }
}

export function measurementNumbers(value: string) {
  return [...value.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => {
    const raw = match[0].replace(',', '.')
    const parsed = Number(raw)
    return raw.includes('.') && parsed < 20 ? Math.round(parsed * 1000) : Math.round(parsed)
  }).filter((item) => item > 0)
}

function codedDoorValues(value: string) {
  return Object.fromEntries(
    [...value.matchAll(/\b(CG|CK|CH)\s*[:：=]?\s*(\d+)/gi)].map((match) => [match[1].toUpperCase(), Number(match[2])]),
  ) as Partial<Record<'CG' | 'CK' | 'CH', number>>
}

function observationId(observation: Observation) {
  return observation.field.replace(/^ocr:/, '')
}

function observationSingleNumber(observation: Observation) {
  const values = measurementNumbers(observation.value)
  return values.length === 1 ? values[0] : null
}

function edgeEvidenceChain(spec: RoomSpec, wallIndex: number, width: number) {
  const edge = spec.plan_annotation?.edge_chain?.[wallIndex]
  if (!edge?.length_mm || !edge.evidence_ids.length) return null
  const observationsById = new Map(spec.observations.map((item) => [observationId(item), item]))
  const segments = edge.evidence_ids.flatMap((id) => {
    const observation = observationsById.get(id)
    const value = observation ? observationSingleNumber(observation) : null
    if (!observation?.bbox || value === null) return []
    const center = edge.direction === 'right' || edge.direction === 'left'
      ? (observation.bbox.x_min + observation.bbox.x_max) / 2
      : (observation.bbox.y_min + observation.bbox.y_max) / 2
    return [{ id, value, center: edge.direction === 'left' || edge.direction === 'up' ? -center : center }]
  }).sort((left, right) => left.center - right.center)
  if (!segments.length || segments.reduce((sum, item) => sum + item.value, 0) !== edge.length_mm) return null
  const widthIndex = segments.findIndex((item) => item.value === width)
  if (widthIndex < 0) return null
  return {
    offset: segments.slice(0, widthIndex).reduce((sum, item) => sum + item.value, 0),
    evidenceIds: segments.map((item) => item.id),
  }
}

function wallLengthForOpening(spec: RoomSpec, wallIndex: number) {
  const edgeLength = spec.plan_annotation?.edge_chain?.[wallIndex]?.length_mm
  if (edgeLength) return edgeLength
  const start = spec.boundary[wallIndex]
  const end = spec.boundary.length ? spec.boundary[(wallIndex + 1) % spec.boundary.length] : undefined
  return start && end ? Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm) : 0
}

function openingPlacement(spec: RoomSpec, wallIndex: number, width: number, target: NonNullable<ReturnType<typeof wallTarget>>) {
  const length = wallLengthForOpening(spec, wallIndex)
  if (target.endRatio !== null && target.startRatio !== null) {
    return { offset: Math.max(0, Math.round(Math.min(target.startRatio, target.endRatio) * length)), evidenceIds: [] }
  }
  const chain = edgeEvidenceChain(spec, wallIndex, width)
  if (chain) return chain
  if (target.startRatio !== null) return { offset: Math.max(0, Math.round(target.startRatio * length - width / 2)), evidenceIds: [] }
  return { offset: 0, evidenceIds: [] }
}

function upsertOpening(spec: RoomSpec, id: string, value: string, numbers: number[], targetId: string | null) {
  const codedValues = codedDoorValues(value)
  const usesCodedValues = /\b(?:CG|CK|CH)\b/i.test(value)
  const width = codedValues.CK ?? numbers.find((item) => item >= 500 && item <= 1600)
  const height = codedValues.CH ?? numbers.find((item) => item >= 1800 && item <= 2800) ?? numbers[1]
  const sill = codedValues.CG ?? (usesCodedValues ? undefined : 0)
  const target = wallTarget(targetId)
  const wallCount = spec.plan_annotation?.boundary.length ?? spec.boundary.length
  if (!width || !height || sill === undefined || !target || !Number.isInteger(target.wallIndex) || target.wallIndex < 0 || target.wallIndex >= wallCount) return

  const openingCode = value.match(/\b([DW][12])\b/i)?.[1].toUpperCase()
  const openingKind: OpeningSpec['kind'] = openingCode?.startsWith('W') ? 'window' : 'door'
  const placement = openingPlacement(spec, target.wallIndex, width, target)
  const evidenceIds = [...new Set([id, ...placement.evidenceIds])]
  const opening = spec.openings.find((item) => item.evidence_ids?.includes(id))
  const nextOpening = {
    kind: openingKind,
    wall_index: target.wallIndex,
    offset_mm: placement.offset,
    width_mm: width,
    height_mm: height,
    thickness_mm: opening?.thickness_mm ?? 100,
    sill_mm: sill,
    label: openingCode ?? (openingKind === 'window' ? '窗洞' : '门洞'),
    source: 'user' as const,
    confidence: 1,
    evidence_ids: evidenceIds,
  }
  if (opening) Object.assign(opening, nextOpening)
  else spec.openings.push({ id: `${openingKind}-${crypto.randomUUID().slice(0, 8)}`, ...nextOpening })
}

export function applyEvidenceToSpec(spec: RoomSpec, id: string, value: string, role: EvidenceRole, targetId: string | null = null, ignored = false) {
  const next = cloneSpec(spec)
  const observation = next.observations.find((item) => item.field === `ocr:${id}`)
  if (!observation) return next
  observation.value = value
  observation.source = 'user'
  observation.confidence = 1
  observation.confirmed = true
  observation.review_required = false
  observation.semantic_role = role
  observation.target_id = targetId
  if (ignored) return next

  const numbers = measurementNumbers(value)
  if (role === 'room_height' && numbers[0]) next.height_mm = numbers[0]
  if (role === 'wall_segment' && numbers[0] && targetId?.startsWith('wall:') && next.plan_annotation) {
    const wallIndex = Number(targetId.slice(5).split('@')[0])
    const edge = next.plan_annotation.edge_chain?.[wallIndex]
    if (edge && Number.isInteger(wallIndex) && wallIndex >= 0 && wallIndex < next.plan_annotation.boundary.length) {
      edge.length_mm = numbers[0]
      edge.measured_length_mm = numbers[0]
      edge.closure_adjustment_mm = 0
      edge.source = 'user'
      edge.confidence = 1
      edge.evidence_ids = [...new Set([...(edge.evidence_ids ?? []), id])]
      next.plan_annotation.confirmed = false
    }
  }
  if (role === 'door_size') upsertOpening(next, id, value, numbers, targetId)
  return next
}

export function deleteEvidenceFromSpec(spec: RoomSpec, id: string) {
  const next = cloneSpec(spec)
  next.observations = next.observations.filter((item) => item.field !== `ocr:${id}`)
  for (const edge of next.plan_annotation?.edge_chain ?? []) {
    if (!edge.evidence_ids.includes(id)) continue
    edge.evidence_ids = edge.evidence_ids.filter((item) => item !== id)
    if (!edge.evidence_ids.length && edge.source !== 'user') {
      edge.length_mm = null
      edge.measured_length_mm = null
      edge.closure_adjustment_mm = 0
      edge.confidence = 0.5
    }
  }
  next.openings = next.openings
    .map((item) => ({ ...item, evidence_ids: item.evidence_ids?.filter((evidenceId) => evidenceId !== id) ?? [] }))
    .filter((item) => item.evidence_ids.length > 0 || item.source === 'user')
  next.fixtures = next.fixtures
    .map((item) => ({ ...item, evidence_ids: item.evidence_ids?.filter((evidenceId) => evidenceId !== id) ?? [] }))
    .filter((item) => item.evidence_ids.length > 0 || item.source === 'user')
  return next
}
