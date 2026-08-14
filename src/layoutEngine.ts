import type { FixtureModelAsset, FixtureSpec, LayoutLevelDecision, LayoutProductInput, ModelCallAudit, ModelLookup, RoomSpec } from './types'
import graphOutput from './generated-layout-products.json'
import productCatalog from './generated-product-catalog.json'
import { dimensionsFor } from './modelDimensions'
import { builtInAssetAsRoomAsset, exactModelAssetForProduct, modelAssetForProduct, surfaceAssetForProduct, type BuiltInModelRecord } from './modelLibrary'
import { finishedRoomBoundary, fixturePointUsage, toiletPlacementFromDrain } from './spec'

export type DemandProfile = 'standard_shower' | 'laundry' | 'elderly_safe'
export type BudgetTier = 'basic' | 'comfort' | 'premium'
export interface LayoutPreference { style?: string | null; levels?:LayoutLevelDecision[] }
export type SemanticWall = 'north'|'south'|'east'|'west'|'nearest_plumbing'
export interface LayoutInstruction { fixture_role:string; wall:SemanticWall; zone:'dry'|'wet'|'service'; near?:string; min_clearance_mm:number }
export interface LayoutScript { version:'layout-script-v1'; demand:DemandProfile; budget:BudgetTier; instructions:LayoutInstruction[]; source:'requirement-rule-engine'|'model-assisted-rule-engine'|'deterministic-rule-engine' }

export interface LayoutAnchor { id: string; label: string; x_mm: number; z_mm: number; instruction: string }
export type LayoutCheckSeverity = 'error' | 'warning' | 'info'
export interface LayoutCheck { code: string; passed: boolean; severity: LayoutCheckSeverity; source: string; message: string }
export interface LayoutSolution {
  id: string
  demand: DemandProfile
  budget: BudgetTier
  title: string
  budget_label: string
  layout_label: string
  layout_summary: string
  product_lines: Array<{ code: string; category: string; spec: string; price: number; quantity: number; unit: string }>
  material_lines: Array<{ code: string; category: string; spec: string; price: number; quantity: number; unit: string; subtotal: number; model_asset_id?: string }>
  surface_materials: { wall?: BuiltInModelRecord; floor?: BuiltInModelRecord }
  equipment_price: number
  material_price: number
  total_price: number
  score: number
  fixtures: FixtureSpec[]
  anchors: LayoutAnchor[]
  checks: LayoutCheck[]
  wet_zone: { x_mm: number; z_mm: number; width_mm: number; depth_mm: number }
  floor_layout: FloorLayoutPlan
  layout_script: LayoutScript
  solver_trace: { candidates_evaluated:number; feasible_candidates:number; reachable:boolean }
  model_reason?: string
  selected_product_ids: string[]
  model_call?: ModelCallAudit
  model_calls?: ModelCallAudit[]
}
export interface FloorLayoutPlan { rotation_deg:0|90; offset_x_mm:number; offset_z_mm:number; cut_count:number; narrow_cut_count:number; min_edge_mm:number; score:number; description:string }

const demandLabels: Record<DemandProfile, string> = {
  standard_shower: '标准淋浴', laundry: '洗衣复合', elderly_safe: '适老安全',
}
const budgetLabels: Record<BudgetTier, string> = { basic: '经济档', comfort: '舒适档', premium: '品质档' }
const layoutLabels: Record<BudgetTier, string> = { basic: '约束求解方案', comfort: '约束求解方案', premium: '约束求解方案' }
const budgets: BudgetTier[] = ['basic', 'comfort', 'premium']

type GraphProduct = { graph_id: string; code: string; category: string; spec: string; price: number }
type CatalogProduct = { 材料编号: string; 材料名称: string; 规格型号: string; 人群: string; 风格: string; 单价: string; 数量单位: string; 备注: string }

function supportsStyle(product: CatalogProduct, style: string) {
  const values = product.风格.split(/[、,，/；;\s]+/).filter(Boolean)
  return values.includes('通用') || values.includes(style)
}

function materialProduct(category: '墙板' | '地砖' | '吊顶', quality: number, style: string) {
  const all = (productCatalog as CatalogProduct[]).filter((product) => product.材料名称 === category)
  const styled = all.filter((product) => supportsStyle(product, style))
  const candidates = (styled.length ? styled : all).sort((a, b) => Number(a.单价) - Number(b.单价) || a.材料编号.localeCompare(b.材料编号))
  if (!candidates.length) throw new Error(`产品目录缺少材料：${category}`)
  const uniquePrices = [...new Set(candidates.map((product) => Number(product.单价)))].sort((a, b) => a - b)
  const targetPrice = uniquePrices[Math.min(quality, uniquePrices.length - 1)]
  return candidates.find((product) => Number(product.单价) === targetPrice) as CatalogProduct
}

function surfaceQuantities(spec: RoomSpec) {
  const points = spec.boundary
  const floor = Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + point.x_mm * next.z_mm - next.x_mm * point.z_mm
  }, 0)) / 2 / 1_000_000
  const perimeter = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + Math.hypot(next.x_mm - point.x_mm, next.z_mm - point.z_mm)
  }, 0)
  const openingArea = spec.openings.reduce((sum, opening) => sum + opening.width_mm * opening.height_mm / 1_000_000, 0)
  const wall = Math.max(0, perimeter * (spec.height_mm ?? 2600) / 1_000_000 - openingArea)
  return { floor: Math.round(floor * 1.1 * 100) / 100, ceiling: Math.round(floor * 1.1 * 100) / 100, wall: Math.round(wall * 1.1 * 100) / 100 }
}
function graphProduct(demand: DemandProfile, category: string, quality: number, style?: string) {
  const all = (graphOutput.scenarios[demand].products as GraphProduct[])
    .filter((product) => product.category === category)
    .sort((a, b) => a.price - b.price || a.code.localeCompare(b.code))
  const styled = style ? all.filter((product) => {
    const catalog = (productCatalog as CatalogProduct[]).find((item) => item.材料编号 === product.code)
    return !catalog || supportsStyle(catalog, style)
  }) : all
  const candidates = styled.length ? styled : all
  if (!candidates.length) throw new Error(`知识图谱未返回必需品类：${demand}/${category}`)
  return candidates[Math.min(quality, candidates.length - 1)]
}

function rectangleBounds(spec: RoomSpec) {
  const xs = spec.boundary.map((p) => p.x_mm); const zs = spec.boundary.map((p) => p.z_mm)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
}

function layoutBoundary(spec: RoomSpec) {
  return finishedRoomBoundary({ ...spec, wall_finish_gap_mm: Math.max(35, spec.wall_finish_gap_mm ?? 0) })
}
function buildLayoutScript(demand:DemandProfile,budget:BudgetTier):LayoutScript{
  const variant=budgets.indexOf(budget), walls:SemanticWall[][]=[['east','west','north'],['west','east','north'],['south','north','east']]
  const [wetWall,dryWall,serviceWall]=walls[variant]
  const instructions:LayoutInstruction[]=[
    {fixture_role:'wet_zone',wall:wetWall,zone:'wet',near:'shower_drain',min_clearance_mm:0},
    {fixture_role:'vanity',wall:dryWall,zone:'dry',min_clearance_mm:600},
    {fixture_role:'toilet',wall:serviceWall,zone:'dry',near:'toilet_drain',min_clearance_mm:demand==='elderly_safe'?800:600},
    {fixture_role:'heater',wall:wetWall,zone:'service',near:'wet_zone',min_clearance_mm:0},
  ]
  if(demand==='laundry')instructions.push({fixture_role:'washer',wall:serviceWall,zone:'service',near:'water',min_clearance_mm:600})
  if(demand==='elderly_safe')instructions.push({fixture_role:'grab_bars',wall:wetWall,zone:'wet',near:'wet_zone',min_clearance_mm:0})
  return{version:'layout-script-v1',demand,budget,instructions,source:'requirement-rule-engine'}
}
function semanticTarget(spec:RoomSpec,instruction:LayoutInstruction,w:number,d:number){const b=rectangleBounds(spec),m=80;let x=(b.minX+b.maxX)/2,z=(b.minZ+b.maxZ)/2;if(instruction.wall==='west')x=b.minX+w/2+m;if(instruction.wall==='east')x=b.maxX-w/2-m;if(instruction.wall==='south')z=b.minZ+d/2+m;if(instruction.wall==='north')z=b.maxZ-d/2-m;if(instruction.wall==='nearest_plumbing'){const p=spec.fixtures.find(f=>['floor_drain','drain','water'].includes(f.kind));if(p){x=p.x_mm;z=p.z_mm}}return{x,z}}
function axisCuts(length:number,tile:number,offset:number){const first=offset===0?tile:offset;const remainder=((length-first)%tile+tile)%tile;const edges=[Math.min(first,length),...(remainder>0?[remainder]:[])].filter(v=>v>0&&v<tile);return{cuts:edges.length,narrow:edges.filter(v=>v<tile/3).length,min:edges.length?Math.min(...edges):tile}}
export function optimizeFloorLayout(spec:RoomSpec,tileWidthMm:number,tileDepthMm:number):FloorLayoutPlan{const b=rectangleBounds(spec),width=b.maxX-b.minX,depth=b.maxZ-b.minZ;const tileLongAxisIsWidth=tileWidthMm>=tileDepthMm;const roomShortAxisIsWidth=width<=depth;const requiredRotation:0|90=tileLongAxisIsWidth===roomShortAxisIsWidth?0:90;let best:FloorLayoutPlan|null=null;for(const rotation of [requiredRotation]){const tw=rotation===0?tileWidthMm:tileDepthMm,td=rotation===0?tileDepthMm:tileWidthMm;for(const ox of [...new Set([0,Math.round((width%tw)/2),width%tw])])for(const oz of [...new Set([0,Math.round((depth%td)/2),depth%td])]){const x=axisCuts(width,tw,ox),z=axisCuts(depth,td,oz),cuts=x.cuts*Math.ceil(depth/td)+z.cuts*Math.ceil(width/tw),narrow=x.narrow*Math.ceil(depth/td)+z.narrow*Math.ceil(width/tw),min=Math.round(Math.min(x.min,z.min)),score=100000-narrow*10000-cuts*100+min;const c:FloorLayoutPlan={rotation_deg:rotation,offset_x_mm:ox,offset_z_mm:oz,cut_count:cuts,narrow_cut_count:narrow,min_edge_mm:min,score,description:`长边沿房型短边 · ${rotation?'旋转90°':'横向'}铺贴 · 起铺偏移 ${ox}/${oz}mm · 窄条 ${narrow} · 最窄边条 ${min}mm`};if(!best||c.score>best.score)best=c}}return best as FloorLayoutPlan}

