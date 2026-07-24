export type SourceKind = 'measured' | 'derived' | 'estimated' | 'user'
export type EvidenceRole = 'room_dimension' | 'wall_segment' | 'wall_thickness' | 'room_height' | 'ceiling_height' | 'door_size' | 'door_position' | 'drain_position' | 'pipe_box' | 'fixture_dimension' | 'fixture_label' | 'other'

export interface Point2D {
  x_mm: number
  z_mm: number
}

export interface ImageBoundaryPoint {
  x: number
  y: number
  role?: 'wall_corner' | 'structure_return' | 'door_jamb' | 'other'
  confidence?: number
  evidence_ids?: string[]
}

export interface PlanAnnotation {
  rotation_degrees: 0 | 90 | 180 | 270
  boundary: ImageBoundaryPoint[]
  confirmed: boolean
}

export interface Observation {
  field: string
  value: string
  source: SourceKind
  asset_id?: string | null
  bbox?: { x_min: number; y_min: number; x_max: number; y_max: number } | null
  confidence: number
  confirmed: boolean
  alternatives?: string[]
  note: string
  semantic_role?: EvidenceRole
  review_required?: boolean
  rotation_degrees?: 0 | 90 | 180 | 270
  target_id?: string | null
}

export interface OpeningSpec {
  id: string
  kind: 'door' | 'window' | 'opening'
  wall_index: number
  offset_mm: number
  width_mm: number
  height_mm: number
  thickness_mm?: number | null
  sill_mm: number
  label: string
  source: SourceKind
  confidence: number
  swing_direction?: 'left' | 'right' | 'inward' | 'outward' | 'unknown'
  evidence_ids?: string[]
}

export type FixtureKind = 'toilet' | 'vanity' | 'shower' | 'floor_drain' | 'pipe' | 'column' | 'radiator' | 'other'

export interface FixtureSpec {
  id: string
  kind: FixtureKind
  label: string
  x_mm: number
  z_mm: number
  width_mm: number
  depth_mm: number
  height_mm: number
  rotation_deg: number
  source: SourceKind
  confidence: number
  evidence_ids?: string[]
}

export interface WallProfile {
  wall_index: number
  kind: 'interior' | 'exterior' | 'pipe_chase' | 'other'
  thickness_mm: number
  source: SourceKind
  confidence: number
  evidence_ids?: string[]
}

export interface CeilingZone {
  id: string
  label: string
  boundary: Point2D[]
  height_mm: number
  source: SourceKind
  confidence: number
  evidence_ids?: string[]
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  target_id?: string | null
}

export interface RoomSpec {
  schema_version: '1.0'
  name: string
  boundary: Point2D[]
  height_mm: number | null
  wall_thickness_mm: number
  wall_profiles?: WallProfile[]
  openings: OpeningSpec[]
  fixtures: FixtureSpec[]
  ceiling_zones?: CeilingZone[]
  observations: Observation[]
  plan_annotation?: PlanAnnotation | null
  issues: ValidationIssue[]
  confirmed: boolean
}

export interface MeasurementModel {
  schema_version: '1.0'
  measurement_id: string
  revision: number
  units: 'mm'
  coordinate_system: {
    origin: 'boundary_min_x_min_z'
    x_axis: 'right'
    z_axis: 'down'
    y_axis: 'up'
    dimension_basis: 'finished_surface_clear'
  }
  room: { name: string; length_mm: number; width_mm: number }
  heights: {
    room_height_mm: number | null
    wall_height_mm: number | null
    net_height_mm: number | null
    ground_elevation_mm: number
    source: SourceKind
    confidence: number
    status: 'verified' | 'unverified' | 'provisional'
    evidence_ids: string[]
  }
  walls: Array<{
    id: string; index: number; start: Point2D; end: Point2D
    thickness_mm: number; length_mm: number; source: SourceKind
    confidence: number; status: 'verified' | 'unverified' | 'provisional'; evidence_ids: string[]
  }>
  openings: Array<Record<string, unknown>>
  anchors: Array<Record<string, unknown>>
  evidence: Array<MeasurementEvidence>
  source_asset_ids: string[]
  unresolved_fields: string[]
  issues: ValidationIssue[]
  confirmed: boolean
}

export interface MeasurementEvidence {
  id: string
  field: string
  raw_text: string
  normalized_value: string
  unit: 'mm' | 'text'
  source: SourceKind
  asset_id?: string | null
  bbox?: { x_min: number; y_min: number; x_max: number; y_max: number } | null
  confidence: number
  status: 'verified' | 'unverified' | 'provisional'
  alternatives: string[]
  note: string
  semantic_role: EvidenceRole
  review_required: boolean
  rotation_degrees: 0 | 90 | 180 | 270
  target_id?: string | null
}

export interface Asset {
  id: string
  project_id: string
  role: 'floorplan' | 'photo'
  filename: string
  mime_type: string
  width: number
  height: number
  created_at: string
  url: string
}

export interface Project {
  id: string
  name: string
  status: string
  created_at: string
  updated_at: string
  spec: RoomSpec | null
  measurement?: MeasurementModel | null
  assets: Asset[]
}

export interface AnalysisResponse {
  spec: RoomSpec
  measurement: MeasurementModel
  sufficient: boolean
  missing: string[]
}

export interface Health {
  ok: boolean
  ai_configured: boolean
  model: string | null
  fallback_model?: string | null
  ocr_configured?: boolean
}

export type Selection = { type: 'room' } | { type: 'fixture'; id: string } | { type: 'opening'; id: string }
