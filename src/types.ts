export type SourceKind = 'measured' | 'derived' | 'estimated' | 'user'
export type EvidenceRole = 'room_dimension' | 'wall_segment' | 'wall_thickness' | 'room_height' | 'ceiling_height' | 'door_size' | 'door_position' | 'drain_position' | 'pipe_box' | 'fixture_dimension' | 'fixture_label' | 'other'

export interface Point2D {
  x_mm: number
  z_mm: number
}

export type PlanLineKind = 'pipe_chase' | 'inner_wall' | 'door_line'

export interface PlanLineSpec {
  id: string
  kind: PlanLineKind
  label: string
  points: Point2D[]
  source: SourceKind
  confidence: number
  evidence_ids?: string[]
}

export interface PlanLabelSpec {
  id: string
  text: string
  x_mm: number
  z_mm: number
  source: SourceKind
  confidence: number
  evidence_ids?: string[]
}

export interface ImageBoundaryPoint {
  x: number
  y: number
  role?: 'wall_corner' | 'structure_return' | 'door_jamb' | 'other'
  confidence?: number
  evidence_ids?: string[]
}

export interface BoundaryEdge {
  direction: 'right' | 'down' | 'left' | 'up'
  length_mm: number | null
  measured_length_mm?: number | null
  closure_adjustment_mm?: number
  source?: SourceKind
  role: 'wall' | 'door_jamb' | 'structure_return' | 'other'
  evidence_ids: string[]
  confidence: number
}

export interface PlanAnnotation {
  rotation_degrees: 0 | 90 | 180 | 270
  boundary: ImageBoundaryPoint[]
  edge_chain?: BoundaryEdge[]
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
  opening_form?: 'hinged' | 'sliding' | 'folding' | 'pocket' | 'revolving' | 'unknown'
  evidence_ids?: string[]
  wall_binding?: {
    wall_index: number
    start_ratio: number
    end_ratio: number
    wall_start?: Point2D
    wall_end?: Point2D
    image_start?: { x: number; y: number }
    image_end?: { x: number; y: number }
  } | null
  line?: { start: Point2D; end: Point2D } | null
}

export type FixtureKind = 'toilet' | 'vanity' | 'shower' | 'floor_drain' | 'drain' | 'water' | 'electric' | 'pipe' | 'column' | 'radiator' | 'other'
export type FixturePointUsage = 'general' | 'toilet' | 'shower' | 'basin'

export type ModelAssetFormat = 'gltf' | 'glb' | 'fbx' | '3ds' | 'obj'
export type ModelAssetLifecycle = 'approved' | 'needs_conversion' | 'converted' | 'converted_duplicate' | 'deprecated'

export interface FixtureModelAsset {
  id: string
  src: string
  format?: ModelAssetFormat
  label: string
  unit: 'm'
  fit: 'contain'
  version?: string
  sha256?: string
  bytes?: number
  thumbnail?: string
  source?: string
  source_asset_id?: string
  lifecycle?: ModelAssetLifecycle
  legacy_source_ids?: string[]
}

