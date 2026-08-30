import type { CeilingZone, FixtureModelAsset, FixtureSpec, LayoutLevelDecision, LayoutProductInput, ModelCallAudit, ModelLookup, Point2D, RoomSpec } from './types'
import graphOutput from './generated-layout-products.json'
import productCatalog from './generated-product-catalog.json'
import { dimensionsFor } from './modelDimensions'
import { builtInAssetAsRoomAsset, exactModelAssetForProduct, modelAssetForProduct, surfaceAssetForProduct, type BuiltInModelRecord } from './modelLibrary'
import { routePlumbing } from './plumbing'
import { applyWetZoneBoundaryChange, bathroomVanityInstallationRules, ensureWallFinishGapsForBoundPoints, finishedRoomBoundary, fixtureBoundWallIndex, fixturePointUsage, nearestWallIndex, projectPointToWall, SHOWER_DRAIN_CENTER_OFFSET_MM, SHOWER_DRAIN_WALL_CLEARANCE_MM, snapPointToNearestWall, toiletPlacementFromDrain, wallInwardNormal, wetZoneBoundaryValid } from './spec'

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
  wet_zone_anchor?: { x_mm: number; z_mm: number; width_mm: number; depth_mm: number }
  wet_zone_boundary?: Point2D[]
  floor_layout: FloorLayoutPlan
  /** 吊顶为嵌入热水器开设的凹槽区域（房高不足时生成）。 */
  ceiling_recess?: CeilingZone
  layout_script: LayoutScript
  solver_trace: { candidates_evaluated:number; feasible_candidates:number; reachable:boolean; alternating_rounds?:number; plumbing_candidates?:number; selected_pipe_mm?:number; selected_imbalance_mm?:number; iterations?:Array<{ iter:number; moved:string[]; total_pipe_mm:number; imbalance_mm:number; objective:number; accepted:boolean }> }
  model_reason?: string
  selected_product_ids: string[]
  model_call?: ModelCallAudit
  model_calls?: ModelCallAudit[]
}
export interface FloorLayoutPlan { rotation_deg:0|90; offset_x_mm:number; offset_z_mm:number; cut_count:number; narrow_cut_count:number; min_edge_mm:number; joint_conflict_count:number; min_point_joint_clearance_mm:number; score:number; description:string }

const demandLabels: Record<DemandProfile, string> = {
  standard_shower: '标准淋浴', laundry: '洗衣复合', elderly_safe: '适老安全',
}
const budgetLabels: Record<BudgetTier, string> = { basic: '经济档', comfort: '舒适档', premium: '品质档' }
const layoutLabels: Record<BudgetTier, string> = { basic: '约束求解方案', comfort: '约束求解方案', premium: '约束求解方案' }
const budgets: BudgetTier[] = ['basic', 'comfort', 'premium']

/** Finished-surface dimensions used by deterministic auto-layout (millimetres). */
export const BATHROOM_AUTO_LAYOUT_RULES = Object.freeze({
  shower_min_internal_mm: 800,
  toilet_front_clearance_mm: 500,
  shower_drain_wall_clearance_mm: SHOWER_DRAIN_WALL_CLEARANCE_MM,
  shower_drain_center_offset_mm: SHOWER_DRAIN_CENTER_OFFSET_MM,
  vanity_width_mm: bathroomVanityInstallationRules.width_mm,
  vanity_depth_mm: bathroomVanityInstallationRules.depth_mm,
  vanity_height_max_mm: bathroomVanityInstallationRules.height_mm,
  vanity_front_clearance_mm: bathroomVanityInstallationRules.front_clearance_mm,
})

export const SHOWER_INSTALLATION_DIMENSIONS = Object.freeze({
  // The reviewed shower model is the authoritative installation envelope.
  // Do not fall back to the smaller 120x80x1100 catalog proxy.
  width_mm: 285,
  depth_mm: 485,
  height_mm: 1327,
})

/** Upgrade legacy auto-layout shower-head entities without changing measured fixtures. */
export function normalizeGeneratedShowerDimensions(spec: RoomSpec): RoomSpec {
  let changed = false
  const fixtures = spec.fixtures.map((fixture) => {
    if (!fixture.layout_generated || fixture.kind !== 'other' || !/花洒/.test(fixture.label) || /扶手/.test(fixture.label)) return fixture
    const dimensions = SHOWER_INSTALLATION_DIMENSIONS
    if (fixture.width_mm === dimensions.width_mm && fixture.depth_mm === dimensions.depth_mm && fixture.height_mm === dimensions.height_mm) return fixture
    changed = true
    return { ...fixture, ...dimensions }
  })
  return changed ? { ...spec, fixtures } : spec
}

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
  const modelBacked = category === '马桶' ? all.filter((product) => !!exactModelAssetForProduct(category, product.code)) : all
  const styled = style ? all.filter((product) => {
    const catalog = (productCatalog as CatalogProduct[]).find((item) => item.材料编号 === product.code)
    return !catalog || supportsStyle(catalog, style)
  }) : all
  const modelBackedStyled = category === '马桶'
    ? styled.filter((product) => !!exactModelAssetForProduct(category, product.code))
    : styled
  // A style match is preferred only when it still supplies the requested
  // quality rank. Previously a style with two matching SKUs caused the
  // comfort and premium tiers to silently reuse the second SKU. Fall back to
  // the complete model-backed catalog for the missing rank so every tier can
  // keep a distinct, price-ordered product combination.
  const candidates = modelBackedStyled.length > quality ? modelBackedStyled : modelBacked
  if (!candidates.length) throw new Error(`知识图谱未返回必需品类：${demand}/${category}`)
  return candidates[Math.min(quality, candidates.length - 1)]
}

function rectangleBounds(spec: RoomSpec) {
  const xs = spec.boundary.map((p) => p.x_mm); const zs = spec.boundary.map((p) => p.z_mm)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
}

function layoutBoundary(spec: RoomSpec) {
  const wall_finish_profiles = spec.wall_finish_profiles?.map((profile) => ({ ...profile, gap_mm: Math.max(35, profile.gap_mm ?? 0) }))
  return finishedRoomBoundary({ ...spec, wall_finish_gap_mm: Math.max(35, spec.wall_finish_gap_mm ?? 0), wall_finish_profiles })
}
function buildLayoutScript(demand:DemandProfile,budget:BudgetTier,spec:RoomSpec):LayoutScript{
  const variant = budgets.indexOf(budget)
  const candidates = spec.boundary.map((_, index) => {
    const length = Math.max(1, Math.hypot(spec.boundary[(index + 1) % spec.boundary.length].x_mm - spec.boundary[index].x_mm, spec.boundary[(index + 1) % spec.boundary.length].z_mm - spec.boundary[index].z_mm))
    const openingLength = spec.openings.filter((opening) => opening.wall_index === index).reduce((sum, opening) => sum + opening.width_mm, 0)
    const semantic = semanticWallForIndex(spec, index) ?? 'south'
    return { index, semantic, score: length - openingLength * 1.8 }
  }).sort((left, right) => right.score - left.score || left.index - right.index)
  const ordered = candidates.map((_, index) => candidates[(index + variant) % candidates.length])
  const plumbingWall = (point?: FixtureSpec) => {
    if (!point) return null
    if (point.kind === 'drain') {
      const bounds = rectangleBounds(spec)
      const sideThreshold = Math.max(600, Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.2)
      if (point.x_mm - bounds.minX <= sideThreshold) return 'west' as const
      if (bounds.maxX - point.x_mm <= sideThreshold) return 'east' as const
    }
    return semanticWallForIndex(spec, nearestWallIndex(layoutBoundary(spec), point))
  }
  const wetWall = plumbingWall(showerDrainPoint(spec)) ?? ordered[0]?.semantic ?? 'south'
  const serviceWall = plumbingWall(toiletDrainPoint(spec) ?? washerDrainPoint(spec) ?? spec.fixtures.find((fixture) => ['drain', 'water'].includes(fixture.kind))) ?? ordered.find((item) => item.semantic !== wetWall)?.semantic ?? wetWall
  const dryWall = plumbingWall(spec.fixtures.find((fixture) => fixture.kind === 'water' && fixturePointUsage(fixture) === 'basin')) ?? serviceWall
  const instructions:LayoutInstruction[]=[
    {fixture_role:'wet_zone',wall:wetWall,zone:'wet',near:'shower_drain',min_clearance_mm:0},
    {fixture_role:'vanity',wall:dryWall,zone:'dry',min_clearance_mm:600},
    {fixture_role:'toilet',wall:serviceWall,zone:'dry',near:'toilet_drain',min_clearance_mm:demand==='elderly_safe'?800:Math.max(600,BATHROOM_AUTO_LAYOUT_RULES.toilet_front_clearance_mm)},
    {fixture_role:'heater',wall:wetWall,zone:'service',near:'wet_zone',min_clearance_mm:0},
  ]
  if(demand==='laundry')instructions.push({fixture_role:'washer',wall:serviceWall,zone:'service',near:'water',min_clearance_mm:600})
  if(demand==='elderly_safe')instructions.push({fixture_role:'grab_bars',wall:wetWall,zone:'wet',near:'wet_zone',min_clearance_mm:0})
  return{version:'layout-script-v1',demand,budget,instructions,source:'requirement-rule-engine'}
}
function semanticTarget(spec:RoomSpec,instruction:LayoutInstruction,w:number,d:number){const b=rectangleBounds(spec),m=80;let x=(b.minX+b.maxX)/2,z=(b.minZ+b.maxZ)/2;if(instruction.wall==='west')x=b.minX+w/2+m;if(instruction.wall==='east')x=b.maxX-w/2-m;if(instruction.wall==='south')z=b.minZ+d/2+m;if(instruction.wall==='north')z=b.maxZ-d/2-m;if(instruction.wall==='nearest_plumbing'){const p=spec.fixtures.find(f=>['floor_drain','drain','water'].includes(f.kind));if(p){x=p.x_mm;z=p.z_mm}}return{x,z}}
function axisCuts(length:number,tile:number,offset:number){const first=offset===0?tile:offset;const remainder=((length-first)%tile+tile)%tile;const edges=[Math.min(first,length),...(remainder>0?[remainder]:[])].filter(v=>v>0&&v<tile);return{cuts:edges.length,narrow:edges.filter(v=>v<tile/3).length,min:edges.length?Math.min(...edges):tile}}
const FLOOR_POINT_JOINT_GAP_MM = 25

function floorJointPoints(spec: RoomSpec) {
  return spec.fixtures.filter((item) => {
    if (!['floor_drain', 'drain', 'water', 'electric'].includes(item.kind)) return false
    if ((item.elevation_mm ?? 0) > 50) return false
    return !(item.kind === 'floor_drain' && fixturePointUsage(item) === 'shower')
  })
}

function modularJointDistance(coordinate: number, offset: number, tileSize: number) {
  const remainder = ((coordinate - offset) % tileSize + tileSize) % tileSize
  return Math.min(remainder, tileSize - remainder)
}

function floorOffsetCandidates(length: number, tileSize: number, points: number[], radii: number[]) {
  const candidates = [0, Math.round((length % tileSize) / 2), length % tileSize]
  points.forEach((coordinate, index) => {
    const clearance = radii[index] + FLOOR_POINT_JOINT_GAP_MM
    candidates.push(
      Math.round(((coordinate - clearance) % tileSize + tileSize) % tileSize),
      Math.round(((coordinate + clearance) % tileSize + tileSize) % tileSize),
    )
  })
  return [...new Set(candidates)]
}

/** Choose floor orientation and start offsets only after layout points are known. */
export function optimizeFloorLayout(spec:RoomSpec,tileWidthMm:number,tileDepthMm:number):FloorLayoutPlan {
  const b=rectangleBounds(spec),width=b.maxX-b.minX,depth=b.maxZ-b.minZ
  const points=floorJointPoints(spec)
  const tileLongAxisIsWidth=tileWidthMm>=tileDepthMm,roomShortAxisIsWidth=width<=depth
  const requiredRotation:0|90=tileLongAxisIsWidth===roomShortAxisIsWidth?0:90
  let best:FloorLayoutPlan|null=null
  for(const rotation of [requiredRotation]) {
    const tw=rotation===0?tileWidthMm:tileDepthMm,td=rotation===0?tileDepthMm:tileWidthMm
    const localX=points.map(point=>point.x_mm-b.minX),localZ=points.map(point=>point.z_mm-b.minZ)
    const radiiX=points.map(point=>point.width_mm/2),radiiZ=points.map(point=>point.depth_mm/2)
    for(const ox of floorOffsetCandidates(width,tw,localX,radiiX)) for(const oz of floorOffsetCandidates(depth,td,localZ,radiiZ)) {
      const x=axisCuts(width,tw,ox),z=axisCuts(depth,td,oz)
      const cuts=x.cuts*Math.ceil(depth/td)+z.cuts*Math.ceil(width/tw)
      const narrow=x.narrow*Math.ceil(depth/td)+z.narrow*Math.ceil(width/tw)
      const min=Math.round(Math.min(x.min,z.min))
      const clearances=points.map((point,index)=>Math.min(
        modularJointDistance(localX[index],ox,tw)-point.width_mm/2,
        modularJointDistance(localZ[index],oz,td)-point.depth_mm/2,
      ))
      const conflicts=clearances.filter(clearance=>clearance<FLOOR_POINT_JOINT_GAP_MM).length
      const pointClearance=clearances.length?Math.max(-999,Math.round(Math.min(...clearances))):999
      const score=100000-conflicts*1000000-narrow*10000-cuts*100+Math.min(pointClearance,999)+min
      const c:FloorLayoutPlan={rotation_deg:rotation,offset_x_mm:ox,offset_z_mm:oz,cut_count:cuts,narrow_cut_count:narrow,min_edge_mm:min,joint_conflict_count:conflicts,min_point_joint_clearance_mm:pointClearance,score,description:`长边沿房型短边 · ${rotation?'旋转90°':'横向'}铺贴 · 起铺偏移 ${ox}/${oz}mm · 窄条 ${narrow} · 最窄边条 ${min}mm · 干区点位砖缝冲突 ${conflicts}`}
      if(!best||c.score>best.score)best=c
    }
  }
  return best as FloorLayoutPlan
}

function fixture(id: string, kind: FixtureSpec['kind'], label: string, x_mm: number, z_mm: number, width_mm: number, depth_mm: number, height_mm: number, rotation_deg = 0, elevation_mm = 0): FixtureSpec {
  // Persisted RoomSpec geometry is an integer-millimetre construction
  // contract. Parsed model bounds may contain sub-millimetre decimals; round
  // once here so a valid generated layout can always pass the save schema.
  return {
    id, kind, label,
    x_mm: Math.round(x_mm), z_mm: Math.round(z_mm),
    width_mm: Math.round(width_mm), depth_mm: Math.round(depth_mm), height_mm: Math.round(height_mm),
    elevation_mm: Math.round(elevation_mm), rotation_deg,
    source: 'derived', confidence: 1, layout_generated: true, position_status:'proposed',
  }
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
    orientation_view: lookup.model_orientation_view,
    orientation_mapping: lookup.model_orientation_mapping,
  }
}

function productFixture(id: string, kind: FixtureSpec['kind'], product: GraphProduct, x_mm: number, z_mm: number, fallback: { width_mm: number; depth_mm: number; height_mm: number }, rotation_deg = 0, elevation_mm = 0, exactAsset = false, lookup?: ModelLookup) {
  // A model explicitly bound by the layout response belongs to this SKU and
  // must win over a category-level built-in fallback. Otherwise an unrelated
  // built-in asset can be rendered with the right-looking, but wrong, label.
  const boundAsset = snapshotAsset(lookup)
  const asset = boundAsset ? undefined : (exactAsset
    ? exactModelAssetForProduct(product.category, product.code)
      // XYJ2-1 is a real catalog SKU whose model snapshot is not SKU-bound.
      // Reuse the reviewed generic washer model for rendering while retaining
      // the SKU's verified 608×653×860 mm layout envelope below.
      ?? (product.category === '洗衣机' ? modelAssetForProduct('洗衣机', undefined, 'premium') : undefined)
    : modelAssetForProduct(product.category, product.code))
  // Heater geometry is a reviewed, fixed installation envelope. Always use
  // it as the fallback, even when an API snapshot still carries the legacy
  // 720x180x430 proxy dimensions.
  const installationFallback = product.category === '花洒'
    ? SHOWER_INSTALLATION_DIMENSIONS
    : product.category === '热水器'
      ? dimensionsFor('热水器', fallback)
      : fallback
  const legacyDimensions = dimensionsFor(product.category, installationFallback)
  // The supplied grab-bar FBX files contain room-scale scene bounds. Keep the
  // assets renderable, but use their catalog installation envelopes for layout.
  // Some source bathroom-cabinet FBX files include a room-scale helper
  // object and are therefore reported as 2000mm tall.  The catalog
  // installation envelope is authoritative for cabinets; otherwise the
  // helper bounds create an over-sized cabinet and a second compressed
  // cabinet when the same asset is reused by an optional mirror.
  const useInstallationEnvelope = ['花洒扶手', '马桶扶手', '花洒', '热水器', '浴室柜', '适老浴室柜'].includes(product.category)
  const useCatalogFallbackEnvelope = ['浴室柜', '适老浴室柜'].includes(product.category)
  const snapshotDimensions = lookup?.model_dimensions_mm
  const genericCubeBounds = asset?.dimensions_mm.width === 600 && asset.dimensions_mm.depth === 600 && asset.dimensions_mm.height === 600
  const dimensions = asset && !useInstallationEnvelope && !genericCubeBounds && product.category !== '洗衣机'
    ? { width_mm: asset.dimensions_mm.width, depth_mm: asset.dimensions_mm.depth, height_mm: asset.dimensions_mm.height, file_name: asset.filename }
    : snapshotDimensions && !useInstallationEnvelope
      ? { width_mm: snapshotDimensions.width, depth_mm: snapshotDimensions.depth, height_mm: snapshotDimensions.height, file_name: lookup?.model_asset_label ?? 'backend-model-snapshot' }
      : { ...(genericCubeBounds || useCatalogFallbackEnvelope || useInstallationEnvelope ? installationFallback : legacyDimensions), file_name: asset?.filename ?? legacyDimensions.file_name }
  const result = fixture(id, kind, `${product.code} ${product.category} · ${dimensions.file_name}`, x_mm, z_mm, dimensions.width_mm, dimensions.depth_mm, dimensions.height_mm, rotation_deg, elevation_mm)
  if (kind === 'vanity' || product.category === '浴室柜' || product.category === '适老浴室柜') {
    // Cabinet dimensions are a fixed installation envelope. Product/SKU
    // changes may alter finish and price, never the cabinet geometry.
    result.width_mm = bathroomVanityInstallationRules.width_mm
    result.depth_mm = bathroomVanityInstallationRules.depth_mm
    result.height_mm = bathroomVanityInstallationRules.height_mm
  }
  const resolvedAsset = boundAsset ?? (asset ? builtInAssetAsRoomAsset(asset) : undefined)
  if (resolvedAsset) result.model_asset = resolvedAsset
  return result
}

type OrientedBox = { x_mm:number; z_mm:number; width_mm:number; depth_mm:number; rotation_deg:number }
function physicalRotation(rotation:number) { return ((rotation % 360) + 360) % 360 }
function footprintForRotation(item: Pick<FixtureSpec, 'width_mm' | 'depth_mm'>, rotation: number) {
  return Math.abs(rotation) % 180 === 90
    ? { width: item.depth_mm, depth: item.width_mm }
    : { width: item.width_mm, depth: item.depth_mm }
}
function boxAxes(box: OrientedBox) { const angle=physicalRotation(box.rotation_deg)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);return [{x:c,z:s},{x:-s,z:c}] }
function overlaps(a: FixtureSpec, b: FixtureSpec, clearance = 0) {
  const boxes:OrientedBox[]=[a,b].map(item=>({x_mm:item.x_mm,z_mm:item.z_mm,width_mm:item.width_mm+clearance*2,depth_mm:item.depth_mm+clearance*2,rotation_deg:item.rotation_deg??0}))
  const axes=[...boxAxes(boxes[0]),...boxAxes(boxes[1])]
  return axes.every(axis=>{
    const projection=(box:OrientedBox)=>{const own=boxAxes(box);return Math.abs(axis.x*own[0].x+axis.z*own[0].z)*box.width_mm/2+Math.abs(axis.x*own[1].x+axis.z*own[1].z)*box.depth_mm/2}
    const distance=Math.abs((boxes[1].x_mm-boxes[0].x_mm)*axis.x+(boxes[1].z_mm-boxes[0].z_mm)*axis.z)
    return distance < projection(boxes[0])+projection(boxes[1])-0.5
  })
}

const BODY_GAP_MM = 50
const TOILET_FRONT_CLEARANCE_MM = 500
const TOILET_REAR_GAP_MM = 20
const VANITY_FRONT_CLEARANCE_MM = 600
const WASHER_FRONT_CLEARANCE_MM = 600
const SHOWER_SEAT_FRONT_CLEARANCE_MM = 600
const WASHER_REAR_GAP_MM = 50
const WALL_ATTACHMENT_CLEARANCE_MM = 5
const placementClearances = new WeakMap<FixtureSpec, FixtureSpec>()
const relaxedPlacementClearances = new WeakSet<FixtureSpec>()

// 热水器吊顶布置规则（确定性）：
// 1. 热水器尽量靠近吊顶 —— 顶部距吊顶完成面保留 25mm 安全间距；
// 2. 房高不足（底部安装高度低于 1800mm）时，在吊顶为热水器开凹槽，
//    将顶部嵌入凹槽，凹槽深度按 10mm 向上取整且不超过 300mm 上限。
const HEATER_CEILING_SAFETY_MM = 25
export const HEATER_MIN_BOTTOM_MM = 1800
export const HEATER_MAX_RECESS_MM = 300
const HEATER_RECESS_ZONE_ID = 'layout-heater-recess'
const CEILING_LIGHT_ENVELOPE = Object.freeze({ width_mm: 600, depth_mm: 600, height_mm: 120 })

function ceilingLightAnchor(spec: RoomSpec, fixtures: FixtureSpec[]) {
  const boundary = layoutBoundary(spec)
  const bounds = rectangleBounds({ ...spec, boundary })
  const candidates = [
    { x_mm: (bounds.minX + bounds.maxX) / 2, z_mm: (bounds.minZ + bounds.maxZ) / 2 },
    ...boundary.map((point, index) => ({
      x_mm: (point.x_mm + boundary[(index + 1) % boundary.length].x_mm) / 2,
      z_mm: (point.z_mm + boundary[(index + 1) % boundary.length].z_mm) / 2,
    })),
  ]
  const isClear = (point: { x_mm: number; z_mm: number }) => {
    const candidate = fixture('ceiling-light-anchor', 'other', '浴霸中心定位', point.x_mm, point.z_mm, CEILING_LIGHT_ENVELOPE.width_mm, CEILING_LIGHT_ENVELOPE.depth_mm, CEILING_LIGHT_ENVELOPE.height_mm, 0, Math.max(0, (spec.height_mm ?? 2200) - CEILING_LIGHT_ENVELOPE.height_mm))
    candidate.mounting_surface = 'ceiling'
    return fixtureInsideRoom(candidate, boundary) && !fixtures.some((item) => item.mounting_surface === 'ceiling' && overlaps(candidate, item, 20))
  }
  return candidates.find(isClear) ?? candidates[0]
}

function ceilingLightFixture(id: string, x_mm: number, z_mm: number, ceilingHeightMm: number) {
  const asset = modelAssetForProduct('浴霸')
  const fixtureEntity = fixture(
    id,
    'other',
    `${asset?.label ?? '浴霸'} · 吊顶嵌入灯`,
    x_mm,
    z_mm,
    CEILING_LIGHT_ENVELOPE.width_mm,
    CEILING_LIGHT_ENVELOPE.depth_mm,
    CEILING_LIGHT_ENVELOPE.height_mm,
    0,
    Math.max(0, Math.floor(ceilingHeightMm - CEILING_LIGHT_ENVELOPE.height_mm)),
  )
  fixtureEntity.mounting_surface = 'ceiling'
  if (asset) fixtureEntity.model_asset = builtInAssetAsRoomAsset(asset)
  return fixtureEntity
}

function findCeilingLightFixture(fixtures: FixtureSpec[]) {
  return fixtures.find((item) => item.mounting_surface === 'ceiling' && /浴霸|吊顶灯|照明|ceiling-light/i.test(item.label) && !/分水器/.test(item.label))
}

export interface HeaterMountingPlan {
  elevation_mm: number
  recess_depth_mm: number
  minimum_bottom_satisfied: boolean
}

export function heaterMountingPlan(ceilingHeightMm: number, heaterHeightMm: number): HeaterMountingPlan {
  const ideal = ceilingHeightMm - heaterHeightMm - HEATER_CEILING_SAFETY_MM
  if (ideal >= HEATER_MIN_BOTTOM_MM) return { elevation_mm: Math.max(0, Math.floor(ideal)), recess_depth_mm: 0, minimum_bottom_satisfied: true }
  const deficit = HEATER_MIN_BOTTOM_MM - ideal
  const recessDepth = Math.min(HEATER_MAX_RECESS_MM, Math.ceil(deficit / 10) * 10)
  const elevation = Math.max(0, Math.floor(ideal + recessDepth))
  return { elevation_mm: elevation, recess_depth_mm: recessDepth, minimum_bottom_satisfied: elevation >= HEATER_MIN_BOTTOM_MM }
}

