import { describe, expect, it } from 'vitest'
import { drawableEvidence, observationId, reviewEvidence } from './evidence'
import type { Observation, RoomSpec } from './types'

const observation = (id: string, overrides: Partial<Observation> = {}): Observation => ({
  field: `ocr:${id}`,
  value: '615',
  source: 'measured',
  asset_id: 'plan-a',
  bbox: { x_min: 100, y_min: 100, x_max: 150, y_max: 130 },
  confidence: 0.8,
  confirmed: false,
  alternatives: [],
  note: '',
  semantic_role: 'wall_segment',
  review_required: true,
  target_id: 'wall:0@0.5',
  ...overrides,
})

const spec = (observations: Observation[]): RoomSpec => ({
  schema_version: '1.0',
  name: 'test',
  boundary: [],
  height_mm: null,
  wall_thickness_mm: 100,
  wall_profiles: [],
  openings: [],
  fixtures: [],
  ceiling_zones: [],
  observations,
  issues: [],
  confirmed: false,
  plan_annotation: {
    rotation_degrees: 0,
    boundary: [],
    edge_chain: [{ direction: 'right', length_mm: 615, role: 'wall', evidence_ids: ['used'], confidence: 0.8 }],
    confirmed: false,
  },
})

describe('photo evidence visibility', () => {
  it('keeps boxes from another floorplan out of the current project view', () => {
    const current = observation('used')
    const stale = observation('stale', { asset_id: 'plan-b' })

    expect(drawableEvidence(spec([current, stale]), 'plan-a').map(observationId)).toEqual(['used'])
  })

  it('does not ask users to review unused dimensions, other noise, or whole-room ceilings', () => {
    const items = [
      observation('unused'),
      observation('noise', { semantic_role: 'other', value: '表格线' }),
      observation('ceiling', { semantic_role: 'ceiling_height', value: '整屋吊顶 2100', target_id: null }),
      observation('used'),
    ]

    expect(reviewEvidence(spec(items), 'plan-a').map(observationId)).toEqual(['used'])
  })

  it('deduplicates overlapping complete CG CK CH rows', () => {
    const first = observation('door-a', { semantic_role: 'door_size', value: 'D1 CG 0 CK 800 CH 2055', target_id: null, confidence: 0.9 })
    const duplicate = observation('door-b', { semantic_role: 'door_size', value: 'D1 CG 0 CK 300 CH 2055', target_id: null, confidence: 0.8 })

    expect(reviewEvidence(spec([first, duplicate]), 'plan-a').map(observationId)).toEqual(['door-a'])
  })

  it('does not force a wall selection after the OCR row already created the same opening', () => {
    const header = observation('header', { semantic_role: 'door_size', value: '门窗洞口 · CG 距地 / CK 内宽 / CH 内高', target_id: null })
    const door = observation('door-row', { semantic_role: 'door_size', value: 'D1 CG 0 CK 800 CH 2055', target_id: null })
    const current = spec([header, door])
    current.openings.push({ id: 'opening-d1', kind: 'door', wall_index: 2, offset_mm: 770, width_mm: 800, height_mm: 2055, sill_mm: 0, label: 'D1', source: 'derived', confidence: 0.95, evidence_ids: ['other-door-row'] })

    expect(reviewEvidence(current, 'plan-a')).toEqual([])
  })
})