function fixture(id: string, kind: FixtureSpec['kind'], label: string, x_mm: number, z_mm: number, width_mm: number, depth_mm: number, height_mm: number, rotation_deg = 0, elevation_mm = 0): FixtureSpec {
  return { id, kind, label, x_mm: Math.round(x_mm), z_mm: Math.round(z_mm), width_mm, depth_mm, height_mm, elevation_mm, rotation_deg, source: 'derived', confidence: 1, layout_generated: true }
}

function snapshotAsset(lookup?: ModelLookup): FixtureModelAsset | undefined {
  if (!lookup?.model_asset_src) return undefined
  return {
    id: lookup.model_asset_id ?? `catalog-${lookup.catalog_code}`,
    src: lookup.model_asset_src,
    format: lookup.model_asset_format ?? undefined,
    label: lookup.model_asset_label ?? `${lookup.catalog_code} ${lookup.category}`,
    unit: 'm', fit: 'contain', source: '需求助手产品模型快照',
    source_asset_id: lookup.model_asset_id ?? undefined, lifecycle: 'approved',
  }
}

function productFixture(id: string, kind: FixtureSpec['kind'], product: GraphProduct, x_mm: number, z_mm: number, fallback: { width_mm: number; depth_mm: number; height_mm: number }, rotation_deg = 0, elevation_mm = 0, exactAsset = false, lookup?: ModelLookup) {
  const asset = exactAsset ? exactModelAssetForProduct(product.category, product.code) : modelAssetForProduct(product.category, product.code)
  const legacyDimensions = dimensionsFor(product.category, fallback)
  // The supplied grab-bar FBX files contain room-scale scene bounds. Keep the
  // assets renderable, but use their catalog installation envelopes for layout.
  const useInstallationEnvelope = ['花洒扶手', '马桶扶手', '花洒', '热水器'].includes(product.category)
  const snapshotDimensions = lookup?.model_dimensions_mm
  const dimensions = asset && !useInstallationEnvelope
    ? { width_mm: asset.dimensions_mm.width, depth_mm: asset.dimensions_mm.depth, height_mm: asset.dimensions_mm.height, file_name: asset.filename }
    : snapshotDimensions && !useInstallationEnvelope
      ? { width_mm: snapshotDimensions.width, depth_mm: snapshotDimensions.depth, height_mm: snapshotDimensions.height, file_name: lookup?.model_asset_label ?? 'backend-model-snapshot' }
      : { ...legacyDimensions, file_name: asset?.filename ?? (exactAsset ? 'proxy' : legacyDimensions.file_name) }
  const result = fixture(id, kind, `${product.code} ${product.category} · ${dimensions.file_name}`, x_mm, z_mm, dimensions.width_mm, dimensions.depth_mm, dimensions.height_mm, rotation_deg, elevation_mm)
  const resolvedAsset = asset ? builtInAssetAsRoomAsset(asset) : snapshotAsset(lookup)
  if (resolvedAsset) result.model_asset = resolvedAsset
  return result
}

function overlaps(a: FixtureSpec, b: FixtureSpec, clearance = 0) {
  return Math.abs(a.x_mm - b.x_mm) < (a.width_mm + b.width_mm) / 2 + clearance && Math.abs(a.z_mm - b.z_mm) < (a.depth_mm + b.depth_mm) / 2 + clearance
}

const BODY_GAP_MM = 50
const WASHER_REAR_GAP_MM = 50
const WALL_ATTACHMENT_CLEARANCE_MM = 5
const placementClearances = new WeakMap<FixtureSpec, FixtureSpec>()

function requiredRearWallGap(item: FixtureSpec) {
  if (item.kind === 'water' || item.kind === 'electric') return undefined
  if (item.kind === 'shower') return undefined
  if (/洗衣机/.test(item.label)) return WASHER_REAR_GAP_MM
  if (/(热水器|花洒|扶手|淋浴椅|适老椅|浴室柜)/.test(item.label)) return WALL_ATTACHMENT_CLEARANCE_MM
  return undefined
}

function wallFacingRotation(wall: Exclude<SemanticWall, 'nearest_plumbing'>) {
  return ({ south: 0, west: 90, north: 180, east: 270 } as const)[wall]
}

function rearWallDistance(spec: RoomSpec, item: FixtureSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>) {
  const boundary = layoutBoundary(spec)
  const xs = boundary.map((p) => p.x_mm); const zs = boundary.map((p) => p.z_mm)
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
  if (wall === 'west') return item.x_mm - item.width_mm / 2 - bounds.minX
  if (wall === 'east') return bounds.maxX - item.x_mm - item.width_mm / 2
  if (wall === 'south') return item.z_mm - item.depth_mm / 2 - bounds.minZ
  return bounds.maxZ - item.z_mm - item.depth_mm / 2
}

function snapRearToWall(spec: RoomSpec, item: FixtureSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>, gapMm: number) {
  const boundary = layoutBoundary(spec)
  const xs = boundary.map((p) => p.x_mm); const zs = boundary.map((p) => p.z_mm)
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
  const rotation = wallFacingRotation(wall)
  if (Math.abs(item.rotation_deg) % 180 !== rotation % 180) [item.width_mm, item.depth_mm] = [item.depth_mm, item.width_mm]
  item.rotation_deg = rotation
  if (wall === 'west') item.x_mm = Math.round(bounds.minX + item.width_mm / 2 + gapMm)
  if (wall === 'east') item.x_mm = Math.round(bounds.maxX - item.width_mm / 2 - gapMm)
  if (wall === 'south') item.z_mm = Math.round(bounds.minZ + item.depth_mm / 2 + gapMm)
  if (wall === 'north') item.z_mm = Math.round(bounds.maxZ - item.depth_mm / 2 - gapMm)
  item.bound_wall_index = wallIndexForSemantic(wall)
}

export function fixtureFront(item: FixtureSpec): Exclude<SemanticWall, 'nearest_plumbing'> {
  const rotation = ((item.rotation_deg % 360) + 360) % 360
  if (rotation === 90) return 'east'
  if (rotation === 180) return 'south'
  if (rotation === 270) return 'west'
  return 'north'
}

export function frontClearanceEnvelope(item: FixtureSpec, instruction: LayoutInstruction) {
  const clearance = Math.max(0, instruction.min_clearance_mm)
  if (!clearance) return undefined
  // Semantic wall describes intent. The solved rotation describes the real
  // fixture front and therefore controls its physical use-clearance envelope.
  const front = fixtureFront(item)
  let x = item.x_mm; let z = item.z_mm; let width = item.width_mm; let depth = item.depth_mm
  if (front === 'east') { x += item.width_mm / 2 + clearance / 2; width = clearance }
  if (front === 'west') { x -= item.width_mm / 2 + clearance / 2; width = clearance }
  if (front === 'north') { z += item.depth_mm / 2 + clearance / 2; depth = clearance }
  if (front === 'south') { z -= item.depth_mm / 2 + clearance / 2; depth = clearance }
  return fixture(`clearance-${item.id}`, 'other', `${item.label}前向使用净空`, x, z, width, depth, 1)
}

function pointInPolygon(x: number, z: number, polygon: RoomSpec['boundary']) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j]
    const cross = (x - a.x_mm) * (b.z_mm - a.z_mm) - (z - a.z_mm) * (b.x_mm - a.x_mm)
    if (Math.abs(cross) <= 1 && x >= Math.min(a.x_mm, b.x_mm) - 1 && x <= Math.max(a.x_mm, b.x_mm) + 1 && z >= Math.min(a.z_mm, b.z_mm) - 1 && z <= Math.max(a.z_mm, b.z_mm) + 1) return true
    if (((a.z_mm > z) !== (b.z_mm > z)) && x < ((b.x_mm - a.x_mm) * (z - a.z_mm)) / (b.z_mm - a.z_mm) + a.x_mm) inside = !inside
  }
  return inside
}