function heaterCeilingRecessZone(spec: RoomSpec, heater: FixtureSpec, recessDepthMm: number): CeilingZone {
  const footprint = footprintForRotation(heater, heater.rotation_deg)
  const ceilingHeight = spec.height_mm ?? 2200
  // Keep the generated zone on the fixture footprint. A symmetric margin made
  // wall-mounted heaters extend the recess behind the finished room boundary.
  const minX = Math.floor(heater.x_mm - footprint.width / 2)
  const maxX = Math.ceil(heater.x_mm + footprint.width / 2)
  const minZ = Math.floor(heater.z_mm - footprint.depth / 2)
  const maxZ = Math.ceil(heater.z_mm + footprint.depth / 2)
  return {
    id: HEATER_RECESS_ZONE_ID,
    label: `热水器吊顶凹槽 · 嵌入 ${recessDepthMm}mm`,
    // Contract winding order: counterclockwise viewed from above.
    boundary: [
      { x_mm: minX, z_mm: minZ },
      { x_mm: maxX, z_mm: minZ },
      { x_mm: maxX, z_mm: maxZ },
      { x_mm: minX, z_mm: maxZ },
    ],
    height_mm: ceilingHeight + recessDepthMm,
    source: 'derived',
    confidence: 1,
  }
}

function findHeaterFixture(fixtures: FixtureSpec[]) {
  return fixtures.find((fixture) => fixture.label.includes('热水器'))
}

function requiredRearWallGap(item: FixtureSpec) {
  if (item.kind === 'water' || item.kind === 'electric') return undefined
  if (item.kind === 'shower') return undefined
  // A washer floor drain is a floor point under the appliance, not the
  // appliance itself. Its label contains "洗衣机", so this guard must run
  // before the washer-body rear-clearance rule below.
  if (item.kind === 'floor_drain' || item.kind === 'drain') return undefined
  if (item.kind === 'toilet') return TOILET_REAR_GAP_MM
  if (/洗衣机/.test(item.label)) return WASHER_REAR_GAP_MM
  // Bathroom cabinets use their own verified installation envelope. The
  // cabinet body is placed 5 mm off the finished wall; the separate 35 mm
  // wall-finish cavity belongs to the wall assembly, not the cabinet gap.
  if (isBathroomCabinet(item)) return bathroomVanityInstallationRules.rear_wall_gap_mm
  if (/(热水器|花洒|扶手|淋浴椅|适老椅|浴室柜)/.test(item.label)) return WALL_ATTACHMENT_CLEARANCE_MM
  return undefined
}

export function effectiveLayoutInstruction(item: FixtureSpec, instruction: LayoutInstruction): LayoutInstruction {
  let minimum = 0
  if (item.kind === 'toilet') minimum = TOILET_FRONT_CLEARANCE_MM
  else if (item.kind === 'vanity' || /浴室柜/.test(item.label)) minimum = VANITY_FRONT_CLEARANCE_MM
  else if (/洗衣机/.test(item.label)) minimum = WASHER_FRONT_CLEARANCE_MM
  else if (/淋浴椅|适老椅/.test(item.label)) minimum = SHOWER_SEAT_FRONT_CLEARANCE_MM
  return { ...instruction, min_clearance_mm: Math.max(instruction.min_clearance_mm, minimum) }
}

function wallFacingRotation(wall: Exclude<SemanticWall, 'nearest_plumbing'>) {
  // Contract rotation is CCW viewed from above, so front(r) = (-sin r, cos r).
  // A fixture mounted on a wall faces the opposite direction (into the room):
  // south wall faces north (r=0), north faces south (r=180), west faces east
  // (r=270), east faces west (r=90).
  return ({ south: 0, west: 270, north: 180, east: 90 } as const)[wall]
}

function rearWallDistance(spec: RoomSpec, item: FixtureSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>) {
  const boundary = layoutBoundary(spec)
  const wallIndex = item.bound_wall_index ?? wallIndexForSemantic(spec, wall, item)
  const projection = projectPointToWall(boundary, wallIndex, item)
  if (!projection) return Number.POSITIVE_INFINITY
  const inward = wallInwardNormal(boundary, wallIndex)
  const footprint = footprintForRotation(item, item.rotation_deg)
  const halfDepth = Math.abs(inward.x) * footprint.width / 2 + Math.abs(inward.z) * footprint.depth / 2
  return projection.distance_mm - halfDepth
}

function isBathroomCabinet(item: FixtureSpec) {
  return item.kind === 'vanity' || (!['floor_drain', 'drain', 'water', 'electric', 'pipe'].includes(item.kind) && /浴室柜/.test(item.label))
}

function bodyCollisionClearance(a: FixtureSpec, b: FixtureSpec, defaultClearance = BODY_GAP_MM) {
  // A cabinet's side panels may finish directly against a return, partition,
  // or adjacent unit. Its front operating envelope and rear wall gap are
  // checked separately, so a symmetric body buffer would invent side space.
  return isBathroomCabinet(a) || isBathroomCabinet(b)
    ? bathroomVanityInstallationRules.side_clearance_mm
    : defaultClearance
}

function cabinetRuleDescription() {
  const rule = bathroomVanityInstallationRules
  return `浴室柜完整模型包络 ${rule.width_mm}×${rule.depth_mm}×${rule.height_mm}mm，后沿贴墙，前方操作净空 ${rule.front_clearance_mm}mm，左右不预留操作净空`
}

function cabinetEnvelopeFailures(spec: RoomSpec, fixtures: FixtureSpec[]) {
  const failures: string[] = []
  for (const item of fixtures.filter(isBathroomCabinet)) {
    const expected = bathroomVanityInstallationRules
    if (item.width_mm !== expected.width_mm || item.depth_mm !== expected.depth_mm || item.height_mm !== expected.height_mm) {
      failures.push(`${item.label} 固定安装包络应为 ${expected.width_mm}×${expected.depth_mm}×${expected.height_mm}mm`)
    }
    const clearance = frontClearanceEnvelope(item, { fixture_role: 'vanity', wall: 'nearest_plumbing', zone: 'dry', min_clearance_mm: expected.front_clearance_mm })
    if (!clearance || !fixtureInsideRoom(clearance, layoutBoundary(spec)) || blocksFurnitureOpeningEnvelope(spec, clearance) || fixtures.some((other) => other !== item && blocksUseClearance(item, clearance, other))) {
      failures.push(`${item.label} 前方操作净空不足 ${expected.front_clearance_mm}mm`)
    }
    const wallIndex = item.bound_wall_index
    if (wallIndex === undefined || wallIndex === null || wallIndex < 0 || wallIndex >= spec.boundary.length || fixtureBoundWallIndex(spec, item) === null) {
      failures.push(`${item.label} 未绑定有效墙段`)
      continue
    }
    const wall = semanticWallForIndex(spec, wallIndex)
    if (!wall || Math.abs(rearWallDistance(spec, item, wall) - expected.rear_wall_gap_mm) > 10) failures.push(`${item.label} 后沿未贴墙（目标墙缝 ${expected.rear_wall_gap_mm}mm）`)
  }
  return failures
}

function snapRearToWallIndex(spec: RoomSpec, item: FixtureSpec, wallIndex: number, gapMm: number) {
  const boundary = layoutBoundary(spec)
  const resolvedWall = semanticWallForIndex(spec, wallIndex) ?? wallNearestPoint(spec, item)
  const rotation = wallFacingRotation(resolvedWall)
  item.rotation_deg = rotation
  const projection = projectPointToWall(boundary, wallIndex, item)
  if (!projection) { item.bound_wall_index = null; return false }
  const inward = wallInwardNormal(boundary, wallIndex)
  const start = boundary[wallIndex]
  const end = boundary[(wallIndex + 1) % boundary.length]
  const length = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
  const tangent = { x: (end.x_mm - start.x_mm) / length, z: (end.z_mm - start.z_mm) / length }
  const footprint = footprintForRotation(item, rotation)
  const halfDepth = Math.abs(inward.x) * footprint.width / 2 + Math.abs(inward.z) * footprint.depth / 2
  const halfTangent = Math.abs(tangent.x) * footprint.width / 2 + Math.abs(tangent.z) * footprint.depth / 2
  const projectedAlong = (projection.point.x_mm - start.x_mm) * tangent.x + (projection.point.z_mm - start.z_mm) * tangent.z
  const maxAlongOffset = Math.max(0, length - halfTangent - 2)
  const offsets = [0]
  for (let step = 100; step <= length; step += 100) offsets.push(step, -step)
  let placed = false
  for (const offset of offsets) {
    const along = Math.max(halfTangent + 2, Math.min(maxAlongOffset, projectedAlong + offset))
    const candidate = {
      ...item,
      x_mm: Math.round(start.x_mm + tangent.x * along + inward.x * (halfDepth + gapMm)),
      z_mm: Math.round(start.z_mm + tangent.z * along + inward.z * (halfDepth + gapMm)),
    }
    if (!fixtureInsideRoom(candidate, boundary) || blocksFurnitureOpeningEnvelope(spec, candidate)) continue
    item.x_mm = candidate.x_mm
    item.z_mm = candidate.z_mm
    placed = true
    break
  }
  // A short return can be closer than a usable wall but still cannot contain
  // the complete installation envelope. Never leave a stale wall binding in
  // that case; callers may then try the next semantic wall.
  item.bound_wall_index = placed ? wallIndex : null
  return placed
}

function snapRearToWall(spec: RoomSpec, item: FixtureSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>, gapMm: number) {
  return snapRearToWallIndex(spec, item, wallIndexForSemantic(spec, wall, item), gapMm)
}

function snapWallMountedFixtureAwayFromOpenings(spec: RoomSpec, item: FixtureSpec, preferredWall: Exclude<SemanticWall, 'nearest_plumbing'>, gapMm: number, occupied: FixtureSpec[] = []) {
  const walls: Exclude<SemanticWall, 'nearest_plumbing'>[] = ['south', 'east', 'north', 'west']
  const original = { ...item }
  const ordered = [preferredWall, ...walls.filter((wall) => wall !== preferredWall)]
  const physicallyClear = (candidate: FixtureSpec) => !occupied.some((other) => other !== item
    && other.id !== item.id
    && !permittedAssembly(candidate, other)
    && overlaps(candidate, other, bodyCollisionClearance(candidate, other, 30)))
  for (const wall of ordered) {
    const candidate = { ...item }
    if (!snapRearToWall(spec, candidate, wall, gapMm) || !physicallyClear(candidate)) {
      // A semantic wall can resolve to a short stepped return. Retry with an
      // explicit full-envelope sweep on every segment carrying that semantic.
      // This avoids retaining a stale bound index when the nearest segment is
      // too short for the model body.
      const boundary = layoutBoundary(spec)
      const semanticIndexes = boundary.map((_, index) => index).filter((index) => semanticWallForIndex(spec, index) === wall)
      let fitted = false
      for (const wallIndex of semanticIndexes) {
        const start = boundary[wallIndex]
        const end = boundary[(wallIndex + 1) % boundary.length]
        const length = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
        const inward = wallInwardNormal(boundary, wallIndex)
        const tangent = { x: (end.x_mm - start.x_mm) / length, z: (end.z_mm - start.z_mm) / length }
        const rotation = wallFacingRotation(wall)
        const footprint = footprintForRotation(candidate, rotation)
        const halfNormal = Math.abs(inward.x) * footprint.width / 2 + Math.abs(inward.z) * footprint.depth / 2
        const halfTangent = Math.abs(tangent.x) * footprint.width / 2 + Math.abs(tangent.z) * footprint.depth / 2
        const projected = projectPointToWall(boundary, wallIndex, candidate)
        if (!projected || length < halfTangent * 2 + 4) continue
        const minAlong = halfTangent + 2
        const maxAlong = length - halfTangent - 2
        for (let along = minAlong; along <= maxAlong + 0.1; along += 25) {
          const probe = {
            ...candidate,
            rotation_deg: rotation,
            x_mm: Math.round(start.x_mm + tangent.x * along + inward.x * (halfNormal + gapMm)),
            z_mm: Math.round(start.z_mm + tangent.z * along + inward.z * (halfNormal + gapMm)),
          }
          if (fixtureInsideRoom(probe, boundary) && !blocksFurnitureOpeningEnvelope(spec, probe) && physicallyClear(probe)) {
            Object.assign(candidate, probe)
            candidate.bound_wall_index = wallIndex
            fitted = true
            break
          }
        }
        if (fitted) break
      }
      if (!fitted) continue
    }
    if (!fixtureInsideRoom(candidate, layoutBoundary(spec)) || blocksFurnitureOpeningEnvelope(spec, candidate) || !physicallyClear(candidate)) continue
    Object.assign(item, candidate)
    return true
  }
  Object.assign(item, original)
  return false
}

export function fixtureFront(item: FixtureSpec): Exclude<SemanticWall, 'nearest_plumbing'> {
  // front(r) = (-sin r, cos r) per the frozen CCW rotation convention.
  const rotation = ((item.rotation_deg % 360) + 360) % 360
  if (rotation === 90) return 'west'
  if (rotation === 180) return 'south'
  if (rotation === 270) return 'east'
  return 'north'
}

export function frontClearanceEnvelope(item: FixtureSpec, instruction: LayoutInstruction) {
  const clearance = Math.max(0, instruction.min_clearance_mm)
  if (!clearance) return undefined
  // Semantic wall describes intent. The solved rotation describes the real
  // fixture front and therefore controls its physical use-clearance envelope.
  const front = fixtureFront(item)
  const footprint = footprintForRotation(item, item.rotation_deg)
  let x = item.x_mm; let z = item.z_mm; let width = footprint.width; let depth = footprint.depth
  if (front === 'east') { x += footprint.width / 2 + clearance / 2; width = clearance }
  if (front === 'west') { x -= footprint.width / 2 + clearance / 2; width = clearance }
  if (front === 'north') { z += footprint.depth / 2 + clearance / 2; depth = clearance }
  if (front === 'south') { z -= footprint.depth / 2 + clearance / 2; depth = clearance }
  return fixture(`clearance-${item.id}`, 'other', `${item.label}前向使用净空`, x, z, width, depth, 1)
}

function wetWallContactLength(spec: RoomSpec, item: FixtureSpec) {
  if (item.kind !== 'shower') return 0
  const boundary = layoutBoundary(spec)
  let contacts = 0
  let contactLength = 0
  for (let index = 0; index < boundary.length; index += 1) {
    const projection = projectPointToWall(boundary, index, item)
    if (!projection) continue
    const inward = wallInwardNormal(boundary, index)
    const halfExtent = Math.abs(inward.x) * item.width_mm / 2 + Math.abs(inward.z) * item.depth_mm / 2
    // A wall only counts when it is alongside the shower envelope edge. A
    // return passing through the middle of the envelope is not wall contact;
    // rewarding it made concave-room candidates straddle recesses.
    if (Math.abs(projection.distance_mm - halfExtent) <= 25) {
      contacts += 1
      const start = boundary[index]
      const end = boundary[(index + 1) % boundary.length]
      const wallLength = Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm)
      const wetEdgeLength = Math.abs(inward.x) > Math.abs(inward.z) ? item.depth_mm : item.width_mm
      contactLength += Math.min(wallLength, wetEdgeLength)
    }
  }
  // Preserve semantic-wall and plumbing priorities; use overlap length only
  // as a deterministic tie-break between candidates with equal wall contacts.
  return contacts + contactLength / 1_000_000_000
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
  const angle=physicalRotation(f.rotation_deg??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle)
  const corners=[[-hw,-hd],[hw,-hd],[hw,hd],[-hw,hd]].map(([x,z])=>[f.x_mm+x*c-z*s,f.z_mm+x*s+z*c])
  // Concave cut-outs can sit between four valid corners. Sample every edge so
  // a shower/fixture envelope cannot bridge an out-of-room notch.
  return corners.flatMap((start,index)=>{
    const end=corners[(index+1)%corners.length]
    const length=Math.hypot(end[0]-start[0],end[1]-start[1])
    const samples=Math.max(1,Math.ceil(length/100))
    return Array.from({length:samples+1},(_,sample)=>[
      start[0]+(end[0]-start[0])*sample/samples,
      start[1]+(end[1]-start[1])*sample/samples,
    ])
  }).every(([x,z])=>pointInPolygon(x,z,polygon))
}

function permittedAssembly(a: FixtureSpec, b: FixtureSpec) {
  if (a.mounting_surface === 'ceiling' || b.mounting_surface === 'ceiling') return true
  const aBottom = a.elevation_mm ?? 0
  const bBottom = b.elevation_mm ?? 0
  const verticalOverlap = Math.min(aBottom + Math.max(1, a.height_mm), bBottom + Math.max(1, b.height_mm))
    > Math.max(aBottom, bBottom) + 0.5
  // A shared plan footprint is harmless only when the physical height ranges
  // are disjoint. This keeps elevated accessories permissive without letting
  // the heater tunnel through full-height glass.
  if (!verticalOverlap) return true
  const labels = `${a.label}/${b.label}`
  if (/热水器/.test(labels) && /淋浴隔断/.test(labels)) return false
  // Corner-joining glass panels of one shower enclosure physically meet;
  // their footprints legitimately touch where the long and return panels
  // connect.
  if (a.label.includes('淋浴隔断') && b.label.includes('淋浴隔断')) return true
  if (/镜柜/.test(labels) && (a.kind === 'vanity' || b.kind === 'vanity')) return true
  const wetEnvelope = /淋浴(?:湿)?区/.test(a.label) ? a : /淋浴(?:湿)?区/.test(b.label) ? b : null
  if (wetEnvelope) {
    const other = wetEnvelope === a ? b : a
    return /(淋浴椅|淋浴隔断|扶手|花洒|地漏)/.test(other.label)
  }
  return /(扶手|花洒|热水器)/.test(labels)
}

// Glass screens are optional finish hardware. If the measured room leaves no
// legal separation from the fixed heater envelope, omit the colliding panel
// rather than allowing a hard layout failure or a visual through-model.
function removeHeaterScreenCollisions(fixtures: FixtureSpec[]) {
  const heaters = fixtures.filter((fixture) => /热水器/.test(fixture.label))
  for (const heater of heaters) {
    for (let index = fixtures.length - 1; index >= 0; index -= 1) {
      const panel = fixtures[index]
      if (!/淋浴隔断/.test(panel.label) || permittedAssembly(heater, panel) || !overlaps(heater, panel, bodyCollisionClearance(heater, panel, 30))) continue
      fixtures.splice(index, 1)
    }
  }
}

// Only compact wall accessories can sit inside a door's floor-swing envelope.
// Large wall-mounted appliances (notably the heater) still occupy that plan
// area and must be kept out of the moving door leaf.
function isElevatedDoorAccessory(f: FixtureSpec) {
  if ((f.elevation_mm ?? 0) <= 50) return false
  // Preserve the existing elevated-accessory rule, but explicitly retain
  // floor-plan blocking for appliances and furniture with a substantial body.
  return !/(热水器|洗衣机|马桶|浴缸|淋浴椅|淋浴隔断)/.test(f.label)
}

function wallIndexForSemantic(spec: RoomSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>, point?: { x_mm:number; z_mm:number }) {
  const boundary = layoutBoundary(spec)
  const desired = ({ south:{x:0,z:1}, east:{x:-1,z:0}, north:{x:0,z:-1}, west:{x:1,z:0} } as const)[wall]
  const candidates = boundary.map((start, index) => {
    const end = boundary[(index + 1) % boundary.length]
    const inward = wallInwardNormal(boundary, index)
    const alignment = inward.x * desired.x + inward.z * desired.z
    const projection = point ? projectPointToWall(boundary, index, point) : null
    return { index, alignment, distance:projection?.distance_mm ?? 0, length:Math.hypot(end.x_mm-start.x_mm,end.z_mm-start.z_mm) }
  }).filter((candidate) => candidate.alignment > 0.7)
  const ranked = candidates.length ? candidates : boundary.map((_, index) => ({ index, alignment:0, distance:point ? projectPointToWall(boundary,index,point)?.distance_mm ?? Number.POSITIVE_INFINITY : 0, length:0 }))
  return ranked.sort((left,right) => left.distance-right.distance || right.length-left.length)[0]?.index ?? 0
}
function semanticWallForIndex(spec: RoomSpec, index: number | null | undefined): Exclude<SemanticWall, 'nearest_plumbing'> | null {
  if (index === null || index === undefined || index < 0 || index >= spec.boundary.length) return null
  const inward = wallInwardNormal(layoutBoundary(spec), index)
  if (Math.abs(inward.x) >= Math.abs(inward.z)) return inward.x >= 0 ? 'west' : 'east'
  return inward.z >= 0 ? 'south' : 'north'
}

function wallServicePoint(spec: RoomSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>, anchor: FixtureSpec, tangentOffsetMm: number, elevationMm: number, label: string, kind: 'water' | 'electric', id: string, pointUsage?: FixtureSpec['point_usage']) {
  // Service points belong on the wall-panel face, matching the fixture wall
  // rather than the structural wall behind its 35 mm cavity.
  const boundary = layoutBoundary(spec)
  const wallIndex = anchor.bound_wall_index ?? wallIndexForSemantic(spec, wall, anchor)
  const start = boundary[wallIndex]
  const end = boundary[(wallIndex + 1) % boundary.length]
  const length = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
  const baseRatio = ((anchor.x_mm - start.x_mm) * (end.x_mm - start.x_mm) + (anchor.z_mm - start.z_mm) * (end.z_mm - start.z_mm)) / (length * length)
  // A percentage clamp can move a service point hundreds of millimetres from
  // its appliance on a long wall. Keep only a physical 20 mm edge clearance.
  const edgeRatio = Math.min(0.5, 20 / length)
  const ratio = Math.max(edgeRatio, Math.min(1 - edgeRatio, baseRatio + tangentOffsetMm / length))
  const result = fixture(id, kind, label, start.x_mm + (end.x_mm - start.x_mm) * ratio, start.z_mm + (end.z_mm - start.z_mm) * ratio, 40, 40, 10, wallFacingRotation(semanticWallForIndex(spec,wallIndex)??wall), elevationMm)
  result.bound_wall_index = wallIndex
  result.point_usage = pointUsage
  return result
}

/** Keep derived service points on the same finished wall as a dragged appliance. */
export function syncDraggedFixtureServicePoints(spec: RoomSpec, anchor: FixtureSpec) {
  const wall = semanticWallForIndex(spec, anchor.bound_wall_index) ?? wallNearestPoint(spec, anchor)
  const replace = (point: FixtureSpec, offset: number, elevation: number) => Object.assign(point, wallServicePoint(spec, wall, anchor, offset, elevation, point.label, point.kind as 'water'|'electric', point.id, point.point_usage))
  if (/花洒/.test(anchor.label) && !/扶手/.test(anchor.label)) {
    spec.fixtures.filter((item) => item.layout_generated && item.kind === 'water' && /自动花洒/.test(item.label)).forEach((point) => replace(point, /热/.test(point.label) ? 75 : -75, 1050))
  }
  if (/洗衣机/.test(anchor.label)) {
    spec.fixtures.filter((item) => item.layout_generated && /自动洗衣机/.test(item.label) && (item.kind === 'water' || item.kind === 'electric')).forEach((point) => replace(point, point.kind === 'electric' ? 120 : -120, point.kind === 'electric' ? 1200 : 1100))
  }
  if (anchor.kind === 'toilet') {
    spec.fixtures.filter((item) => item.layout_generated && item.kind === 'water' && item.point_usage === 'toilet').forEach((point) => replace(point, 200, 200))
  }
  if (anchor.label.includes('热水器')) {
    spec.fixtures.filter((item) => item.layout_generated && item.kind === 'water' && item.point_usage === 'heater').forEach((point) => replace(point, /冷水|进水/.test(point.label) ? -75 : 75, Math.max(1200, anchor.elevation_mm ?? 0)))
  }
  // The derived basin drain follows the vanity. A washer floor drain is a
  // measured binding point, so it remains authoritative when the appliance
  // is dragged instead of being regenerated from the appliance footprint.
  if (anchor.kind === 'vanity' || /浴室柜/.test(anchor.label)) {
    spec.fixtures.filter((item) => item.layout_generated && item.kind === 'water' && item.point_usage === 'basin').forEach((point) => replace(point, /热水/.test(point.label) ? 75 : -75, 500))
    spec.fixtures.filter((item) => item.layout_generated && (item.kind === 'drain' || item.kind === 'floor_drain') && fixturePointUsage(item) === 'basin').forEach((point) => {
      const target = deviceDrainPoint(spec, anchor, 0)
      point.x_mm = target.x_mm; point.z_mm = target.z_mm
      point.bound_wall_index = target.wallIndex
      point.rotation_deg = wallFacingRotation(target.semanticWall)
      moveInsideRoomPolygon(spec, point)
    })
  }
  // The ceiling 分水器 re-anchors to the re-routed cold manifold whenever a
  // drag changes the plumbing picture.
  syncManifoldFixture(spec)
}

/** Re-anchor the single ceiling 分水器 to the current cold-water route. */
export function syncManifoldFixture(spec: RoomSpec) {
  const manifold = spec.fixtures.find((item) => item.layout_generated && item.kind === 'pipe' && /分水器/.test(item.label))
  if (!manifold) return
  const route = routePlumbing(spec)
  if (!route?.manifold_ports) return
  manifold.x_mm = route.cold_manifold.x_mm
  manifold.z_mm = route.cold_manifold.z_mm
  manifold.elevation_mm = Math.max(0, route.cold_manifold.y_mm - manifold.height_mm)
  manifold.width_mm = route.manifold_ports === 6 ? 320 : 420
  manifold.label = `${route.manifold_ports === 6 ? 'FSN1-6' : 'FSN1-8'} ${route.manifold_ports}孔分水器`
}

function appendToiletWaterValve(spec: RoomSpec, fixtures: FixtureSpec[], toilet: FixtureSpec | undefined, id: string) {
  if (!toilet || spec.fixtures.some((item) => item.kind === 'water' && fixturePointUsage(item) === 'toilet' && !item.layout_generated)) return
  const wall = semanticWallForIndex(spec, toilet.bound_wall_index) ?? wallNearestPoint(spec, toilet)
  fixtures.push(wallServicePoint(spec, wall, toilet, 200, 200, '自动马桶进水阀', 'water', id, 'toilet'))
}

