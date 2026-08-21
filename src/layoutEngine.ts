import type { CeilingZone, FixtureModelAsset, FixtureSpec, LayoutLevelDecision, LayoutProductInput, ModelCallAudit, ModelLookup, RoomSpec } from './types'
import graphOutput from './generated-layout-products.json'
import productCatalog from './generated-product-catalog.json'
import { dimensionsFor } from './modelDimensions'
import { builtInAssetAsRoomAsset, exactModelAssetForProduct, modelAssetForProduct, surfaceAssetForProduct, type BuiltInModelRecord } from './modelLibrary'
import { ensureWallFinishGapsForBoundPoints, finishedRoomBoundary, fixturePointUsage, nearestWallIndex, projectPointToWall, toiletPlacementFromDrain, wallInwardNormal } from './spec'

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
  /** 吊顶为嵌入热水器开设的凹槽区域（房高不足时生成）。 */
  ceiling_recess?: CeilingZone
  layout_script: LayoutScript
  solver_trace: { candidates_evaluated:number; feasible_candidates:number; reachable:boolean }
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
  const serviceWall = plumbingWall(toiletDrainPoint(spec) ?? spec.fixtures.find((fixture) => ['drain', 'water'].includes(fixture.kind))) ?? ordered.find((item) => item.semantic !== wetWall)?.semantic ?? wetWall
  const dryWall = plumbingWall(spec.fixtures.find((fixture) => fixture.kind === 'water' && fixturePointUsage(fixture) === 'basin')) ?? serviceWall
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
  return { id, kind, label, x_mm: Math.round(x_mm), z_mm: Math.round(z_mm), width_mm, depth_mm, height_mm, elevation_mm, rotation_deg, source: 'derived', confidence: 1, layout_generated: true, position_status:'proposed' }
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
  // A model explicitly bound by the layout response belongs to this SKU and
  // must win over a category-level built-in fallback. Otherwise an unrelated
  // built-in asset can be rendered with the right-looking, but wrong, label.
  const boundAsset = snapshotAsset(lookup)
  const asset = boundAsset ? undefined : (exactAsset ? exactModelAssetForProduct(product.category, product.code) : modelAssetForProduct(product.category, product.code))
  const legacyDimensions = dimensionsFor(product.category, fallback)
  // The supplied grab-bar FBX files contain room-scale scene bounds. Keep the
  // assets renderable, but use their catalog installation envelopes for layout.
  const useInstallationEnvelope = ['花洒扶手', '马桶扶手', '花洒', '热水器'].includes(product.category)
  const snapshotDimensions = lookup?.model_dimensions_mm
  const dimensions = asset && !useInstallationEnvelope
    ? { width_mm: asset.dimensions_mm.width, depth_mm: asset.dimensions_mm.depth, height_mm: asset.dimensions_mm.height, file_name: asset.filename }
    : snapshotDimensions && !useInstallationEnvelope
      ? { width_mm: snapshotDimensions.width, depth_mm: snapshotDimensions.depth, height_mm: snapshotDimensions.height, file_name: lookup?.model_asset_label ?? 'backend-model-snapshot' }
      : { ...legacyDimensions, file_name: asset?.filename ?? legacyDimensions.file_name }
  const result = fixture(id, kind, `${product.code} ${product.category} · ${dimensions.file_name}`, x_mm, z_mm, dimensions.width_mm, dimensions.depth_mm, dimensions.height_mm, rotation_deg, elevation_mm)
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
const HEATER_RECESS_MARGIN_MM = 25

export interface HeaterMountingPlan {
  elevation_mm: number
  recess_depth_mm: number
}

export function heaterMountingPlan(ceilingHeightMm: number, heaterHeightMm: number): HeaterMountingPlan {
  const ideal = ceilingHeightMm - heaterHeightMm - HEATER_CEILING_SAFETY_MM
  if (ideal >= HEATER_MIN_BOTTOM_MM) return { elevation_mm: Math.max(0, Math.floor(ideal)), recess_depth_mm: 0 }
  const deficit = HEATER_MIN_BOTTOM_MM - ideal
  const recessDepth = Math.min(HEATER_MAX_RECESS_MM, Math.ceil(deficit / 10) * 10)
  return { elevation_mm: Math.max(0, Math.floor(ideal + recessDepth)), recess_depth_mm: recessDepth }
}

function heaterCeilingRecessZone(spec: RoomSpec, heater: FixtureSpec, recessDepthMm: number): CeilingZone {
  const footprint = footprintForRotation(heater, heater.rotation_deg)
  const ceilingHeight = spec.height_mm ?? 2200
  const minX = Math.round(heater.x_mm - footprint.width / 2 - HEATER_RECESS_MARGIN_MM)
  const maxX = Math.round(heater.x_mm + footprint.width / 2 + HEATER_RECESS_MARGIN_MM)
  const minZ = Math.round(heater.z_mm - footprint.depth / 2 - HEATER_RECESS_MARGIN_MM)
  const maxZ = Math.round(heater.z_mm + footprint.depth / 2 + HEATER_RECESS_MARGIN_MM)
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
  if (item.kind === 'toilet') return TOILET_REAR_GAP_MM
  if (/洗衣机/.test(item.label)) return WASHER_REAR_GAP_MM
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

function snapRearToWall(spec: RoomSpec, item: FixtureSpec, wall: Exclude<SemanticWall, 'nearest_plumbing'>, gapMm: number) {
  const boundary = layoutBoundary(spec)
  const wallIndex = wallIndexForSemantic(spec, wall, item)
  const resolvedWall = semanticWallForIndex(spec, wallIndex) ?? wall
  const rotation = wallFacingRotation(resolvedWall)
  item.rotation_deg = rotation
  const projection = projectPointToWall(boundary, wallIndex, item)
  if (!projection) return
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
    break
  }
  item.bound_wall_index = wallIndex
}