function fixtureInsideRoom(f: FixtureSpec, polygon: RoomSpec['boundary']) {
  // Model envelopes contain decimal millimetres while solved coordinates are integers.
  // Keep a 1 mm numeric tolerance so rounding does not turn wall contact into overflow.
  const hw = Math.max(0, f.width_mm / 2 - 1); const hd = Math.max(0, f.depth_mm / 2 - 1)
  return [[f.x_mm - hw, f.z_mm - hd], [f.x_mm + hw, f.z_mm - hd], [f.x_mm + hw, f.z_mm + hd], [f.x_mm - hw, f.z_mm + hd]].every(([x, z]) => pointInPolygon(x, z, polygon))
}

function permittedAssembly(a: FixtureSpec, b: FixtureSpec) {
  const labels = `${a.label}/${b.label}`
  const wetEnvelope = /淋浴(?:湿)?区/.test(a.label) ? a : /淋浴(?:湿)?区/.test(b.label) ? b : null
  if (wetEnvelope) {
    const other = wetEnvelope === a ? b : a
    return /(淋浴椅|扶手|花洒|地漏)/.test(other.label)
  }
  return /(扶手|花洒|热水器)/.test(labels)
}

function wallIndexForSemantic(wall: Exclude<SemanticWall, 'nearest_plumbing'>) {
  return ({ south: 0, east: 1, north: 2, west: 3 } as const)[wall]
}
function semanticWallForIndex(index: number | null | undefined): Exclude<SemanticWall, 'nearest_plumbing'> | null { return (['south','east','north','west'] as const)[index ?? -1] ?? null }

function wallServicePoint(spec: RoomSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>, anchor: FixtureSpec, tangentOffsetMm: number, elevationMm: number, label: string, kind: 'water' | 'electric', id: string, pointUsage?: FixtureSpec['point_usage']) {
  // Service points belong on the wall-panel face, matching the fixture wall
  // rather than the structural wall behind its 35 mm cavity.
  const boundary = layoutBoundary(spec)
  const wallIndex = wallIndexForSemantic(wall)
  const start = boundary[wallIndex]
  const end = boundary[(wallIndex + 1) % boundary.length]
  const length = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
  const baseRatio = ((anchor.x_mm - start.x_mm) * (end.x_mm - start.x_mm) + (anchor.z_mm - start.z_mm) * (end.z_mm - start.z_mm)) / (length * length)
  const ratio = Math.max(0.08, Math.min(0.92, baseRatio + tangentOffsetMm / length))
  const result = fixture(id, kind, label, start.x_mm + (end.x_mm - start.x_mm) * ratio, start.z_mm + (end.z_mm - start.z_mm) * ratio, 40, 40, 10, wallFacingRotation(wall), elevationMm)
  result.bound_wall_index = wallIndex
  result.point_usage = pointUsage
  return result
}

function isSpatialWetZone(item: FixtureSpec) {
  return item.kind === 'shower' && /淋浴(?:湿)?区/.test(item.label)
}

export function blocksUseClearance(candidate: FixtureSpec, clearance: FixtureSpec, other: FixtureSpec) {
  // The open shower zone is a floor-use region rather than a solid obstacle.
  // Fixture bodies cannot enter it, but standing/use clearances may overlap it.
  return !isSpatialWetZone(other) && !permittedAssembly(candidate, other) && overlaps(clearance, other)
}
function blocksDoorEnvelope(spec:RoomSpec,f:FixtureSpec){if((f.elevation_mm??0)>0)return false;const door=spec.openings.find(o=>o.kind==='door');if(!door)return false;const s=spec.boundary[door.wall_index],e=spec.boundary[(door.wall_index+1)%spec.boundary.length],b=rectangleBounds(spec),horizontal=Math.abs(e.x_mm-s.x_mm)>=Math.abs(e.z_mm-s.z_mm);if(horizontal){const lo=Math.min(s.x_mm,e.x_mm)+door.offset_mm,hi=lo+door.width_mm,top=s.z_mm>b.minZ+(b.maxZ-b.minZ)/2;return f.x_mm+f.width_mm/2>lo&&f.x_mm-f.width_mm/2<hi&&(top?f.z_mm+f.depth_mm/2>s.z_mm-800:f.z_mm-f.depth_mm/2<s.z_mm+800)}const lo=Math.min(s.z_mm,e.z_mm)+door.offset_mm,hi=lo+door.width_mm,right=s.x_mm>b.minX+(b.maxX-b.minX)/2;return f.z_mm+f.depth_mm/2>lo&&f.z_mm-f.depth_mm/2<hi&&(right?f.x_mm+f.width_mm/2>s.x_mm-800:f.x_mm-f.width_mm/2<s.x_mm+800)}
type PlacementAnchor = { x_mm: number; z_mm: number; rotation_deg?: number; locked?: boolean; max_distance_mm?: number }

function showerDrainPoint(spec: RoomSpec) {
  return spec.fixtures.find((fixture) => fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'shower')
}

function toiletDrainPoint(spec: RoomSpec) {
  return spec.fixtures.find((fixture) => fixture.kind === 'drain' && fixturePointUsage(fixture) === 'toilet')
}

function toiletAnchorPoint(spec: RoomSpec): PlacementAnchor | undefined {
  const drain = toiletDrainPoint(spec)
  if (!drain) return undefined
  return { ...toiletPlacementFromDrain(spec, drain), max_distance_mm: 600 }
}

function moveInsideRoomPolygon(spec: RoomSpec, item: FixtureSpec) {
  const boundary = spec.boundary
  if (fixtureInsideRoom(item, boundary)) return true
  const bounds = rectangleBounds(spec)
  const origin = { x: item.x_mm, z: item.z_mm }
  let best: { x: number; z: number; cost: number } | null = null
  for (let x = bounds.minX + item.width_mm / 2; x <= bounds.maxX - item.width_mm / 2; x += 50) {
    for (let z = bounds.minZ + item.depth_mm / 2; z <= bounds.maxZ - item.depth_mm / 2; z += 50) {
      const candidate = { ...item, x_mm: x, z_mm: z }
      if (!fixtureInsideRoom(candidate, boundary)) continue
      const cost = Math.hypot(x - origin.x, z - origin.z)
      if (!best || cost < best.cost) best = { x, z, cost }
    }
  }
  if (!best) return false
  item.x_mm = Math.round(best.x)
  item.z_mm = Math.round(best.z)
  return true
}

function wallNearestPoint(spec: RoomSpec, point: { x_mm: number; z_mm: number }): Exclude<SemanticWall, 'nearest_plumbing'> {
  const bounds = rectangleBounds(spec)
  const candidates: Array<[Exclude<SemanticWall, 'nearest_plumbing'>, number]> = [
    ['west', Math.abs(point.x_mm - bounds.minX)], ['east', Math.abs(bounds.maxX - point.x_mm)],
    ['south', Math.abs(point.z_mm - bounds.minZ)], ['north', Math.abs(bounds.maxZ - point.z_mm)],
  ]
  return candidates.sort((left, right) => left[1] - right[1])[0][0]
}

function infrastructureRule(spec: RoomSpec, instruction: LayoutInstruction, anchor?: PlacementAnchor): LayoutInstruction {
  return anchor ? { ...instruction, wall: wallNearestPoint(spec, anchor) } : instruction
}

function fixedLayoutObstacles(spec: RoomSpec) {
  return spec.fixtures.filter((fixture) => !fixture.layout_generated && ['pipe', 'column', 'radiator', 'other'].includes(fixture.kind))
}

function retainFixtureAcrossLayouts(fixture: FixtureSpec) {
  if (fixture.layout_generated) return false
  if (['floor_drain', 'drain', 'water', 'electric', 'pipe', 'column', 'radiator'].includes(fixture.kind)) return true
  // `syncToiletWithDrain` creates a temporary product placeholder. The selected
  // catalog toilet replaces it while its measured drain remains untouched.
  if (fixture.kind === 'toilet' && fixture.evidence_ids?.some((id) => id.startsWith('toilet-drain:'))) return false
  return true
}