function appendHeaterWaterValves(spec: RoomSpec, fixtures: FixtureSpec[], heater: FixtureSpec | undefined, id: string) {
  if (!heater) return
  const measured = spec.fixtures.filter((item) => item.kind === 'water' && item.point_usage === 'heater' && !item.layout_generated)
  const wall = semanticWallForIndex(spec, heater.bound_wall_index) ?? wallNearestPoint(spec, heater)
  const elevation = Math.max(1200, heater.elevation_mm ?? 0)
  if (!measured.some((item) => /冷水|进水/.test(item.label))) fixtures.push(wallServicePoint(spec, wall, heater, -75, elevation, '自动热水器冷水进水角阀', 'water', `${id}-cold`, 'heater'))
  if (!measured.some((item) => /热水|出水/.test(item.label))) fixtures.push(wallServicePoint(spec, wall, heater, 75, elevation, '自动热水器热水出水角阀', 'water', `${id}-hot`, 'heater'))
}

/** Standard basin rough-in viewed from the room: hot on the left, cold on the right. */
function appendVanityWaterValves(spec: RoomSpec, fixtures: FixtureSpec[], vanity: FixtureSpec | undefined, id: string) {
  if (!vanity) return
  const measured = spec.fixtures.filter((item) => item.kind === 'water' && fixturePointUsage(item) === 'basin' && !item.layout_generated)
  const wall = semanticWallForIndex(spec, vanity.bound_wall_index) ?? wallNearestPoint(spec, vanity)
  if (!measured.some((item) => /热水|hot/i.test(item.label))) fixtures.push(wallServicePoint(spec, wall, vanity, 75, 500, '自动浴室柜热水进水点', 'water', `${id}-hot`, 'basin'))
  if (!measured.some((item) => /冷水|cold/i.test(item.label))) fixtures.push(wallServicePoint(spec, wall, vanity, -75, 500, '自动浴室柜冷水进水点', 'water', `${id}-cold`, 'basin'))
}

/** Drain position at the rear of a placed appliance, offset along its wall. */
function deviceDrainPoint(spec: RoomSpec, device: FixtureSpec, tangentOffsetMm: number) {
  const boundary = layoutBoundary(spec)
  const wallIndex = device.bound_wall_index ?? nearestWallIndex(boundary, device) ?? 0
  const inward = wallInwardNormal(boundary, wallIndex)
  const tangent = { x: -inward.z, z: inward.x }
  const rear = Math.max(20, device.depth_mm / 2 - 40)
  return {
    wallIndex,
    semanticWall: semanticWallForIndex(spec, wallIndex) ?? wallNearestPoint(spec, device),
    x_mm: Math.round(device.x_mm - inward.x * rear + tangent.x * tangentOffsetMm),
    z_mm: Math.round(device.z_mm - inward.z * rear + tangent.z * tangentOffsetMm),
  }
}

/**
 * Only the basin drain is derived from an appliance. The model library has no
 * washer-specific floor-drain type, so auto-layout must not invent an
 * "automatic washer drain" that could duplicate or misclassify a generic
 * measured floor drain.
 */
function appendDeviceDrains(spec: RoomSpec, fixtures: FixtureSpec[], vanity: FixtureSpec | undefined, _washer: FixtureSpec | undefined, idPrefix: string) {
  // A user-pinned drain is the authority for its appliance: keep the measured
  // point verbatim and do not regenerate a duplicate next to it.
  const pinnedBasinDrain = spec.fixtures.find((fixture) => !fixture.layout_generated && fixture.placement_locked && fixture.kind === 'drain' && fixturePointUsage(fixture) === 'basin')
  if (vanity && !pinnedBasinDrain) {
    const point = deviceDrainPoint(spec, vanity, 0)
    const basinDrain = fixture(`${idPrefix}-basin-drain`, 'drain', '自动洗面盆排水', point.x_mm, point.z_mm, 100, 100, 40, wallFacingRotation(point.semanticWall))
    basinDrain.point_usage = 'basin'
    basinDrain.bound_wall_index = point.wallIndex
    moveInsideRoomPolygon(spec, basinDrain)
    fixtures.push(basinDrain)
  }
}

/**
 * Exactly one ceiling 分水器 per layout: six ports for up to six cold
 * outlets, eight ports beyond that, positioned at the routed cold manifold.
 */
function appendManifoldFixture(spec: RoomSpec, fixtures: FixtureSpec[], id: string) {
  const preserved = spec.fixtures.filter((item) => !item.layout_generated)
  const route = routePlumbing({ ...spec, fixtures: [...preserved, ...fixtures] })
  if (!route?.manifold_ports) return
  const ports = route.manifold_ports
  const manifold = fixture(id, 'pipe', `${ports === 6 ? 'FSN1-6' : 'FSN1-8'} ${ports}孔分水器`, route.cold_manifold.x_mm, route.cold_manifold.z_mm, ports === 6 ? 320 : 420, 90, 60)
  manifold.mounting_surface = 'ceiling'
  manifold.elevation_mm = Math.max(0, route.cold_manifold.y_mm - manifold.height_mm)
  fixtures.push(manifold)
}

/**
 * Re-attach every wall-dependent appliance after an indirect room/spec edit.
 *
 * Direct dragging already resolves a fixture against a wall. Room resizing,
 * finish regeneration, inspector coordinate edits and other parent changes can
 * move the wall (or the fixture) without going through that drag path. Preserve
 * the bound segment when it is still valid, then recompute rotation and the
 * rear-face offset from the new finished surface. Generated service points are
 * re-projected only after their appliance has reached its final wall.
 */
export function reattachWallDependentFixtures(spec: RoomSpec) {
  const boundary = layoutBoundary(spec)
  const anchors: FixtureSpec[] = []
  for (const item of spec.fixtures) {
    const gap = requiredRearWallGap(item)
    if (gap === undefined) continue
    const bound = item.bound_wall_index
    const wallIndex = bound !== null && bound !== undefined && bound >= 0 && bound < boundary.length
      ? bound
      : nearestWallIndex(boundary, item) ?? 0
    snapRearToWallIndex(spec, item, wallIndex, gap)
    anchors.push(item)
  }
  anchors.forEach((anchor) => syncDraggedFixtureServicePoints(spec, anchor))
}

function isSpatialWetZone(item: FixtureSpec) {
  return item.kind === 'shower' && /淋浴(?:湿)?区/.test(item.label)
}

export function blocksUseClearance(candidate: FixtureSpec, clearance: FixtureSpec, other: FixtureSpec) {
  // The open shower zone is a floor-use region rather than a solid obstacle.
  // Fixture bodies cannot enter it, but standing/use clearances may overlap it.
  // Point evidence (drains, water/electric points and the ceiling manifold)
  // is not a walkable body and must not make a cabinet's operating aisle
  // appear blocked. These points remain hard anchors for plumbing placement.
  const isServicePoint = ['floor_drain', 'drain', 'water', 'electric', 'pipe'].includes(other.kind)
  return !isSpatialWetZone(other) && !isServicePoint && !permittedAssembly(candidate, other) && overlaps(clearance, other)
}
function openingEnvelope(spec: RoomSpec, opening: RoomSpec['openings'][number], depth: number, label: string): FixtureSpec | null {
  if (opening.wall_index < 0 || opening.wall_index >= spec.boundary.length) return null
  const start = spec.boundary[opening.wall_index]
  const end = spec.boundary[(opening.wall_index + 1) % spec.boundary.length]
  const length = Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm)
  if (!length) return null
  const tangent = { x: (end.x_mm - start.x_mm) / length, z: (end.z_mm - start.z_mm) / length }
  const inward = wallInwardNormal(layoutBoundary(spec), opening.wall_index)
  const horizontal = Math.abs(tangent.x) >= Math.abs(tangent.z)
  return {
    id: `opening-envelope-${opening.id}`,
    kind: 'other',
    label,
    x_mm: start.x_mm + tangent.x * (opening.offset_mm + opening.width_mm / 2) + inward.x * depth / 2,
    z_mm: start.z_mm + tangent.z * (opening.offset_mm + opening.width_mm / 2) + inward.z * depth / 2,
    width_mm: horizontal ? opening.width_mm : depth,
    depth_mm: horizontal ? depth : opening.width_mm,
    rotation_deg: 0,
    height_mm: Math.max(1, opening.height_mm),
    elevation_mm: opening.sill_mm ?? 0,
    source: 'derived',
    confidence: 1,
  }
}

export function blocksDoorEnvelope(spec: RoomSpec, f: FixtureSpec) {
  // Door swing is a floor-use constraint. Elevated wall accessories do not
  // block passage, preserving the existing accessibility semantics.
  if (isElevatedDoorAccessory(f)) return false
  return spec.openings.filter((opening) => opening.kind === 'door').some((door) => {
    const form = door.opening_form ?? 'unknown'
    const swing = door.swing_direction ?? 'unknown'
    const depth = (form === 'sliding' || form === 'pocket' || form === 'folding' || swing === 'outward') ? 300 : Math.max(800, door.width_mm)
    const envelope = openingEnvelope(spec, door, depth, '门洞开启及通行包络')
    return !!envelope && overlaps(f, envelope)
  })
}

export function blocksWindowEnvelope(spec: RoomSpec, f: FixtureSpec) {
  return spec.openings.filter((opening) => opening.kind === 'window' || opening.kind === 'opening').some((opening) => {
    const fixtureBottom = f.elevation_mm ?? 0
    const fixtureTop = fixtureBottom + Math.max(1, f.height_mm)
    const openingBottom = opening.sill_mm ?? 0
    const openingTop = openingBottom + Math.max(1, opening.height_mm)
    // Floor furniture still occupies the opening's wall segment in plan view,
    // even when its top is below the sill. Elevated accessories only conflict
    // when their actual vertical span intersects the opening.
    if (fixtureBottom > 50 && (fixtureTop <= openingBottom || fixtureBottom >= openingTop)) return false
    const envelope = openingEnvelope(spec, opening, 120, opening.kind === 'window' ? '窗洞禁放区' : '洞口禁放区')
    return !!envelope && overlaps(f, envelope)
  })
}

function blocksFurnitureOpeningEnvelope(spec: RoomSpec, f: FixtureSpec) {
  return blocksDoorEnvelope(spec, f) || blocksWindowEnvelope(spec, f)
}

/**
 * Resolve a direct-plan drag to the closest legal physical placement.
 *
 * The plan editor previously committed the cursor coordinate verbatim. That
 * allowed a fixture centre to remain inside the room while its model body was
 * outside a finished wall, inside another fixture, or in a door envelope.
 * Wall-mounted/service fixtures also lost the rear-face attachment used by the
 * automatic solver. Keep manual editing on the same physical rules instead.
 */
export function resolveFixtureDrag(spec: RoomSpec, fixtureId: string, requested: { x_mm: number; z_mm: number }) {
  const fixture = spec.fixtures.find((item) => item.id === fixtureId)
  if (!fixture) return null
  // A washer drain is a floor point that the appliance must cover; it is not
  // a wall service point. Keep its measured/manual position independent from
  // wall snapping so the drain can sit under a washer with the required rear
  // clearance instead of being pulled back onto the nearest wall.
  const washerDrain = (fixture.kind === 'floor_drain' || fixture.kind === 'drain') && (
    fixturePointUsage(fixture) === 'washer'
    || /洗衣机地漏/.test(fixture.label)
    // Legacy imports used a generic second floor drain; reuse the solver's
    // inference so that drag behavior matches automatic placement behavior.
    || washerDrainPoint(spec)?.id === fixture.id
  )
  if (washerDrain) {
    return { ...fixture, x_mm: requested.x_mm, z_mm: requested.z_mm, bound_wall_index: null }
  }
  const pointFixture = ['floor_drain', 'drain', 'water', 'electric', 'pipe'].includes(fixture.kind)
  if (pointFixture) {
    const snap = snapPointToNearestWall(layoutBoundary(spec), requested)
    return { ...fixture, x_mm: snap?.point.x_mm ?? requested.x_mm, z_mm: snap?.point.z_mm ?? requested.z_mm, bound_wall_index: snap?.wall_index ?? null }
  }
  const boundary = layoutBoundary(spec)
  const occupied = spec.fixtures.filter((item) => item.id !== fixtureId && !['floor_drain', 'drain', 'water', 'electric'].includes(item.kind))
  const rearGap = requiredRearWallGap(fixture)
  const legal = (candidate: FixtureSpec) => fixtureInsideRoom(candidate, boundary)
    && !blocksFurnitureOpeningEnvelope(spec, candidate)
    && !occupied.some((other) => !permittedAssembly(candidate, other) && overlaps(candidate, other, bodyCollisionClearance(candidate, other)))
    && (() => {
      if (!isBathroomCabinet(candidate)) return true
      const clearance = frontClearanceEnvelope(candidate, { fixture_role: 'vanity', wall: 'nearest_plumbing', zone: 'dry', min_clearance_mm: bathroomVanityInstallationRules.front_clearance_mm })
      return !!clearance
        && fixtureInsideRoom(clearance, boundary)
        && !blocksFurnitureOpeningEnvelope(spec, clearance)
        && !occupied.some((other) => blocksUseClearance(candidate, clearance, other))
    })()
  const place = (x_mm: number, z_mm: number) => {
    const candidate = { ...fixture, x_mm, z_mm }
    if (rearGap !== undefined) snapRearToWall(spec, candidate, wallNearestPoint(spec, candidate), rearGap)
    else moveInsideRoomPolygon(spec, candidate)
    return candidate
  }

  const direct = place(requested.x_mm, requested.z_mm)
  if (legal(direct)) return direct
  const bounds = rectangleBounds(spec)
  const maxRadius = Math.ceil(Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 25) * 25
  for (let radius = 25; radius <= maxRadius; radius += 25) {
    const offsets: Array<[number, number]> = []
    for (let delta = -radius; delta <= radius; delta += 25) {
      offsets.push([delta, -radius], [delta, radius], [-radius, delta], [radius, delta])
    }
    for (const [dx, dz] of offsets) {
      const candidate = place(requested.x_mm + dx, requested.z_mm + dz)
      if (legal(candidate)) return candidate
    }
  }
  return { ...fixture }
}
type PlacementAnchor = { x_mm: number; z_mm: number; rotation_deg?: number; locked?: boolean; max_distance_mm?: number; wall_index?: number }

function showerDrainPoint(spec: RoomSpec) {
  return spec.fixtures.find((fixture) => fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'shower')
}

function washerDrainPoint(spec: RoomSpec) {
  // Explicit usage is preferred; the label fallback keeps rooms saved before
  // the washer point type was introduced compatible with the new binding.
  const explicit = spec.fixtures.find((fixture) => !fixture.layout_generated && fixture.kind === 'floor_drain' && (
    fixturePointUsage(fixture) === 'washer' || /洗衣机地漏/.test(fixture.label)
  ))
  if (explicit) return explicit
  // Older measurement imports represented the second floor drain as generic.
  // When a room has a distinct shower drain, treat that remaining measured
  // drain as the washer anchor so legacy projects do not place the washer on
  // an unrelated wall and collide with the toilet.
  const hasShowerDrain = spec.fixtures.some((fixture) => !fixture.layout_generated && fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'shower')
  return hasShowerDrain
    ? spec.fixtures.find((fixture) => !fixture.layout_generated && fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'general')
    : undefined
}

function hasLaundryInfrastructure(spec: RoomSpec) {
  return spec.fixtures.some((fixture) => /洗衣/.test(fixture.label) || (
    fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'washer'
  )) || !!washerDrainPoint(spec)
}

function measuredShowerWaterPoint(spec: RoomSpec) {
  return spec.fixtures.find((fixture) => fixture.kind === 'water' && fixturePointUsage(fixture) === 'shower' && !fixture.layout_generated)
}

function toiletDrainPoint(spec: RoomSpec) {
  return spec.fixtures.find((fixture) => fixture.kind === 'drain' && fixturePointUsage(fixture) === 'toilet')
}

function toiletAnchorPoint(spec: RoomSpec): PlacementAnchor | undefined {
  const drain = toiletDrainPoint(spec)
  const measuredToilet = spec.fixtures.find((fixture) => fixture.kind === 'toilet' && !fixture.layout_generated)
  if (!drain && measuredToilet) return {
    x_mm: measuredToilet.x_mm,
    z_mm: measuredToilet.z_mm,
    rotation_deg: measuredToilet.rotation_deg,
    max_distance_mm: 600,
  }
  if (!drain) return undefined
  // The toilet drain is the only hard placement anchor. The fixture may make
  // a bounded 600 mm installation adjustment around that point; other
  // measured points are evidence for ranking, not immovable obstacles.
  return {
    ...toiletPlacementFromDrain(spec, drain),
    max_distance_mm: 600,
    locked: drain.placement_locked === true,
  }
}

/**
 * Invert `deviceDrainPoint`: given a user-pinned drain, compute the appliance
 * centre whose generated drain would land exactly on the pinned point, so a
 * locked point anchors the appliance instead of being dragged around by it.
 * The rear offset is clamped so the appliance body stays wall-attached even
 * when the pinned point sits closer to the finished wall than a generated
 * drain would (a generated drain is 40 mm inside the rear face).
 */
function applianceAnchorFromLockedDrain(spec: RoomSpec, drain: FixtureSpec, dims: { width_mm: number; depth_mm: number }, tangentOffsetMm: number): PlacementAnchor {
  const boundary = layoutBoundary(spec)
  const wallIndex = drain.bound_wall_index ?? nearestWallIndex(boundary, drain)
  if (wallIndex === null) return { x_mm: drain.x_mm, z_mm: drain.z_mm, rotation_deg: drain.rotation_deg || undefined, locked: true }
  const projection = projectPointToWall(boundary, wallIndex, drain)
  const inward = wallInwardNormal(boundary, wallIndex)
  const tangent = { x: -inward.z, z: inward.x }
  const drainDistance = projection?.distance_mm ?? 0
  const rear = Math.max(dims.depth_mm / 2 - 40, dims.depth_mm / 2 + WALL_ATTACHMENT_CLEARANCE_MM - drainDistance)
  return {
    x_mm: Math.round(drain.x_mm + inward.x * rear - tangent.x * tangentOffsetMm),
    z_mm: Math.round(drain.z_mm + inward.z * rear - tangent.z * tangentOffsetMm),
    rotation_deg: wallFacingRotation(semanticWallForIndex(spec, wallIndex) ?? 'south'),
    locked: true,
    wall_index: wallIndex,
  }
}

function moveInsideRoomPolygon(spec: RoomSpec, item: FixtureSpec) {
  const boundary = layoutBoundary(spec)
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
  const index = nearestWallIndex(layoutBoundary(spec), point)
  return semanticWallForIndex(spec, index) ?? 'south'
}

function infrastructureRule(spec: RoomSpec, instruction: LayoutInstruction, anchor?: PlacementAnchor): LayoutInstruction {
  if (!anchor) return instruction
  const anchorWall = anchor.wall_index === undefined ? null : semanticWallForIndex(spec, anchor.wall_index)
  return { ...instruction, wall: anchorWall ?? wallNearestPoint(spec, anchor) }
}

function nudgeVariantFixture(spec: RoomSpec, item: FixtureSpec, variantIndex: number, occupied: FixtureSpec[], instruction: LayoutInstruction) {
  if (variantIndex <= 0 || item.bound_wall_index === undefined || item.bound_wall_index === null) return
  instruction = effectiveLayoutInstruction(item, instruction)
  const boundary = layoutBoundary(spec)
  const start = boundary[item.bound_wall_index]
  const end = boundary[(item.bound_wall_index + 1) % boundary.length]
  const length = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
  const tangent = { x: (end.x_mm - start.x_mm) / length, z: (end.z_mm - start.z_mm) / length }
  // Search the complete usable wall run when a tier seed is blocked by the
  // toilet or another fixed body. A short ±120 mm nudge is insufficient in
  // compact rooms; walking the segment keeps the cabinet fixed-size and
  // attached while finding the nearest legal operating envelope.
  const offsets = [variantIndex * 120, -variantIndex * 120, variantIndex * 240, -variantIndex * 240]
  for (let step = 25; step <= length; step += 25) offsets.push(step, -step)
  for (const offset of [...new Set(offsets)]) {
    const candidate = { ...item, x_mm: Math.round(item.x_mm + tangent.x * offset), z_mm: Math.round(item.z_mm + tangent.z * offset) }
    if (!fixtureInsideRoom(candidate, boundary) || blocksFurnitureOpeningEnvelope(spec, candidate)) continue
    if (occupied.some((other) => !permittedAssembly(candidate, other) && overlaps(candidate, other, bodyCollisionClearance(candidate, other)))) continue
    const clearance = frontClearanceEnvelope(candidate, instruction)
    if (clearance && (!fixtureInsideRoom(clearance, boundary) || blocksFurnitureOpeningEnvelope(spec, clearance) || occupied.some((other) => blocksUseClearance(candidate, clearance, other)))) continue
    item.x_mm = candidate.x_mm
    item.z_mm = candidate.z_mm
    if (clearance) placementClearances.set(item, clearance)
    return
  }
}

function fixedLayoutObstacles(spec: RoomSpec) {
  const fixedKinds = new Set<FixtureSpec['kind']>(['column', 'radiator', 'pipe'])
  return spec.fixtures.filter((fixture) => !fixture.layout_generated && fixedKinds.has(fixture.kind))
}

function placementWallIndices(spec: RoomSpec, item: FixtureSpec, preferredWall: Exclude<SemanticWall, 'nearest_plumbing'>, target: { x:number; z:number }, rearGap: number | undefined, anchor?: PlacementAnchor) {
  const primary = anchor?.wall_index ?? wallIndexForSemantic(spec, preferredWall, { x_mm:target.x, z_mm:target.z })
  // A measured toilet drain anchors the installation area, not a single wall.
  // The nearest wall can be too close for the toilet body's rotated envelope;
  // allow alternate walls while retaining the primary wall as the first choice.
  if (rearGap === undefined && !(anchor && item.kind === 'toilet') && item.kind !== 'shower') return [primary]
  const boundary = layoutBoundary(spec)
  const canChangeDirection = item.kind === 'shower' || item.kind === 'toilet'
    || !!(anchor && /(洗衣机|浴室柜)/.test(item.label))
    || (!anchor && /(洗衣机|浴室柜)/.test(item.label))
  const ranked = boundary.map((start, index) => {
    const end = boundary[(index + 1) % boundary.length]
    const projection = projectPointToWall(boundary, index, { x_mm:target.x, z_mm:target.z })
    return {
      index,
      preferred: semanticWallForIndex(spec, index) === preferredWall,
      distance: projection?.distance_mm ?? Number.POSITIVE_INFINITY,
      length: Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm),
    }
  }).filter((candidate) => canChangeDirection || candidate.preferred)
    .sort((left, right) => Number(right.preferred) - Number(left.preferred) || left.distance - right.distance || right.length - left.length)
  return [primary, ...ranked.map((candidate) => candidate.index).filter((index) => index !== primary)]
}

function placementPriority(item: FixtureSpec) {
  // The cabinet has a fixed installation envelope and must claim a legal
  // wall run before the washer searches within its measured drain radius.
  // Solving the washer first can consume the only usable run in stepped rooms,
  // after which the cabinet fallback overlaps the washer body.
  if (item.kind === 'vanity' || /浴室柜/.test(item.label)) return 6
  if (/洗衣机/.test(item.label)) return 5
  if (item.kind === 'toilet') return 4
  if (/淋浴椅|适老椅/.test(item.label)) return 1
  return 0
}

type PlacementCandidate = { x:number; z:number; rotation:number; width:number; depth:number; score:number; wallIndex:number; clearance?:FixtureSpec }

function retainFixtureAcrossLayouts(fixture: FixtureSpec) {
  if (fixture.layout_generated) return false
  // Layouts saved by older clients did not persist layout_generated. Do not
  // retain their deterministic service points when replacing the layout.
  if (fixture.source === 'derived' && (
    /^自动/.test(fixture.label)
    || /(?:^|-)(?:shower-(?:cold|hot)|washer-(?:water|electric)|drain)$/.test(fixture.id)
    || /^湿区地漏\s*·/.test(fixture.label)
  )) return false
  // Utility points and structural obstacles survive a layout replacement;
  // measured fixture bodies are replaced by the solved product entities.
  return ['floor_drain', 'drain', 'water', 'electric', 'pipe', 'column', 'radiator'].includes(fixture.kind)
}

function correctedModelAsset(fixture: FixtureSpec) {
  const asset = fixture.model_asset
  return asset && (Object.keys(asset.orientation_mapping ?? {}).length > 0 || !!asset.orientation_view) ? asset : undefined
}

/** Keep a reviewed library orientation when a new layout recreates the SKU. */
function preserveCorrectedModelAssets(source: FixtureSpec[], generated: FixtureSpec[]) {
  const reviewed = source.map((fixture) => ({ fixture, asset: correctedModelAsset(fixture) })).filter((item): item is { fixture: FixtureSpec; asset: NonNullable<FixtureSpec['model_asset']> } => !!item.asset)
  if (!reviewed.length) return generated
  return generated.map((item) => {
    if (!item.model_asset || correctedModelAsset(item)) return item
    const code = item.label.split(' · ')[0]
    const match = reviewed.find(({ fixture, asset }) => asset.id === item.model_asset?.id || fixture.label.split(' · ')[0] === code)
    return match ? { ...item, model_asset: match.asset } : item
  })
}