function snapWallMountedFixtureAwayFromOpenings(spec: RoomSpec, item: FixtureSpec, preferredWall: Exclude<SemanticWall, 'nearest_plumbing'>, gapMm: number) {
  const walls: Exclude<SemanticWall, 'nearest_plumbing'>[] = ['south', 'east', 'north', 'west']
  const original = { ...item }
  const ordered = [preferredWall, ...walls.filter((wall) => wall !== preferredWall)]
  for (const wall of ordered) {
    const candidate = { ...item }
    snapRearToWall(spec, candidate, wall, gapMm)
    if (!fixtureInsideRoom(candidate, layoutBoundary(spec)) || blocksFurnitureOpeningEnvelope(spec, candidate)) continue
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

function wetWallContactCount(spec: RoomSpec, item: FixtureSpec) {
  if (item.kind !== 'shower') return 0
  const boundary = layoutBoundary(spec)
  let contacts = 0
  for (let index = 0; index < boundary.length; index += 1) {
    const projection = projectPointToWall(boundary, index, item)
    if (!projection) continue
    const inward = wallInwardNormal(boundary, index)
    const halfExtent = Math.abs(inward.x) * item.width_mm / 2 + Math.abs(inward.z) * item.depth_mm / 2
    if (projection.distance_mm <= halfExtent + 25) contacts += 1
  }
  return contacts
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
  return [[-hw,-hd],[hw,-hd],[hw,hd],[-hw,hd]].map(([x,z])=>[f.x_mm+x*c-z*s,f.z_mm+x*s+z*c]).every(([x, z]) => pointInPolygon(x, z, polygon))
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
  const ratio = Math.max(0.08, Math.min(0.92, baseRatio + tangentOffsetMm / length))
  const result = fixture(id, kind, label, start.x_mm + (end.x_mm - start.x_mm) * ratio, start.z_mm + (end.z_mm - start.z_mm) * ratio, 40, 40, 10, wallFacingRotation(semanticWallForIndex(spec,wallIndex)??wall), elevationMm)
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
  if ((f.elevation_mm ?? 0) > 50) return false
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
  // The toilet drain is the only hard placement anchor. The fixture may make
  // a bounded 600 mm installation adjustment around that point; other
  // measured points are evidence for ranking, not immovable obstacles.
  return { ...toiletPlacementFromDrain(spec, drain), max_distance_mm: 600 }
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
  return anchor ? { ...instruction, wall: wallNearestPoint(spec, anchor) } : instruction
}

function nudgeVariantFixture(spec: RoomSpec, item: FixtureSpec, variantIndex: number, occupied: FixtureSpec[], instruction: LayoutInstruction) {
  if (variantIndex <= 0 || item.bound_wall_index === undefined || item.bound_wall_index === null) return
  instruction = effectiveLayoutInstruction(item, instruction)
  const boundary = layoutBoundary(spec)
  const start = boundary[item.bound_wall_index]
  const end = boundary[(item.bound_wall_index + 1) % boundary.length]
  const length = Math.max(1, Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))
  const tangent = { x: (end.x_mm - start.x_mm) / length, z: (end.z_mm - start.z_mm) / length }
  for (const offset of [variantIndex * 120, -variantIndex * 120, variantIndex * 240, -variantIndex * 240]) {
    const candidate = { ...item, x_mm: Math.round(item.x_mm + tangent.x * offset), z_mm: Math.round(item.z_mm + tangent.z * offset) }
    if (!fixtureInsideRoom(candidate, boundary) || blocksFurnitureOpeningEnvelope(spec, candidate)) continue
    if (occupied.some((other) => !permittedAssembly(candidate, other) && overlaps(candidate, other, BODY_GAP_MM))) continue
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
  const primary = wallIndexForSemantic(spec, preferredWall, { x_mm:target.x, z_mm:target.z })
  // A measured toilet drain anchors the installation area, not a single wall.
  // The nearest wall can be too close for the toilet body's rotated envelope;
  // allow alternate walls while retaining the primary wall as the first choice.
  if (rearGap === undefined && !(anchor && item.kind === 'toilet') && item.kind !== 'shower') return [primary]
  const boundary = layoutBoundary(spec)
  const canChangeDirection = item.kind === 'shower' || !!(anchor && item.kind === 'toilet') || (!anchor && /(洗衣机|浴室柜)/.test(item.label))
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
  if (item.kind === 'toilet') return 4
  if (/洗衣机/.test(item.label)) return 3
  if (item.kind === 'vanity' || /浴室柜/.test(item.label)) return 2
  if (/淋浴椅|适老椅/.test(item.label)) return 1
  return 0
}

type PlacementCandidate = { x:number; z:number; rotation:number; width:number; depth:number; score:number; wallIndex:number; clearance?:FixtureSpec }

function retainFixtureAcrossLayouts(fixture: FixtureSpec) {
  if (fixture.layout_generated) return false
  // Utility points and structural obstacles survive a layout replacement;
  // measured fixture bodies are replaced by the solved product entities.
  return ['floor_drain', 'drain', 'water', 'electric', 'pipe', 'column', 'radiator'].includes(fixture.kind)
}

function searchPlacement(spec: RoomSpec, item: FixtureSpec, occupied: FixtureSpec[], instruction: LayoutInstruction, plumbing?: FixtureSpec, trace = { evaluated: 0, feasible: 0 }, anchor?: PlacementAnchor) {
  instruction = effectiveLayoutInstruction(item, instruction)
  const b = rectangleBounds(spec); const step = 100
  const rearGap = requiredRearWallGap(item)
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
      const wallX = rearGap !== undefined && hostIsVertical ? Math.round(hostStart.x_mm + hostInward.x * (width / 2 + rearGap)) : undefined
      const wallZ = rearGap !== undefined && !hostIsVertical ? Math.round(hostStart.z_mm + hostInward.z * (depth / 2 + rearGap)) : undefined
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
      const baseX = anchor?.locked ? [anchor.x_mm] : [...new Set([anchor?.x_mm,target.x,...fitX,...gridX,...(!hostIsVertical ? wallSweepValues : [])].filter((value): value is number => value !== undefined))]
      const baseZ = anchor?.locked ? [anchor.z_mm] : [...new Set([anchor?.z_mm,target.z,...fitZ,...gridZ,...(hostIsVertical ? wallSweepValues : [])].filter((value): value is number => value !== undefined))]
      const xValues = wallX === undefined ? (rearGap !== undefined && !hostIsVertical ? baseX.filter((value)=>value>=segmentMinX&&value<=segmentMaxX) : baseX) : [wallX]
      const zValues = wallZ === undefined ? (rearGap !== undefined && hostIsVertical ? baseZ.filter((value)=>value>=segmentMinZ&&value<=segmentMaxZ) : baseZ) : [wallZ]
      for (const x of xValues) {
        for (const z of zValues) {
          trace.evaluated++
          if (anchor?.max_distance_mm !== undefined && Math.hypot(x - anchor.x_mm, z - anchor.z_mm) > anchor.max_distance_mm) continue
          const candidate = { ...item, x_mm:x, z_mm:z, rotation_deg:rotation }
          const clearance = frontClearanceEnvelope(candidate, instruction)
          const occupiedConflict = occupied.some((other) => !permittedAssembly(candidate, other) && (
            overlaps(candidate, other, BODY_GAP_MM)
            || (placementClearances.get(other) ? overlaps(candidate, placementClearances.get(other)!) : false)
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
            if (item.kind === 'vanity' && instruction.min_clearance_mm <= 600) {
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
          const score = wetWallContactCount(spec, candidate) * wallContactWeight - wallDistance * 2 - plumbingDistance * 8 - semanticDistance * 8
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
  if (!best) {
    // Keep attached fixtures inside the wall-panel boundary even when a
    // clearance rule rejects this candidate. The caller still marks it invalid.
    if (rearGap !== undefined) snapRearToWall(spec, item, hostWall, rearGap)
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
    snapRearToWall(spec, item, wallNearestPoint(spec, item), TOILET_REAR_GAP_MM)
  }
}

function solveWetZone(spec: RoomSpec, id: string, label: string, preferredSize: number, instruction: LayoutInstruction, occupied: FixtureSpec[], plumbing: FixtureSpec | undefined, trace: { evaluated: number; feasible: number }) {
  const minimumSize = 800
  const sizes = [...new Set([preferredSize, 900, minimumSize])].filter((size) => size <= preferredSize && size >= minimumSize)
  let last = fixture(id, 'shower', label, plumbing?.x_mm ?? 0, plumbing?.z_mm ?? 0, minimumSize, minimumSize, 2000)
  for (const size of sizes) {
    const target = plumbing ? { x: plumbing.x_mm, z: plumbing.z_mm } : semanticTarget(spec, instruction, size, size)
    const candidate = fixture(id, 'shower', label, target.x, target.z, size, size, 2000)
    last = candidate
    if (searchPlacement(spec, candidate, occupied, instruction, plumbing, trace)) return { shower: candidate, solved: true }
  }
  return { shower: last, solved: false }
}
function isReachable(spec:RoomSpec,fixtures:FixtureSpec[],goal:{x:number;z:number}){const b=rectangleBounds(spec),step=100,radius=300,blocked=(x:number,z:number)=>!pointInPolygon(x,z,spec.boundary)||fixtures.some(f=>(f.elevation_mm??0)===0&&f.kind!=='floor_drain'&&Math.abs(x-f.x_mm)<f.width_mm/2+radius&&Math.abs(z-f.z_mm)<f.depth_mm/2+radius);const door=spec.openings.find(o=>o.kind==='door');if(!door)return true;const edge=spec.boundary[door.wall_index],next=spec.boundary[(door.wall_index+1)%spec.boundary.length],horizontal=Math.abs(next.x_mm-edge.x_mm)>=Math.abs(next.z_mm-edge.z_mm);let sx=horizontal?Math.min(edge.x_mm,next.x_mm)+door.offset_mm+door.width_mm/2:edge.x_mm,sz=horizontal?edge.z_mm:Math.min(edge.z_mm,next.z_mm)+door.offset_mm+door.width_mm/2;sx+=horizontal?0:(sx<(b.minX+b.maxX)/2?step:-step);sz+=horizontal?(sz<(b.minZ+b.maxZ)/2?step:-step):0;const key=(x:number,z:number)=>`${Math.round(x/step)},${Math.round(z/step)}`,queue=[[Math.round(sx/step)*step,Math.round(sz/step)*step]],seen=new Set<string>();while(queue.length){const [x,z]=queue.shift()!,k=key(x,z);if(seen.has(k))continue;if(Math.hypot(x-goal.x,z-goal.z)<=450)return true;if(blocked(x,z))continue;seen.add(k);for(const [dx,dz] of [[step,0],[-step,0],[0,step],[0,-step]])queue.push([x+dx,z+dz])}return false}

function check(code: string, passed: boolean, severity: LayoutCheckSeverity, source: string, message: string): LayoutCheck {
  return { code, passed, severity, source, message }
}

function makeSolution(spec: RoomSpec, demand: DemandProfile, budget: BudgetTier, preference?: LayoutPreference): LayoutSolution {
  const b = rectangleBounds(spec); const width = b.maxX - b.minX; const depth = b.maxZ - b.minZ
  const quality = budgets.indexOf(budget)
  const layoutScript=buildLayoutScript(demand,budget,spec),instruction=(role:string)=>layoutScript.instructions.find(i=>i.fixture_role===role)!
  const style = preference?.style ?? (demand === 'laundry' ? '中古' : demand === 'elderly_safe' ? '轻法' : '素雅')
  const margin = 60
  const showerSize = demand === 'elderly_safe' ? 1000 : quality === 2 ? 1000 : quality === 1 ? 900 : 800
  const vanityWidth = demand === 'elderly_safe' ? 800 : [600, 700, 800][quality]
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
  solveToiletReservation(spec, reservedToilet, fixedObstacles, infrastructureRule(spec, instruction('toilet'), measuredToiletAnchor), toiletDrainPoint(spec), measuredToiletAnchor, wetTrace)
  let wetPlacement=solveWetZone(spec,`${demand}-${budget}-shower`,`${budgetLabels[budget]}淋浴区`,showerSize,instruction('wet_zone'),fixedObstacles,measuredShowerDrain,wetTrace)
  if (reservedToilet && overlaps(wetPlacement.shower, reservedToilet, BODY_GAP_MM)) {
    wetPlacement=solveWetZone(spec,`${demand}-${budget}-shower`,`${budgetLabels[budget]}淋浴区`,showerSize,instruction('wet_zone'),[...fixedObstacles, reservedToilet],measuredShowerDrain,wetTrace)
  }
  const shower=wetPlacement.shower
  const placementFailures:string[]=[]
  if(!wetPlacement.solved)placementFailures.push(shower.label)
  const vanityProduct = graphProduct(demand, demand === 'elderly_safe' ? '适老浴室柜' : '浴室柜', quality, style)
  const vanityDimensions = dimensionsFor(vanityProduct.category, { width_mm: vanityWidth, depth_mm: 560, height_mm: quality === 2 ? 900 : 850 })
  const vt=semanticTarget(spec,instruction('vanity'),vanityDimensions.width_mm,vanityDimensions.depth_mm),vp={...vt,rotation:0}
  const vanity = productFixture(`${demand}-${budget}-vanity`, 'vanity', vanityProduct, vp.x, vp.z, { width_mm: vanityWidth, depth_mm: 560, height_mm: quality === 2 ? 900 : 850 }, vp.rotation, 0, true)
  const tt=measuredToiletAnchor?{x:measuredToiletAnchor.x_mm,z:measuredToiletAnchor.z_mm}:{...semanticTarget(spec,instruction('toilet'),toiletWidth,toiletDepth)},tp={...tt,rotation:measuredToiletAnchor?.rotation_deg??0}
  const toiletX = tp.x
  const toiletZ = tp.z
  const toiletProduct = graphProduct(demand, '马桶', quality, style)
  const toilet = productFixture(`${demand}-${budget}-toilet`, 'toilet', toiletProduct, toiletX, toiletZ, { width_mm: toiletWidth, depth_mm: toiletDepth, height_mm: 760 }, tp.rotation, 0, true)
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
  fixtures.push(productFixture(`${demand}-${budget}-shower-head`, 'other', showerProduct, shower.x_mm, shower.z_mm, { width_mm: 120, depth_mm: 80, height_mm: 1100 }, 0, 700, true))
  // Keep the full measured heater bound clear of the 260 mm pipe chase at the origin.
  // 热水器贴近吊顶：房高不足时按 heaterMountingPlan 在吊顶开凹槽嵌入。
  const heaterMount = heaterMountingPlan(spec.height_mm ?? 2200, heaterDimensions.height_mm)
  fixtures.push(productFixture(`${demand}-${budget}-heater`, 'other', heaterProduct, b.minX + heaterDimensions.width_mm / 2 + 280, b.minZ + heaterDimensions.depth_mm / 2 + 20, { width_mm: 720, depth_mm: 180, height_mm: 430 }, 0, heaterMount.elevation_mm, true))
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
  const solverTrace={evaluated:wetTrace.evaluated,feasible:wetTrace.feasible},groundProducts=fixtures.filter(f=>['vanity','toilet'].includes(f.kind)||/(洗衣机|淋浴椅)/.test(f.label)).sort((left,right)=>placementPriority(right)-placementPriority(left)),placed=[...fixedObstacles,shower,...fixtures.filter(f=>!groundProducts.includes(f)&&(f.elevation_mm??0)===0)];for(const item of groundProducts){const role=item.kind==='vanity'?'vanity':item.kind==='toilet'?'toilet':item.label.includes('洗衣机')?'washer':'wet_zone',plumbing=item.kind==='toilet'?toiletDrainPoint(spec):item.label.includes('洗衣机')?spec.fixtures.find(f=>f.kind==='water'):item.kind==='vanity'?spec.fixtures.find(f=>f.kind==='water'&&fixturePointUsage(f)==='basin'):undefined,anchor=item.kind==='toilet'?measuredToiletAnchor:undefined,baseRule=infrastructureRule(spec,instruction(role),anchor),rule=/淋浴椅/.test(item.label)?{...baseRule,wall:wallNearestPoint(spec,shower)}:baseRule;if(!searchPlacement(spec,item,placed,rule,plumbing,solverTrace,anchor))placementFailures.push(item.label);placed.push(item)}
  for(const item of fixtures.filter(f=>(f.elevation_mm??0)>0)){
    const baseRule=item.label.includes('热水器')?instruction('heater'):item.label.includes('扶手')?instruction('grab_bars'):instruction('wet_zone')
    const hostWall=item.label.includes('马桶扶手')?wallNearestPoint(spec,toilet):/花洒/.test(item.label)?wallNearestPoint(spec,shower):baseRule.wall==='nearest_plumbing'?wallNearestPoint(spec,item):baseRule.wall
    if(item.label.includes('马桶扶手')){item.x_mm=Math.round(toilet.x_mm+330);item.z_mm=Math.round(toilet.z_mm)}
    if (item.label.includes('热水器')) snapWallMountedFixtureAwayFromOpenings(spec, item, hostWall, requiredRearWallGap(item) ?? 0)
    else snapRearToWall(spec,item,hostWall,requiredRearWallGap(item)??0)
    moveInsideRoomPolygon(spec,item)
  }
  const showerHead=fixtures.find(item=>/花洒/.test(item.label)&&!/扶手/.test(item.label))
  const washer=fixtures.find(item=>/洗衣机/.test(item.label))
  // 吊顶凹槽在热水器吸附到最终墙面后再按其最终占位生成。
  const heaterFixture = findHeaterFixture(fixtures)
  const heaterPlan = heaterFixture ? heaterMountingPlan(spec.height_mm ?? 2200, heaterFixture.height_mm) : null
  const ceilingRecess = heaterFixture && heaterPlan && heaterPlan.recess_depth_mm > 0
    ? heaterCeilingRecessZone(spec, heaterFixture, heaterPlan.recess_depth_mm)
    : undefined
  if(showerHead){const rule=instruction('wet_zone'),wall=semanticWallForIndex(spec,showerHead.bound_wall_index)??(rule.wall==='nearest_plumbing'?wallNearestPoint(spec,showerHead):rule.wall);fixtures.push(wallServicePoint(spec,wall,showerHead,-75,1050,'自动花洒冷水点','water',`${demand}-${budget}-shower-cold`,'shower'),wallServicePoint(spec,wall,showerHead,75,1050,'自动花洒热水点','water',`${demand}-${budget}-shower-hot`,'shower'))}
  if(washer){const rule=instruction('washer'),wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,washer):rule.wall;fixtures.push(wallServicePoint(spec,wall,washer,-120,1100,'自动洗衣机进水点','water',`${demand}-${budget}-washer-water`),wallServicePoint(spec,wall,washer,120,1200,'自动洗衣机电点','electric',`${demand}-${budget}-washer-electric`))}
  const reachable=isReachable(spec,groundProducts,{x:shower.x_mm,z:shower.z_mm})

  const finishedBoundary=layoutBoundary(spec)
  const outsideFixtures = fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind) && !fixtureInsideRoom(f, finishedBoundary))
  if(!fixtureInsideRoom(shower,finishedBoundary))outsideFixtures.push(shower)
  const inside = outsideFixtures.length === 0
  const solids = [...fixedObstacles, ...fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind))]
  const collisions = solids.flatMap((a, i) => solids.slice(i + 1).filter((other) => !permittedAssembly(a, other) && overlaps(a, other, 30)).map((other) => `${a.label}/${other.label}`))
  const ceilingHeight = spec.height_mm ?? 2200
  // 嵌入吊顶凹槽的热水器以凹槽完成面为垂直安全界面。
  const heaterRecessAllowance = (f: FixtureSpec) => (heaterFixture && f === heaterFixture ? (heaterPlan?.recess_depth_mm ?? 0) : 0)
  const verticalOverflow = fixtures.filter((f) => (f.elevation_mm ?? 0) + Math.max(1, f.height_mm) > ceilingHeight - 25 + heaterRecessAllowance(f))
  const frontClearance = Math.max(0, depth - vanity.depth_mm - shower.depth_mm)
  const toiletSideClearance = Math.min(toilet.x_mm - toiletWidth / 2 - b.minX, b.maxX - (toilet.x_mm + toiletWidth / 2))
  const toiletFrontClearance = toilet.z_mm - toiletDepth / 2 - (b.minZ + vanity.depth_mm + margin)
  const doorClear=!fixtures.some(f=>!['floor_drain','water','electric'].includes(f.kind)&&blocksFurnitureOpeningEnvelope(spec,f))
  const hasDrainEvidence = spec.fixtures.some((f) => f.kind === 'floor_drain')
  const toiletOffset = measuredToiletAnchor ? Math.hypot(toilet.x_mm - measuredToiletAnchor.x_mm, toilet.z_mm - measuredToiletAnchor.z_mm) : 0
  const rearWallFailures=fixtures.filter(item=>requiredRearWallGap(item)!==undefined).filter(item=>{const wall=semanticWallForIndex(spec,item.bound_wall_index)??wallNearestPoint(spec,item);return Math.abs(rearWallDistance(spec,item,wall)-(requiredRearWallGap(item)??0))>10})
  const checks: LayoutCheck[] = [
    check('G01', inside, 'error', '几何', inside ? '全部设备实体位于房间边界内' : `设备越界：${outsideFixtures.map((f) => f.label).join('、')}`),
    check('G01-COLLISION', collisions.length === 0, 'error', '几何', collisions.length ? `设备实体碰撞：${collisions.join('、')}` : '设备实体包围盒无碰撞（30mm 容差）'),
    check('G01-VERTICAL', verticalOverflow.length === 0, 'error', '几何', verticalOverflow.length ? `设备穿越吊顶安全界面：${verticalOverflow.map((f) => f.label).join('、')}` : ceilingRecess ? `热水器嵌入吊顶凹槽 ${ceilingRecess.height_mm - ceilingHeight}mm，其余设备低于吊顶安全界面 25mm` : '全部设备低于吊顶安全界面 25mm'),
    ...(heaterFixture ? [check('CEILING-RECESS', !ceilingRecess || (heaterFixture.elevation_mm ?? 0) >= HEATER_MIN_BOTTOM_MM, 'warning', '吊顶嵌入', ceilingRecess
      ? ((heaterFixture.elevation_mm ?? 0) >= HEATER_MIN_BOTTOM_MM
        ? `房高不足，热水器顶部嵌入吊顶凹槽 ${ceilingRecess.height_mm - ceilingHeight}mm（凹槽完成面高 ${ceilingRecess.height_mm}mm），底部 ${Math.round(heaterFixture.elevation_mm ?? 0)}mm`
        : `吊顶凹槽已达 ${HEATER_MAX_RECESS_MM}mm 上限，热水器底部 ${Math.round(heaterFixture.elevation_mm ?? 0)}mm 低于 ${HEATER_MIN_BOTTOM_MM}mm 安装高度，需现场复核`)
      : `热水器贴近吊顶安装，顶部距吊顶完成面 ${HEATER_CEILING_SAFETY_MM}mm`)] : []),
    check('G02-CLEARANCE', placementFailures.length === 0, 'error', '几何净空', placementFailures.length ? `没有满足完成面、门区和前向净空的候选位置：${placementFailures.join('、')}` : '全部落地设备满足完成面、门区和前向净空'),
    check('G02-CLEARANCE-RELAXED', !fixtures.some((fixture) => relaxedPlacementClearances.has(fixture)), 'warning', '几何净空', fixtures.some((fixture) => relaxedPlacementClearances.has(fixture)) ? '浴室柜在当前房型采用 300mm 前向净空降级，需现场复核使用空间' : '未使用净空降级'),
    check('C01', frontClearance >= 800, 'warning', 'D', `主要通路估算净宽 ${frontClearance}mm（建议 ≥800mm）`),
    check('G04', doorClear, 'error', '几何', doorClear ? '门窗洞口及门扇开启包络未被设备占用' : '设备侵入门窗洞口或门扇开启包络'),
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
    check('MODEL-DIMENSIONS', fixtures.filter((f) => !['floor_drain','water','electric'].includes(f.kind)).every((f) => !f.label.includes(' · proxy')), 'warning', 'AGEN-44 模型包围盒', fixtures.some((f) => f.label.includes(' · proxy')) ? `附件缺少可解析模型的品类使用代理尺寸：${fixtures.filter((f) => f.label.includes(' · proxy')).map((f) => f.label.split(' ')[1]).join('、')}` : '家具尺寸均来自附件中成功解析的模型包围盒；马桶已绑定 MT3 精确模型'),
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
  return { id: `${demand}-${budget}`, demand, budget, title: `${demandLabels[demand]} · ${budgetLabels[budget]}`, budget_label: budgetLabels[budget], layout_label: layoutLabels[budget], layout_summary: `依据量房基础设施与几何约束求解；${summaries[variant]}；${floorLayout.description}`, product_lines: productLines, material_lines: materialLines, surface_materials: { wall: surfaceAssetForProduct(wallProduct.材料编号), floor: floorAsset }, equipment_price: equipmentPrice, material_price: materialPrice, total_price: totalPrice, score, fixtures, anchors, checks, wet_zone: { x_mm: shower.x_mm, z_mm: shower.z_mm, width_mm: shower.width_mm, depth_mm: shower.depth_mm },floor_layout:floorLayout,ceiling_recess:ceilingRecess,layout_script:layoutScript,solver_trace:{candidates_evaluated:solverTrace.evaluated,feasible_candidates:solverTrace.feasible,reachable},selected_product_ids:selectedProductIds }
}

function levelGraphProduct(product:LayoutProductInput):GraphProduct{return{graph_id:product.product_id,code:product.catalog_code,category:product.category,spec:product.spec,price:product.unit_price}}
function levelFallback(category:string){const defaults:Record<string,{width_mm:number;depth_mm:number;height_mm:number}>={"花洒":{width_mm:120,depth_mm:80,height_mm:1100},"热水器":{width_mm:720,depth_mm:180,height_mm:430},"马桶":{width_mm:380,depth_mm:680,height_mm:760},"浴室柜":{width_mm:800,depth_mm:500,height_mm:850},"适老浴室柜":{width_mm:800,depth_mm:500,height_mm:850},"洗衣机":{width_mm:600,depth_mm:620,height_mm:850},"淋浴椅":{width_mm:420,depth_mm:360,height_mm:450},"花洒扶手":{width_mm:80,depth_mm:600,height_mm:900},"马桶扶手":{width_mm:80,depth_mm:600,height_mm:750}};return defaults[category]??{width_mm:500,depth_mm:500,height_mm:800}}
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
  const measuredShowerDrain=showerDrainPoint(spec),measuredToiletAnchor=toiletAnchorPoint(spec),fixedObstacles=fixedLayoutObstacles(spec)
  const showerSize=demand==='elderly_safe'?1000:quality===2?1000:quality===1?900:800,wetRule=instruction('wet_zone')
  const reservedToilet=measuredToiletAnchor?products.find(product=>product.category==='马桶'):undefined,reservedDims=reservedToilet?dimensionsFor('马桶',levelFallback('马桶')):undefined,reservedRotation=measuredToiletAnchor?.rotation_deg??0,reservedWidth=reservedDims?(Math.abs(reservedRotation)%180===90?reservedDims.depth_mm:reservedDims.width_mm):0,reservedDepth=reservedDims?(Math.abs(reservedRotation)%180===90?reservedDims.width_mm:reservedDims.depth_mm):0
  const reservedBodies=measuredToiletAnchor&&reservedDims?[fixture(`${level.id}-reserved-toilet`,'toilet','实测排污点马桶预留体积',measuredToiletAnchor.x_mm,measuredToiletAnchor.z_mm,reservedWidth,reservedDepth,reservedDims.height_mm,reservedRotation)]:[]
  const solverTrace={evaluated:0,feasible:0},placementFailures:string[]=[]
  solveToiletReservation(spec, reservedBodies[0], fixedObstacles, infrastructureRule(spec, instruction('toilet'), measuredToiletAnchor), toiletDrainPoint(spec), measuredToiletAnchor, solverTrace)
  const wetPlacement=solveWetZone(spec,`${level.id}-wet-zone`,`${level.name}淋浴湿区`,showerSize,wetRule,[...fixedObstacles,...reservedBodies],measuredShowerDrain,solverTrace)
  const shower=wetPlacement.shower
  if(!wetPlacement.solved)placementFailures.push(shower.label)
  const drainDimensions=dimensionsFor('地漏',{width_mm:100,depth_mm:100,height_mm:20}),drain=fixture(`${level.id}-drain`,'floor_drain',`湿区地漏 · ${drainDimensions.file_name}`,shower.x_mm,shower.z_mm,drainDimensions.width_mm,drainDimensions.depth_mm,drainDimensions.height_mm),drainAsset=modelAssetForProduct('地漏');if(drainAsset)drain.model_asset=builtInAssetAsRoomAsset(drainAsset)
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
  const placed:FixtureSpec[]=[...fixedObstacles,drain,shower]
  ground.sort((left,right)=>placementPriority(right)-placementPriority(left))
  for(const entity of ground){const product=fixtureProducts.get(entity.id)!,role=levelRole(product.category),plumbing=product.category==='马桶'?toiletDrainPoint(spec):product.category==='洗衣机'?spec.fixtures.find(f=>f.kind==='water'):product.category.includes('浴室柜')?spec.fixtures.find(f=>f.kind==='water'&&fixturePointUsage(f)==='basin'):undefined,anchor=product.category==='马桶'?measuredToiletAnchor:undefined,baseRule=infrastructureRule(spec,instruction(role),anchor),rule=product.category==='淋浴椅'?{...baseRule,wall:wallNearestPoint(spec,shower)}:baseRule;if(!searchPlacement(spec,entity,placed,rule,plumbing,solverTrace,anchor))placementFailures.push(entity.label);placed.push(entity)}
  const variantVanity=ground.find((entity)=>entity.kind==='vanity')
  if(variantVanity)nudgeVariantFixture(spec,variantVanity,variantIndex,placed.filter((entity)=>entity!==variantVanity),instruction('vanity'))
  const toilet=fixtures.find(f=>f.kind==='toilet')
  for(const entity of elevated){const product=fixtureProducts.get(entity.id)!,baseRule=instruction(levelRole(product.category)),rule=product.category==='马桶扶手'&&toilet?{...baseRule,wall:wallNearestPoint(spec,toilet)}:['花洒','花洒扶手'].includes(product.category)?{...baseRule,wall:wallNearestPoint(spec,shower)}:baseRule;if(product.category==='马桶扶手'&&toilet){entity.x_mm=Math.round(toilet.x_mm+330);entity.z_mm=toilet.z_mm}const wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,entity):rule.wall;if(product.category==='热水器')snapWallMountedFixtureAwayFromOpenings(spec,entity,wall,requiredRearWallGap(entity)??0);else snapRearToWall(spec,entity,wall,requiredRearWallGap(entity)??0);moveInsideRoomPolygon(spec,entity)}
  const showerHead=fixtures.find(item=>/花洒/.test(item.label)&&!/扶手/.test(item.label)),washer=fixtures.find(item=>/洗衣机/.test(item.label))
  // 吊顶凹槽在热水器吸附到最终墙面后再按其最终占位生成。
  const heaterFixture=findHeaterFixture(fixtures),heaterPlan=heaterFixture?heaterMountingPlan(spec.height_mm??2200,heaterFixture.height_mm):null
  const ceilingRecess=heaterFixture&&heaterPlan&&heaterPlan.recess_depth_mm>0?heaterCeilingRecessZone(spec,heaterFixture,heaterPlan.recess_depth_mm):undefined
  const heaterRecessAllowance=(f:FixtureSpec)=>(heaterFixture&&f===heaterFixture?(heaterPlan?.recess_depth_mm??0):0)
  if(showerHead){const rule=instruction('wet_zone'),wall=semanticWallForIndex(spec,showerHead.bound_wall_index)??(rule.wall==='nearest_plumbing'?wallNearestPoint(spec,showerHead):rule.wall);fixtures.push(wallServicePoint(spec,wall,showerHead,-75,1050,'自动花洒冷水点','water',`${level.id}-shower-cold`,'shower'),wallServicePoint(spec,wall,showerHead,75,1050,'自动花洒热水点','water',`${level.id}-shower-hot`,'shower'))}
  if(washer){const rule=instruction('washer'),wall=rule.wall==='nearest_plumbing'?wallNearestPoint(spec,washer):rule.wall;fixtures.push(wallServicePoint(spec,wall,washer,-120,1100,'自动洗衣机进水点','water',`${level.id}-washer-water`),wallServicePoint(spec,wall,washer,120,1200,'自动洗衣机电点','electric',`${level.id}-washer-electric`))}
  const finishedBoundary=layoutBoundary(spec),outside=fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind)&&!fixtureInsideRoom(f,finishedBoundary)),solids=[...fixedObstacles,...fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind))],collisions=solids.flatMap((a,i)=>solids.slice(i+1).filter(other=>!permittedAssembly(a,other)&&overlaps(a,other,30)).map(other=>`${a.label}/${other.label}`)),doorClear=!fixtures.some(f=>!['floor_drain','water','electric'].includes(f.kind)&&blocksFurnitureOpeningEnvelope(spec,f)),reachable=isReachable(spec,ground,{x:shower.x_mm,z:shower.z_mm}),ceilingHeight=spec.height_mm??2200,verticalOverflow=fixtures.filter(f=>(f.elevation_mm??0)+Math.max(1,f.height_mm)>ceilingHeight-25+heaterRecessAllowance(f))
  if(!fixtureInsideRoom(shower,finishedBoundary))outside.push(shower)
  const selectedCodes=new Set(level.products.map(product=>product.catalog_code)),fixtureCodes=new Set([...fixtureProducts.values()].map(product=>product.code)),selectedGraphIds=new Set(level.product_ids),fixtureGraphIds=new Set([...fixtureProducts.values()].map(product=>product.graph_id)),accessibleSelected=new Set(level.products.map(product=>product.category)),hasAccessible=['淋浴椅','花洒扶手','马桶扶手'].every(category=>accessibleSelected.has(category))
  const exactSelection=selectedCodes.size===fixtureCodes.size&&[...selectedCodes].every(code=>fixtureCodes.has(code))&&selectedGraphIds.size===fixtureGraphIds.size&&[...selectedGraphIds].every(id=>fixtureGraphIds.has(id))
  const toiletOffset=measuredToiletAnchor&&toilet?Math.hypot(toilet.x_mm-measuredToiletAnchor.x_mm,toilet.z_mm-measuredToiletAnchor.z_mm):0
  const rearWallFailures=fixtures.filter(item=>requiredRearWallGap(item)!==undefined).filter(item=>{const wall=semanticWallForIndex(spec,item.bound_wall_index)??wallNearestPoint(spec,item);return Math.abs(rearWallDistance(spec,item,wall)-(requiredRearWallGap(item)??0))>10})
  const checks:LayoutCheck[]=[check('G01',outside.length===0,'error','几何',outside.length?`设备越界：${outside.map(f=>f.label).join('、')}`:'全部设备实体位于房间边界内'),check('G01-COLLISION',collisions.length===0,'error','几何',collisions.length?`设备实体碰撞：${collisions.join('、')}`:'设备实体包围盒无碰撞（30mm 容差）'),check('G01-VERTICAL',verticalOverflow.length===0,'error','几何',verticalOverflow.length?`设备穿越吊顶安全界面：${verticalOverflow.map(f=>f.label).join('、')}`:ceilingRecess?`热水器嵌入吊顶凹槽 ${ceilingRecess.height_mm-ceilingHeight}mm，其余设备低于吊顶安全界面 25mm`:'全部设备低于吊顶安全界面 25mm'),...(heaterFixture?[check('CEILING-RECESS',!ceilingRecess||(heaterFixture.elevation_mm??0)>=HEATER_MIN_BOTTOM_MM,'warning','吊顶嵌入',ceilingRecess?((heaterFixture.elevation_mm??0)>=HEATER_MIN_BOTTOM_MM?`房高不足，热水器顶部嵌入吊顶凹槽 ${ceilingRecess.height_mm-ceilingHeight}mm（凹槽完成面高 ${ceilingRecess.height_mm}mm），底部 ${Math.round(heaterFixture.elevation_mm??0)}mm`:`吊顶凹槽已达 ${HEATER_MAX_RECESS_MM}mm 上限，热水器底部 ${Math.round(heaterFixture.elevation_mm??0)}mm 低于 ${HEATER_MIN_BOTTOM_MM}mm 安装高度，需现场复核`):`热水器贴近吊顶安装，顶部距吊顶完成面 ${HEATER_CEILING_SAFETY_MM}mm`)]:[]),check('G02-CLEARANCE',placementFailures.length===0,'error','几何净空',placementFailures.length?`没有满足前向净空和实体间距的候选位置：${placementFailures.join('、')}`:'全部落地设备满足布局脚本的前向使用净空'),check('G04',doorClear,'error','几何',doorClear?'入口开门包络未被设备占用':'设备侵入入口开门包络'),check('G06-WALL-ATTACH',rearWallFailures.length===0,'warning','安装约束',rearWallFailures.length?`设备未满足墙板吸附或插电预留：${rearWallFailures.map(item=>item.label).join('、')}`:'墙板距墙 35mm；壁挂设备吸附完成面，洗衣机背后预留 50mm'),check('MEP-AUTO-POINTS', !!showerHead&&fixtures.filter(item=>item.kind==='water'&&item.point_usage==='shower').length>=2&&(!washer||fixtures.some(item=>item.label==='自动洗衣机进水点')&&fixtures.some(item=>item.label==='自动洗衣机电点')), 'error', '水电点规则', washer?'已生成花洒冷热水点及洗衣机进水、电点':'已生成花洒冷热水点'),check('G05',reachable,'warning','栅格可达性',reachable?'门口至湿区存在连续可达路径':'门口至湿区通路未通过，需选择其他候选'),check('PLUMBING-TOILET',!measuredToiletAnchor||toiletOffset<=600,'error','排水粗装约束',measuredToiletAnchor?`马桶中心相对排水粗装锚点微调 ${Math.round(toiletOffset)}mm`:'量房未提供马桶排水粗装点'),check('KG-SELECTION',exactSelection,'error','产品知识图谱','布局实体与需求助手选择的 graph_id 和目录编号逐项一致'),check('KG-ACCESSIBLE',demand!=='elderly_safe'||hasAccessible,'error','设备规则',demand==='elderly_safe'?'适老安全设备完整且未使用淋浴隔断':'非适老分支'),check('MODEL-DIMENSIONS',fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind)).every(f=>!f.label.includes(' · proxy')),'warning','模型包围盒','实体优先使用精确 SKU 或后端模型快照尺寸，缺失模型时使用审计代理尺寸'),check('MODEL-ASSETS',fixtures.filter(f=>!['floor_drain','water','electric'].includes(f.kind)).every(f=>!!f.model_asset),'warning','模型资产','实体优先按精确 SKU 绑定本地模型，否则沿用后端产品模型快照'),check('INPUT-DRAIN',spec.fixtures.some(f=>f.kind==='floor_drain'),'warning','输入门禁',measuredShowerDrain?'沿用量房淋浴排水点':'量房未提供淋浴排水点，位置待专业确认')]
  const anchors:LayoutAnchor[]=fixtures.map(entity=>{const product=fixtureProducts.get(entity.id),rule=instruction(product?levelRole(product.category):'wet_zone');return{id:`anchor-${entity.id}`,label:`${entity.label}中心点`,x_mm:entity.x_mm,z_mm:entity.z_mm,instruction:`${rule.zone}区 / 靠${rule.wall}墙 / ${rule.near?`邻近 ${rule.near} / `:''}最小净距 ${rule.min_clearance_mm}mm / 旋转 ${entity.rotation_deg}°`}})
  const productLines=level.products.map(product=>({code:product.catalog_code,category:product.category,spec:product.spec,price:product.unit_price,quantity:1,unit:product.price_unit})),quantities=surfaceQuantities(spec),wallProduct=materialProduct('墙板',quality,style),floorProduct=materialProduct('地砖',quality,style),ceilingProduct=materialProduct('吊顶',quality,style),floorAsset=surfaceAssetForProduct(floorProduct.材料编号),floorLayout=optimizeFloorLayout({...spec,fixtures},floorAsset?.dimensions_mm.width??600,floorAsset?.dimensions_mm.depth??600),materialLines=[{product:wallProduct,quantity:quantities.wall},{product:floorProduct,quantity:quantities.floor},{product:ceilingProduct,quantity:quantities.ceiling}].map(({product,quantity})=>({code:product.材料编号,category:product.材料名称,spec:product.规格型号,price:Number(product.单价),quantity,unit:product.数量单位,subtotal:Math.round(Number(product.单价)*quantity*100)/100,model_asset_id:surfaceAssetForProduct(product.材料编号)?.id})),equipmentPrice=productLines.reduce((sum,line)=>sum+line.price,0),materialPrice=materialLines.reduce((sum,line)=>sum+line.subtotal,0)
  checks.push(check('FLOOR-CUT',floorLayout.narrow_cut_count===0,'warning','地砖排版优化器',floorLayout.description),check('FLOOR-JOINT-POINT',floorLayout.joint_conflict_count===0,'error','地砖排版优化器',floorLayout.joint_conflict_count?`干区地面点位与砖缝冲突 ${floorLayout.joint_conflict_count} 处`:`干区地面点位均避开砖缝，最小净距 ${floorLayout.min_point_joint_clearance_mm}mm`))
  const score=Math.max(0,Math.min(100,100-checks.filter(c=>!c.passed&&c.severity==='error').length*25-checks.filter(c=>!c.passed&&c.severity==='warning').length*5+quality*2))
  return{id:level.id,demand,budget,title:level.name,budget_label:budgetLabels[budget],layout_label:layoutLabels[budget],layout_summary:`${level.reason}；${floorLayout.description}`,model_reason:level.reason,product_lines:productLines,material_lines:materialLines,surface_materials:{wall:surfaceAssetForProduct(wallProduct.材料编号),floor:floorAsset},equipment_price:equipmentPrice,material_price:materialPrice,total_price:Math.round((equipmentPrice+materialPrice)*100)/100,score,fixtures,anchors,checks,wet_zone:{x_mm:shower.x_mm,z_mm:shower.z_mm,width_mm:shower.width_mm,depth_mm:shower.depth_mm},floor_layout:floorLayout,ceiling_recess:ceilingRecess,layout_script:layoutScript,solver_trace:{candidates_evaluated:solverTrace.evaluated,feasible_candidates:solverTrace.feasible,reachable},selected_product_ids:[...level.product_ids]}
}