function searchPlacement(spec: RoomSpec, item: FixtureSpec, occupied: FixtureSpec[], instruction: LayoutInstruction, plumbing?: FixtureSpec, trace = { evaluated: 0, feasible: 0 }, anchor?: PlacementAnchor) {
  const b = rectangleBounds(spec); const step = 100
  const rearGap = requiredRearWallGap(item)
  const boundary = spec.boundary
  const hostWall = instruction.wall === 'nearest_plumbing' ? wallNearestPoint(spec, plumbing ?? item) : instruction.wall
  const finishBoundary = layoutBoundary(spec), finishXs = finishBoundary.map((point) => point.x_mm), finishZs = finishBoundary.map((point) => point.z_mm)
  const finishBounds = { minX: Math.min(...finishXs), maxX: Math.max(...finishXs), minZ: Math.min(...finishZs), maxZ: Math.max(...finishZs) }
  const target = anchor
    ? { x: anchor.x_mm, z: anchor.z_mm }
    : plumbing
      ? { x: plumbing.x_mm, z: plumbing.z_mm }
      : semanticTarget(spec, instruction, item.width_mm, item.depth_mm)
  let best: { x:number; z:number; rotation:number; width:number; depth:number; score:number; clearance?:FixtureSpec } | null = null
  const rotations = rearGap === undefined ? (anchor?.rotation_deg === undefined ? [0, 90, 180, 270] : [anchor.rotation_deg]) : [wallFacingRotation(hostWall)]
  for (const rotation of rotations) {
    const width = rotation % 180 ? item.depth_mm : item.width_mm
    const depth = rotation % 180 ? item.width_mm : item.depth_mm
    const gridX = Array.from({ length: Math.max(0, Math.floor((b.maxX - width - 80) / step) + 1) }, (_, index) => Math.ceil((b.minX + width / 2 + 40) / step) * step + index * step)
    const gridZ = Array.from({ length: Math.max(0, Math.floor((b.maxZ - depth - 80) / step) + 1) }, (_, index) => Math.ceil((b.minZ + depth / 2 + 40) / step) * step + index * step)
    const wallX = rearGap === undefined ? undefined : hostWall === 'west' ? Math.round(finishBounds.minX + width / 2 + rearGap) : hostWall === 'east' ? Math.round(finishBounds.maxX - width / 2 - rearGap) : undefined
    const wallZ = rearGap === undefined ? undefined : hostWall === 'south' ? Math.round(finishBounds.minZ + depth / 2 + rearGap) : hostWall === 'north' ? Math.round(finishBounds.maxZ - depth / 2 - rearGap) : undefined
    const xValues = wallX === undefined ? (anchor?.locked ? [anchor.x_mm] : [...new Set([anchor?.x_mm, ...gridX].filter((value): value is number => value !== undefined))]) : [wallX]
    const zValues = wallZ === undefined ? (anchor?.locked ? [anchor.z_mm] : [...new Set([anchor?.z_mm, ...gridZ].filter((value): value is number => value !== undefined))]) : [wallZ]
    for (const x of xValues) {
      for (const z of zValues) {
        trace.evaluated++
        if (anchor?.max_distance_mm !== undefined && Math.hypot(x - anchor.x_mm, z - anchor.z_mm) > anchor.max_distance_mm) continue
        const candidate = { ...item, x_mm:x, z_mm:z, width_mm:width, depth_mm:depth, rotation_deg:rotation }
        const clearance = frontClearanceEnvelope(candidate, instruction)
        const occupiedConflict = occupied.some((other) => !permittedAssembly(candidate, other) && (
          overlaps(candidate, other, BODY_GAP_MM)
          || (placementClearances.get(other) ? overlaps(candidate, placementClearances.get(other)!) : false)
        ))
        const clearanceConflict = !!clearance && (
          !fixtureInsideRoom(clearance, boundary)
          || blocksDoorEnvelope(spec, clearance)
          || occupied.some((other) => blocksUseClearance(candidate, clearance, other))
        )
        if (!fixtureInsideRoom(candidate, boundary) || blocksDoorEnvelope(spec, candidate) || occupiedConflict || clearanceConflict) continue
        trace.feasible++
        const wallDistance = Math.min(x - b.minX - width / 2, b.maxX - x - width / 2, z - b.minZ - depth / 2, b.maxZ - z - depth / 2)
        const plumbingDistance = plumbing ? Math.hypot(x - plumbing.x_mm, z - plumbing.z_mm) : 0
        const semanticDistance = Math.hypot(x - target.x, z - target.z)
        const score = -wallDistance * 2 - plumbingDistance * 8 - semanticDistance * 8
        if (!best || score > best.score) best = { x, z, rotation, width, depth, score, clearance }
      }
    }
  }
  if (!best) {
    // Keep attached fixtures inside the wall-panel boundary even when a
    // clearance rule rejects this candidate. The caller still marks it invalid.
    if (rearGap !== undefined) snapRearToWall(spec, item, hostWall, rearGap)
    return false
  }
  Object.assign(item, { x_mm:best.x, z_mm:best.z, rotation_deg:best.rotation, width_mm:best.width, depth_mm:best.depth })
  if (rearGap !== undefined) item.bound_wall_index = wallIndexForSemantic(hostWall)
  if (best.clearance) placementClearances.set(item, best.clearance)
  return true
}
function isReachable(spec:RoomSpec,fixtures:FixtureSpec[],goal:{x:number;z:number}){const b=rectangleBounds(spec),step=100,radius=300,blocked=(x:number,z:number)=>!pointInPolygon(x,z,spec.boundary)||fixtures.some(f=>(f.elevation_mm??0)===0&&f.kind!=='floor_drain'&&Math.abs(x-f.x_mm)<f.width_mm/2+radius&&Math.abs(z-f.z_mm)<f.depth_mm/2+radius);const door=spec.openings.find(o=>o.kind==='door');if(!door)return true;const edge=spec.boundary[door.wall_index],next=spec.boundary[(door.wall_index+1)%spec.boundary.length],horizontal=Math.abs(next.x_mm-edge.x_mm)>=Math.abs(next.z_mm-edge.z_mm);let sx=horizontal?Math.min(edge.x_mm,next.x_mm)+door.offset_mm+door.width_mm/2:edge.x_mm,sz=horizontal?edge.z_mm:Math.min(edge.z_mm,next.z_mm)+door.offset_mm+door.width_mm/2;sx+=horizontal?0:(sx<(b.minX+b.maxX)/2?step:-step);sz+=horizontal?(sz<(b.minZ+b.maxZ)/2?step:-step):0;const key=(x:number,z:number)=>`${Math.round(x/step)},${Math.round(z/step)}`,queue=[[Math.round(sx/step)*step,Math.round(sz/step)*step]],seen=new Set<string>();while(queue.length){const [x,z]=queue.shift()!,k=key(x,z);if(seen.has(k))continue;if(Math.hypot(x-goal.x,z-goal.z)<=450)return true;if(blocked(x,z))continue;seen.add(k);for(const [dx,dz] of [[step,0],[-step,0],[0,step],[0,-step]])queue.push([x+dx,z+dz])}return false}

function check(code: string, passed: boolean, severity: LayoutCheckSeverity, source: string, message: string): LayoutCheck {
  return { code, passed, severity, source, message }
}