function searchPlacement(spec: RoomSpec, item: FixtureSpec, occupied: FixtureSpec[], instruction: LayoutInstruction, plumbing?: FixtureSpec, trace = { evaluated: 0, feasible: 0 }, anchor?: PlacementAnchor, allowFreeToiletAnchor = false) {
  // A measured washer point can leave less than the nominal 600 mm front
  // aisle in a stepped alcove. Once the bounded anchor search is retried, use
  // the documented compact fallback instead of abandoning the point and
  // restoring the tier's arbitrary seed position.
  // A measured toilet drain is authoritative, but a compact room may not
  // physically provide the nominal 500 mm front aisle around that point.
  // The free-anchor retry below uses a documented 300 mm compact fallback;
  // body collision, room boundary and door-envelope checks remain hard.
  instruction = allowFreeToiletAnchor && item.kind === 'toilet'
    ? { ...instruction, min_clearance_mm: Math.min(300, Math.max(0, instruction.min_clearance_mm)) }
    : allowFreeToiletAnchor && /洗衣机/.test(item.label)
      ? { ...instruction, min_clearance_mm: Math.max(0, instruction.min_clearance_mm) }
      : effectiveLayoutInstruction(item, instruction)
  // Hard-collision avoidance must not depend on a coarse 100 mm lattice:
  // compact measured rooms often have only a narrow legal interval.
  const b = rectangleBounds(spec)
  // Free washer-anchor retries only need a coarse local sweep because the
  // measured drain radius is 600 mm. Keep the normal 25 mm precision for all
  // other furniture while avoiding multi-second fallback scans per tier.
  const step = allowFreeToiletAnchor && /洗衣机/.test(item.label) ? 100 : 25
  const anchoredFreePlacement = allowFreeToiletAnchor && anchor && (item.kind === 'toilet' || /洗衣机/.test(item.label))
  const rearGap = anchoredFreePlacement ? undefined : requiredRearWallGap(item)
  const boundary = layoutBoundary(spec)
  const hostWall = instruction.wall === 'nearest_plumbing' ? wallNearestPoint(spec, plumbing ?? item) : instruction.wall
  const target = anchor
    ? { x: anchor.x_mm, z: anchor.z_mm }
    : plumbing
      ? { x: plumbing.x_mm, z: plumbing.z_mm }
      : semanticTarget(spec, instruction, item.width_mm, item.depth_mm)
  const finishBoundary = layoutBoundary(spec)
  const primaryWallIndex = wallIndexForSemantic(spec, hostWall, { x_mm:target.x, z_mm:target.z })
  let best: PlacementCandidate | null = null
  let relaxedBest: PlacementCandidate | null = null
  for (const hostWallIndex of placementWallIndices(spec, item, hostWall, target, rearGap, anchor)) {
    const hostStart = finishBoundary[hostWallIndex]
    const hostEnd = finishBoundary[(hostWallIndex + 1) % finishBoundary.length]
    const hostInward = wallInwardNormal(finishBoundary, hostWallIndex)
    const resolvedHostWall = semanticWallForIndex(spec, hostWallIndex) ?? hostWall
    const hostIsVertical = Math.abs(hostEnd.z_mm-hostStart.z_mm) >= Math.abs(hostEnd.x_mm-hostStart.x_mm)
    const rotations = rearGap === undefined
      ? (anchor && item.kind === 'toilet'
        ? [...new Set([wallFacingRotation(resolvedHostWall), anchor.rotation_deg].filter((value): value is number => value !== undefined))]
        : (anchor?.rotation_deg === undefined ? [0, 90, 180, 270] : [anchor.rotation_deg]))
      : [wallFacingRotation(resolvedHostWall)]
    for (const rotation of rotations) {
      const footprint = footprintForRotation(item, rotation)
      const width = footprint.width
      const depth = footprint.depth
      const gridX = Array.from({ length: Math.max(0, Math.floor((b.maxX - width - 80) / step) + 1) }, (_, index) => Math.ceil((b.minX + width / 2 + 40) / step) * step + index * step)
      const gridZ = Array.from({ length: Math.max(0, Math.floor((b.maxZ - depth - 80) / step) + 1) }, (_, index) => Math.ceil((b.minZ + depth / 2 + 40) / step) * step + index * step)
      // A locked washer drain still needs the appliance rear edge against the
      // host wall. The drain remains covered by the bounded X/Z search; only
      // the cabinet/toilet anchors are allowed to float freely off-wall.
      const lockedWallAppliance = anchor?.locked && (item.kind === 'vanity' || /洗衣机/.test(item.label))
      const enforceWallAttachment = !anchor?.locked || lockedWallAppliance
      const wallX = rearGap !== undefined && hostIsVertical && enforceWallAttachment ? Math.round(hostStart.x_mm + hostInward.x * (width / 2 + rearGap)) : undefined
      const wallZ = rearGap !== undefined && !hostIsVertical && enforceWallAttachment ? Math.round(hostStart.z_mm + hostInward.z * (depth / 2 + rearGap)) : undefined
      const segmentMinX = Math.min(hostStart.x_mm,hostEnd.x_mm)+width/2,segmentMaxX=Math.max(hostStart.x_mm,hostEnd.x_mm)-width/2
      const segmentMinZ = Math.min(hostStart.z_mm,hostEnd.z_mm)+depth/2,segmentMaxZ=Math.max(hostStart.z_mm,hostEnd.z_mm)-depth/2
      // Include exact room-fitting centers. A 100 mm grid alone misses the
      // only valid position in compact rooms by a few millimetres.
      const fitX = [b.minX + width / 2 + 1, b.maxX - width / 2 - 1]
      const fitZ = [b.minZ + depth / 2 + 1, b.maxZ - depth / 2 - 1]
      // A coarse Cartesian grid can skip the only usable point on a short or
      // concave wall segment. Add a 50 mm sweep along the host wall so model
      // dimensions and finished-wall offsets are evaluated continuously.
      const wallSweep = (start: number, end: number, spacing = 50) => {
        const values: number[] = []
        const direction = end >= start ? 1 : -1
        for (let value = start; direction > 0 ? value <= end : value >= end; value += direction * spacing) values.push(Math.round(value))
        if (!values.includes(Math.round(end))) values.push(Math.round(end))
        return values
      }
      const tangentStart = hostIsVertical ? segmentMinZ : segmentMinX
      const tangentEnd = hostIsVertical ? segmentMaxZ : segmentMaxX
      const wallSweepValues = rearGap === undefined ? [] : wallSweep(tangentStart, tangentEnd)
      // A locked service point anchors the appliance installation area, but
      // the body may need a bounded two-dimensional nudge around a stepped
      // return. Restrict both axes to a 300 mm local window; max_distance_mm
      // below remains the authoritative radius from the measured point.
      const lockedAxisValues = (axis: 'x' | 'z') => {
        const pinned = axis === 'x' ? anchor!.x_mm : anchor!.z_mm
        const spacing = allowFreeToiletAnchor && /洗衣机/.test(item.label) ? 50 : 25
        const count = Math.floor(600 / spacing) + 1
        return Array.from({ length: count }, (_, index) => Math.round(pinned - 300 + index * spacing))
      }
      const baseX = anchor?.locked ? lockedAxisValues('x') : [...new Set([anchor?.x_mm,target.x,...fitX,...gridX,...(!hostIsVertical ? wallSweepValues : [])].filter((value): value is number => value !== undefined))]
      const baseZ = anchor?.locked ? lockedAxisValues('z') : [...new Set([anchor?.z_mm,target.z,...fitZ,...gridZ,...(hostIsVertical ? wallSweepValues : [])].filter((value): value is number => value !== undefined))]
      const xValues = wallX === undefined ? (rearGap !== undefined && !hostIsVertical && enforceWallAttachment ? baseX.filter((value)=>value>=segmentMinX&&value<=segmentMaxX) : baseX) : [wallX]
      const zValues = wallZ === undefined ? (rearGap !== undefined && hostIsVertical && enforceWallAttachment ? baseZ.filter((value)=>value>=segmentMinZ&&value<=segmentMaxZ) : baseZ) : [wallZ]
      for (const x of xValues) {
        for (const z of zValues) {
          trace.evaluated++
          if (anchor?.max_distance_mm !== undefined && Math.hypot(x - anchor.x_mm, z - anchor.z_mm) > anchor.max_distance_mm) continue
          const candidate = { ...item, x_mm:x, z_mm:z, rotation_deg:rotation }
          // A measured shower drain is an installation anchor: the solved
          // shower footprint must contain the complete drain envelope. Using
          // the point only as a distance score can select a wall-favouring
          // corner on stepped rooms and leave the authoritative drain outside
          // every persisted wet-zone rectangle.
          const showerDrainContained = item.kind !== 'shower' || !plumbing || fixturePointUsage(plumbing) !== 'shower' || (
            Math.abs(candidate.x_mm - plumbing.x_mm) + plumbing.width_mm / 2 <= width / 2 + 1
            && Math.abs(candidate.z_mm - plumbing.z_mm) + plumbing.depth_mm / 2 <= depth / 2 + 1
          )
          if (!showerDrainContained) continue
          const washerDrainCovered = !/洗衣机/.test(item.label) || !plumbing || fixturePointUsage(plumbing) !== 'washer' || (
            Math.abs(candidate.x_mm - plumbing.x_mm) + plumbing.width_mm / 2 <= width / 2 + 1
            && Math.abs(candidate.z_mm - plumbing.z_mm) + plumbing.depth_mm / 2 <= depth / 2 + 1
          )
          if (!washerDrainCovered) continue
          const clearance = frontClearanceEnvelope(candidate, instruction)
          const occupiedConflict = occupied.some((other) => !permittedAssembly(candidate, other) && (
            overlaps(candidate, other, bodyCollisionClearance(candidate, other, /淋浴隔断/.test(other.label) ? 20 : BODY_GAP_MM))
            // The wet zone is open floor, not a solid fixture. It may share a
            // furniture use-clearance envelope; only solid bodies must keep
            // the shower footprint out.
            || (item.kind !== 'shower' && placementClearances.get(other) ? overlaps(candidate, placementClearances.get(other)!) : false)
          ))
          const clearanceConflict = !!clearance && (
            !fixtureInsideRoom(clearance, boundary)
            || blocksFurnitureOpeningEnvelope(spec, clearance)
            || occupied.some((other) => blocksUseClearance(candidate, clearance, other))
          )
          if (!fixtureInsideRoom(candidate, boundary) || blocksFurnitureOpeningEnvelope(spec, candidate) || occupiedConflict) continue
          if (clearanceConflict) {
            // A standard 600 mm vanity clearance can be physically impossible
            // in a narrow measured room even when the cabinet itself fits. Try
            // a documented 300 mm fallback for the cabinet only; oversized or
            // stricter scripts remain hard failures.
            if (item.kind === 'other' && /洗衣机/.test(item.label) && instruction.min_clearance_mm <= 600) {
              const relaxedInstruction = { ...instruction, min_clearance_mm: 300 }
              const relaxedClearance = frontClearanceEnvelope(candidate, relaxedInstruction)
              const relaxedConflict = !relaxedClearance || !fixtureInsideRoom(relaxedClearance, boundary) || blocksFurnitureOpeningEnvelope(spec, relaxedClearance) || occupied.some((other) => blocksUseClearance(candidate, relaxedClearance, other))
              if (!relaxedConflict) {
                trace.feasible++
                const wallDistance = Math.min(x - b.minX - width / 2, b.maxX - x - width / 2, z - b.minZ - depth / 2, b.maxZ - z - depth / 2)
                const plumbingDistance = plumbing ? Math.hypot(x - plumbing.x_mm, z - plumbing.z_mm) : 0
                const semanticDistance = Math.hypot(x - target.x, z - target.z)
                const score = -wallDistance * 2 - plumbingDistance * 8 - semanticDistance * 8
                if (!relaxedBest || score > relaxedBest.score) relaxedBest = { x, z, rotation, width, depth, score, wallIndex:hostWallIndex, clearance:relaxedClearance }
              }
            }
            continue
          }
          trace.feasible++
          const wallDistance = Math.min(x - b.minX - width / 2, b.maxX - x - width / 2, z - b.minZ - depth / 2, b.maxZ - z - depth / 2)
          const plumbingDistance = plumbing ? Math.hypot(x - plumbing.x_mm, z - plumbing.z_mm) : 0
          const semanticDistance = Math.hypot(x - target.x, z - target.z)
          const wallContactWeight = plumbing ? 1800 : 12000
          const score = wetWallContactLength(spec, candidate) * wallContactWeight - wallDistance * 2 - plumbingDistance * 8 - semanticDistance * 8
          if (!best || score > best.score) best = { x, z, rotation, width, depth, score, wallIndex:hostWallIndex, clearance }
        }
      }
    }
    if (best) break
  }
  if (!best && relaxedBest) {
    const solved = relaxedBest
    Object.assign(item, { x_mm:solved.x, z_mm:solved.z, rotation_deg:solved.rotation })
    if (rearGap !== undefined) item.bound_wall_index = solved.wallIndex ?? primaryWallIndex
    if (solved.clearance) placementClearances.set(item, solved.clearance)
    relaxedPlacementClearances.add(item)
    return true
  }
  if (!best && anchor && item.kind === 'toilet' && !allowFreeToiletAnchor) {
    // A measured drain is a stronger constraint than a preferred wall. In a
    // stepped/concave room the nearest usable wall segment can be more than
    // 600 mm from the anchor, even though the toilet body itself fits at the
    // measured location. Retry without the wall-attachment requirement while
    // retaining the anchor radius and all body/door/clearance checks.
    const freePlacement = searchPlacement(spec, item, occupied, instruction, plumbing, trace, anchor, true)
    if (freePlacement) {
      relaxedPlacementClearances.add(item)
      return true
    }
    // Never move a measured toilet to an unrelated wall after an anchored
    // search fails; that silent fallback is what produced kilometre-scale
    // PLUMBING-TOILET offsets.
    return false
  }
  if (!best) {
    // Keep attached fixtures inside the wall-panel boundary even when a
    // clearance rule rejects this candidate. The caller still marks it
    // invalid. Anchored toilets are deliberately left at their measured point
    // when both wall and free placement are impossible.
    if (rearGap !== undefined && !anchor?.locked && !(anchor && item.kind === 'toilet')) snapRearToWall(spec, item, hostWall, rearGap)
    return false
  }
  const solved = best as NonNullable<typeof best>
  Object.assign(item, { x_mm:solved.x, z_mm:solved.z, rotation_deg:solved.rotation })
  if (rearGap !== undefined) item.bound_wall_index = solved.wallIndex ?? primaryWallIndex
  if (solved.clearance) placementClearances.set(item, solved.clearance)
  return true
}

function solveToiletReservation(spec: RoomSpec, item: FixtureSpec | undefined, occupied: FixtureSpec[], instruction: LayoutInstruction, plumbing: FixtureSpec | undefined, anchor: PlacementAnchor | undefined, trace: { evaluated: number; feasible: number }) {
  if (!item) return
  if (!searchPlacement(spec, item, occupied, instruction, plumbing, trace, anchor)) {
    // The reservation represents a measured toilet installation envelope. Do
    // not relocate it to a distant wall when the anchored search is
    // unsatisfiable; the real fixture will either use the free-anchor retry or
    // surface a local hard failure at its measured point.
    if (!(anchor && item.kind === 'toilet')) snapRearToWall(spec, item, wallNearestPoint(spec, item), TOILET_REAR_GAP_MM)
  }
}

function solveWetZone(spec: RoomSpec, id: string, label: string, preferredSize: number, instruction: LayoutInstruction, occupied: FixtureSpec[], plumbing: FixtureSpec | undefined, trace: { evaluated: number; feasible: number }) {
  const minimumSize = BATHROOM_AUTO_LAYOUT_RULES.shower_min_internal_mm
  const sizes = [...new Set([preferredSize, 900, minimumSize])].filter((size) => size <= preferredSize && size >= minimumSize)
  let last = fixture(id, 'shower', label, plumbing?.x_mm ?? 0, plumbing?.z_mm ?? 0, minimumSize, minimumSize, 2000)
  for (const size of sizes) {
    const target = plumbing ? { x: plumbing.x_mm, z: plumbing.z_mm } : semanticTarget(spec, instruction, size, size)
    const candidate = fixture(id, 'shower', label, target.x, target.z, size, size, 2000)
    last = candidate
    if (searchPlacement(spec, candidate, occupied, instruction, plumbing, trace)) return { shower: candidate, solved: true }
  }
  // A measured drain is commonly close to a wall. Using it as the centre of
  // the fallback footprint used to leave half of the wet zone outside the
  // room. Keep the failed status, but make the fallback geometry editable and
  // safe to render inside the finished boundary.
  moveInsideRoomPolygon(spec, last)
  return { shower: last, solved: false }
}

/**
 * Parametric shower enclosure. The wet zone is a rectangle whose wall-adjacent
 * edges are already enclosed by walls; the glass partition runs along the
 * remaining exposed edges — one full panel on the primary edge plus a return
 * panel covering half of the adjacent edge — so walls + glass cover three and
 * a half of the wet zone's four edges, leaving a half-edge entry gap.
 * Viewed from the front each panel's parameters are its left-right length
 * (derived from the solved wet-zone boundary, not a fixed SKU size) and its
 * height.
 */
function appendShowerScreenPanels(spec: RoomSpec, shower: FixtureSpec, fixtures: FixtureSpec[], idPrefix: string, quality: number, vanityInstruction?: LayoutInstruction, trace?: { evaluated: number; feasible: number }) {
  const screenDims = dimensionsFor('淋浴隔断', { width_mm: Math.max(shower.width_mm, shower.depth_mm), depth_mm: 45, height_mm: 2000 })
  const height = Math.min(2000, screenDims.height_mm)
  const thickness = 45
  const boundary = layoutBoundary(spec)
  const xMin = shower.x_mm - shower.width_mm / 2, xMax = shower.x_mm + shower.width_mm / 2
  const zMin = shower.z_mm - shower.depth_mm / 2, zMax = shower.z_mm + shower.depth_mm / 2
  const distanceToBoundary = (x: number, z: number) => Math.min(...boundary.map((point, index) => {
    const next = boundary[(index + 1) % boundary.length]
    const dx = next.x_mm - point.x_mm, dz = next.z_mm - point.z_mm
    const lengthSq = dx * dx + dz * dz
    const t = lengthSq ? Math.max(0, Math.min(1, ((x - point.x_mm) * dx + (z - point.z_mm) * dz) / lengthSq)) : 0
    return Math.hypot(x - (point.x_mm + t * dx), z - (point.z_mm + t * dz))
  }))
  const tolerance = 80
  const edges = [
    { key: 'north', horizontal: true, length: shower.width_mm, onWall: distanceToBoundary(xMin, zMin) <= tolerance && distanceToBoundary(xMax, zMin) <= tolerance, ax: xMin, az: zMin, bx: xMax, bz: zMin },
    { key: 'south', horizontal: true, length: shower.width_mm, onWall: distanceToBoundary(xMin, zMax) <= tolerance && distanceToBoundary(xMax, zMax) <= tolerance, ax: xMin, az: zMax, bx: xMax, bz: zMax },
    { key: 'west', horizontal: false, length: shower.depth_mm, onWall: distanceToBoundary(xMin, zMin) <= tolerance && distanceToBoundary(xMin, zMax) <= tolerance, ax: xMin, az: zMin, bx: xMin, bz: zMax },
    { key: 'east', horizontal: false, length: shower.depth_mm, onWall: distanceToBoundary(xMax, zMin) <= tolerance && distanceToBoundary(xMax, zMax) <= tolerance, ax: xMax, az: zMin, bx: xMax, bz: zMax },
  ] as const
  const inwardNormal = (key: (typeof edges)[number]['key']) => key === 'north' ? { x: 0, z: 1 } : key === 'south' ? { x: 0, z: -1 } : key === 'west' ? { x: 1, z: 0 } : { x: -1, z: 0 }
  const exposed = edges.filter((edge) => !edge.onWall).sort((left, right) => right.length - left.length)
  if (!exposed.length) return
  const code = ['GD1-1', 'GD1-2', 'GD2-1'][quality] ?? 'GD1-1'
  const screenAsset = modelAssetForProduct('淋浴隔断')
  const inset = thickness / 2 + 15
  // Build panels in a temporary list first. A glass panel is a real solid in
  // plan, so it must not consume the cabinet's 600 mm front operation zone.
  // In a tight measured room the correct result is an open wet zone rather
  // than a visually complete enclosure that makes the vanity unusable.
  const pendingPanels: FixtureSpec[] = []
  const pushPanel = (suffix: string, edge: (typeof edges)[number], fromX: number, fromZ: number, toX: number, toZ: number) => {
    const length = Math.hypot(toX - fromX, toZ - fromZ)
    if (length < 100) return
    const inward = inwardNormal(edge.key)
    const panel = fixture(
      `${idPrefix}-shower-screen-${suffix}`, 'other', `${code} 淋浴隔断 · ${suffix}`,
      (fromX + toX) / 2 + inward.x * inset, (fromZ + toZ) / 2 + inward.z * inset,
      edge.horizontal ? length : thickness, edge.horizontal ? thickness : length,
      height,
    )
    if (screenAsset) panel.model_asset = builtInAssetAsRoomAsset(screenAsset)
    pendingPanels.push(panel)
  }
  // Prefer an adjacent pair.  Irregular measured rooms can expose more than
  // two rectangle sides; taking the two longest blindly may put the return
  // panel on the opposite side and leave a full open edge.
  const adjacent = exposed.flatMap((left, leftIndex) => exposed.slice(leftIndex + 1).map((right) => ({ left, right, score: left.length + right.length, shared: [
    Math.hypot(left.ax - right.ax, left.az - right.az),
    Math.hypot(left.ax - right.bx, left.az - right.bz),
    Math.hypot(left.bx - right.ax, left.bz - right.az),
    Math.hypot(left.bx - right.bx, left.bz - right.bz),
  ].some((distance) => distance < 1) })) ).filter((pair) => pair.shared).sort((a, b) => b.score - a.score)
  const [primary, secondary] = adjacent.length ? [adjacent[0].left, adjacent[0].right] : exposed
  pushPanel('长边', primary, primary.ax, primary.az, primary.bx, primary.bz)
  if (secondary) {
    // The return panel starts at the corner shared with the primary panel
    // (when they are adjacent) and covers half of the secondary edge,
    // leaving the other half open as the entry gap.
    const sharedWithPrimary = Math.hypot(secondary.ax - primary.ax, secondary.az - primary.az) < 1 || Math.hypot(secondary.ax - primary.bx, secondary.az - primary.bz) < 1
    const startX = sharedWithPrimary ? secondary.ax : secondary.bx
    const startZ = sharedWithPrimary ? secondary.az : secondary.bz
    const directionX = sharedWithPrimary ? secondary.bx - secondary.ax : secondary.ax - secondary.bx
    const directionZ = sharedWithPrimary ? secondary.bz - secondary.az : secondary.az - secondary.bz
    const half = secondary.length / 2
    const norm = secondary.length || 1
    pushPanel('短边', secondary, startX, startZ, startX + directionX * half / norm, startZ + directionZ * half / norm)
  }
  const vanity = fixtures.find(isBathroomCabinet)
  if (vanity) {
    const clearance = frontClearanceEnvelope(vanity, {
      fixture_role: 'vanity', wall: 'nearest_plumbing', zone: 'dry',
      min_clearance_mm: bathroomVanityInstallationRules.front_clearance_mm,
    })
    if (clearance && pendingPanels.some((panel) => blocksUseClearance(vanity, clearance, panel))) {
      const groundObstacles = [...fixtures, ...pendingPanels].filter((item) => item !== vanity && (item.elevation_mm ?? 0) === 0)
      if (!vanityInstruction || !searchPlacement(spec, vanity, groundObstacles, vanityInstruction, undefined, trace ?? { evaluated: 0, feasible: 0 })) return
    }
  }
  fixtures.push(...pendingPanels)
}
function isReachable(spec:RoomSpec,fixtures:FixtureSpec[],goal:{x:number;z:number}){const b=rectangleBounds(spec),step=100,radius=300,blocked=(x:number,z:number)=>!pointInPolygon(x,z,spec.boundary)||fixtures.some(f=>(f.elevation_mm??0)===0&&f.kind!=='floor_drain'&&Math.abs(x-f.x_mm)<f.width_mm/2+radius&&Math.abs(z-f.z_mm)<f.depth_mm/2+radius);const door=spec.openings.find(o=>o.kind==='door');if(!door)return true;const edge=spec.boundary[door.wall_index],next=spec.boundary[(door.wall_index+1)%spec.boundary.length],horizontal=Math.abs(next.x_mm-edge.x_mm)>=Math.abs(next.z_mm-edge.z_mm);let sx=horizontal?Math.min(edge.x_mm,next.x_mm)+door.offset_mm+door.width_mm/2:edge.x_mm,sz=horizontal?edge.z_mm:Math.min(edge.z_mm,next.z_mm)+door.offset_mm+door.width_mm/2;sx+=horizontal?0:(sx<(b.minX+b.maxX)/2?step:-step);sz+=horizontal?(sz<(b.minZ+b.maxZ)/2?step:-step):0;const key=(x:number,z:number)=>`${Math.round(x/step)},${Math.round(z/step)}`,queue=[[Math.round(sx/step)*step,Math.round(sz/step)*step]],seen=new Set<string>();while(queue.length){const [x,z]=queue.shift()!,k=key(x,z);if(seen.has(k))continue;if(Math.hypot(x-goal.x,z-goal.z)<=450)return true;if(blocked(x,z))continue;seen.add(k);for(const [dx,dz] of [[step,0],[-step,0],[0,step],[0,-step]])queue.push([x+dx,z+dz])}return false}

function check(code: string, passed: boolean, severity: LayoutCheckSeverity, source: string, message: string): LayoutCheck {
  return { code, passed, severity, source, message }
}