export function generateLayoutSolutions(spec: RoomSpec, preference?: LayoutPreference) {
  if(preference?.levels?.length)return diversifyDuplicateLayoutLevels(spec, preference.levels.slice(0,3)).map(level=>makeLevelSolution(spec,level,preference))
  return [generateAutomaticLayoutSolution(spec, preference)]
}

/** Generate three local, product-backed alternatives for remote layout fallback. */
export function generateDeterministicLayoutSolutions(spec: RoomSpec, preference?: Omit<LayoutPreference, 'levels'>) {
  const demand: DemandProfile = spec.fixtures.some((fixture) => /洗衣/.test(fixture.label)) ? 'laundry' : 'standard_shower'
  return budgets.map((budget, index) => ({
    ...makeSolution(spec, demand, budget, preference),
    id: `level${index + 1}`,
    title: `${budgetLabels[budget]}约束求解方案`,
    budget_label: budgetLabels[budget],
    layout_label: layoutLabels[budget],
  }))
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
  // 热水器吊顶凹槽随方案写入 ceiling_zones；重复应用时替换旧凹槽。
  const ceilingZones = (spec.ceiling_zones ?? []).filter((zone) => zone.id !== HEATER_RECESS_ZONE_ID)
  if (solution.ceiling_recess) ceilingZones.push(solution.ceiling_recess)
  const next = { ...spec, wall_finish_gap_mm: Math.max(35, spec.wall_finish_gap_mm ?? 0), fixtures: [...retainedFixtures, ...solution.fixtures.map((fixture) => ({ ...fixture, layout_generated: true }))], dry_wet_zones: retainedZones.length ? retainedZones : [solvedZone], ...(ceilingZones.length ? { ceiling_zones: ceilingZones } : {}) }
  return ensureWallFinishGapsForBoundPoints(next)
}