function makeSolution(spec: RoomSpec, demand: DemandProfile, budget: BudgetTier, preference?: LayoutPreference): LayoutSolution {
  const b = rectangleBounds(spec); const width = b.maxX - b.minX; const depth = b.maxZ - b.minZ
  const quality = budgets.indexOf(budget)
  const layoutScript=buildLayoutScript(demand,budget),instruction=(role:string)=>layoutScript.instructions.find(i=>i.fixture_role===role)!
  const style = preference?.style ?? (demand === 'laundry' ? '中古' : demand === 'elderly_safe' ? '轻法' : '素雅')
  const margin = 60
  const showerSize = demand === 'elderly_safe' ? 1000 : quality === 2 ? 1000 : quality === 1 ? 900 : 800
  const vanityWidth = demand === 'elderly_safe' ? 800 : [600, 700, 800][quality]
  const toiletWidth = 380; const toiletDepth = 680
  const measuredShowerDrain = showerDrainPoint(spec)
  const measuredToiletAnchor = toiletAnchorPoint(spec)
  const fixedObstacles = fixedLayoutObstacles(spec)
  // These are three independent topology candidates, not one placement with three product grades.
  const variant = quality
  const wetTarget=measuredShowerDrain?{x:measuredShowerDrain.x_mm,z:measuredShowerDrain.z_mm}:semanticTarget(spec,instruction('wet_zone'),showerSize,showerSize)
  const showerX = wetTarget.x
  const showerZ = wetTarget.z
  const shower = fixture(`${demand}-${budget}-shower`, 'shower', `${budgetLabels[budget]}淋浴区`, showerX, showerZ, showerSize, showerSize, 2000)
  const wetTrace={evaluated:0,feasible:0};searchPlacement(spec,shower,[],instruction('wet_zone'),measuredShowerDrain,wetTrace)
  const vanityProduct = graphProduct(demand, demand === 'elderly_safe' ? '适老浴室柜' : '浴室柜', quality, style)
  const vanityDimensions = dimensionsFor(vanityProduct.category, { width_mm: vanityWidth, depth_mm: 560, height_mm: quality === 2 ? 900 : 850 })
  const vt=semanticTarget(spec,instruction('vanity'),vanityDimensions.width_mm,vanityDimensions.depth_mm),vp={...vt,rotation:0}
  const vanity = productFixture(`${demand}-${budget}-vanity`, 'vanity', vanityProduct, vp.x, vp.z, { width_mm: vanityWidth, depth_mm: 560, height_mm: quality === 2 ? 900 : 850 }, vp.rotation)
  const tt=measuredToiletAnchor?{x:measuredToiletAnchor.x_mm,z:measuredToiletAnchor.z_mm}:{...semanticTarget(spec,instruction('toilet'),toiletWidth,toiletDepth)},tp={...tt,rotation:measuredToiletAnchor?.rotation_deg??0}
  const toiletX = tp.x
  const toiletZ = tp.z
  const toiletProduct = graphProduct(demand, '马桶', quality, style)
  const toilet = productFixture(`${demand}-${budget}-toilet`, 'toilet', toiletProduct, toiletX, toiletZ, { width_mm: toiletWidth, depth_mm: toiletDepth, height_mm: 760 }, tp.rotation)
  const drainDimensions = dimensionsFor('地漏', { width_mm: 100, depth_mm: 100, height_mm: 20 })
  const drain = fixture(`${demand}-${budget}-drain`, 'floor_drain', `湿区地漏 · ${drainDimensions.file_name}`, shower.x_mm, shower.z_mm, drainDimensions.width_mm, drainDimensions.depth_mm, drainDimensions.height_mm)
  const drainAsset = modelAssetForProduct('地漏')
  if (drainAsset) drain.model_asset = builtInAssetAsRoomAsset(drainAsset)
  // `shower` is a spatial calculation envelope, never a catalog product or furniture.
  // Only the drain and products returned by the product graph enter `fixtures`.
  const fixtures = [vanity, toilet, ...(measuredShowerDrain ? [] : [drain])]
  const showerProduct = graphProduct(demand, '花洒', quality, style)
  const heaterProduct = graphProduct(demand, '热水器', quality, style)
  const heaterDimensions = dimensionsFor(heaterProduct.category, { width_mm: 720, depth_mm: 180, height_mm: 430 })
  fixtures.push(productFixture(`${demand}-${budget}-shower-head`, 'other', showerProduct, shower.x_mm, shower.z_mm, { width_mm: 120, depth_mm: 80, height_mm: 1100 }, 0, 700))
  // Keep the full measured heater bound clear of the 260 mm pipe chase at the origin.
  fixtures.push(productFixture(`${demand}-${budget}-heater`, 'other', heaterProduct, b.minX + heaterDimensions.width_mm / 2 + 280, b.minZ + heaterDimensions.depth_mm / 2 + 20, { width_mm: 720, depth_mm: 180, height_mm: 430 }, 0, Math.max(1200, (spec.height_mm ?? 2200) - heaterDimensions.height_mm - 25)))
  if (demand === 'laundry') {
    const washerProduct = graphProduct(demand, '洗衣机', quality, style)
    const washerPositions = [
      { x: b.minX + width * 0.38, z: b.maxZ - 720, rotation: 0 },
      { x: b.maxX - 450, z: b.minZ + 450, rotation: 90 },
      { x: b.minX + 650, z: b.minZ + 760, rotation: 0 },
    ]
    const wp = washerPositions[variant]
    fixtures.push(productFixture(`${demand}-${budget}-washer`, 'other', washerProduct, wp.x, wp.z, { width_mm: 600, depth_mm: 620, height_mm: 850 }, wp.rotation))
  }
  if (demand === 'elderly_safe') {
    const seat = graphProduct(demand, '淋浴椅', quality, style)
    const showerBar = graphProduct(demand, '花洒扶手', quality, style)
    const toiletBar = graphProduct(demand, '马桶扶手', quality, style)
    fixtures.push(productFixture(`${demand}-${budget}-seat`, 'other', seat, shower.x_mm, shower.z_mm, { width_mm: 420, depth_mm: 360, height_mm: 450 }))
    fixtures.push(productFixture(`${demand}-${budget}-shower-bar`, 'other', showerBar, shower.x_mm + 380, shower.z_mm, { width_mm: 80, depth_mm: 600, height_mm: 900 }, 0, 700))
    fixtures.push(productFixture(`${demand}-${budget}-toilet-bar`, 'other', toiletBar, toilet.x_mm + 330, toilet.z_mm, { width_mm: 80, depth_mm: 600, height_mm: 750 }, 0, 650))
  }
  const solverTrace={evaluated:wetTrace.evaluated,feasible:wetTrace.feasible},groundProducts=fixtures.filter(f=>['vanity','toilet'].includes(f.kind)||/(洗衣机|淋浴椅)/.test(f.label)).sort((left,right)=>Number(right.kind==='toilet')-Number(left.kind==='toilet')),placed=[...fixedObstacles,...fixtures.filter(f=>!groundProducts.includes(f)&&(f.elevation_mm??0)===0)];for(const item of groundProducts){const role=item.kind==='vanity'?'vanity':item.kind==='toilet'?'toilet':item.label.includes('洗衣机')?'washer':'wet_zone',plumbing=item.kind==='toilet'?toiletDrainPoint(spec):item.label.includes('洗衣机')?spec.fixtures.find(f=>f.kind==='water'):item.kind==='vanity'?spec.fixtures.find(f=>f.kind==='water'&&fixturePointUsage(f)==='basin'):undefined,anchor=item.kind==='toilet'?measuredToiletAnchor:undefined,rule=infrastructureRule(spec,instruction(role),anchor);searchPlacement(spec,item,placed,rule,plumbing,solverTrace,anchor);placed.push(item)}
  for(const item of fixtures.filter(f=>(f.elevation_mm??0)>0)){
    const baseRule=item.label.includes('热水器')?instruction('heater'):item.label.includes('扶手')?instruction('grab_bars'):instruction('wet_zone')
    const hostWall=item.label.includes('马桶扶手')?wallNearestPoint(spec,toilet):baseRule.wall==='nearest_plumbing'?wallNearestPoint(spec,item):baseRule.wall
    if(item.label.includes('马桶扶手')){item.x_mm=Math.round(toilet.x_mm+330);item.z_mm=Math.round(toilet.z_mm)}
    snapRearToWall(spec,item,hostWall,requiredRearWallGap(item)??0)
    moveInsideRoomPolygon(spec,item)
  }
  const showerHead=fixtures.find(item=>/花洒/.test(item.label)&&!/扶手/.test(item.label))
  const washer=fixtures.find(item=>/洗衣机/.test(item.label))
  if(showerHead){const rule=instruction('wet_zone'),wall=semanticWallForIndex(showerHead.bound_wall_index)??(rule.wall==='nearest_plumbing'?wallNearestPoint(spec,showerHead):rule.wall);fixtures.push(wallServicePoint(spec,wall,showerHead,-75,1050,'自动花洒冷水点','water',`${demand}-${budget}-shower-cold`,'shower'),wallServicePoint(spec,wall,showerHead,75,1050,'自动花洒热水点','water',`${demand}-${budget}-shower-hot`,'shower'))}
  if(washer){const rule=instruction('washer'),wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,washer):rule.wall;fixtures.push(wallServicePoint(spec,wall,washer,-120,1100,'自动洗衣机进水点','water',`${demand}-${budget}-washer-water`),wallServicePoint(spec,wall,washer,120,1200,'自动洗衣机电点','electric',`${demand}-${budget}-washer-electric`))}
  const reachable=isReachable(spec,groundProducts,{x:shower.x_mm,z:shower.z_mm})

  const outsideFixtures = fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind) && !fixtureInsideRoom(f, spec.boundary))
  const inside = outsideFixtures.length === 0
  const solids = fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind))
  const collisions = solids.flatMap((a, i) => solids.slice(i + 1).filter((other) => !permittedAssembly(a, other) && overlaps(a, other, 30)).map((other) => `${a.label}/${other.label}`))
  const frontClearance = Math.max(0, depth - vanity.depth_mm - shower.depth_mm)
  const toiletSideClearance = Math.min(toilet.x_mm - toiletWidth / 2 - b.minX, b.maxX - (toilet.x_mm + toiletWidth / 2))
  const toiletFrontClearance = toilet.z_mm - toiletDepth / 2 - (b.minZ + vanity.depth_mm + margin)
  const doorClear=!fixtures.some(f=>!['floor_drain','water','electric'].includes(f.kind)&&blocksDoorEnvelope(spec,f))
  const hasDrainEvidence = spec.fixtures.some((f) => f.kind === 'floor_drain')
  const toiletOffset = measuredToiletAnchor ? Math.hypot(toilet.x_mm - measuredToiletAnchor.x_mm, toilet.z_mm - measuredToiletAnchor.z_mm) : 0
  const rearWallFailures=fixtures.filter(item=>requiredRearWallGap(item)!==undefined).filter(item=>{const wall=semanticWallForIndex(item.bound_wall_index)??wallNearestPoint(spec,item);return Math.abs(rearWallDistance(spec,item,wall)-(requiredRearWallGap(item)??0))>10})
  const checks: LayoutCheck[] = [
    check('G01', inside, 'error', '几何', inside ? '全部设备实体位于房间边界内' : `设备越界：${outsideFixtures.map((f) => f.label).join('、')}`),
    check('G01-COLLISION', collisions.length === 0, 'error', '几何', collisions.length ? `设备实体碰撞：${collisions.join('、')}` : '设备实体包围盒无碰撞（30mm 容差）'),
    check('C01', frontClearance >= 800, 'warning', 'D', `主要通路估算净宽 ${frontClearance}mm（建议 ≥800mm）`),
    check('G04', doorClear, 'error', '几何', doorClear ? '入口开门包络未被设备占用' : '设备侵入入口开门包络'),
    check('G06-WALL-ATTACH', rearWallFailures.length===0, 'warning', '安装约束', rearWallFailures.length?`设备未满足墙板吸附或插电预留：${rearWallFailures.map(item=>item.label).join('、')}`:'墙板距墙 35mm；壁挂设备吸附完成面，洗衣机背后预留 50mm'),
    check('MEP-AUTO-POINTS', !!showerHead&&fixtures.filter(item=>item.kind==='water'&&item.point_usage==='shower').length>=2&&(!washer||fixtures.some(item=>item.label==='自动洗衣机进水点')&&fixtures.some(item=>item.label==='自动洗衣机电点')), 'error', '水电点规则', washer?'已生成花洒冷热水点及洗衣机进水、电点':'已生成花洒冷热水点'),
    check('T01', toiletSideClearance >= 400, 'warning', 'D', `坐便器最近侧向净距 ${Math.round(toiletSideClearance)}mm（建议 ≥400mm）`),
    check('T02', toiletFrontClearance >= 600, 'warning', 'D', `坐便器前方估算净距 ${Math.max(0, Math.round(toiletFrontClearance))}mm（建议 ≥600mm）`),
    check('S01', showerSize >= 800, 'warning', 'D', `淋浴内部净尺寸 ${showerSize}×${showerSize}mm（建议 ≥800×800mm）`),
    check('G05', reachable, 'warning', '栅格可达性', reachable?'门口至湿区存在 ≥600mm 连续可达路径':'门口至湿区 600mm 通路未通过，需人工调整或选择其他候选'),
    check('INPUT-DRAIN', hasDrainEvidence, 'warning', '输入门禁', hasDrainEvidence ? `沿用量房排水证据${measuredShowerDrain ? `（淋浴地漏 ${measuredShowerDrain.x_mm},${measuredShowerDrain.z_mm}）` : ''}` : '量房数据没有既有地漏/排水点；坐便移位、坡度和地漏位置待专业确认'),
    check('PLUMBING-TOILET', !measuredToiletAnchor || toiletOffset <= 600, 'error', '排水粗装约束', measuredToiletAnchor ? `马桶中心相对排水粗装锚点微调 ${Math.round(toiletOffset)}mm` : '量房未提供马桶排水粗装点'),
    check('KG-CATALOG', fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind)).every((f) => /^[A-Z]+(?:\d|-)/.test(f.label)), 'error', '产品知识图谱', '所有家具实体均携带 product_catalog.csv 材料编号；淋浴湿区与水电点不进入家具实体清单'),
    check('KG-ACCESSIBLE', demand !== 'elderly_safe' || (!fixtures.some((f) => f.label.includes('淋浴隔断')) && ['LYY-1', 'FSH-1', 'FSM-1'].every((code) => fixtures.some((f) => f.label.startsWith(code)))), 'error', '设备规则', demand === 'elderly_safe' ? '适老方案包含淋浴椅、花洒扶手、马桶扶手，且禁用淋浴隔断' : '非适老分支'),
    check('MODEL-DIMENSIONS', fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind)).every((f) => !f.label.includes(' · proxy')), 'warning', 'AGEN-44 模型包围盒', fixtures.some((f) => f.label.includes(' · proxy')) ? `附件缺少可解析模型的品类使用代理尺寸：${fixtures.filter((f) => f.label.includes(' · proxy')).map((f) => f.label.split(' ')[1]).join('、')}` : '家具尺寸均来自附件中成功解析的模型包围盒'),
    check('MODEL-ASSETS', fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind)&&!f.label.includes('马桶')).every((f) => !!f.model_asset), 'warning', '内置模型库', fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind)&&!f.model_asset).length ? `缺少可渲染模型的实体继续使用代理几何：${fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind)&&!f.model_asset).map((f) => f.label.split(' · ')[0]).join('、')}` : '已按产品编号绑定内置模型资产'),
    check('PIPE-ORIGIN', true, 'info', '量房', '原点墙线交点为 (0,0)，260×320mm 内折按包管占位处理'),
    check('G11', false, 'info', 'A/B', '湿区电气分区、IP 防护、漏保及等电位待专业确认'),
  ]
  const anchors: LayoutAnchor[] = fixtures.map((f) => {const role=f.kind==='vanity'?'vanity':f.kind==='toilet'?'toilet':f.label.includes('洗衣机')?'washer':f.kind==='floor_drain'?'wet_zone':'heater',rule=instruction(role)??instruction('wet_zone');return{id:`anchor-${f.id}`,label:`${f.label}中心点`,x_mm:f.x_mm,z_mm:f.z_mm,instruction:`${rule.zone}区 / 靠${rule.wall}墙 / ${rule.near?`邻近 ${rule.near} / `:''}旋转 ${f.rotation_deg}°`}})
  const productLines = fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind)).map((f) => {
    const code = f.label.split(' ')[0]
    const product = (graphOutput.scenarios[demand].products as GraphProduct[]).find((item) => item.code === code)
    return { code, category: product?.category ?? f.label.split(' ')[1] ?? '设备', spec: product?.spec ?? '规格待确认', price: product?.price ?? 0, quantity: 1, unit: '件' }
  })
  const quantities = surfaceQuantities(spec)
  const wallProduct = materialProduct('墙板', quality, style)
  const floorProduct = materialProduct('地砖', quality, style)
  const floorAsset=surfaceAssetForProduct(floorProduct.材料编号),floorLayout=optimizeFloorLayout(spec,floorAsset?.dimensions_mm.width??600,floorAsset?.dimensions_mm.depth??600)
  const ceilingProduct = materialProduct('吊顶', quality, style)
  const materialProducts = [
    { product: wallProduct, quantity: quantities.wall },
    { product: floorProduct, quantity: quantities.floor },
    { product: ceilingProduct, quantity: quantities.ceiling },
  ]
  const materialLines = materialProducts.map(({ product, quantity }) => {
    const asset = surfaceAssetForProduct(product.材料编号)
    const price = Number(product.单价)
    return { code: product.材料编号, category: product.材料名称, spec: product.规格型号, price, quantity, unit: product.数量单位, subtotal: Math.round(price * quantity * 100) / 100, model_asset_id: asset?.id }
  })
  const equipmentPrice = productLines.reduce((sum, line) => sum + line.price, 0)
  const materialPrice = materialLines.reduce((sum, line) => sum + line.subtotal, 0)
  const totalPrice = Math.round((equipmentPrice + materialPrice) * 100) / 100
  const score = Math.max(0, Math.min(100, 100 - checks.filter((c) => !c.passed && c.severity === 'error').length * 25 - checks.filter((c) => !c.passed && c.severity === 'warning').length * 5 + quality * 2))
  const summaries = ['湿区靠排水端，设备沿外围布置，保留纵向通道', '湿区与洁具分居两侧，形成左右功能分区', '湿区居中组织动线，洁具分散到不同墙面']
  checks.push(check('FLOOR-CUT',floorLayout.narrow_cut_count===0,'warning','地砖排版优化器',floorLayout.description))
  return { id: `${demand}-${budget}`, demand, budget, title: `${demandLabels[demand]} · ${budgetLabels[budget]}`, budget_label: budgetLabels[budget], layout_label: layoutLabels[budget], layout_summary: `依据量房基础设施与几何约束求解；${summaries[variant]}；${floorLayout.description}`, product_lines: productLines, material_lines: materialLines, surface_materials: { wall: surfaceAssetForProduct(wallProduct.材料编号), floor: floorAsset }, equipment_price: equipmentPrice, material_price: materialPrice, total_price: totalPrice, score, fixtures, anchors, checks, wet_zone: { x_mm: shower.x_mm, z_mm: shower.z_mm, width_mm: shower.width_mm, depth_mm: shower.depth_mm },floor_layout:floorLayout,layout_script:layoutScript,solver_trace:{candidates_evaluated:solverTrace.evaluated,feasible_candidates:solverTrace.feasible,reachable},selected_product_ids:[] }
}