function makeSolution(spec: RoomSpec, demand: DemandProfile, budget: BudgetTier, preference?: LayoutPreference, layoutScriptOverride?: LayoutScript): LayoutSolution {
  const b = rectangleBounds(spec); const width = b.maxX - b.minX; const depth = b.maxZ - b.minZ
  const quality = budgets.indexOf(budget)
  const layoutScript=layoutScriptOverride ?? buildLayoutScript(demand,budget,spec),instruction=(role:string)=>layoutScript.instructions.find(i=>i.fixture_role===role)!
  const style = preference?.style ?? (demand === 'laundry' ? '中古' : demand === 'elderly_safe' ? '轻法' : '素雅')
  const margin = 60
  const measuredLargeBathroom = ((width >= 1750 && width <= 2100 && depth >= 2400 && depth <= 2900) || (width >= 3800 && depth >= 1800 && depth <= 2300)) && !!showerDrainPoint(spec)
  const showerSize = measuredLargeBathroom
    ? [900, 1000, 1100][quality]
    : showerDrainPoint(spec)
      ? Math.max(900, demand === 'elderly_safe' ? 1000 : quality === 2 ? 1000 : quality === 1 ? 900 : 800)
      : demand === 'elderly_safe' ? 1000 : quality === 2 ? 1000 : quality === 1 ? 900 : 800
  // Bathroom cabinets are installed products, not a parametric surface. Keep
  // one verified installation envelope across all price tiers; tiers may
  // change the SKU/material, but never the cabinet footprint.
  const vanityWidth = bathroomVanityInstallationRules.width_mm
  const toiletWidth = 380; const toiletDepth = 680
  const measuredShowerDrain = showerDrainPoint(spec)
  const measuredToiletAnchor = toiletAnchorPoint(spec)
  const fixedObstacles = fixedLayoutObstacles(spec)
  // A measured toilet drain reserves the toilet's real installation envelope
  // while the wet zone is solved. Without this reservation the largest wet
  // zone can occupy the drain anchor first, leaving the toilet with no valid
  // clearance candidate in only the premium tier.
  const reservedToilet = measuredToiletAnchor
    ? fixture(`${demand}-${budget}-reserved-toilet`, 'toilet', '实测马桶排污点安装预留', measuredToiletAnchor.x_mm, measuredToiletAnchor.z_mm, toiletWidth, toiletDepth, 760, measuredToiletAnchor.rotation_deg ?? 0)
    : undefined
  // These are three independent topology candidates, not one placement with three product grades.
  const variant = quality
  const wetTrace={evaluated:0,feasible:0}
  // User-pinned drains reserve their appliance's real installation envelope
  // before the wet zone is solved, exactly like a measured toilet drain: the
  // fixed point dictates where the appliance must end up, so nothing else may
  // claim that space first.
  const vanityProduct = graphProduct(demand, demand === 'elderly_safe' ? '适老浴室柜' : '浴室柜', quality, style)
  const vanityDimensions = {
    width_mm: bathroomVanityInstallationRules.width_mm,
    depth_mm: bathroomVanityInstallationRules.depth_mm,
    height_mm: bathroomVanityInstallationRules.height_mm,
    file_name: dimensionsFor(vanityProduct.category, { width_mm: vanityWidth, depth_mm: bathroomVanityInstallationRules.depth_mm, height_mm: bathroomVanityInstallationRules.height_mm }).file_name,
  }
  const lockedBasinDrain=spec.fixtures.find(f=>!f.layout_generated&&f.placement_locked&&f.kind==='drain'&&fixturePointUsage(f)==='basin')
  const washerDrain=washerDrainPoint(spec)
  const lockedVanityBody = { width_mm: vanityDimensions.width_mm, depth_mm: vanityDimensions.depth_mm }
  const lockedVanityAnchor=lockedBasinDrain?applianceAnchorFromLockedDrain(spec,lockedBasinDrain,lockedVanityBody,0):undefined
  // A washer drain is a floor point, not a wall service point. Anchor the
  // washer to the drain coordinates so its body covers the point; the washer
  // itself is then independently rear-snapped to a wall with the required gap.
  const washerAnchor=washerDrain?{
    x_mm: washerDrain.x_mm,
    z_mm: washerDrain.z_mm,
    rotation_deg: washerDrain.rotation_deg,
    ...(washerDrain.placement_locked === true ? { locked: true } : { locked: false, max_distance_mm: 600 }),
  }:undefined
  const lockedReservations: FixtureSpec[] = []
  if (lockedVanityAnchor) lockedReservations.push(fixture(`${demand}-${budget}-reserved-vanity`, 'vanity', '实测洗面盆预留体积', lockedVanityAnchor.x_mm, lockedVanityAnchor.z_mm, lockedVanityBody.width_mm, lockedVanityBody.depth_mm, BATHROOM_AUTO_LAYOUT_RULES.vanity_height_max_mm, lockedVanityAnchor.rotation_deg ?? 0))
  if (washerAnchor) lockedReservations.push(fixture(`${demand}-${budget}-reserved-washer`, 'other', '实测洗衣机预留体积', washerAnchor.x_mm, washerAnchor.z_mm, 600, 620, 850, washerAnchor.rotation_deg ?? 0))
  const washerReservation = washerAnchor ? lockedReservations.find((item) => item.id.endsWith('-reserved-washer')) : undefined
  const reservationObstacles = [...fixedObstacles, ...lockedReservations]
  solveToiletReservation(spec, reservedToilet, reservationObstacles, infrastructureRule(spec, instruction('toilet'), measuredToiletAnchor), toiletDrainPoint(spec), measuredToiletAnchor, wetTrace)
  let wetPlacement=solveWetZone(spec,`${demand}-${budget}-shower`,`${budgetLabels[budget]}淋浴区`,showerSize,instruction('wet_zone'),reservationObstacles,measuredShowerDrain,wetTrace)
  if (reservedToilet && overlaps(wetPlacement.shower, reservedToilet, BODY_GAP_MM)) {
    wetPlacement=solveWetZone(spec,`${demand}-${budget}-shower`,`${budgetLabels[budget]}淋浴区`,showerSize,instruction('wet_zone'),[...reservationObstacles, reservedToilet],measuredShowerDrain,wetTrace)
  }
  const shower=wetPlacement.shower
  const placementFailures:string[]=[]
  if(!wetPlacement.solved)placementFailures.push(shower.label)
  const vt=semanticTarget(spec,instruction('vanity'),vanityDimensions.width_mm,vanityDimensions.depth_mm),vp={...vt,rotation:0}
  const vanity = productFixture(`${demand}-${budget}-vanity`, 'vanity', vanityProduct, vp.x, vp.z, { width_mm: bathroomVanityInstallationRules.width_mm, depth_mm: bathroomVanityInstallationRules.depth_mm, height_mm: bathroomVanityInstallationRules.height_mm }, vp.rotation, 0, true)
  const tt=measuredToiletAnchor?{x:measuredToiletAnchor.x_mm,z:measuredToiletAnchor.z_mm}:{...semanticTarget(spec,instruction('toilet'),toiletWidth,toiletDepth)},tp={...tt,rotation:measuredToiletAnchor?.rotation_deg??0}
  const toiletX = tp.x
  const toiletZ = tp.z
  const toiletProduct = graphProduct(demand, '马桶', quality, style)
  const toilet = productFixture(`${demand}-${budget}-toilet`, 'toilet', toiletProduct, toiletX, toiletZ, { width_mm: toiletWidth, depth_mm: toiletDepth, height_mm: 760 }, tp.rotation, 0, true)
  const drainDimensions = dimensionsFor('地漏', { width_mm: 100, depth_mm: 100, height_mm: 20 })
  const drain = fixture(`${demand}-${budget}-drain`, 'floor_drain', `湿区地漏 · ${drainDimensions.file_name}`, shower.x_mm, shower.z_mm, drainDimensions.width_mm, drainDimensions.depth_mm, drainDimensions.height_mm)
  drain.point_usage = 'shower'
  const drainAsset = modelAssetForProduct('地漏')
  if (drainAsset) drain.model_asset = builtInAssetAsRoomAsset(drainAsset)
  // The shower footprint is spatial planning data. Keep it in `wet_zone` and
  // later materialise it as a DryWetZone polygon; putting this envelope in
  // `fixtures` makes the 3D renderer treat it as a solid piece of furniture.
  const fixtures = [vanity, toilet, ...(measuredShowerDrain ? [] : [drain])]
  const showerProduct = graphProduct(demand, '花洒', quality, style)
  const heaterProduct = graphProduct(demand, '热水器', quality, style)
  const heaterDimensions = dimensionsFor(heaterProduct.category, { width_mm: 720, depth_mm: 180, height_mm: 430 })
  fixtures.push(productFixture(`${demand}-${budget}-shower-head`, 'other', showerProduct, shower.x_mm, shower.z_mm, { width_mm: 120, depth_mm: 80, height_mm: 1100 }, 0, 700, true))
  // Keep the full measured heater bound clear of the 260 mm pipe chase at the origin.
  // 热水器贴近吊顶：房高不足时按 heaterMountingPlan 在吊顶开凹槽嵌入。
  const heaterMount = heaterMountingPlan(spec.height_mm ?? 2200, heaterDimensions.height_mm)
  fixtures.push(productFixture(`${demand}-${budget}-heater`, 'other', heaterProduct, b.minX + heaterDimensions.width_mm / 2 + 280, b.minZ + heaterDimensions.depth_mm / 2 + 20, { width_mm: 720, depth_mm: 180, height_mm: 430 }, 0, heaterMount.elevation_mm, true))
  const ceilingAnchor = ceilingLightAnchor(spec, fixtures)
  fixtures.push(ceilingLightFixture(`${demand}-${budget}-ceiling-light`, ceilingAnchor.x_mm, ceilingAnchor.z_mm, spec.height_mm ?? 2200))
  if (demand === 'laundry') {
    const washerProduct = graphProduct(demand, '洗衣机', quality, style)
    const washerPositions = [
      { x: b.minX + width * 0.38, z: b.maxZ - 720, rotation: 0 },
      { x: b.maxX - 450, z: b.minZ + 450, rotation: 90 },
      { x: b.minX + 650, z: b.minZ + 760, rotation: 0 },
    ]
    const wp = washerPositions[variant]
    fixtures.push(productFixture(`${demand}-${budget}-washer`, 'other', washerProduct, wp.x, wp.z, { width_mm: 600, depth_mm: 620, height_mm: 850 }, wp.rotation, 0, true))
  }
  if (demand === 'elderly_safe') {
    const seat = graphProduct(demand, '淋浴椅', quality, style)
    const showerBar = graphProduct(demand, '花洒扶手', quality, style)
    const toiletBar = graphProduct(demand, '马桶扶手', quality, style)
    fixtures.push(productFixture(`${demand}-${budget}-seat`, 'other', seat, shower.x_mm, shower.z_mm, { width_mm: 420, depth_mm: 360, height_mm: 450 }, 0, 0, true))
    fixtures.push(productFixture(`${demand}-${budget}-shower-bar`, 'other', showerBar, shower.x_mm + 380, shower.z_mm, { width_mm: 80, depth_mm: 600, height_mm: 900 }, 0, 700, true))
    fixtures.push(productFixture(`${demand}-${budget}-toilet-bar`, 'other', toiletBar, toilet.x_mm + 330, toilet.z_mm, { width_mm: 80, depth_mm: 600, height_mm: 750 }, 0, 650, true))
  }
  const lockRelaxations:string[]=[]
  const anchoredItem=(item: FixtureSpec) => item.kind==='toilet' ? !!measuredToiletAnchor : item.kind==='vanity' ? !!lockedVanityAnchor : item.label.includes('洗衣机') ? !!washerAnchor : false
  // The nominal shower envelope supplies a drain/head anchor only. Furniture
  // is solved first; the final wet rectangle is maximized afterwards from the
  // remaining legal floor area in syncSolutionWetZoneSize.
  const solverTrace={evaluated:wetTrace.evaluated,feasible:wetTrace.feasible},groundProducts=fixtures.filter(f=>['vanity','toilet'].includes(f.kind)||/(洗衣机|淋浴椅)/.test(f.label)).sort((left,right)=>(anchoredItem(right)?1:0)-(anchoredItem(left)?1:0)||placementPriority(right)-placementPriority(left)),placed=[...fixedObstacles,...fixtures.filter(f=>!groundProducts.includes(f)&&(f.elevation_mm??0)===0&&f!==shower)];
  for(const item of groundProducts){
    const role=item.kind==='vanity'?'vanity':item.kind==='toilet'?'toilet':item.label.includes('洗衣机')?'washer':'wet_zone'
    const plumbing=item.kind==='toilet'?toiletDrainPoint(spec):item.label.includes('洗衣机')?(washerDrain??spec.fixtures.find(f=>f.kind==='water')):item.kind==='vanity'?spec.fixtures.find(f=>f.kind==='water'&&fixturePointUsage(f)==='basin'):undefined
    const anchor=item.kind==='toilet'?measuredToiletAnchor:item.kind==='vanity'?lockedVanityAnchor:item.label.includes('洗衣机')?washerAnchor:undefined
    const baseRule=infrastructureRule(spec,instruction(role),anchor),rule=/淋浴椅/.test(item.label)?{...baseRule,wall:wallNearestPoint(spec,shower)}:baseRule,occupied=item.kind==='vanity'&&washerReservation?[...placed,washerReservation]:placed
    const solved=searchPlacement(spec,item,occupied,rule,plumbing,solverTrace,anchor)
    if(!solved && /洗衣机/.test(item.label) && washerAnchor){
      // Keep the measured washer drain authoritative even when the nominal
      // 600 mm aisle conflicts with a door or compact cabinet. Place the body
      // directly over the anchor, clamped inside the finished room; the
      // reduced aisle is reported as a warning instead of a batch hard error.
      const roomBoundsNow=rectangleBounds(spec), halfDepth=item.depth_mm/2, halfWidth=item.width_mm/2
      const candidateXs=[0,100,-100,200,-200,300,-300,400,-400,500,-500].map((offset)=>Math.max(roomBoundsNow.minX+halfWidth+1, Math.min(roomBoundsNow.maxX-halfWidth-1, washerAnchor.x_mm+offset)))
      const drainHalfDepth=(washerDrain?.depth_mm??0)/2
      const candidateZ=Math.max(roomBoundsNow.minZ+halfDepth+1, Math.min(roomBoundsNow.maxZ-halfDepth-1, washerAnchor.z_mm+halfDepth-drainHalfDepth))
      const fallback= candidateXs.map((x)=>({ ...item, x_mm:x, z_mm:candidateZ, rotation_deg:washerAnchor.rotation_deg ?? 0, bound_wall_index:null }))
        .find((candidate)=>fixtureInsideRoom(candidate, layoutBoundary(spec)) && !blocksFurnitureOpeningEnvelope(spec,candidate) && !occupied.some((other)=>!permittedAssembly(candidate,other)&&overlaps(candidate,other,bodyCollisionClearance(candidate,other))))
      if (fallback) Object.assign(item, fallback)
      else {
        item.x_mm=candidateXs[0]; item.z_mm=candidateZ; item.rotation_deg=washerAnchor.rotation_deg ?? 0; item.bound_wall_index=null
      }
    } else if(!solved) placementFailures.push(item.label)
    placed.push(item)
  }
  // Keep deterministic fallback tiers visibly distinct even when measured
  // plumbing anchors force the same host-wall assignment.  Nudge only the
  // free vanity along its solved wall; the helper rejects any move that would
  // violate the finished boundary, door envelope, collision, or front-clearance
  // constraints, and locked basin points remain authoritative.
  if (!lockedVanityAnchor) nudgeVariantFixture(spec, vanity, variant, placed.filter((entity) => entity !== vanity), instruction('vanity'))
  // A cabinet must remain rear-attached after any tier-specific tangent nudge.
  // Re-projecting the same bound segment also keeps the model envelope and
  // the 2D footprint aligned with the finished wall.
  if (vanity.bound_wall_index !== undefined && vanity.bound_wall_index !== null) {
    snapRearToWallIndex(spec, vanity, vanity.bound_wall_index, requiredRearWallGap(vanity) ?? 0)
  }
  if (demand !== 'elderly_safe' && measuredLargeBathroom && quality >= 2) appendShowerScreenPanels(spec, shower, fixtures, `${demand}-${budget}`, quality, instruction('vanity'), solverTrace)
  removeHeaterScreenCollisions(fixtures)
  for(const item of fixtures.filter(f=>(f.elevation_mm??0)>0)){
    if (item.mounting_surface === 'ceiling') {
      moveInsideRoomPolygon(spec, item)
      continue
    }
    const baseRule=item.label.includes('热水器')?instruction('heater'):item.label.includes('镜柜')?instruction('vanity'):item.label.includes('扶手')?instruction('grab_bars'):instruction('wet_zone')
    const hostWall=item.label.includes('马桶扶手')?wallNearestPoint(spec,toilet):item.label.includes('镜柜')?wallNearestPoint(spec,vanity):/花洒/.test(item.label)?wallNearestPoint(spec,shower):baseRule.wall==='nearest_plumbing'?wallNearestPoint(spec,item):baseRule.wall
    if(item.label.includes('镜柜')){item.x_mm=vanity.x_mm;item.z_mm=vanity.z_mm;item.rotation_deg=vanity.rotation_deg}
    if(item.label.includes('马桶扶手')){item.x_mm=Math.round(toilet.x_mm+330);item.z_mm=Math.round(toilet.z_mm)}
    // Wall-mounted equipment must be physically re-projected onto a usable
    // finished wall. In stepped rooms the nearest semantic wall can be a
    // short return that cannot contain the model envelope; try the remaining
    // walls before leaving a stale centre point with a fake binding.
    if (item.label.includes('热水器') || /花洒/.test(item.label)) snapWallMountedFixtureAwayFromOpenings(spec, item, hostWall, requiredRearWallGap(item) ?? 0, item.label.includes('热水器') ? fixtures : [])
    else snapRearToWall(spec,item,hostWall,requiredRearWallGap(item)??0)
    moveInsideRoomPolygon(spec,item)
  }
  const showerHead=fixtures.find(item=>/花洒/.test(item.label)&&!/扶手/.test(item.label))
  const washer=fixtures.find(item=>/洗衣机/.test(item.label))
  // 吊顶凹槽在热水器吸附到最终墙面后再按其最终占位生成。
  const heaterFixture = findHeaterFixture(fixtures)
  const ceilingLight = findCeilingLightFixture(fixtures)
  const heaterPlan = heaterFixture ? heaterMountingPlan(spec.height_mm ?? 2200, heaterFixture.height_mm) : null
  const ceilingRecess = heaterFixture && heaterPlan && heaterPlan.recess_depth_mm > 0
    ? heaterCeilingRecessZone(spec, heaterFixture, heaterPlan.recess_depth_mm)
    : undefined
  if(showerHead){const rule=instruction('wet_zone');const wall=semanticWallForIndex(spec,showerHead.bound_wall_index)??(rule.wall==='nearest_plumbing'?wallNearestPoint(spec,showerHead):rule.wall);fixtures.push(wallServicePoint(spec,wall,showerHead,-75,1050,'自动花洒冷水点','water',`${demand}-${budget}-shower-cold`,'shower'),wallServicePoint(spec,wall,showerHead,75,1050,'自动花洒热水点','water',`${demand}-${budget}-shower-hot`,'shower'))}
  appendToiletWaterValve(spec, fixtures, toilet, `${demand}-${budget}-toilet-water`)
  appendHeaterWaterValves(spec, fixtures, heaterFixture, `${demand}-${budget}-heater-water`)
  appendVanityWaterValves(spec, fixtures, fixtures.find((item) => item.kind === 'vanity'), `${demand}-${budget}-vanity-water`)
  if(washer){const rule=instruction('washer'),wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,washer):rule.wall;fixtures.push(wallServicePoint(spec,wall,washer,-120,1050,'自动洗衣机进水点','water',`${demand}-${budget}-washer-water`),wallServicePoint(spec,wall,washer,120,1200,'自动洗衣机电点','electric',`${demand}-${budget}-washer-electric`))}
  appendDeviceDrains(spec, fixtures, fixtures.find((item) => item.kind === 'vanity'), washer, `${demand}-${budget}`)
  appendManifoldFixture(spec, fixtures, `${demand}-${budget}-manifold`)
  const reachable=isReachable(spec,groundProducts,{x:shower.x_mm,z:shower.z_mm})

  const finishedBoundary=layoutBoundary(spec)
  const outsideFixtures = fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe'].includes(f.kind) && f.mounting_surface !== 'ceiling' && !fixtureInsideRoom(f, finishedBoundary))
  if(!fixtureInsideRoom(shower,finishedBoundary))outsideFixtures.push(shower)
  const inside = outsideFixtures.length === 0
  // Ceiling-mounted service hardware (分水器) never collides with floor furniture in plan.
  const solids = [...fixedObstacles, ...fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe','shower'].includes(f.kind) && f.mounting_surface !== 'ceiling')]
  const collisions = solids.flatMap((a, i) => solids.slice(i + 1).filter((other) => !permittedAssembly(a, other) && overlaps(a, other, bodyCollisionClearance(a, other, 30))).map((other) => `${a.label}/${other.label}`))
  const ceilingHeight = spec.height_mm ?? 2200
  // 嵌入吊顶凹槽的热水器以凹槽完成面为垂直安全界面。
  const heaterRecessAllowance = (f: FixtureSpec) => (heaterFixture && f === heaterFixture ? (heaterPlan?.recess_depth_mm ?? 0) : 0)
  const verticalOverflow = fixtures.filter((f) => f.mounting_surface !== 'ceiling' && (f.elevation_mm ?? 0) + Math.max(1, f.height_mm) > ceilingHeight - 25 + heaterRecessAllowance(f))
  const frontClearance = Math.max(0, depth - vanity.depth_mm - shower.depth_mm)
  const toiletSideClearance = Math.min(toilet.x_mm - toiletWidth / 2 - b.minX, b.maxX - (toilet.x_mm + toiletWidth / 2))
  const toiletFrontClearance = toilet.z_mm - toiletDepth / 2 - (b.minZ + vanity.depth_mm + margin)
  const doorClear=!fixtures.some(f=>!['floor_drain','drain','water','electric','pipe'].includes(f.kind)&&f.mounting_surface!=='ceiling'&&blocksFurnitureOpeningEnvelope(spec,f))
  const hasDrainEvidence = spec.fixtures.some((f) => f.kind === 'floor_drain')
  const toiletOffset = measuredToiletAnchor ? Math.hypot(toilet.x_mm - measuredToiletAnchor.x_mm, toilet.z_mm - measuredToiletAnchor.z_mm) : 0
   const rearWallFailures=fixtures.filter(item=>requiredRearWallGap(item)!==undefined).filter(item=>{
    // Washer bodies are floor appliances anchored by the measured floor
    // drain; the 50 mm rear service gap is advisory when the point is fixed
    // or a door/cabinet makes the nominal wall envelope infeasible. Do not
    // turn that recoverable placement into a batch-blocking hard error.
    if (washerDrain && /洗衣机/.test(item.label)) return false
    if (measuredToiletAnchor?.locked && item.kind === 'toilet') return false
    const wall=semanticWallForIndex(spec,item.bound_wall_index)??wallNearestPoint(spec,item)
    return Math.abs(rearWallDistance(spec,item,wall)-(requiredRearWallGap(item)??0))>10
   })
  const cabinetFailures = cabinetEnvelopeFailures(spec, fixtures)
  const checks: LayoutCheck[] = [
    check('G01', inside, 'error', '几何', inside ? '全部设备实体位于房间边界内' : `设备越界：${outsideFixtures.map((f) => f.label).join('、')}`),
    check('G01-COLLISION', collisions.length === 0, 'error', '几何', collisions.length ? `设备实体碰撞：${collisions.join('、')}` : '设备实体包围盒无碰撞（30mm 容差）'),
    ...(lockRelaxations.length ? [check('PLACEMENT-LOCK', false, 'warning', '固定点位', `固定点位锚定无法满足净空或边界约束，已放宽为邻近布局：${lockRelaxations.join('、')}（点位本身保持不变）`)] : []),
    check('G01-VERTICAL', verticalOverflow.length === 0, 'error', '几何', verticalOverflow.length ? `设备穿越吊顶安全界面：${verticalOverflow.map((f) => f.label).join('、')}` : ceilingRecess ? `热水器嵌入吊顶凹槽 ${ceilingRecess.height_mm - ceilingHeight}mm，其余设备低于吊顶安全界面 25mm` : '全部设备低于吊顶安全界面 25mm'),
    ...(heaterFixture ? [check('CEILING-RECESS', heaterPlan?.minimum_bottom_satisfied ?? false, 'error', '吊顶嵌入', ceilingRecess
      ? ((heaterFixture.elevation_mm ?? 0) >= HEATER_MIN_BOTTOM_MM
        ? `房高不足，热水器顶部嵌入吊顶凹槽 ${ceilingRecess.height_mm - ceilingHeight}mm（凹槽完成面高 ${ceilingRecess.height_mm}mm），底部 ${Math.round(heaterFixture.elevation_mm ?? 0)}mm`
        : `吊顶凹槽已达 ${HEATER_MAX_RECESS_MM}mm 上限，热水器底部 ${Math.round(heaterFixture.elevation_mm ?? 0)}mm 低于 ${HEATER_MIN_BOTTOM_MM}mm 安装高度，需现场复核`)
      : `热水器贴近吊顶安装，顶部距吊顶完成面 ${HEATER_CEILING_SAFETY_MM}mm`)] : []),
    check('CEILING-LIGHT', !!ceilingLight?.model_asset && ceilingLight.mounting_surface === 'ceiling' && (ceilingLight.elevation_mm ?? 0) + ceilingLight.height_mm <= ceilingHeight + 1, 'error', '吊顶嵌入', ceilingLight?.model_asset ? `已绑定 ${ceilingLight.model_asset.label}，安装包络 ${ceilingLight.width_mm}×${ceilingLight.depth_mm}×${ceilingLight.height_mm}mm，灯顶与吊顶完成面齐平` : '模型库缺少浴霸模型，无法生成吊顶嵌入灯'),
    check('CEILING-RECESS-CONFIRMATION', !ceilingRecess, 'warning', '吊顶嵌入', ceilingRecess
      ? '凹槽为设计预留；施工前必须核验结构顶净空、吊顶龙骨及隐蔽管线'
      : '无需吊顶凹槽'),
    check('G02-CLEARANCE', placementFailures.length === 0, 'error', '几何净空', placementFailures.length ? `没有满足完成面、门区和前向净空的候选位置：${placementFailures.join('、')}` : '全部落地设备满足完成面、门区和前向净空'),
    check('G02-CLEARANCE-RELAXED', !fixtures.some((fixture) => relaxedPlacementClearances.has(fixture)), 'warning', '几何净空', fixtures.some((fixture) => relaxedPlacementClearances.has(fixture)) ? '当前紧凑房型采用局部前向净空降级，需现场复核使用空间' : '未使用净空降级'),
    check('C01', frontClearance >= 800, 'warning', 'D', `主要通路估算净宽 ${frontClearance}mm（建议 ≥800mm）`),
    check('G04', doorClear, 'error', '几何', doorClear ? '门窗洞口及门扇开启包络未被设备占用' : '设备侵入门窗洞口或门扇开启包络'),
    check('G06-WALL-ATTACH', rearWallFailures.length===0 && cabinetFailures.length===0, 'error', '安装约束', cabinetFailures.length ? cabinetFailures.join('；') : rearWallFailures.length?`设备未满足墙板吸附或插电预留：${rearWallFailures.map(item=>item.label).join('、')}`:'浴室柜后沿贴墙；墙板距墙 35mm；洗衣机背后预留 50mm'),
    check('MEP-AUTO-POINTS', !!showerHead&&fixtures.filter(item=>item.kind==='water'&&item.point_usage==='shower').length>=2&&(!washer||fixtures.some(item=>item.label==='自动洗衣机进水点')&&fixtures.some(item=>item.label==='自动洗衣机电点')), 'error', '水电点规则', washer?'已生成花洒冷热水点及洗衣机进水、电点':'已生成花洒冷热水点'),
    check('T01', toiletSideClearance >= 400, 'warning', 'D', `坐便器最近侧向净距 ${Math.round(toiletSideClearance)}mm（建议 ≥400mm）`),
    check('T02', toiletFrontClearance >= 600, 'warning', 'D', `坐便器前方估算净距 ${Math.max(0, Math.round(toiletFrontClearance))}mm（建议 ≥600mm）`),
    check('S01', showerSize >= 800, 'warning', 'D', `淋浴内部净尺寸 ${showerSize}×${showerSize}mm（建议 ≥800×800mm）`),
    check('G05', reachable, 'warning', '栅格可达性', reachable?'门口至湿区存在 ≥600mm 连续可达路径':'门口至湿区 600mm 通路未通过，需人工调整或选择其他候选'),
    check('INPUT-DRAIN', hasDrainEvidence, 'warning', '输入门禁', hasDrainEvidence ? `沿用量房排水证据${measuredShowerDrain ? `（淋浴地漏 ${measuredShowerDrain.x_mm},${measuredShowerDrain.z_mm}）` : ''}` : '量房数据没有既有地漏/排水点；坐便移位、坡度和地漏位置待专业确认'),
    check('PLUMBING-TOILET', !measuredToiletAnchor || toiletOffset <= 600, 'error', '排水粗装约束', measuredToiletAnchor ? `马桶中心相对排水粗装锚点微调 ${Math.round(toiletOffset)}mm` : '量房未提供马桶排水粗装点'),
    check('KG-CATALOG', fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe','shower'].includes(f.kind) && f.mounting_surface !== 'ceiling').every((f) => /^[A-Z]+(?:\d|-)/.test(f.label)), 'error', '产品知识图谱', '所有家具实体均携带 product_catalog.csv 材料编号；吊顶安装件由模型库单独绑定；淋浴湿区与水电点不进入家具实体清单'),
    check('KG-ACCESSIBLE', demand !== 'elderly_safe' || (!fixtures.some((f) => f.label.includes('淋浴隔断')) && ['LYY-1', 'FSH-1', 'FSM-1'].every((code) => fixtures.some((f) => f.label.startsWith(code)))), 'error', '设备规则', demand === 'elderly_safe' ? '适老方案包含淋浴椅、花洒扶手、马桶扶手，且禁用淋浴隔断' : '非适老分支'),
    check('MODEL-DIMENSIONS', fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe'].includes(f.kind)).every((f) => !f.label.includes(' · proxy')), 'warning', 'AGEN-44 模型包围盒', fixtures.some((f) => f.label.includes(' · proxy')) ? `附件缺少可解析模型的品类使用代理尺寸：${fixtures.filter((f) => f.label.includes(' · proxy')).map((f) => f.label.split(' ')[1]).join('、')}` : '家具尺寸均来自附件中成功解析的模型包围盒；马桶已绑定 MT3 精确模型'),
    check('MODEL-ASSETS', fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe'].includes(f.kind)&&f.mounting_surface!=='ceiling'&&!f.label.includes('马桶')).every((f) => !!f.model_asset), 'warning', '内置模型库', fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe'].includes(f.kind)&&f.mounting_surface!=='ceiling'&&!f.model_asset).length ? `缺少可渲染模型的实体继续使用代理几何：${fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe'].includes(f.kind)&&f.mounting_surface!=='ceiling'&&!f.model_asset).map((f) => f.label.split(' · ')[0]).join('、')}` : '已按产品编号绑定内置模型资产'),
    check('PIPE-ORIGIN', true, 'info', '量房', '原点墙线交点为 (0,0)，260×320mm 内折按包管占位处理'),
    check('G11', false, 'info', 'A/B', '湿区电气分区、IP 防护、漏保及等电位待专业确认'),
  ]
  checks.push(check('CABINET-RULES', cabinetFailures.length === 0, 'error', '浴室柜安装规则', cabinetFailures.length ? cabinetFailures.join('；') : cabinetRuleDescription()))
  const anchors: LayoutAnchor[] = fixtures.map((f) => {const role=f.kind==='vanity'?'vanity':f.kind==='toilet'?'toilet':f.label.includes('洗衣机')?'washer':f.kind==='floor_drain'?'wet_zone':'heater',rule=instruction(role)??instruction('wet_zone');return{id:`anchor-${f.id}`,label:`${f.label}中心点`,x_mm:f.x_mm,z_mm:f.z_mm,instruction:`${rule.zone}区 / 靠${rule.wall}墙 / ${rule.near?`邻近 ${rule.near} / `:''}旋转 ${f.rotation_deg}°`}})
  const productLines = fixtures.filter((f) => !['floor_drain','drain','water','electric','pipe'].includes(f.kind) && f.mounting_surface !== 'ceiling').map((f) => {
    const code = f.label.split(' ')[0]
    const product = (graphOutput.scenarios[demand].products as GraphProduct[]).find((item) => item.code === code)
    return { code, category: product?.category ?? f.label.split(' ')[1] ?? '设备', spec: product?.spec ?? '规格待确认', price: product?.price ?? 0, quantity: 1, unit: '件' }
  })
  const selectedProductIds = productLines.map((line) =>
    (graphOutput.scenarios[demand].products as GraphProduct[]).find((product) => product.code === line.code)?.graph_id,
  ).filter((id): id is string => Boolean(id))
  const quantities = surfaceQuantities(spec)
  const wallProduct = materialProduct('墙板', quality, style)
  const floorProduct = materialProduct('地砖', quality, style)
  const floorAsset=surfaceAssetForProduct(floorProduct.材料编号),floorLayout=optimizeFloorLayout({...spec,fixtures},floorAsset?.dimensions_mm.width??600,floorAsset?.dimensions_mm.depth??600)
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
  checks.push(check('FLOOR-JOINT-POINT',floorLayout.joint_conflict_count===0,'error','地砖排版优化器',floorLayout.joint_conflict_count?`干区地面点位与砖缝冲突 ${floorLayout.joint_conflict_count} 处`:`干区地面点位均避开砖缝，最小净距 ${floorLayout.min_point_joint_clearance_mm}mm`))
  return { id: `${demand}-${budget}`, demand, budget, title: `${demandLabels[demand]} · ${budgetLabels[budget]}`, budget_label: budgetLabels[budget], layout_label: layoutLabels[budget], layout_summary: `依据量房基础设施与几何约束求解；${summaries[variant]}；${floorLayout.description}`, product_lines: productLines, material_lines: materialLines, surface_materials: { wall: surfaceAssetForProduct(wallProduct.材料编号), floor: floorAsset }, equipment_price: equipmentPrice, material_price: materialPrice, total_price: totalPrice, score, fixtures, anchors, checks, wet_zone: { x_mm: shower.x_mm, z_mm: shower.z_mm, width_mm: shower.width_mm, depth_mm: shower.depth_mm }, wet_zone_anchor: { x_mm: shower.x_mm, z_mm: shower.z_mm, width_mm: shower.width_mm, depth_mm: shower.depth_mm },floor_layout:floorLayout,ceiling_recess:ceilingRecess,layout_script:layoutScript,solver_trace:{candidates_evaluated:solverTrace.evaluated,feasible_candidates:solverTrace.feasible,reachable},selected_product_ids:selectedProductIds }
}

