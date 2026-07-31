import { describe, expect, it } from 'vitest'
import { applyEvidenceToSpec, deleteEvidenceFromSpec } from './measurementDraft'
import type { BoundaryEdge, Observation, RoomSpec } from './types'

const edge = (direction: BoundaryEdge['direction'], length_mm: number, evidence_ids: string[] = []): BoundaryEdge => ({
  direction,
  length_mm,
  measured_length_mm: length_mm,
  role: 'wall',
  evidence_ids,
  confidence: 0.9,
})

const ocr = (id: string, value: string, x1: number, x2: number, overrides: Partial<Observation> = {}): Observation => ({
  field: `ocr:${id}`,
  value,
  source: 'measured',
  asset_id: 'plan',
  bbox: { x_min: x1, y_min: 900, x_max: x2, y_max: 940 },
  confidence: 0.9,
  confirmed: false,
  alternatives: [],
  note: '',
  semantic_role: 'wall_segment',
  review_required: true,
  ...overrides,
})

const spec = (): RoomSpec => ({
  schema_version: '1.0',
  name: 'test',
  boundary: [],
  height_mm: 2400,
  wall_thickness_mm: 100,
  openings: [],
  fixtures: [],
  observations: [
    ocr('T1', '400', 100, 250),
    ocr('T2', '800', 250, 650),
    ocr('T3', '55', 650, 700),
    ocr('D1', 'D1 CG 0 CK 800 CH 2055', 730, 950, { semantic_role: 'door_size', target_id: 'wall:0' }),
  ],
  issues: [],
  confirmed: false,
  plan_annotation: {
    rotation_degrees: 0,
    boundary: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 900 }, { x: 100, y: 900 }],
    edge_chain: [
      edge('right', 1255, ['T1', 'T2', 'T3']),
      edge('down', 1800),
      edge('left', 1255),
      edge('up', 1800),
    ],
    confirmed: false,
  },
})

describe('measurement draft evidence application', () => {
  it('derives a door opening from the cited wall segment chain', () => {
    const next = applyEvidenceToSpec(spec(), 'D1', 'D1 CG 0 CK 800 CH 2055', 'door_size', 'wall:0')

    expect(next.openings).toHaveLength(1)
    expect(next.openings[0]).toMatchObject({
      kind: 'door',
      wall_index: 0,
      offset_mm: 400,
      width_mm: 800,
      height_mm: 2055,
      sill_mm: 0,
      thickness_mm: 100,
      label: 'D1',
      evidence_ids: ['D1', 'T1', 'T2', 'T3'],
    })
  })

  it('keeps a wall length confirmation in the plan annotation edge chain', () => {
    const next = applyEvidenceToSpec(spec(), 'T3', '60', 'wall_segment', 'wall:0@0.9')

    expect(next.plan_annotation?.edge_chain?.[0]).toMatchObject({
      length_mm: 60,
      measured_length_mm: 60,
      source: 'user',
      confidence: 1,
      evidence_ids: ['T1', 'T2', 'T3'],
    })
  })

  it('removes deleted evidence from edge chains and dependent openings', () => {
    const withDoor = applyEvidenceToSpec(spec(), 'D1', 'D1 CG 0 CK 800 CH 2055', 'door_size', 'wall:0')
    const next = deleteEvidenceFromSpec(withDoor, 'T2')

    expect(next.plan_annotation?.edge_chain?.[0].evidence_ids).toEqual(['T1', 'T3'])
    expect(next.openings[0].evidence_ids).toEqual(['D1', 'T1', 'T3'])
  })
})