function levelGraphProduct(product:LayoutProductInput):GraphProduct{return{graph_id:product.product_id,code:product.catalog_code,category:product.category,spec:product.spec,price:product.unit_price}}
function levelFallback(category:string){const defaults:Record<string,{width_mm:number;depth_mm:number;height_mm:number}>={"花洒":{width_mm:120,depth_mm:80,height_mm:1100},"热水器":{width_mm:720,depth_mm:180,height_mm:430},"马桶":{width_mm:380,depth_mm:680,height_mm:760},"浴室柜":{width_mm:800,depth_mm:500,height_mm:850},"适老浴室柜":{width_mm:800,depth_mm:500,height_mm:850},"洗衣机":{width_mm:600,depth_mm:620,height_mm:850},"淋浴椅":{width_mm:420,depth_mm:360,height_mm:450},"花洒扶手":{width_mm:80,depth_mm:600,height_mm:900},"马桶扶手":{width_mm:80,depth_mm:600,height_mm:750}};return defaults[category]??{width_mm:500,depth_mm:500,height_mm:800}}
function levelRole(category:string){if(category==='马桶')return'toilet';if(['浴室柜','适老浴室柜'].includes(category))return'vanity';if(category==='洗衣机')return'washer';if(category==='热水器')return'heater';if(['花洒扶手','马桶扶手'].includes(category))return'grab_bars';return'wet_zone'}
function levelKind(category:string):FixtureSpec['kind']{if(category==='马桶')return'toilet';if(['浴室柜','适老浴室柜'].includes(category))return'vanity';return'other'}
const distinctLayoutWalls: Array<Partial<Record<'wet_zone'|'vanity'|'toilet', SemanticWall>>> = [
  { wet_zone: 'east', vanity: 'west', toilet: 'north' },
  { wet_zone: 'west', vanity: 'east', toilet: 'south' },
  { wet_zone: 'south', vanity: 'north', toilet: 'east' },
]
function layoutScriptSignature(script: LayoutScript) {
  return script.instructions.map((item) => `${item.fixture_role}:${item.wall}:${item.zone}:${item.near ?? ''}:${item.min_clearance_mm}`).sort().join('|')
}
function withDistinctLayoutWalls(level: LayoutLevelDecision, walls: Partial<Record<'wet_zone'|'vanity'|'toilet', SemanticWall>>) {
  const availableRoles = new Set(['wet_zone', ...level.products.map((product) => levelRole(product.category))])
  const instructions = level.layout_script.instructions.map((item) => {
    const wall = walls[item.fixture_role as keyof typeof walls]
    return wall && availableRoles.has(item.fixture_role) ? { ...item, wall } : item
  })
  for (const [role, wall] of Object.entries(walls) as Array<[keyof typeof walls, SemanticWall]>) {
    if (availableRoles.has(role) && !instructions.some((item) => item.fixture_role === role)) instructions.push({ fixture_role: role, wall, zone: role === 'wet_zone' ? 'wet' : 'dry', min_clearance_mm: role === 'wet_zone' ? 0 : 600 })
  }
  return { ...level, layout_script: { ...level.layout_script, instructions } }
}
function diversifyDuplicateLayoutLevels(levels: LayoutLevelDecision[]) {
  const used = new Set<string>()
  return levels.map((level) => {
    const initial = layoutScriptSignature(level.layout_script)
    if (!used.has(initial)) { used.add(initial); return level }
    for (const walls of distinctLayoutWalls) {
      const diversified = withDistinctLayoutWalls(level, walls)
      const signature = layoutScriptSignature(diversified.layout_script)
      if (!used.has(signature)) { used.add(signature); return diversified }
    }
    return level
  })
}
function makeLevelSolution(spec:RoomSpec,level:LayoutLevelDecision,preference?:LayoutPreference):LayoutSolution{
  const demand=level.demand_profile,budget=level.product_tier,quality=budgets.indexOf(budget),b=rectangleBounds(spec)
  const layoutScript=level.layout_script as LayoutScript,instruction=(role:string)=>layoutScript.instructions.find(i=>i.fixture_role===role)??layoutScript.instructions.find(i=>i.fixture_role==='wet_zone')??buildLayoutScript(demand,budget).instructions[0]
  const style=preference?.style??(demand==='laundry'?'中古':demand==='elderly_safe'?'轻法':'素雅'),products=level.products.map(levelGraphProduct),productInputs=new Map(level.products.map(product=>[product.product_id,product]))
  const measuredShowerDrain=showerDrainPoint(spec),measuredToiletAnchor=toiletAnchorPoint(spec),fixedObstacles=fixedLayoutObstacles(spec)
  const showerSize=demand==='elderly_safe'?1000:quality===2?1000:quality===1?900:800,wetRule=instruction('wet_zone'),wetTarget=measuredShowerDrain?{x:measuredShowerDrain.x_mm,z:measuredShowerDrain.z_mm}:semanticTarget(spec,wetRule,showerSize,showerSize)
  const reservedToilet=measuredToiletAnchor?products.find(product=>product.category==='马桶'):undefined,reservedDims=reservedToilet?dimensionsFor('马桶',levelFallback('马桶')):undefined,reservedRotation=measuredToiletAnchor?.rotation_deg??0,reservedWidth=reservedDims?(Math.abs(reservedRotation)%180===90?reservedDims.depth_mm:reservedDims.width_mm):0,reservedDepth=reservedDims?(Math.abs(reservedRotation)%180===90?reservedDims.width_mm:reservedDims.depth_mm):0
  const reservedBodies=measuredToiletAnchor&&reservedDims?[fixture(`${level.id}-reserved-toilet`,'toilet','实测排污点马桶预留体积',measuredToiletAnchor.x_mm,measuredToiletAnchor.z_mm,reservedWidth,reservedDepth,reservedDims.height_mm,reservedRotation)]:[]
  const shower=fixture(`${level.id}-wet-zone`,'shower',`${level.name}淋浴湿区`,wetTarget.x,wetTarget.z,showerSize,showerSize,2000),solverTrace={evaluated:0,feasible:0},placementFailures:string[]=[];if(!searchPlacement(spec,shower,[...fixedObstacles,...reservedBodies],wetRule,measuredShowerDrain,solverTrace))placementFailures.push(shower.label)
  const drainDimensions=dimensionsFor('地漏',{width_mm:100,depth_mm:100,height_mm:20}),drain=fixture(`${level.id}-drain`,'floor_drain',`湿区地漏 · ${drainDimensions.file_name}`,shower.x_mm,shower.z_mm,drainDimensions.width_mm,drainDimensions.depth_mm,drainDimensions.height_mm),drainAsset=modelAssetForProduct('地漏');if(drainAsset)drain.model_asset=builtInAssetAsRoomAsset(drainAsset)
  const fixtures:FixtureSpec[]=[...(measuredShowerDrain?[]:[drain])],fixtureProducts=new Map<string,GraphProduct>(),ground:FixtureSpec[]=[],elevated:FixtureSpec[]=[]
  for(const product of products){
    const fallback=levelFallback(product.category),role=levelRole(product.category),rule=instruction(role),dims=dimensionsFor(product.category,fallback),target=semanticTarget(spec,rule,dims.width_mm,dims.depth_mm),kind=levelKind(product.category)
    let x=target.x,z=target.z,elevation=0
    if(product.category==='马桶'&&measuredToiletAnchor){x=measuredToiletAnchor.x_mm;z=measuredToiletAnchor.z_mm}
    if(product.category==='花洒'){x=shower.x_mm;z=shower.z_mm;elevation=700}
    if(product.category==='热水器'){elevation=Math.max(1200,(spec.height_mm??2200)-dims.height_mm-25)}
    if(product.category==='花洒扶手'){x=shower.x_mm+Math.min(380,showerSize/2-40);z=shower.z_mm;elevation=700}
    if(product.category==='马桶扶手'){const toilet=fixtures.find(f=>f.kind==='toilet');x=(toilet?.x_mm??target.x)+330;z=toilet?.z_mm??target.z;elevation=650}
    const entity=productFixture(`${level.id}-${product.graph_id}`,kind,product,x,z,fallback,measuredToiletAnchor?.rotation_deg??0,elevation,true,productInputs.get(product.graph_id)?.model_lookup);fixtures.push(entity);fixtureProducts.set(entity.id,product)
    if(elevation>0)elevated.push(entity);else ground.push(entity)
  }
  const placed:FixtureSpec[]=[...fixedObstacles,drain,shower]
  ground.sort((left,right)=>Number(fixtureProducts.get(right.id)?.category==='马桶')-Number(fixtureProducts.get(left.id)?.category==='马桶'))
  for(const entity of ground){const product=fixtureProducts.get(entity.id)!,role=levelRole(product.category),plumbing=product.category==='马桶'?toiletDrainPoint(spec):product.category==='洗衣机'?spec.fixtures.find(f=>f.kind==='water'):product.category.includes('浴室柜')?spec.fixtures.find(f=>f.kind==='water'&&fixturePointUsage(f)==='basin'):undefined,anchor=product.category==='马桶'?measuredToiletAnchor:undefined,rule=infrastructureRule(spec,instruction(role),anchor);if(!searchPlacement(spec,entity,placed,rule,plumbing,solverTrace,anchor))placementFailures.push(entity.label);placed.push(entity)}
  const toilet=fixtures.find(f=>f.kind==='toilet')
  for(const entity of elevated){const product=fixtureProducts.get(entity.id)!,baseRule=instruction(levelRole(product.category)),rule=product.category==='马桶扶手'&&toilet?{...baseRule,wall:wallNearestPoint(spec,toilet)}:baseRule;if(product.category==='马桶扶手'&&toilet){entity.x_mm=Math.round(toilet.x_mm+330);entity.z_mm=toilet.z_mm}const wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,entity):rule.wall;snapRearToWall(spec,entity,wall,requiredRearWallGap(entity)??0);moveInsideRoomPolygon(spec,entity)}
  const showerHead=fixtures.find(item=>/花洒/.test(item.label)&&!/扶手/.test(item.label)),washer=fixtures.find(item=>/洗衣机/.test(item.label))
  if(showerHead){const rule=instruction('wet_zone'),wall=semanticWallForIndex(showerHead.bound_wall_index)??(rule.wall==='nearest_plumbing'?wallNearestPoint(spec,showerHead):rule.wall);fixtures.push(wallServicePoint(spec,wall,showerHead,-75,1050,'自动花洒冷水点','water',`${level.id}-shower-cold`,'shower'),wallServicePoint(spec,wall,showerHead,75,1050,'自动花洒热水点','water',`${level.id}-shower-hot`,'shower'))}
  if(washer){const rule=instruction('washer'),wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,washer):rule.wall;fixtures.push(wallServicePoint(spec,wall,washer,-120,1100,'自动洗衣机进水点','water',`${level.id}-washer-water`),wallServicePoint(spec,wall,washer,120,1200,'自动洗衣机电点','electric',`${level.id}-washer-electric`))}
  const outside=fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind)&&!fixtureInsideRoom(f,spec.boundary)),solids=fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind)),collisions=solids.flatMap((a,i)=>solids.slice(i+1).filter(other=>!permittedAssembly(a,other)&&overlaps(a,other,30)).map(other=>`${a.label}/${other.label}`)),doorClear=!fixtures.some(f=>!['floor_drain','water','electric'].includes(f.kind)&&blocksDoorEnvelope(spec,f)),reachable=isReachable(spec,ground,{x:shower.x_mm,z:shower.z_mm})
  const selectedCodes=new Set(level.products.map(product=>product.catalog_code)),fixtureCodes=new Set([...fixtureProducts.values()].map(product=>product.code)),selectedGraphIds=new Set(level.product_ids),fixtureGraphIds=new Set([...fixtureProducts.values()].map(product=>product.graph_id)),accessibleSelected=new Set(level.products.map(product=>product.category)),hasAccessible=['淋浴椅','花洒扶手','马桶扶手'].every(category=>accessibleSelected.has(category))
  const exactSelection=selectedCodes.size===fixtureCodes.size&&[...selectedCodes].every(code=>fixtureCodes.has(code))&&selectedGraphIds.size===fixtureGraphIds.size&&[...selectedGraphIds].every(id=>fixtureGraphIds.has(id))
  const toiletOffset=measuredToiletAnchor&&toilet?Math.hypot(toilet.x_mm-measuredToiletAnchor.x_mm,toilet.z_mm-measuredToiletAnchor.z_mm):0
  const rearWallFailures=fixtures.filter(item=>requiredRearWallGap(item)!==undefined).filter(item=>{const wall=semanticWallForIndex(item.bound_wall_index)??wallNearestPoint(spec,item);return Math.abs(rearWallDistance(spec,item,wall)-(requiredRearWallGap(item)??0))>10})
  const checks:LayoutCheck[]=[check('G01',outside.length===0,'error','几何',outside.length?`设备越界：${outside.map(f=>f.label).join('、')}`:'全部设备实体位于房间边界内'),check('G01-COLLISION',collisions.length===0,'error','几何',collisions.length?`设备实体碰撞：${collisions.join('、')}`:'设备实体包围盒无碰撞（30mm 容差）'),check('G02-CLEARANCE',placementFailures.length===0,'error','几何净空',placementFailures.length?`没有满足前向净空和实体间距的候选位置：${placementFailures.join('、')}`:'全部落地设备满足布局脚本的前向使用净空'),check('G04',doorClear,'error','几何',doorClear?'入口开门包络未被设备占用':'设备侵入入口开门包络'),check('G06-WALL-ATTACH',rearWallFailures.length===0,'warning','安装约束',rearWallFailures.length?`设备未满足墙板吸附或插电预留：${rearWallFailures.map(item=>item.label).join('、')}`:'墙板距墙 35mm；壁挂设备吸附完成面，洗衣机背后预留 50mm'),check('MEP-AUTO-POINTS', !!showerHead&&fixtures.filter(item=>item.kind==='water'&&item.point_usage==='shower').length>=2&&(!washer||fixtures.some(item=>item.label==='自动洗衣机进水点')&&fixtures.some(item=>item.label==='自动洗衣机电点')), 'error', '水电点规则', washer?'已生成花洒冷热水点及洗衣机进水、电点':'已生成花洒冷热水点'),check('G05',reachable,'warning','栅格可达性',reachable?'门口至湿区存在连续可达路径':'门口至湿区通路未通过，需选择其他候选'),check('PLUMBING-TOILET',!measuredToiletAnchor||toiletOffset<=600,'error','排水粗装约束',measuredToiletAnchor?`马桶中心相对排水粗装锚点微调 ${Math.round(toiletOffset)}mm`:'量房未提供马桶排水粗装点'),check('KG-SELECTION',exactSelection,'error','产品知识图谱','布局实体与需求助手选择的 graph_id 和目录编号逐项一致'),check('KG-ACCESSIBLE',demand!=='elderly_safe'||hasAccessible,'error','设备规则',demand==='elderly_safe'?'适老安全设备完整且未使用淋浴隔断':'非适老分支'),check('MODEL-DIMENSIONS',fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind)).every(f=>!f.label.includes(' · proxy')),'warning','模型包围盒','实体优先使用精确 SKU 或后端模型快照尺寸，缺失模型时使用审计代理尺寸'),check('MODEL-ASSETS',fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind)).every(f=>!!f.model_asset),'warning','模型资产','实体优先按精确 SKU 绑定本地模型，否则沿用后端产品模型快照'),check('INPUT-DRAIN',spec.fixtures.some(f=>f.kind==='floor_drain'),'warning','输入门禁',measuredShowerDrain?'沿用量房淋浴排水点':'量房未提供淋浴排水点，位置待专业确认')]
  const anchors:LayoutAnchor[]=fixtures.map(entity=>{const product=fixtureProducts.get(entity.id),rule=instruction(product?levelRole(product.category):'wet_zone');return{id:`anchor-${entity.id}`,label:`${entity.label}中心点`,x_mm:entity.x_mm,z_mm:entity.z_mm,instruction:`${rule.zone}区 / 靠${rule.wall}墙 / ${rule.near?`邻近 ${rule.near} / `:''}最小净距 ${rule.min_clearance_mm}mm / 旋转 ${entity.rotation_deg}°`}})
  const productLines=level.products.map(product=>({code:product.catalog_code,category:product.category,spec:product.spec,price:product.unit_price,quantity:1,unit:product.price_unit})),quantities=surfaceQuantities(spec),wallProduct=materialProduct('墙板',quality,style),floorProduct=materialProduct('地砖',quality,style),ceilingProduct=materialProduct('吊顶',quality,style),floorAsset=surfaceAssetForProduct(floorProduct.材料编号),floorLayout=optimizeFloorLayout(spec,floorAsset?.dimensions_mm.width??600,floorAsset?.dimensions_mm.depth??600),materialLines=[{product:wallProduct,quantity:quantities.wall},{product:floorProduct,quantity:quantities.floor},{product:ceilingProduct,quantity:quantities.ceiling}].map(({product,quantity})=>({code:product.材料编号,category:product.材料名称,spec:product.规格型号,price:Number(product.单价),quantity,unit:product.数量单位,subtotal:Math.round(Number(product.单价)*quantity*100)/100,model_asset_id:surfaceAssetForProduct(product.材料编号)?.id})),equipmentPrice=productLines.reduce((sum,line)=>sum+line.price,0),materialPrice=materialLines.reduce((sum,line)=>sum+line.subtotal,0),score=Math.max(0,Math.min(100,100-checks.filter(c=>!c.passed&&c.severity==='error').length*25-checks.filter(c=>!c.passed&&c.severity==='warning').length*5+quality*2))
  return{id:level.id,demand,budget,title:level.name,budget_label:budgetLabels[budget],layout_label:layoutLabels[budget],layout_summary:`${level.reason}；${floorLayout.description}`,model_reason:level.reason,product_lines:productLines,material_lines:materialLines,surface_materials:{wall:surfaceAssetForProduct(wallProduct.材料编号),floor:floorAsset},equipment_price:equipmentPrice,material_price:materialPrice,total_price:Math.round((equipmentPrice+materialPrice)*100)/100,score,fixtures,anchors,checks,wet_zone:{x_mm:shower.x_mm,z_mm:shower.z_mm,width_mm:shower.width_mm,depth_mm:shower.depth_mm},floor_layout:floorLayout,layout_script:layoutScript,solver_trace:{candidates_evaluated:solverTrace.evaluated,feasible_candidates:solverTrace.feasible,reachable},selected_product_ids:[...level.product_ids]}
}