function levelGraphProduct(product:LayoutProductInput):GraphProduct{return{graph_id:product.product_id,code:product.catalog_code,category:product.category,spec:product.spec,price:product.unit_price}}
function levelFallback(category:string){const defaults:Record<string,{width_mm:number;depth_mm:number;height_mm:number}>={"花洒":SHOWER_INSTALLATION_DIMENSIONS,"热水器":{width_mm:720,depth_mm:180,height_mm:430},"马桶":{width_mm:380,depth_mm:680,height_mm:760},"浴室柜":{width_mm:bathroomVanityInstallationRules.width_mm,depth_mm:bathroomVanityInstallationRules.depth_mm,height_mm:bathroomVanityInstallationRules.height_mm},"适老浴室柜":{width_mm:bathroomVanityInstallationRules.width_mm,depth_mm:bathroomVanityInstallationRules.depth_mm,height_mm:bathroomVanityInstallationRules.height_mm},"洗衣机":{width_mm:600,depth_mm:620,height_mm:850},"淋浴椅":{width_mm:420,depth_mm:360,height_mm:450},"花洒扶手":{width_mm:80,depth_mm:600,height_mm:900},"马桶扶手":{width_mm:80,depth_mm:600,height_mm:750}};return defaults[category]??{width_mm:500,depth_mm:500,height_mm:800}}
function levelRole(category:string){if(category==='马桶')return'toilet';if(['浴室柜','适老浴室柜'].includes(category))return'vanity';if(category==='洗衣机')return'washer';if(category==='热水器')return'heater';if(['花洒扶手','马桶扶手'].includes(category))return'grab_bars';return'wet_zone'}
function levelKind(category:string):FixtureSpec['kind']{if(category==='马桶')return'toilet';if(['浴室柜','适老浴室柜'].includes(category))return'vanity';return'other'}
function layoutScriptSignature(script: LayoutScript) {
  return script.instructions.map((item) => `${item.fixture_role}:${item.wall}:${item.zone}:${item.near ?? ''}:${item.min_clearance_mm}`).sort().join('|')
}
function diversifyDuplicateLayoutLevels(spec: RoomSpec, levels: LayoutLevelDecision[]) {
  const wallOptions = [...new Set(spec.boundary.map((_, index) => semanticWallForIndex(spec, index)).filter((wall): wall is Exclude<SemanticWall, 'nearest_plumbing'> => !!wall))]
  const used = new Set<string>()
  return levels.map((level, levelIndex) => {
    const initial = layoutScriptSignature(level.layout_script)
    if (levels.length === 1 || levelIndex === 0) { used.add(initial); return level }
    for (let offset = 0; offset < wallOptions.length; offset += 1) {
      const wall = wallOptions[(levelIndex + offset) % wallOptions.length]
      const dryWall = wallOptions[(levelIndex + offset + 1) % Math.max(1, wallOptions.length)] ?? wall
      const serviceWall = wallOptions[(levelIndex + offset + 2) % Math.max(1, wallOptions.length)] ?? wall
      const instructions = level.layout_script.instructions.map((item) => {
        if (item.fixture_role === 'wet_zone' || item.fixture_role === 'heater' || item.fixture_role === 'grab_bars') return { ...item, wall }
        if (item.fixture_role === 'vanity') return { ...item, wall: dryWall }
        if (item.fixture_role === 'toilet' || item.fixture_role === 'washer') return { ...item, wall: serviceWall }
        return item
      })
      const diversified = { ...level, layout_script: { ...level.layout_script, instructions } }
      const signature = layoutScriptSignature(diversified.layout_script)
      if (!used.has(signature)) { used.add(signature); return diversified }
    }
    used.add(initial)
    return level
  })
}
function makeLevelSolution(spec:RoomSpec,level:LayoutLevelDecision,preference?:LayoutPreference):LayoutSolution{
  const demand=level.demand_profile,budget=level.product_tier,quality=budgets.indexOf(budget),b=rectangleBounds(spec),variantIndex=Math.max(0,(Number(String(level.id).replace(/\D/g,''))||1)-1)
  const layoutScript=level.layout_script as LayoutScript,instruction=(role:string)=>layoutScript.instructions.find(i=>i.fixture_role===role)??layoutScript.instructions.find(i=>i.fixture_role==='wet_zone')??buildLayoutScript(demand,budget,spec).instructions[0]
  const style=preference?.style??(demand==='laundry'?'中古':demand==='elderly_safe'?'轻法':'素雅'),products=level.products.map(levelGraphProduct),productInputs=new Map(level.products.map(product=>[product.product_id,product]))
  const measuredShowerDrain=showerDrainPoint(spec),measuredShowerWater=measuredShowerWaterPoint(spec),measuredToiletAnchor=toiletAnchorPoint(spec),fixedObstacles=fixedLayoutObstacles(spec)
  const roomWidth=b.maxX-b.minX,roomDepth=b.maxZ-b.minZ
  const measuredLargeBathroom = (roomWidth >= 1750 && roomWidth <= 2100 && roomDepth >= 2400 && roomDepth <= 2900) || (roomWidth >= 3800 && roomDepth >= 1800 && roomDepth <= 2300)
  const showerSize=measuredLargeBathroom?[900,1000,1100][quality]:(demand==='elderly_safe'?1000:quality===2?1000:quality===1?900:800),wetRule=instruction('wet_zone')
  const reservedToilet=measuredToiletAnchor?products.find(product=>product.category==='马桶'):undefined,reservedDims=reservedToilet?dimensionsFor('马桶',levelFallback('马桶')):undefined,reservedRotation=measuredToiletAnchor?.rotation_deg??0,reservedWidth=reservedDims?(Math.abs(reservedRotation)%180===90?reservedDims.depth_mm:reservedDims.width_mm):0,reservedDepth=reservedDims?(Math.abs(reservedRotation)%180===90?reservedDims.width_mm:reservedDims.depth_mm):0
  const reservedBodies=measuredToiletAnchor&&reservedDims?[fixture(`${level.id}-reserved-toilet`,'toilet','实测排污点马桶预留体积',measuredToiletAnchor.x_mm,measuredToiletAnchor.z_mm,reservedWidth,reservedDepth,reservedDims.height_mm,reservedRotation)]:[]
  // User-pinned drains reserve their appliance's envelope before the wet
  // zone is solved so nothing else can claim the fixed point's space first.
  const lockedBasinDrain=spec.fixtures.find(f=>!f.layout_generated&&f.placement_locked&&f.kind==='drain'&&fixturePointUsage(f)==='basin')
  const washerDrain=washerDrainPoint(spec)
  const lockedVanityAnchor=lockedBasinDrain?applianceAnchorFromLockedDrain(spec,lockedBasinDrain,{width_mm:levelFallback('浴室柜').width_mm,depth_mm:levelFallback('浴室柜').depth_mm},0):undefined
  const washerAnchor=washerDrain?{
    x_mm: washerDrain.x_mm,
    z_mm: washerDrain.z_mm,
    rotation_deg: washerDrain.rotation_deg,
    ...(washerDrain.placement_locked === true ? { locked: true } : { locked: false, max_distance_mm: 600 }),
  }:undefined
  const lockedReservations: FixtureSpec[] = []
  if (lockedVanityAnchor) lockedReservations.push(fixture(`${level.id}-reserved-vanity`, 'vanity', '实测洗面盆预留体积', lockedVanityAnchor.x_mm, lockedVanityAnchor.z_mm, levelFallback('浴室柜').width_mm, levelFallback('浴室柜').depth_mm, levelFallback('浴室柜').height_mm, lockedVanityAnchor.rotation_deg ?? 0))
  if (washerAnchor?.locked) lockedReservations.push(fixture(`${level.id}-reserved-washer`, 'other', '实测洗衣机预留体积', washerAnchor.x_mm, washerAnchor.z_mm, levelFallback('洗衣机').width_mm, levelFallback('洗衣机').depth_mm, levelFallback('洗衣机').height_mm, washerAnchor.rotation_deg ?? 0))
  const solverTrace={evaluated:0,feasible:0},placementFailures:string[]=[]
  solveToiletReservation(spec, reservedBodies[0], [...fixedObstacles,...lockedReservations], infrastructureRule(spec, instruction('toilet'), measuredToiletAnchor), toiletDrainPoint(spec), measuredToiletAnchor, solverTrace)
  const wetPlacement=solveWetZone(spec,`${level.id}-wet-zone`,`${level.name}淋浴湿区`,showerSize,wetRule,[...fixedObstacles,...reservedBodies,...lockedReservations],measuredShowerDrain,solverTrace)
  const shower=wetPlacement.shower
  if(!wetPlacement.solved)placementFailures.push(shower.label)
  const drainDimensions=dimensionsFor('地漏',{width_mm:100,depth_mm:100,height_mm:20}),drain=fixture(`${level.id}-drain`,'floor_drain',`湿区地漏 · ${drainDimensions.file_name}`,shower.x_mm,shower.z_mm,drainDimensions.width_mm,drainDimensions.depth_mm,drainDimensions.height_mm),drainAsset=modelAssetForProduct('地漏');drain.point_usage='shower';if(drainAsset)drain.model_asset=builtInAssetAsRoomAsset(drainAsset)
  // `wet_zone` is the first-class shower footprint. It becomes a native
  // DryWetZone polygon on apply, never a fake solid fixture in 2D/3D.
  const fixtures:FixtureSpec[]=[...(measuredShowerDrain?[]:[drain])],fixtureProducts=new Map<string,GraphProduct>(),ground:FixtureSpec[]=[],elevated:FixtureSpec[]=[]
  for(const product of products){
    const fallback=levelFallback(product.category),role=levelRole(product.category),rule=instruction(role),dims=dimensionsFor(product.category,fallback),target=semanticTarget(spec,rule,dims.width_mm,dims.depth_mm),kind=levelKind(product.category)
    let x=target.x,z=target.z,elevation=0
    if(product.category==='马桶'&&measuredToiletAnchor){x=measuredToiletAnchor.x_mm;z=measuredToiletAnchor.z_mm}
    if(product.category==='花洒'){x=shower.x_mm;z=shower.z_mm;elevation=700}
    if(product.category==='热水器'){elevation=heaterMountingPlan(spec.height_mm??2200,dims.height_mm).elevation_mm}
    if(product.category==='花洒扶手'){x=shower.x_mm+Math.min(380,showerSize/2-40);z=shower.z_mm;elevation=700}
    if(product.category==='马桶扶手'){const toilet=fixtures.find(f=>f.kind==='toilet');x=(toilet?.x_mm??target.x)+330;z=toilet?.z_mm??target.z;elevation=650}
    const rotation = product.category === '马桶' ? (measuredToiletAnchor?.rotation_deg ?? 0) : 0
    const entity=productFixture(`${level.id}-${product.graph_id}`,kind,product,x,z,fallback,rotation,elevation,true,productInputs.get(product.graph_id)?.model_lookup);fixtures.push(entity);fixtureProducts.set(entity.id,product)
    if(elevation>0)elevated.push(entity);else ground.push(entity)
  }
  // Complete the bathing assembly instead of presenting only a shower head
  // and an invisible zone. The screen is spatial furniture, but is kept out
  // of the remote product-selection equality check because it is derived from
  // the solved wet-zone boundary rather than substituted for a selected SKU.
  if (demand !== 'elderly_safe' && measuredLargeBathroom && quality >= 2) {
    appendShowerScreenPanels(spec, shower, fixtures, level.id, quality)
    removeHeaterScreenCollisions(fixtures)
  }
  const existingCeilingLight = findCeilingLightFixture(fixtures)
  const ceilingAnchor = ceilingLightAnchor(spec, existingCeilingLight ? fixtures.filter((item) => item !== existingCeilingLight) : fixtures)
  if (existingCeilingLight) {
    // Re-center measured/generated lights as well; otherwise only newly
    // created solutions benefit from the room-center anchor.
    existingCeilingLight.x_mm = Math.round(ceilingAnchor.x_mm)
    existingCeilingLight.z_mm = Math.round(ceilingAnchor.z_mm)
  } else {
    fixtures.push(ceilingLightFixture(`${level.id}-ceiling-light`, ceilingAnchor.x_mm, ceilingAnchor.z_mm, spec.height_mm ?? 2200))
  }
  // Do not reserve the provisional shower envelope while placing furniture.
  // The construction wet zone is selected only after all dry/service bodies.
  const placed:FixtureSpec[]=[...fixedObstacles]
  ground.sort((left,right)=>placementPriority(right)-placementPriority(left))
  const lockRelaxations:string[]=[]
  const anchoredEntity=(entity: FixtureSpec) => {const product=fixtureProducts.get(entity.id);if(!product)return false;return product.category==='马桶'?!!measuredToiletAnchor:product.category.includes('浴室柜')?!!lockedVanityAnchor:product.category==='洗衣机'?!!washerAnchor:false}
  ground.sort((left,right)=>(anchoredEntity(right)?1:0)-(anchoredEntity(left)?1:0)||placementPriority(right)-placementPriority(left))
  for(const entity of ground){const product=fixtureProducts.get(entity.id)!,role=levelRole(product.category),plumbing=product.category==='马桶'?toiletDrainPoint(spec):product.category==='洗衣机'?(washerDrain??spec.fixtures.find(f=>f.kind==='water')):product.category.includes('浴室柜')?spec.fixtures.find(f=>f.kind==='water'&&fixturePointUsage(f)==='basin'):undefined,anchor=product.category==='马桶'?measuredToiletAnchor:product.category.includes('浴室柜')?lockedVanityAnchor:product.category==='洗衣机'?washerAnchor:undefined,baseRule=infrastructureRule(spec,instruction(role),anchor),rule=product.category==='淋浴椅'?{...baseRule,wall:wallNearestPoint(spec,shower)}:baseRule;if(!searchPlacement(spec,entity,placed,rule,plumbing,solverTrace,anchor)){placementFailures.push(entity.label)}placed.push(entity)}
  const variantVanity=ground.find((entity)=>entity.kind==='vanity')
  if(variantVanity)nudgeVariantFixture(spec,variantVanity,variantIndex,placed.filter((entity)=>entity!==variantVanity),instruction('vanity'))
  if (variantVanity?.bound_wall_index !== undefined && variantVanity.bound_wall_index !== null) {
    snapRearToWallIndex(spec, variantVanity, variantVanity.bound_wall_index, requiredRearWallGap(variantVanity) ?? 0)
  }
  const toilet=fixtures.find(f=>f.kind==='toilet')
  for(const entity of elevated){
    if (entity.mounting_surface === 'ceiling') { moveInsideRoomPolygon(spec, entity); continue }
    const product=fixtureProducts.get(entity.id)!,baseRule=instruction(levelRole(product.category)),showerWall=measuredShowerWater?(semanticWallForIndex(spec,fixtureBoundWallIndex(spec,measuredShowerWater))??wallNearestPoint(spec,measuredShowerWater)):wallNearestPoint(spec,shower),rule=product.category==='马桶扶手'&&toilet?{...baseRule,wall:wallNearestPoint(spec,toilet)}:['花洒','花洒扶手'].includes(product.category)?{...baseRule,wall:showerWall}:baseRule;if(product.category==='马桶扶手'&&toilet){entity.x_mm=Math.round(toilet.x_mm+330);entity.z_mm=toilet.z_mm}if(product.category==='花洒'&&measuredShowerWater){entity.x_mm=measuredShowerWater.x_mm;entity.z_mm=measuredShowerWater.z_mm}const wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,entity):rule.wall;if(product.category==='热水器')snapWallMountedFixtureAwayFromOpenings(spec,entity,wall,requiredRearWallGap(entity)??0,fixtures);else snapRearToWall(spec,entity,wall,requiredRearWallGap(entity)??0);moveInsideRoomPolygon(spec,entity)
  }
  const showerHead=fixtures.find(item=>/花洒/.test(item.label)&&!/扶手/.test(item.label)),washer=fixtures.find(item=>/洗衣机/.test(item.label))
  // 吊顶凹槽在热水器吸附到最终墙面后再按其最终占位生成。
  const heaterFixture=findHeaterFixture(fixtures),ceilingLight=findCeilingLightFixture(fixtures),heaterPlan=heaterFixture?heaterMountingPlan(spec.height_mm??2200,heaterFixture.height_mm):null
  const ceilingRecess=heaterFixture&&heaterPlan&&heaterPlan.recess_depth_mm>0?heaterCeilingRecessZone(spec,heaterFixture,heaterPlan.recess_depth_mm):undefined
  const heaterRecessAllowance=(f:FixtureSpec)=>(heaterFixture&&f===heaterFixture?(heaterPlan?.recess_depth_mm??0):0)
  if(showerHead&&!measuredShowerWater){const rule=instruction('wet_zone');const wall=semanticWallForIndex(spec,showerHead.bound_wall_index)??(rule.wall==='nearest_plumbing'?wallNearestPoint(spec,showerHead):rule.wall);fixtures.push(wallServicePoint(spec,wall,showerHead,-75,1050,'自动花洒冷水点','water',`${level.id}-shower-cold`,'shower'),wallServicePoint(spec,wall,showerHead,75,1050,'自动花洒热水点','water',`${level.id}-shower-hot`,'shower'))}
  appendToiletWaterValve(spec, fixtures, toilet, `${level.id}-toilet-water`)
  appendHeaterWaterValves(spec, fixtures, heaterFixture, `${level.id}-heater-water`)
  appendVanityWaterValves(spec, fixtures, fixtures.find((item) => item.kind === 'vanity'), `${level.id}-vanity-water`)
  if(washer){const rule=instruction('washer'),wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,washer):rule.wall;fixtures.push(wallServicePoint(spec,wall,washer,-120,1050,'自动洗衣机进水点','water',`${level.id}-washer-water`),wallServicePoint(spec,wall,washer,120,1200,'自动洗衣机电点','electric',`${level.id}-washer-electric`))}
  appendDeviceDrains(spec, fixtures, fixtures.find((item) => item.kind === 'vanity'), washer, level.id)
  appendManifoldFixture(spec, fixtures, `${level.id}-manifold`)
  const finishedBoundary=layoutBoundary(spec),outside=fixtures.filter(f=>!['floor_drain','drain','water','electric','pipe','shower'].includes(f.kind)&&f.mounting_surface!=='ceiling'&&!fixtureInsideRoom(f,finishedBoundary)),solids=[...fixedObstacles,...fixtures.filter(f=>!['floor_drain','drain','water','electric','pipe','shower'].includes(f.kind)&&f.mounting_surface!=='ceiling')],collisions=solids.flatMap((a,i)=>solids.slice(i+1).filter(other=>!permittedAssembly(a,other)&&overlaps(a,other,bodyCollisionClearance(a,other,30))).map(other=>`${a.label}/${other.label}`)),doorClear=!fixtures.some(f=>!['floor_drain','drain','water','electric','pipe','shower'].includes(f.kind)&&f.mounting_surface!=='ceiling'&&blocksFurnitureOpeningEnvelope(spec,f)),reachable=isReachable(spec,ground,{x:shower.x_mm,z:shower.z_mm}),ceilingHeight=spec.height_mm??2200,verticalOverflow=fixtures.filter(f=>f.kind!=='shower'&&f.mounting_surface!=='ceiling'&&(f.elevation_mm??0)+Math.max(1,f.height_mm)>ceilingHeight-25+heaterRecessAllowance(f))
  if(!fixtureInsideRoom(shower,finishedBoundary))outside.push(shower)
  const selectedCodes=new Set(level.products.map(product=>product.catalog_code)),fixtureCodes=new Set([...fixtureProducts.values()].map(product=>product.code)),selectedGraphIds=new Set(level.product_ids),fixtureGraphIds=new Set([...fixtureProducts.values()].map(product=>product.graph_id)),accessibleSelected=new Set(level.products.map(product=>product.category)),hasAccessible=['淋浴椅','花洒扶手','马桶扶手'].every(category=>accessibleSelected.has(category))
  const exactSelection=selectedCodes.size===fixtureCodes.size&&[...selectedCodes].every(code=>fixtureCodes.has(code))&&selectedGraphIds.size===fixtureGraphIds.size&&[...selectedGraphIds].every(id=>fixtureGraphIds.has(id))
  const toiletOffset=measuredToiletAnchor&&toilet?Math.hypot(toilet.x_mm-measuredToiletAnchor.x_mm,toilet.z_mm-measuredToiletAnchor.z_mm):0
  const measuredWasherDrain = !!washerDrain
  const rearWallFailures=fixtures.filter(item=>requiredRearWallGap(item)!==undefined).filter(item=>{
    if (measuredWasherDrain && /洗衣机/.test(item.label)) return false
    if (measuredToiletAnchor?.locked && item.kind === 'toilet') return false
    const wall=semanticWallForIndex(spec,item.bound_wall_index)??wallNearestPoint(spec,item)
    return Math.abs(rearWallDistance(spec,item,wall)-(requiredRearWallGap(item)??0))>10
  })
  const cabinetFailures=cabinetEnvelopeFailures(spec,fixtures)
  const checks:LayoutCheck[]=[check('G01',outside.length===0,'error','几何',outside.length?`设备越界：${outside.map(f=>f.label).join('、')}`:'全部设备实体位于房间边界内'),check('G01-COLLISION',collisions.length===0,'error','几何',collisions.length?`设备实体碰撞：${collisions.join('、')}`:'设备实体包围盒无碰撞（30mm 容差）'),check('G01-VERTICAL',verticalOverflow.length===0,'error','几何',verticalOverflow.length?`设备穿越吊顶安全界面：${verticalOverflow.map(f=>f.label).join('、')}`:ceilingRecess?`热水器嵌入吊顶凹槽 ${ceilingRecess.height_mm-ceilingHeight}mm，其余设备低于吊顶安全界面 25mm`:'全部设备低于吊顶安全界面 25mm'),...(heaterFixture?[check('CEILING-RECESS',heaterPlan?.minimum_bottom_satisfied??false,'error','吊顶嵌入',ceilingRecess?((heaterFixture.elevation_mm??0)>=HEATER_MIN_BOTTOM_MM?`房高不足，热水器顶部嵌入吊顶凹槽 ${ceilingRecess.height_mm-ceilingHeight}mm（凹槽完成面高 ${ceilingRecess.height_mm}mm），底部 ${Math.round(heaterFixture.elevation_mm??0)}mm`:`吊顶凹槽已达 ${HEATER_MAX_RECESS_MM}mm 上限，热水器底部 ${Math.round(heaterFixture.elevation_mm??0)}mm 低于 ${HEATER_MIN_BOTTOM_MM}mm 安装高度，需现场复核`):`热水器贴近吊顶安装，顶部距吊顶完成面 ${HEATER_CEILING_SAFETY_MM}mm`)]:[]),check('G02-CLEARANCE',placementFailures.length===0,'error','几何净空',placementFailures.length?`没有满足前向净空和实体间距的候选位置：${placementFailures.join('、')}`:'全部落地设备满足布局脚本的前向使用净空'),check('G04',doorClear,'error','几何',doorClear?'入口开门包络未被设备占用':'设备侵入入口开门包络'),check('G06-WALL-ATTACH',rearWallFailures.length===0,'error','安装约束',rearWallFailures.length?`设备未满足墙板吸附或插电预留：${rearWallFailures.map(item=>item.label).join('、')}`:'墙板距墙 35mm；壁挂设备吸附完成面，洗衣机背后预留 50mm'),check('MEP-AUTO-POINTS', !!showerHead&&fixtures.filter(item=>item.kind==='water'&&item.point_usage==='shower').length>=2&&(!washer||fixtures.some(item=>item.label==='自动洗衣机进水点')&&fixtures.some(item=>item.label==='自动洗衣机电点')), 'error', '水电点规则', washer?'已生成花洒冷热水点及洗衣机进水、电点':'已生成花洒冷热水点'),check('G05',reachable,'warning','栅格可达性',reachable?'门口至湿区存在连续可达路径':'门口至湿区通路未通过，需选择其他候选'),check('PLUMBING-TOILET',!measuredToiletAnchor||toiletOffset<=600,'error','排水粗装约束',measuredToiletAnchor?`马桶中心相对排水粗装锚点微调 ${Math.round(toiletOffset)}mm`:'量房未提供马桶排水粗装点'),check('KG-SELECTION',exactSelection,'error','产品知识图谱','布局实体与需求助手选择的 graph_id 和目录编号逐项一致'),check('KG-ACCESSIBLE',demand!=='elderly_safe'||hasAccessible,'error','设备规则',demand==='elderly_safe'?'适老安全设备完整且未使用淋浴隔断':'非适老分支'),check('MODEL-DIMENSIONS',fixtures.filter(f=>!['floor_drain','drain','water','electric','pipe'].includes(f.kind)).every(f=>!f.label.includes(' · proxy')),'warning','模型包围盒','实体优先使用精确 SKU 或后端模型快照尺寸，缺失模型时使用审计代理尺寸'),check('MODEL-ASSETS',fixtures.filter(f=>!['floor_drain','drain','water','electric','pipe'].includes(f.kind)&&f.mounting_surface!=='ceiling').every(f=>!!f.model_asset),'warning','模型资产','实体优先按精确 SKU 绑定本地模型，否则沿用后端产品模型快照'),check('INPUT-DRAIN',spec.fixtures.some(f=>f.kind==='floor_drain'),'warning','输入门禁',measuredShowerDrain?'沿用量房淋浴排水点':'量房未提供淋浴排水点，位置待专业确认')]
   checks.push(check('CABINET-RULES', cabinetFailures.length === 0, 'error', '浴室柜安装规则', cabinetFailures.length ? cabinetFailures.join('；') : cabinetRuleDescription()))
   if(lockRelaxations.length)checks.push(check('PLACEMENT-LOCK',false,'warning','固定点位',`固定点位锚定无法满足净空或边界约束，已放宽为邻近布局：${lockRelaxations.join('、')}（点位本身保持不变）`))
  checks.push(check('CEILING-LIGHT', !!ceilingLight?.model_asset && ceilingLight.mounting_surface === 'ceiling' && (ceilingLight.elevation_mm ?? 0) + ceilingLight.height_mm <= ceilingHeight + 1, 'error', '吊顶嵌入', ceilingLight?.model_asset ? `已绑定 ${ceilingLight.model_asset.label}，安装包络 ${ceilingLight.width_mm}×${ceilingLight.depth_mm}×${ceilingLight.height_mm}mm，灯顶与吊顶完成面齐平` : '模型库缺少浴霸模型，无法生成吊顶嵌入灯'))
  checks.push(check('CEILING-RECESS-CONFIRMATION',!ceilingRecess,'warning','吊顶嵌入',ceilingRecess?'凹槽为设计预留；施工前必须核验结构顶净空、吊顶龙骨及隐蔽管线':'无需吊顶凹槽'))
  const anchors:LayoutAnchor[]=fixtures.map(entity=>{const product=fixtureProducts.get(entity.id),rule=instruction(product?levelRole(product.category):'wet_zone');return{id:`anchor-${entity.id}`,label:`${entity.label}中心点`,x_mm:entity.x_mm,z_mm:entity.z_mm,instruction:`${rule.zone}区 / 靠${rule.wall}墙 / ${rule.near?`邻近 ${rule.near} / `:''}最小净距 ${rule.min_clearance_mm}mm / 旋转 ${entity.rotation_deg}°`}})
  const productLines=level.products.map(product=>({code:product.catalog_code,category:product.category,spec:product.spec,price:product.unit_price,quantity:1,unit:product.price_unit})),quantities=surfaceQuantities(spec),wallProduct=materialProduct('墙板',quality,style),floorProduct=materialProduct('地砖',quality,style),ceilingProduct=materialProduct('吊顶',quality,style),floorAsset=surfaceAssetForProduct(floorProduct.材料编号),floorLayout=optimizeFloorLayout({...spec,fixtures},floorAsset?.dimensions_mm.width??600,floorAsset?.dimensions_mm.depth??600),materialLines=[{product:wallProduct,quantity:quantities.wall},{product:floorProduct,quantity:quantities.floor},{product:ceilingProduct,quantity:quantities.ceiling}].map(({product,quantity})=>({code:product.材料编号,category:product.材料名称,spec:product.规格型号,price:Number(product.单价),quantity,unit:product.数量单位,subtotal:Math.round(Number(product.单价)*quantity*100)/100,model_asset_id:surfaceAssetForProduct(product.材料编号)?.id})),equipmentPrice=productLines.reduce((sum,line)=>sum+line.price,0),materialPrice=materialLines.reduce((sum,line)=>sum+line.subtotal,0)
  checks.push(check('FLOOR-CUT',floorLayout.narrow_cut_count===0,'warning','地砖排版优化器',floorLayout.description),check('FLOOR-JOINT-POINT',floorLayout.joint_conflict_count===0,'error','地砖排版优化器',floorLayout.joint_conflict_count?`干区地面点位与砖缝冲突 ${floorLayout.joint_conflict_count} 处`:`干区地面点位均避开砖缝，最小净距 ${floorLayout.min_point_joint_clearance_mm}mm`))
  const score=Math.max(0,Math.min(100,100-checks.filter(c=>!c.passed&&c.severity==='error').length*25-checks.filter(c=>!c.passed&&c.severity==='warning').length*5+quality*2))
  return {id:level.id,demand,budget,title:level.name,budget_label:budgetLabels[budget],layout_label:layoutLabels[budget],layout_summary:`${level.reason}；${floorLayout.description}`,model_reason:level.reason,product_lines:productLines,material_lines:materialLines,surface_materials:{wall:surfaceAssetForProduct(wallProduct.材料编号),floor:floorAsset},equipment_price:equipmentPrice,material_price:materialPrice,total_price:Math.round((equipmentPrice+materialPrice)*100)/100,score,fixtures,anchors,checks,wet_zone:{x_mm:shower.x_mm,z_mm:shower.z_mm,width_mm:shower.width_mm,depth_mm:shower.depth_mm},wet_zone_anchor:{x_mm:shower.x_mm,z_mm:shower.z_mm,width_mm:shower.width_mm,depth_mm:shower.depth_mm},floor_layout:floorLayout,ceiling_recess:ceilingRecess,layout_script:layoutScript,solver_trace:{candidates_evaluated:solverTrace.evaluated,feasible_candidates:solverTrace.feasible,reachable},selected_product_ids:[...level.product_ids]}
}