export interface FixtureSpec {
  id: string
  kind: FixtureKind
  label: string
  x_mm: number
  z_mm: number
  width_mm: number
  depth_mm: number
  height_mm: number
  elevation_mm?: number
  rotation_deg: number
  source: SourceKind
  confidence: number
  evidence_ids?: string[]
  bound_wall_index?: number | null
  point_usage?: FixturePointUsage
  model_asset?: FixtureModelAsset | null
  // Layout runs may be replaced without discarding measured utility points.
  layout_generated?: boolean
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

export interface DryWetZone {
  id: string
  kind: 'dry' | 'wet'
  label: string
  boundary: Point2D[]
  source: SourceKind
  confidence: number
  evidence_ids?: string[]
}

export interface WallFinishProfile {
  wall_index: number
  thickness_mm: number
  source: SourceKind
  confidence: number
  generated_from_bound_point: boolean
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
  strip_existing_finish?: boolean
  finish_surface_offset_mm?: number
  wall_finish_thickness_mm?: number
  wall_finish_gap_mm?: number
  wall_profiles?: WallProfile[]
  openings: OpeningSpec[]
  fixtures: FixtureSpec[]
  ceiling_zones?: CeilingZone[]
  dry_wet_zones?: DryWetZone[]
  wall_finish_profiles?: WallFinishProfile[]
  plan_lines?: PlanLineSpec[]
  plan_labels?: PlanLabelSpec[]
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
  surface_treatment: {
    strip_existing_finish: boolean
    existing_finish_thickness_mm: number
    new_finish_thickness_mm: number
    wall_finish_profiles: WallFinishProfile[]
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

export interface ImportedModelAsset {
  id: string
  project_id: string
  label: string
  filename: string
  format: ModelAssetFormat
  bytes: number
  sha256: string
  file_count: number
  created_at: string
  src: string
  orientation_view: 'front' | 'top' | 'side' | null
  orientation_corrected: boolean
  orientation_source: 'auto' | 'manual' | null
}

export interface CaptureCheck {
  code: 'resolution' | 'sharpness' | 'exposure' | 'contrast'
  status: 'pass' | 'warning' | 'error'
  label: string
  detail: string
}

export interface CaptureAssessment {
  status: 'ready' | 'usable' | 'retake'
  width: number
  height: number
  sharpness: number
  brightness: number
  contrast: number
  checks: CaptureCheck[]
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
  measurement: MeasurementModel | null
  sufficient: boolean
  missing: string[]
}

export interface MeasurementImportLayer {
  name: string
  entity_count: number
  boundary_candidates: number
  point_markers: number
}

export interface MeasurementImportInspection {
  filename: string
  format: string
  detected_unit: string | null
  unit_required: boolean
  can_import: boolean
  dwg_converter_available: boolean
  layers: MeasurementImportLayer[]
  warnings: string[]
}

export interface MeasurementImportResponse {
  project: Project
  source_format: string
  source_unit: string
  scale_to_mm: number
  selected_layer: string | null
  warnings: string[]
}

export interface Health {
  ok: boolean
  ai_configured: boolean
  chat_configured?: boolean
  model: string | null
  chat_model?: string | null
  fallback_model?: string | null
  ocr_configured?: boolean
  voice_configured?: boolean
  voice_asr_model?: string
  voice_tts?: string
}
export interface ChatMessage { role:'user'|'assistant'; content:string }
export interface SurfaceEstimate { source:string; floor_area_sqm:number; ceiling_area_sqm:number; wall_gross_area_sqm:number|null; opening_area_sqm:number; wall_net_area_sqm:number|null; waste_rate:number; floor_purchase_sqm:number; ceiling_purchase_sqm:number; wall_purchase_sqm:number|null; floor_layout:string; ceiling_layout:string; wall_layout:string; warnings:string[] }
export interface RequirementState { collected:Record<string,string|string[]|null>; missing_fields:string[]; complete:boolean }
export interface QuoteLine { product_id:string; 材料编号:string; 单价:number; 单位:string; 来源:string; 材料名称?:string; 采购量?:number; 材料小计?:number; 家具名称?:string; 数量?:number; 家具小计?:number; model_lookup?:ModelLookup }
export interface StyleMatch { user_terms:string[]; catalog_style:string|null; confidence:number; status:'matched'|'mapped'|'needs_clarification'; candidates:Array<{catalog_style:string;feeling:string}>; resolver_version:string }
export interface ModelLookup { product_id:string; catalog_code:string; category:string; catalog_style:string; normalized_requested_style:string|null; spec:string; model_asset_id:string|null; model_asset_src?:string|null; model_asset_format?:ModelAssetFormat|null; model_asset_label?:string|null; model_dimensions_mm?:{width:number;depth:number;height:number}|null; texture_src?:string|null; layout_fixture_kind:string; binding_status:'awaiting_model_asset'|'bound' }
export interface SelectedFurniture { product_id:string; category:string; catalog_style:string; requested_style:string|null; model_lookup:ModelLookup }
export interface PriceRange { min:number; max:number }
export interface FurnitureCandidateGroup { category:string; selection_status:'deferred_to_auto_layout'; candidate_count:number; min_price:number; max_price:number; candidates:Array<QuoteLine & {风格?:string;匹配风格?:string;model_lookup?:ModelLookup}> }
export type LayoutDemandProfile = 'standard_shower'|'laundry'|'elderly_safe'
export type LayoutBudgetTier = 'basic'|'comfort'|'premium'
export interface LayoutInstructionInput { fixture_role:string; wall:'north'|'south'|'east'|'west'|'nearest_plumbing'; zone:'dry'|'wet'|'service'; near?:string; min_clearance_mm:number }
export interface LayoutProductInput { product_id:string; catalog_code:string; category:string; spec:string; unit_price:number; price_unit:string; model_lookup?:ModelLookup }
export interface LayoutLevelDecision { id:'level1'|'level2'|'level3'; name:string; reason:string; demand_profile:LayoutDemandProfile; product_tier:LayoutBudgetTier; product_ids:string[]; products:LayoutProductInput[]; layout_script:{version:'layout-script-v1';demand:LayoutDemandProfile;budget:LayoutBudgetTier;instructions:LayoutInstructionInput[];source:'model-assisted-rule-engine'|'deterministic-rule-engine'} }
export interface ModelCallAudit { model:string; provider_response_id:string|null; tool_call_id:string|null; usage:Record<string,number>; generated_at:string; strict_model_output:true; purpose:'initial_layout'|'geometry_repair' }
export interface AutoLayoutResponse { layout_levels:LayoutLevelDecision[]; model_call:ModelCallAudit }
export interface DesignChatResponse { message:string; requirements:RequirementState; layout_levels?:LayoutLevelDecision[]; layout_blockers?:string[]; style_match:StyleMatch; surfaces:SurfaceEstimate; material_quotes:QuoteLine[]; furniture_candidates:FurnitureCandidateGroup[]; furniture_quotes:Array<QuoteLine & {风格?:string;匹配风格?:string;model_lookup?:ModelLookup}>; selected_furniture:SelectedFurniture[]; material_total:number; furniture_price_range:PriceRange; total_price_range:PriceRange; furniture_total:number|null; quote_total:number|null; pricing_status:'range_until_auto_layout_selection'|'final'; equipment:Record<string,string[]>; products:Array<{id:string;attributes:Record<string,string>}> }

export interface ChatSessionSummary { id:string; project_id:string; title:string; message_count:number; last_message:string; created_at:string; updated_at:string }
export interface ChatSessionMessage { id:string; role:'user'|'assistant'; content:string; quote:DesignChatResponse|null; created_at:string }
export interface ChatSession extends ChatSessionSummary { messages:ChatSessionMessage[] }
export interface VoiceTurnResponse { transcript:string; session:ChatSession; audio_base64:string; audio_mime_type:'audio/wav'|'audio/mpeg' }
export interface VoiceAudioResponse { text:string; audio_base64:string; audio_mime_type:'audio/wav'|'audio/mpeg' }

export type Selection = { type: 'room' } | { type: 'fixture'; id: string } | { type: 'opening'; id: string } | { type: 'dry_wet_zone'; id: string } | { type: 'plan_line'; id: string } | { type: 'plan_label'; id: string }