export function generateLayoutSolutions(spec: RoomSpec, preference?: LayoutPreference) {
  if(preference?.levels?.length)return diversifyDuplicateLayoutLevels(preference.levels.slice(0,3)).map(level=>makeLevelSolution(spec,level,preference))
  return [generateAutomaticLayoutSolution(spec, preference)]
}

export function generateAutomaticLayoutSolution(spec: RoomSpec, preference?: LayoutPreference): LayoutSolution {
  const hasLaundryInfrastructure = spec.fixtures.some((fixture) =>
    /洗衣/.test(fixture.label),
  )
  const demand: DemandProfile = hasLaundryInfrastructure ? 'laundry' : 'standard_shower'
  const solution = makeSolution(spec, demand, 'comfort', preference)
  return {
    ...solution,
    id: 'automatic-layout',
    title: '当前约束求解结果',
    budget_label: '本地产品规则',
    layout_label: '量房约束自动布局',
    layout_summary: `根据现有门洞、排水、给水和障碍物执行网格候选搜索；${solution.floor_layout.description}`,
  }
}

export function applyLayoutSolution(spec: RoomSpec, solution: LayoutSolution): RoomSpec {
  const blocking = solution.checks.filter((item) => !item.passed && item.severity === 'error')
  if (blocking.length) throw new Error(`方案存在硬错误：${blocking.map((item) => item.code).join('、')}`)
  const s = solution.wet_zone
  const retainedFixtures = spec.fixtures.filter(retainFixtureAcrossLayouts)
  const retainedZones = (spec.dry_wet_zones ?? []).filter((zone) => zone.source !== 'derived')
  const solvedZone = { id: `layout-wet-${solution.id}`, kind: 'wet' as const, label: '自动生成湿区（空间，非家具）', boundary: [{ x_mm: s.x_mm - s.width_mm / 2, z_mm: s.z_mm - s.depth_mm / 2 }, { x_mm: s.x_mm + s.width_mm / 2, z_mm: s.z_mm - s.depth_mm / 2 }, { x_mm: s.x_mm + s.width_mm / 2, z_mm: s.z_mm + s.depth_mm / 2 }, { x_mm: s.x_mm - s.width_mm / 2, z_mm: s.z_mm + s.depth_mm / 2 }], source: 'derived' as const, confidence: 1 }
  return { ...spec, wall_finish_gap_mm: Math.max(35, spec.wall_finish_gap_mm ?? 0), fixtures: [...retainedFixtures, ...solution.fixtures.map((fixture) => ({ ...fixture, layout_generated: true }))], dry_wet_zones: retainedZones.length ? retainedZones : [solvedZone] }
}