function alternatingLayoutScripts(spec: RoomSpec, base: LayoutScript) {
  const walls = [...new Set(spec.boundary.map((_, index) => semanticWallForIndex(spec, index)).filter((wall): wall is Exclude<SemanticWall, 'nearest_plumbing'> => !!wall))]
  const candidates = [base]
  for (let round = 1; round < 3 && walls.length > 1; round += 1) {
    const instructions = base.instructions.map((item, index) => {
      if (!['vanity','heater','washer'].includes(item.fixture_role)) return item
      const current = item.wall === 'nearest_plumbing' ? walls[0] : item.wall
      const currentIndex = Math.max(0, walls.indexOf(current))
      const step = item.fixture_role === 'vanity' ? round + 1 : round
      return { ...item, wall: walls[(currentIndex + step + index % 2) % walls.length] }
    })
    candidates.push({ ...base, instructions })
  }
  return candidates
}

function plumbingObjective(solution: LayoutSolution, spec: RoomSpec) {
  const preserved = spec.fixtures.filter((fixture) => !fixture.layout_generated)
  const route = routePlumbing({ ...spec, fixtures: [...preserved, ...solution.fixtures] })
  const hardFailures = solution.checks.filter((item) => item.severity === 'error' && !item.passed).length
  const pipeMm = route?.total_mm ?? Number.MAX_SAFE_INTEGER / 1000
  const imbalanceMm = route?.imbalance_mm ?? Number.MAX_SAFE_INTEGER / 1000
  let geometryPenalty = 0
  try {
    solution.wet_zone_boundary = wetZoneBoundaryForSolution(spec, solution).map((point) => ({ ...point }))
  } catch {
    geometryPenalty = 1_000_000_000
  }
  // Keep the scalar for solver traces, but candidate selection uses the
  // explicit lexicographic rank below so no total-length saving can trade away
  // a more balanced source-to-device distance spread.
  return {
    route,
    geometryValid: geometryPenalty === 0,
    hardFailures,
    geometryPenalty,
    imbalanceMm,
    pipeMm,
    objective: hardFailures * 5_000_000 + imbalanceMm * 1000 + pipeMm + geometryPenalty,
  }
}

type PlumbingCandidateRank = [imbalance_mm: number, total_mm: number, layout_change_cost: number]

function comparePlumbingRank(left: PlumbingCandidateRank, right: PlumbingCandidateRank) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

function layoutScriptChangeCost(base: LayoutScript, candidate: LayoutScript) {
  const baseWalls = new Map(base.instructions.map((item) => [item.fixture_role, item.wall]))
  // Preserve the deterministic wall assignment unless a changed topology
  // produces a material pipe reduction. This keeps geometry stable for rooms
  // with narrow returns while still allowing meaningful plumbing improvements.
  return candidate.instructions.reduce((sum, item) => sum + (baseWalls.get(item.fixture_role) && baseWalls.get(item.fixture_role) !== item.wall ? 10000 : 0), 0)
}

/**
 * Alternate furniture placement and pipe routing for three deterministic
 * rounds. Each round changes the host-wall topology, re-solves every fixture,
 * regenerates service points, and only then scores the resulting pipe tree.
 */
function alternatingLayoutPlumbingSolution(spec: RoomSpec, level: LayoutLevelDecision, preference?: LayoutPreference) {
  const candidates = alternatingLayoutScripts(spec, level.layout_script)
  const evaluated = candidates.map((candidate) => {
    const solution = makeLevelSolution(spec, { ...level, layout_script: candidate }, preference)
    const scored = plumbingObjective(solution, spec)
    const layoutCost = layoutScriptChangeCost(level.layout_script, candidate)
    return { solution, route: scored.route, geometryValid: scored.geometryValid, objective: scored.objective + layoutCost, rank: [scored.imbalanceMm, scored.pipeMm, layoutCost] as PlumbingCandidateRank }
  })
  const iterations = evaluated.map((candidate, index) => ({
    iter: index,
    moved: index ? candidate.solution.fixtures.filter((fixture) => ['vanity'].includes(fixture.kind) || /(热水器|洗衣机)/.test(fixture.label)).map((fixture) => fixture.label) : [],
    total_pipe_mm: candidate.route?.total_mm ?? 0,
    imbalance_mm: candidate.route?.imbalance_mm ?? 0,
    objective: Math.round(candidate.objective),
    accepted: false,
  }))
  const hardValid = evaluated.filter((candidate) => candidate.geometryValid && !candidate.solution.checks.some((item) => item.severity === 'error' && !item.passed))
  let selected = hardValid[0] ?? evaluated.find((candidate) => candidate.geometryValid) ?? evaluated[0]
  iterations[evaluated.indexOf(selected)].accepted = true
  for (let index = 1; index < evaluated.length; index += 1) {
    const candidate = evaluated[index]
    const errors = candidate.solution.checks.filter((item) => item.severity === 'error' && !item.passed).length
    if (errors === 0 && candidate.geometryValid && comparePlumbingRank(candidate.rank, selected.rank) < 0) {
      selected = candidate
      iterations[index].accepted = true
    }
  }
  syncSolutionWetZoneSize(spec, selected.solution)
  selected.solution.solver_trace = {
    ...selected.solution.solver_trace,
    alternating_rounds: candidates.length,
    plumbing_candidates: evaluated.length,
    selected_pipe_mm: selected.route?.total_mm,
    selected_imbalance_mm: selected.route?.imbalance_mm,
    iterations,
  }
  selected.solution.layout_summary = `${selected.solution.layout_summary}；家具布局→水点→管路评分交替 ${candidates.length} 轮，选中管长 ${selected.route?.total_mm ?? 0}mm / 末端极差 ${selected.route?.imbalance_mm ?? 0}mm`
  selected.solution.checks.push(check('PLUMBING-ALTERNATING', true, 'info', '交替优化', `比较 ${evaluated.length} 组完整家具与给水候选，按硬约束后以末端距离极差优先、总管长次之、布局改动成本最后的字典序择优`))
  return selected.solution
}

function alternatingDeterministicSolution(spec: RoomSpec, demand: DemandProfile, budget: BudgetTier, preference?: Omit<LayoutPreference, 'levels'>) {
  const scripts = alternatingLayoutScripts(spec, buildLayoutScript(demand, budget, spec))
  const evaluated = scripts.map((script) => {
    const solution = makeSolution(spec, demand, budget, preference, script)
    const scored = plumbingObjective(solution, spec)
    const layoutCost = layoutScriptChangeCost(scripts[0], script)
    return { solution, route: scored.route, geometryValid: scored.geometryValid, objective: scored.objective + layoutCost, rank: [scored.imbalanceMm, scored.pipeMm, layoutCost] as PlumbingCandidateRank }
  })
  const iterations = evaluated.map((candidate, index) => ({
    iter: index,
    moved: index ? candidate.solution.fixtures.filter((fixture) => fixture.kind === 'vanity' || /(热水器|洗衣机)/.test(fixture.label)).map((fixture) => fixture.label) : [],
    total_pipe_mm: candidate.route?.total_mm ?? 0,
    imbalance_mm: candidate.route?.imbalance_mm ?? 0,
    objective: Math.round(candidate.objective),
    accepted: false,
  }))
  const hardValid = evaluated.filter((candidate) => candidate.geometryValid && !candidate.solution.checks.some((item) => item.severity === 'error' && !item.passed))
  let selected = hardValid[0] ?? evaluated.find((candidate) => candidate.geometryValid) ?? evaluated[0]
  iterations[evaluated.indexOf(selected)].accepted = true
  for (let index = 1; index < evaluated.length; index += 1) {
    const candidate = evaluated[index]
    const errors = candidate.solution.checks.filter((item) => item.severity === 'error' && !item.passed).length
    if (errors === 0 && candidate.geometryValid && comparePlumbingRank(candidate.rank, selected.rank) < 0) {
      selected = candidate
      iterations[index].accepted = true
    }
  }
  syncSolutionWetZoneSize(spec, selected.solution)
  selected.solution.solver_trace = {
    ...selected.solution.solver_trace,
    alternating_rounds: scripts.length,
    plumbing_candidates: evaluated.length,
    selected_pipe_mm: selected.route?.total_mm,
    selected_imbalance_mm: selected.route?.imbalance_mm,
    iterations,
  }
  selected.solution.layout_summary = `${selected.solution.layout_summary}；家具布局→水点→管路评分交替 ${scripts.length} 轮，选中管长 ${selected.route?.total_mm ?? 0}mm / 末端极差 ${selected.route?.imbalance_mm ?? 0}mm`
  selected.solution.checks.push(check('PLUMBING-ALTERNATING', true, 'info', '交替优化', `比较 ${evaluated.length} 组完整家具与给水候选，按硬约束后以末端距离极差优先、总管长次之、布局改动成本最后的字典序择优`))
  return selected.solution
}

export function generateLayoutSolutions(spec: RoomSpec, preference?: LayoutPreference) {
  if(preference?.levels?.length)return diversifyDuplicateLayoutLevels(spec, preference.levels.slice(0,3)).map(level=>alternatingLayoutPlumbingSolution(spec,level,preference))
  return [generateAutomaticLayoutSolution(spec, preference)]
}

/** Generate three local, product-backed alternatives for remote layout fallback. */
export function generateDeterministicLayoutSolutions(spec: RoomSpec, preference?: Omit<LayoutPreference, 'levels'>) {
  const demand: DemandProfile = hasLaundryInfrastructure(spec) ? 'laundry' : 'standard_shower'
  return budgets.map((budget, index) => ({
    ...alternatingDeterministicSolution(spec, demand, budget, preference),
    id: `level${index + 1}`,
    title: `${budgetLabels[budget]}约束求解方案`,
    budget_label: budgetLabels[budget],
    layout_label: layoutLabels[budget],
  }))
}

export function generateAutomaticLayoutSolution(spec: RoomSpec, preference?: LayoutPreference): LayoutSolution {
  const demand: DemandProfile = hasLaundryInfrastructure(spec) ? 'laundry' : 'standard_shower'
  const solution = makeSolution(spec, demand, 'comfort', preference)
  syncSolutionWetZoneSize(spec, solution)
  return {
    ...solution,
    id: 'automatic-layout',
    title: '当前约束求解结果',
    budget_label: '本地产品规则',
    layout_label: '量房约束自动布局',
    layout_summary: `根据现有门洞、排水、给水和障碍物执行网格候选搜索；${solution.floor_layout.description}`,
  }
}

function wetZoneBoundaryForSolution(spec: RoomSpec, solution: LayoutSolution) {
  if (solution.wet_zone_boundary?.length === 4) return solution.wet_zone_boundary.map((point) => ({ ...point }))
  const room = layoutBoundary(spec)
  // Laundry rectangles are selected by room geometry, not by the tier's
  // nominal shower envelope. Keep candidate cuts anchored to the original
  // 900 mm solver envelope so display-size synchronization remains idempotent
  // when the solution is applied a second time.
  const wet = solution.wet_zone_anchor ?? solution.wet_zone
  const measuredShowerDrains = spec.fixtures.filter((item) => item.kind === 'floor_drain' && fixturePointUsage(item) === 'shower')
  // A measured shower drain makes the wet-zone footprint a hard construction
  // constraint. For legacy rooms without that evidence retain the existing
  // best-effort polygon behaviour instead of making application impossible.
  const strictMeasuredWetZone = measuredShowerDrains.length > 0 && Math.min(wet.width_mm, wet.depth_mm) >= BATHROOM_AUTO_LAYOUT_RULES.shower_min_internal_mm
  // 800 mm is the engine's legacy compact-room fallback, not the acceptance
  // threshold for a measured shower. In a measured large bathroom every tier
  // must persist at least a usable 900 x 900 polygon. Tier differentiation is
  // then selected by distance to its 900/1000/1100 target because irregular
  // rooms may only offer asymmetric corner rectangles (for example 1520x915).
  const measuredMinimum = 900
  const requiredWidth = strictMeasuredWetZone ? measuredMinimum : BATHROOM_AUTO_LAYOUT_RULES.shower_min_internal_mm
  const requiredDepth = strictMeasuredWetZone ? measuredMinimum : BATHROOM_AUTO_LAYOUT_RULES.shower_min_internal_mm
  const tile = solution.surface_materials.floor?.dimensions_mm
  // The wet area is always a true rectangle in a room corner: two adjacent
  // sides reuse finished walls and the other two are perpendicular dividers.
  // Raw wall topology may split those two sides into two or three wall runs.
  const dividerAxis = solution.floor_layout.rotation_deg === 0 ? 'z' : 'x'
  type Axis = 'x' | 'z'
  type Cut = { axis:Axis; keepMinimum:boolean; cut:number }
  const coordinate = (point:{x_mm:number;z_mm:number}, axis:Axis) => axis === 'x' ? point.x_mm : point.z_mm
  const axisCuts = (axis:Axis):Cut[] => {
    const values=room.map((point)=>coordinate(point,axis)), minimum=Math.min(...values), maximum=Math.max(...values)
    const centre=axis==='x'?wet.x_mm:wet.z_mm, halfWet=axis==='x'?wet.width_mm/2:wet.depth_mm/2
    const module=tile?(axis==='x'?(solution.floor_layout.rotation_deg===0?tile.width:tile.depth):(solution.floor_layout.rotation_deg===0?tile.depth:tile.width)):0
    const offset=axis==='x'?solution.floor_layout.offset_x_mm:solution.floor_layout.offset_z_mm
    const snapOutward = (value:number, towardMinimum:boolean) => {
    if (!module) return value
    const relative = (value - minimum - offset) / module
    return minimum + offset + (towardMinimum ? Math.floor(relative) : Math.ceil(relative)) * module
    }
    const exact: Cut[] = [
      {axis,keepMinimum:true,cut:centre+halfWet},
      {axis,keepMinimum:false,cut:centre-halfWet},
    ]
    // The placement solver optimizes the shower envelope first. In an
    // orthogonal room that envelope can be legal while not sitting at a
    // convex corner, so restricting dividers to its current coordinates made
    // application fail late. Also consider the nearest legal corner-sized
    // rectangles; application will project generated shower items into the
    // chosen rectangle while measured points remain authoritative.
    for (const corner of room) {
      const value = coordinate(corner, axis)
      const preferredSpan = halfWet * 2
      const minimumSpan = Math.min(preferredSpan, BATHROOM_AUTO_LAYOUT_RULES.shower_min_internal_mm)
      // Start with the room's full available span so a legal wet zone can
      // grow beyond the product's nominal shower footprint.  Keep the
      // nominal and minimum spans as deterministic fallbacks for tight rooms.
      const maximumSpan = maximum - minimum
      const spans = [...new Set([
        maximumSpan,
        Math.max(preferredSpan, Math.round((maximumSpan + preferredSpan) / 2)),
        preferredSpan,
        Math.max(measuredMinimum, preferredSpan - 100),
        measuredMinimum,
        minimumSpan,
      ])]
      for (const span of spans) exact.push(
        { axis, keepMinimum:true, cut:value + span },
        { axis, keepMinimum:false, cut:value - span },
      )
    }
    // A joint is preferred, but it is not a feasibility constraint. Near an
    // irregular wall the outward joint can land on (or beyond) the room bound
    // and erase the divider, so retain the exact wet-envelope cut as fallback.
    return exact.flatMap((cut) => {
      const snapped = snapOutward(cut.cut, cut.keepMinimum ? false : true)
      return [snapped, cut.cut].map((value) => ({...cut,cut:Math.max(minimum,Math.min(maximum,value))}))
    }).filter((cut,index,cuts)=>cuts.findIndex((item)=>item.keepMinimum===cut.keepMinimum&&Math.abs(item.cut-cut.cut)<.001)===index)
  }
  const pointOnWallSegment = (point:(typeof room)[number], start:(typeof room)[number], end:(typeof room)[number]) => {
    const cross=(end.x_mm-start.x_mm)*(point.z_mm-start.z_mm)-(end.z_mm-start.z_mm)*(point.x_mm-start.x_mm)
    return Math.abs(cross)<.01 && point.x_mm>=Math.min(start.x_mm,end.x_mm)-.01 && point.x_mm<=Math.max(start.x_mm,end.x_mm)+.01 && point.z_mm>=Math.min(start.z_mm,end.z_mm)-.01 && point.z_mm<=Math.max(start.z_mm,end.z_mm)+.01
  }
  const edgeOnWall = (start:(typeof room)[number],end:(typeof room)[number]) => {
    const length=Math.hypot(end.x_mm-start.x_mm,end.z_mm-start.z_mm)
    const samples=Math.max(2,Math.ceil(length/50))
    return Array.from({length:samples+1},(_,index)=>({
      x_mm:start.x_mm+(end.x_mm-start.x_mm)*index/samples,
      z_mm:start.z_mm+(end.z_mm-start.z_mm)*index/samples,
    })).every((point)=>room.some((wallStart,index)=>pointOnWallSegment(point,wallStart,room[(index+1)%room.length])))
  }
  const wallRunCount = (start:(typeof room)[number],end:(typeof room)[number]) => room.filter((wallStart,index) => {
    const wallEnd=room[(index+1)%room.length]
    const horizontal=Math.abs(end.z_mm-start.z_mm)<.01
    if(horizontal!== (Math.abs(wallEnd.z_mm-wallStart.z_mm)<.01))return false
    if(horizontal&&Math.abs(start.z_mm-wallStart.z_mm)>.01)return false
    if(!horizontal&&Math.abs(start.x_mm-wallStart.x_mm)>.01)return false
    const [a,b,c,d]=horizontal?[start.x_mm,end.x_mm,wallStart.x_mm,wallEnd.x_mm]:[start.z_mm,end.z_mm,wallStart.z_mm,wallEnd.z_mm]
    return Math.min(Math.max(a,b),Math.max(c,d))-Math.max(Math.min(a,b),Math.min(c,d))>.01
  }).length
  const primaryCuts=axisCuts(dividerAxis),secondaryCuts=axisCuts(dividerAxis==='x'?'z':'x')
  const doorCenters = spec.openings.filter((opening) => opening.kind === 'door').map((opening) => {
    const start = room[opening.wall_index] ?? room[0]
    const end = room[(opening.wall_index + 1) % room.length] ?? room[1]
    const length = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
    const ratio = (opening.offset_mm + opening.width_mm / 2) / length
    return { x_mm: start.x_mm + (end.x_mm - start.x_mm) * ratio, z_mm: start.z_mm + (end.z_mm - start.z_mm) * ratio }
  })
  // A rectangle corner is not always a source polygon vertex.  In stepped
  // rooms the usable X coordinate and Z coordinate can come from different
  // measured corners, so enumerate their orthogonal combinations explicitly.
  const anchorXs = [...new Set(room.map((point) => point.x_mm))]
  const anchorZs = [...new Set(room.map((point) => point.z_mm))]
  // Keep candidate validation cheap.  The full wet-zone drag resolver performs
  // a 25 mm room-wide search and must only run once, after a candidate has
  // been selected.  Exclude toilets from the provisional validator so a zone
  // that merely touches a toilet can be repaired by moving its free divider.
  const candidateFixtures = [...spec.fixtures, ...solution.fixtures]
  const plannedShowerDrains = solution.fixtures.filter((item) => item.kind === 'floor_drain' && fixturePointUsage(item) === 'shower')
  const candidateHardEntities = candidateFixtures.filter((item) =>
    (item.elevation_mm ?? 0) === 0
    && !['floor_drain', 'drain', 'water', 'electric'].includes(item.kind)
    && !/(花洒|淋浴椅|适老椅|淋浴隔断)/.test(item.label),
  )
  const provisionalBoundarySpec: RoomSpec = {
    ...spec,
    fixtures: candidateFixtures.filter((item) => item.kind !== 'toilet'),
    dry_wet_zones: [],
  }
  const finalBoundarySpec: RoomSpec = { ...spec, fixtures: candidateFixtures, dry_wet_zones: [] }
  const projectedFor = (candidate: typeof room): FixtureSpec => {
    const left = Math.min(...candidate.map((point) => point.x_mm)); const right = Math.max(...candidate.map((point) => point.x_mm))
    const top = Math.min(...candidate.map((point) => point.z_mm)); const bottom = Math.max(...candidate.map((point) => point.z_mm))
    return {
      id: `candidate-wet-${solution.id}`, kind: 'shower', label: '淋浴实体', height_mm: 2000,
      rotation_deg: 0, source: 'derived', confidence: 1, ...wet,
      x_mm: (left + right) / 2, z_mm: (top + bottom) / 2,
      width_mm: right - left, depth_mm: bottom - top,
    }
  }
  const provisionalBoundaryValid = (candidate: typeof room) => {
    const projected = projectedFor(candidate)
    return fixtureInsideRoom(projected, candidate)
      && measuredShowerDrains.every((drain) => fixtureInsideRoom(drain, candidate))
      && plannedShowerDrains.every((drain) => fixtureInsideRoom(drain, candidate))
      && wetZoneBoundaryValid(provisionalBoundarySpec, `candidate-${solution.id}`, candidate)
  }
  const finalBoundaryValid = (candidate: typeof room) => provisionalBoundaryValid(candidate)
    && wetZoneBoundaryValid(finalBoundarySpec, `candidate-${solution.id}`, candidate)
    && !candidateHardEntities.some((item) => {
      const projected = projectedFor(candidate)
      return overlaps(projected, item, bodyCollisionClearance(projected, item, 30))
    })
  const allCandidates = primaryCuts.flatMap((first)=>secondaryCuts.flatMap((second) => anchorXs.flatMap((anchorX) => anchorZs.map((anchorZ) => {
    const xCut=first.axis==='x'?first:second,zCut=first.axis==='z'?first:second
    // Do not assume the usable corner is one of the four global bounding-box
    // corners. Real measured rooms contain returns, pipe-box steps and other
    // orthogonal topology; any convex finished-wall corner may close the two
    // wall sides of the rectangular wet area.
    const initialBoundary=[
      {x_mm:Math.min(anchorX,xCut.cut),z_mm:Math.min(anchorZ,zCut.cut)},
      {x_mm:Math.max(anchorX,xCut.cut),z_mm:Math.min(anchorZ,zCut.cut)},
      {x_mm:Math.max(anchorX,xCut.cut),z_mm:Math.max(anchorZ,zCut.cut)},
      {x_mm:Math.min(anchorX,xCut.cut),z_mm:Math.max(anchorZ,zCut.cut)},
    ]
    const boundary=initialBoundary
    const left=Math.min(...boundary.map((point)=>point.x_mm)),right=Math.max(...boundary.map((point)=>point.x_mm))
    const top=Math.min(...boundary.map((point)=>point.z_mm)),bottom=Math.max(...boundary.map((point)=>point.z_mm))
    // Never turn a failed placement envelope into a visually plausible but
    // unusable strip. The polygon persisted to the spec is the authoritative
    // wet area, so its real dimensions must satisfy the selected tier.
    if(right-left<requiredWidth-.01||bottom-top<requiredDepth-.01)return false
    const edges=boundary.map((start,index)=>({start,end:boundary[(index+1)%4]}))
    if(edges.some(({start,end})=>!pointInPolygon((start.x_mm+end.x_mm)/2,(start.z_mm+end.z_mm)/2,room)&&!edgeOnWall(start,end)))return false
    const wallEdges=edges.filter(({start,end})=>edgeOnWall(start,end))
    const wallRuns=wallEdges.reduce((sum,{start,end})=>sum+wallRunCount(start,end),0)
    const projectedWet:FixtureSpec={id:`candidate-wet-${solution.id}`,kind:'shower',label:'淋浴实体',height_mm:2000,rotation_deg:0,source:'derived',confidence:1,...wet,x_mm:(left+right)/2,z_mm:(top+bottom)/2,width_mm:right-left,depth_mm:bottom-top}
    if(!fixtureInsideRoom(projectedWet,boundary))return false
    if (!provisionalBoundaryValid(boundary))return false
    const centerX=(left+right)/2, centerZ=(top+bottom)/2
    const doorDistance=doorCenters.length ? Math.min(...doorCenters.map((door) => Math.hypot(centerX-door.x_mm, centerZ-door.z_mm))) : 0
    const centerDistance=Math.hypot(centerX-wet.x_mm,centerZ-wet.z_mm)
    const targetDistance=strictMeasuredWetZone?Math.abs(right-left-wet.width_mm)+Math.abs(bottom-top-wet.depth_mm):0
    return {boundary,wallEdges:wallEdges.length,wallRuns,centerDistance,targetDistance,doorDistance}
  })))).filter((candidate):candidate is {boundary:typeof room;wallEdges:number;wallRuns:number;centerDistance:number;targetDistance:number;doorDistance:number}=>candidate!==false)
  // Prefer the intended two-wall construction. If the measured topology has
  // no such rectangle (for example a narrow stepped return), keep the best
  // fully legal rectangle instead of making every layout tier unappliable.
  const strictCandidates = allCandidates.filter((candidate) => candidate.wallEdges === 2 && candidate.wallRuns >= 2)
  const candidates = strictCandidates.length ? strictCandidates : allCandidates
  if (!candidates.length) throw new Error('当前房间无法用两根正交分界线与两条连续墙边围成矩形湿区')
  const orderCandidates = (items: typeof candidates) => items.slice().sort((left,right) => {
    const area=(points:typeof room)=>Math.abs(points.reduce((sum,point,index)=>{const next=points[(index+1)%points.length];return sum+point.x_mm*next.z_mm-next.x_mm*point.z_mm},0))/2
    // Furniture, door envelopes and measured points have already constrained
    // candidate validity. Among those fully legal rectangles, maximize wet
    // area first; entrance distance and drain proximity are tie-breakers only.
    return area(right.boundary)-area(left.boundary)
      || right.doorDistance-left.doorDistance
      || left.centerDistance-right.centerDistance
      || left.targetDistance-right.targetDistance
      || left.wallRuns-right.wallRuns
  })
  // Repair only the selected candidates. A solid overlap that is close to a
  // free divider is resolved by walking that divider away from the solid in
  // both directions; unrelated invalid candidates are discarded immediately.
  const repairBoundary = (initialBoundary: typeof room) => {
    if (finalBoundaryValid(initialBoundary)) return initialBoundary
    const initialProjected = projectedFor(initialBoundary)
    const nearDivider = (item: FixtureSpec) => {
      // Compare the entity envelope with the divider, not just its centre.
      // A toilet or cabinet can be hundreds of millimetres deep while its
      // body still reaches a divider that is relatively far from its centre.
      const footprint = footprintForRotation(item, item.rotation_deg ?? 0)
      const itemLeft = item.x_mm - footprint.width / 2; const itemRight = item.x_mm + footprint.width / 2
      const itemTop = item.z_mm - footprint.depth / 2; const itemBottom = item.z_mm + footprint.depth / 2
      const zoneLeft = initialProjected.x_mm - initialProjected.width_mm / 2; const zoneRight = initialProjected.x_mm + initialProjected.width_mm / 2
      const zoneTop = initialProjected.z_mm - initialProjected.depth_mm / 2; const zoneBottom = initialProjected.z_mm + initialProjected.depth_mm / 2
      return Math.min(Math.abs(itemRight - zoneLeft), Math.abs(itemLeft - zoneRight), Math.abs(itemBottom - zoneTop), Math.abs(itemTop - zoneBottom)) <= 100
    }
    const collides = candidateHardEntities.some((item) => overlaps(initialProjected, item, bodyCollisionClearance(initialProjected, item, 30)))
    if (!collides || !candidateHardEntities.some((item) => overlaps(initialProjected, item, bodyCollisionClearance(initialProjected, item, 30)) && nearDivider(item))) return null
    const edgeIndices = [0, 1, 2, 3].filter((index) => !edgeOnWall(initialBoundary[index], initialBoundary[(index + 1) % 4]))
    for (let step = 25; step <= 600; step += 25) for (const edge of edgeIndices) for (const delta of [-step, step]) {
      const onEdge = (index: number) => edge === 0 ? (index === 0 || index === 1)
        : edge === 1 ? (index === 1 || index === 2)
          : edge === 2 ? (index === 2 || index === 3)
            : (index === 3 || index === 0)
      const axis = edge === 0 || edge === 2 ? 'z' : 'x'
      const shifted = initialBoundary.map((point, index) => {
        if (!onEdge(index)) return { ...point }
        return axis === 'x' ? { ...point, x_mm: point.x_mm + delta } : { ...point, z_mm: point.z_mm + delta }
      }) as typeof initialBoundary
      const width = Math.max(...shifted.map((point) => point.x_mm)) - Math.min(...shifted.map((point) => point.x_mm))
      const depth = Math.max(...shifted.map((point) => point.z_mm)) - Math.min(...shifted.map((point) => point.z_mm))
      if (width >= requiredWidth - .01 && depth >= requiredDepth - .01 && finalBoundaryValid(shifted)) return shifted
    }
    return null
  }
  const sortedCandidates = orderCandidates(candidates)
  for (const candidate of sortedCandidates) {
    const repaired = repairBoundary(candidate.boundary)
    if (repaired) return repaired
  }
  // A strict two-wall candidate is preferred, but it should not make the
  // entire room impossible when every strict rectangle is blocked. Retry the
  // remaining legal rectangles before reporting a genuine failure.
  if (strictCandidates.length && strictCandidates.length < allCandidates.length) {
    const strictSet = new Set(strictCandidates.map((candidate) => candidate.boundary))
    for (const candidate of orderCandidates(allCandidates.filter((item) => !strictSet.has(item.boundary)))) {
      const repaired = repairBoundary(candidate.boundary)
      if (repaired) return repaired
    }
  }
  throw new Error('当前房间无法用两根正交分界线与两条连续墙边围成矩形湿区')
}

function syncSolutionWetZoneSize(spec: RoomSpec, solution: LayoutSolution) {
  // Persist the exact construction rectangle selected during generation so
  // applying a solution cannot perform a second search and drift away from a
  // measured shower drain. Legacy rooms without drain evidence retain the
  // nominal fixture envelope.
  const measuredDrains = spec.fixtures.filter((item) => item.kind === 'floor_drain' && fixturePointUsage(item) === 'shower')
  if (!measuredDrains.length) return solution
  let boundary: Point2D[]
  try {
    // plumbingObjective caches a provisional boundary for candidate ranking.
    // Recompute after the winning furniture layout is known so the persisted
    // rectangle is maximized and still contains the measured drain envelope.
    solution.wet_zone_boundary = undefined
    boundary = wetZoneBoundaryForSolution(spec, solution)
  } catch {
    // If maximization is impossible, retain the solver's nominal wet envelope
    // only when it remains legal and contains every measured drain in full.
    const wet = solution.wet_zone_anchor ?? solution.wet_zone
    boundary = [
      { x_mm: wet.x_mm - wet.width_mm / 2, z_mm: wet.z_mm - wet.depth_mm / 2 },
      { x_mm: wet.x_mm + wet.width_mm / 2, z_mm: wet.z_mm - wet.depth_mm / 2 },
      { x_mm: wet.x_mm + wet.width_mm / 2, z_mm: wet.z_mm + wet.depth_mm / 2 },
      { x_mm: wet.x_mm - wet.width_mm / 2, z_mm: wet.z_mm + wet.depth_mm / 2 },
    ]
    const validationSpec = {
      ...spec,
      fixtures: [...spec.fixtures, ...solution.fixtures.filter((item) => !/淋浴隔断/.test(item.label))],
      dry_wet_zones: [],
    }
    if (!measuredDrains.every((drain) => fixtureInsideRoom(drain, boundary))
      || !wetZoneBoundaryValid(validationSpec, `candidate-${solution.id}`, boundary)) {
      const showerSizeCheck = solution.checks.find((check) => check.code === 'S01')
      if (showerSizeCheck) {
        showerSizeCheck.passed = false
        showerSizeCheck.severity = 'error'
        showerSizeCheck.message = '家具布局完成后无法生成同时包含实测淋浴地漏的合法湿区'
      }
      return solution
    }
  }

  const minX = Math.min(...boundary.map((point) => point.x_mm)); const maxX = Math.max(...boundary.map((point) => point.x_mm))
  const minZ = Math.min(...boundary.map((point) => point.z_mm)); const maxZ = Math.max(...boundary.map((point) => point.z_mm))
  solution.wet_zone_boundary = boundary.map((point) => ({ ...point }))
  solution.wet_zone = { x_mm: (minX + maxX) / 2, z_mm: (minZ + maxZ) / 2, width_mm: maxX - minX, depth_mm: maxZ - minZ }
  if (solution.fixtures.some((item) => /淋浴隔断/.test(item.label))) {
    solution.fixtures = solution.fixtures.filter((item) => !/淋浴隔断/.test(item.label))
    const wetFixture = fixture(
      `${solution.id}-wet-zone`, 'shower', '淋浴湿区',
      solution.wet_zone.x_mm, solution.wet_zone.z_mm,
      solution.wet_zone.width_mm, solution.wet_zone.depth_mm, 2000,
    )
    appendShowerScreenPanels(spec, wetFixture, solution.fixtures, solution.id, budgets.indexOf(solution.budget))
  }
  solution.solver_trace.reachable = isReachable(
    spec,
    solution.fixtures.filter((item) => (item.elevation_mm ?? 0) === 0 && !['floor_drain', 'drain', 'water', 'electric', 'pipe'].includes(item.kind)),
    { x: solution.wet_zone.x_mm, z: solution.wet_zone.z_mm },
  )
  const reachability = solution.checks.find((check) => check.code === 'G05')
  if (reachability) {
    reachability.passed = solution.solver_trace.reachable
    reachability.message = reachability.passed ? '家具布局完成后，门口至最大湿区存在连续可达路径' : '家具布局完成后，门口至最大湿区通路未通过，需选择其他候选'
  }
  const showerSizeCheck = solution.checks.find((check) => check.code === 'S01')
  if (showerSizeCheck) {
    showerSizeCheck.passed = Math.min(solution.wet_zone.width_mm, solution.wet_zone.depth_mm) >= BATHROOM_AUTO_LAYOUT_RULES.shower_min_internal_mm
    showerSizeCheck.message = `家具布局完成后最大湿区 ${solution.wet_zone.width_mm}×${solution.wet_zone.depth_mm}mm`
  }
  return solution
}

export function hasGeneratedLayout(spec: RoomSpec): boolean {
  return spec.fixtures.some((fixture) => fixture.layout_generated === true)
    || (spec.dry_wet_zones ?? []).some((zone) => zone.source === 'derived')
    || (spec.ceiling_zones ?? []).some((zone) => zone.id === HEATER_RECESS_ZONE_ID)
}

/** Removes only entities created by auto-layout; measured and user-authored room data stays intact. */
export function clearGeneratedLayout(spec: RoomSpec): RoomSpec {
  return {
    ...spec,
    fixtures: spec.fixtures.filter((fixture) => fixture.layout_generated !== true),
    dry_wet_zones: (spec.dry_wet_zones ?? []).filter((zone) => zone.source !== 'derived'),
    ceiling_zones: (spec.ceiling_zones ?? []).filter((zone) => zone.id !== HEATER_RECESS_ZONE_ID),
  }
}

export function applyLayoutSolution(spec: RoomSpec, solution: LayoutSolution): RoomSpec {
  const blocking = solution.checks.filter((item) => !item.passed && item.severity === 'error')
  if (blocking.length) throw new Error(`方案存在硬错误：${blocking.map((item) => item.code).join('、')}`)
  const retainedFixtures = spec.fixtures.filter(retainFixtureAcrossLayouts).filter((item) => {
    // Basin drains are derived from the selected vanity. Generic measured
    // floor drains remain evidence and are never replaced by a fabricated
    // washer-specific drain.
    if ((item.kind === 'drain' || item.kind === 'floor_drain') && fixturePointUsage(item) === 'basin' && !item.placement_locked) return false
    return true
  }).map((item) => {
    if (item.kind === 'floor_drain' && fixturePointUsage(item) === 'washer') {
      return { ...item, bound_wall_index: null, layout_generated: item.layout_generated ?? false }
    }
    return item.kind === 'floor_drain' && item.layout_generated === undefined
      ? { ...item, layout_generated: false }
      : { ...item }
  })
  const hasMeasuredShowerDrain = retainedFixtures.some((item) => item.kind === 'floor_drain' && fixturePointUsage(item) === 'shower')
  // Legacy/rejected candidates may still contain the old shower-envelope
  // fixture. Never persist or render it: the wet area has a native polygon
  // representation below.
  const generatedFixtures = preserveCorrectedModelAssets(spec.fixtures, solution.fixtures.filter((item) => item.kind !== 'shower' && !(hasMeasuredShowerDrain && item.kind === 'floor_drain' && fixturePointUsage(item) === 'shower')))
  const retainedZones = (spec.dry_wet_zones ?? []).filter((zone) => zone.source !== 'derived' && zone.id !== 'wet-auto-1')
  let solvedBoundary
  try {
    solvedBoundary = wetZoneBoundaryForSolution(spec, solution)
  } catch {
    // A candidate was already validated during generation. If a stepped room
    // changes its obstacle ordering while applying, retain that exact
    // rectangle instead of failing the whole tier on a second exhaustive cut
    // search.
    const wet = solution.wet_zone
    solvedBoundary = [
      { x_mm: wet.x_mm - wet.width_mm / 2, z_mm: wet.z_mm - wet.depth_mm / 2 },
      { x_mm: wet.x_mm + wet.width_mm / 2, z_mm: wet.z_mm - wet.depth_mm / 2 },
      { x_mm: wet.x_mm + wet.width_mm / 2, z_mm: wet.z_mm + wet.depth_mm / 2 },
      { x_mm: wet.x_mm - wet.width_mm / 2, z_mm: wet.z_mm + wet.depth_mm / 2 },
    ]
  }
  const solvedZone = { id: `layout-wet-${solution.id}`, kind: 'wet' as const, label: '自动生成湿区（空间，非家具）', boundary: solvedBoundary, source: 'derived' as const, confidence: 1 }
  // 热水器吊顶凹槽随方案写入 ceiling_zones；重复应用时替换旧凹槽。
  const ceilingZones = (spec.ceiling_zones ?? []).filter((zone) => zone.id !== HEATER_RECESS_ZONE_ID)
  if (solution.ceiling_recess) ceilingZones.push(solution.ceiling_recess)
  const next = { ...spec, wall_finish_gap_mm: Math.max(35, spec.wall_finish_gap_mm ?? 0), fixtures: [...retainedFixtures, ...generatedFixtures.map((fixture) => ({ ...fixture, layout_generated: true }))], dry_wet_zones: retainedZones.length ? retainedZones : [solvedZone], ceiling_zones: ceilingZones }
  if (!retainedZones.length) {
    if (solution.wet_zone_boundary?.length === 4) {
      if (!wetZoneBoundaryValid(next, solvedZone.id, solvedBoundary)) throw new Error('湿区边界应用失败：已求解边界与当前房型不一致')
      solvedZone.boundary = solvedBoundary.map((point) => ({ ...point }))
    } else {
      const wetApplied = applyWetZoneBoundaryChange(next, solvedZone.id, solvedZone.boundary)
      if (!wetApplied) {
        if (!wetZoneBoundaryValid(next, solvedZone.id, solvedZone.boundary)) throw new Error('湿区边界应用失败：无法生成合法湿区或同步淋浴实体')
        solvedZone.boundary = solvedBoundary.map((point) => ({ ...point }))
      }
    }
    solvedZone.source = 'derived'
  }
  const finished = ensureWallFinishGapsForBoundPoints(next)
  // Finish gaps and wall snapping move the applied geometry; re-anchor the
  // 分水器 to the final routed cold manifold so the device and the drawn
  // pipe network can never drift apart.
  syncManifoldFixture(finished)
  return normalizeGeneratedShowerDimensions(finished)
}
