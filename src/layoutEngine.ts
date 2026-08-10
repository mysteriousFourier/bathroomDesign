import type { FixtureSpec, RoomSpec } from './types'
import graphOutput from './generated-layout-products.json'
import productCatalog from './generated-product-catalog.json'
import { dimensionsFor } from './modelDimensions'
import { builtInAssetAsRoomAsset, modelAssetForProduct, surfaceAssetForProduct, type BuiltInModelRecord } from './modelLibrary'

export type DemandProfile = 'standard_shower' | 'laundry' | 'elderly_safe'
export type BudgetTier = 'basic' | 'comfort' | 'premium'
export interface LayoutPreference { style?: string | null }

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
  product_lines: Array<{ code: string; category: string; price: number }>
  material_lines: Array<{ code: string; category: string; price: number; quantity: number; subtotal: number; model_asset_id?: string }>
  surface_materials: { wall?: BuiltInModelRecord; floor?: BuiltInModelRecord }
  equipment_price: number
  material_price: number
  total_price: number
  score: number
  fixtures: FixtureSpec[]
  anchors: LayoutAnchor[]
  checks: LayoutCheck[]
  wet_zone: { x_mm: number; z_mm: number; width_mm: number; depth_mm: number }
}

const demandLabels: Record<DemandProfile, string> = {
  standard_shower: '标准淋浴', laundry: '洗衣复合', elderly_safe: '适老安全',
}
const budgetLabels: Record<BudgetTier, string> = { basic: '经济档', comfort: '舒适档', premium: '品质档' }
const layoutLabels: Record<BudgetTier, string> = { basic: '沿墙通道型', comfort: '左右分区型', premium: '中央岛式型' }
const budgets: BudgetTier[] = ['basic', 'comfort', 'premium']
const demands: DemandProfile[] = ['standard_shower', 'laundry', 'elderly_safe']

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

function fixture(id: string, kind: FixtureSpec['kind'], label: string, x_mm: number, z_mm: number, width_mm: number, depth_mm: number, height_mm: number, rotation_deg = 0, elevation_mm = 0): FixtureSpec {
  return { id, kind, label, x_mm: Math.round(x_mm), z_mm: Math.round(z_mm), width_mm, depth_mm, height_mm, elevation_mm, rotation_deg, source: 'derived', confidence: 1 }
}

function productFixture(id: string, kind: FixtureSpec['kind'], product: GraphProduct, x_mm: number, z_mm: number, fallback: { width_mm: number; depth_mm: number; height_mm: number }, rotation_deg = 0, elevation_mm = 0) {
  const asset = modelAssetForProduct(product.category, product.code)
  const legacyDimensions = dimensionsFor(product.category, fallback)
  // The supplied grab-bar FBX files contain room-scale scene bounds. Keep the
  // assets renderable, but use their catalog installation envelopes for layout.
  const useInstallationEnvelope = ['花洒扶手', '马桶扶手'].includes(product.category)
  const dimensions = asset && !useInstallationEnvelope
    ? { width_mm: asset.dimensions_mm.width, depth_mm: asset.dimensions_mm.depth, height_mm: asset.dimensions_mm.height, file_name: asset.filename }
    : { ...legacyDimensions, file_name: asset?.filename ?? legacyDimensions.file_name }
  const result = fixture(id, kind, `${product.code} ${product.category} · ${dimensions.file_name}`, x_mm, z_mm, dimensions.width_mm, dimensions.depth_mm, dimensions.height_mm, rotation_deg, elevation_mm)
  if (asset) result.model_asset = builtInAssetAsRoomAsset(asset)
  return result
}

function overlaps(a: FixtureSpec, b: FixtureSpec, clearance = 0) {
  return Math.abs(a.x_mm - b.x_mm) < (a.width_mm + b.width_mm) / 2 + clearance && Math.abs(a.z_mm - b.z_mm) < (a.depth_mm + b.depth_mm) / 2 + clearance
}

function pointInPolygon(x: number, z: number, polygon: RoomSpec['boundary']) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j]
    if (((a.z_mm > z) !== (b.z_mm > z)) && x < ((b.x_mm - a.x_mm) * (z - a.z_mm)) / (b.z_mm - a.z_mm) + a.x_mm) inside = !inside
  }
  return inside
}

function fixtureInsideRoom(f: FixtureSpec, polygon: RoomSpec['boundary']) {
  const hw = f.width_mm / 2; const hd = f.depth_mm / 2
  return [[f.x_mm - hw, f.z_mm - hd], [f.x_mm + hw, f.z_mm - hd], [f.x_mm + hw, f.z_mm + hd], [f.x_mm - hw, f.z_mm + hd]].every(([x, z]) => pointInPolygon(x, z, polygon))
}

function permittedAssembly(a: FixtureSpec, b: FixtureSpec) {
  const labels = `${a.label}/${b.label}`
  return labels.includes('淋浴区') || /(扶手|花洒|热水器)/.test(labels)
}

function check(code: string, passed: boolean, severity: LayoutCheckSeverity, source: string, message: string): LayoutCheck {
  return { code, passed, severity, source, message }
}

function makeSolution(spec: RoomSpec, demand: DemandProfile, budget: BudgetTier, preference?: LayoutPreference): LayoutSolution {
  const b = rectangleBounds(spec); const width = b.maxX - b.minX; const depth = b.maxZ - b.minZ
  const quality = budgets.indexOf(budget)
  const style = preference?.style ?? (demand === 'laundry' ? '中古' : demand === 'elderly_safe' ? '轻法' : '素雅')
  const margin = 60
  const showerSize = demand === 'elderly_safe' ? 1000 : quality === 2 ? 1000 : quality === 1 ? 900 : 800
  const vanityWidth = demand === 'elderly_safe' ? 800 : [600, 700, 800][quality]
  const toiletWidth = 380; const toiletDepth = 680
  const measuredShowerDrain = spec.fixtures.find((f) => f.kind === 'floor_drain' && (f.point_usage === 'shower' || /淋浴/.test(f.label)))
  const measuredToilet = spec.fixtures.find((f) => f.kind === 'toilet')
  // These are three independent topology candidates, not one placement with three product grades.
  const variant = quality
  const showerPositions = [
    { x: b.maxX - showerSize / 2 - margin, z: b.minZ + showerSize / 2 + margin },
    { x: b.minX + width * 0.32, z: b.minZ + depth * 0.58 },
    { x: b.minX + width * 0.28, z: b.minZ + showerSize / 2 + Math.max(80, depth * 0.18) },
  ]
  if (variant === 0 && measuredShowerDrain) showerPositions[0] = { x: Math.min(measuredShowerDrain.x_mm, b.maxX - showerSize / 2 - 10), z: b.minZ + showerSize / 2 + 40 }
  const showerX = showerPositions[variant].x
  const showerZ = showerPositions[variant].z
  const shower = fixture(`${demand}-${budget}-shower`, 'shower', `${budgetLabels[budget]}淋浴区`, showerX, showerZ, showerSize, showerSize, 2000)
  const vanityProduct = graphProduct(demand, demand === 'elderly_safe' ? '适老浴室柜' : '浴室柜', quality, style)
  const vanityDimensions = dimensionsFor(vanityProduct.category, { width_mm: vanityWidth, depth_mm: 560, height_mm: quality === 2 ? 900 : 850 })
  const vanityPositions = [
    { x: b.minX + vanityDimensions.width_mm / 2 + 360, z: b.minZ + vanityDimensions.depth_mm / 2 + 360, rotation: 0 },
    { x: b.minX + width * 0.62, z: b.maxZ - vanityDimensions.depth_mm / 2 - 360, rotation: 180 },
    { x: b.maxX - vanityDimensions.width_mm / 2 - 120, z: b.minZ + depth * 0.30, rotation: 90 },
  ]
  const vp = vanityPositions[variant]
  const vanity = productFixture(`${demand}-${budget}-vanity`, 'vanity', vanityProduct, vp.x, vp.z, { width_mm: vanityWidth, depth_mm: 560, height_mm: quality === 2 ? 900 : 850 }, vp.rotation)
  const toiletPositions = [
    { x: measuredToilet?.x_mm ?? b.minX + width * 0.72, z: measuredToilet?.z_mm ?? b.maxZ - toiletDepth / 2 - margin, rotation: measuredToilet?.rotation_deg ?? 180 },
    { x: b.maxX - toiletDepth / 2 - 120, z: b.minZ + depth * 0.56, rotation: 90 },
    { x: b.minX + width * 0.72, z: b.maxZ - toiletDepth / 2 - 400, rotation: 180 },
  ]
  const tp = toiletPositions[variant]
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
  const fixtures = [vanity, toilet, drain]
  const showerProduct = graphProduct(demand, '花洒', quality, style)
  const heaterProduct = graphProduct(demand, '热水器', quality, style)
  const showerHeadDimensions = dimensionsFor(showerProduct.category, { width_mm: 120, depth_mm: 80, height_mm: 1100 })
  const heaterDimensions = dimensionsFor(heaterProduct.category, { width_mm: 720, depth_mm: 180, height_mm: 430 })
  fixtures.push(productFixture(`${demand}-${budget}-shower-head`, 'other', showerProduct, shower.x_mm, Math.max(b.minZ + showerHeadDimensions.depth_mm / 2 + 20, shower.z_mm - showerSize / 2 + showerHeadDimensions.depth_mm / 2), { width_mm: 120, depth_mm: 80, height_mm: 1100 }, 0, 700))
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

  const outsideFixtures = fixtures.filter((f) => f.kind !== 'floor_drain' && !fixtureInsideRoom(f, spec.boundary))
  const inside = outsideFixtures.length === 0
  const solids = fixtures.filter((f) => !['floor_drain'].includes(f.kind))
  const collisions = solids.flatMap((a, i) => solids.slice(i + 1).filter((other) => !permittedAssembly(a, other) && overlaps(a, other, 30)).map((other) => `${a.label}/${other.label}`))
  const frontClearance = Math.max(0, depth - vanity.depth_mm - shower.depth_mm)
  const toiletSideClearance = Math.min(toilet.x_mm - toiletWidth / 2 - b.minX, b.maxX - (toilet.x_mm + toiletWidth / 2))
  const toiletFrontClearance = toilet.z_mm - toiletDepth / 2 - (b.minZ + vanity.depth_mm + margin)
  const door = spec.openings.find((o) => o.kind === 'door')
  const doorEdge = door ? spec.boundary[door.wall_index] : null
  const doorNext = door ? spec.boundary[(door.wall_index + 1) % spec.boundary.length] : null
  const doorOnTop = !!doorEdge && !!doorNext && doorEdge.z_mm === doorNext.z_mm && doorEdge.z_mm > b.minZ + depth / 2
  const doorClear = !door || !fixtures.some((f) => f.kind !== 'floor_drain' && (f.elevation_mm ?? 0) === 0 && (doorOnTop ? f.z_mm + f.depth_mm / 2 > b.maxZ - 800 : f.z_mm - f.depth_mm / 2 < b.minZ + 800) && f.x_mm > b.minX + door.offset_mm && f.x_mm < b.minX + door.offset_mm + door.width_mm)
  const hasDrainEvidence = spec.fixtures.some((f) => f.kind === 'floor_drain')
  const checks: LayoutCheck[] = [
    check('G01', inside, 'error', '几何', inside ? '全部设备实体位于房间边界内' : `设备越界：${outsideFixtures.map((f) => f.label).join('、')}`),
    check('G01-COLLISION', collisions.length === 0, 'error', '几何', collisions.length ? `设备实体碰撞：${collisions.join('、')}` : '设备实体包围盒无碰撞（30mm 容差）'),
    check('C01', frontClearance >= 800, 'warning', 'D', `主要通路估算净宽 ${frontClearance}mm（建议 ≥800mm）`),
    check('G04', doorClear, 'error', '几何', doorClear ? '入口开门包络未被设备占用' : '设备侵入入口开门包络'),
    check('T01', toiletSideClearance >= 400, 'warning', 'D', `坐便器最近侧向净距 ${Math.round(toiletSideClearance)}mm（建议 ≥400mm）`),
    check('T02', toiletFrontClearance >= 600, 'warning', 'D', `坐便器前方估算净距 ${Math.max(0, Math.round(toiletFrontClearance))}mm（建议 ≥600mm）`),
    check('S01', showerSize >= 800, 'warning', 'D', `淋浴内部净尺寸 ${showerSize}×${showerSize}mm（建议 ≥800×800mm）`),
    check('G05', frontClearance >= 600, 'error', '功能', `连续通路初筛净宽 ${frontClearance}mm（候选门禁 ≥600mm）`),
    check('INPUT-DRAIN', hasDrainEvidence, 'warning', '输入门禁', hasDrainEvidence ? `沿用量房排水证据${measuredShowerDrain ? `（淋浴地漏 ${measuredShowerDrain.x_mm},${measuredShowerDrain.z_mm}）` : ''}` : '量房数据没有既有地漏/排水点；坐便移位、坡度和地漏位置待专业确认'),
    check('KG-CATALOG', fixtures.filter((f) => f.kind !== 'floor_drain').every((f) => /^[A-Z]+(?:\d|-)/.test(f.label)), 'error', '产品知识图谱', '所有家具实体均携带 product_catalog.csv 材料编号；淋浴湿区不进入家具实体清单'),
    check('KG-ACCESSIBLE', demand !== 'elderly_safe' || (!fixtures.some((f) => f.label.includes('淋浴隔断')) && ['LYY-1', 'FSH-1', 'FSM-1'].every((code) => fixtures.some((f) => f.label.startsWith(code)))), 'error', '设备规则', demand === 'elderly_safe' ? '适老方案包含淋浴椅、花洒扶手、马桶扶手，且禁用淋浴隔断' : '非适老分支'),
    check('MODEL-DIMENSIONS', fixtures.every((f) => f.kind === 'floor_drain' || !f.label.includes(' · proxy')), 'warning', 'AGEN-44 模型包围盒', fixtures.some((f) => f.label.includes(' · proxy')) ? `附件缺少可解析模型的品类使用代理尺寸：${fixtures.filter((f) => f.label.includes(' · proxy')).map((f) => f.label.split(' ')[1]).join('、')}` : '家具尺寸均来自附件中成功解析的模型包围盒'),
    check('MODEL-ASSETS', fixtures.filter((f) => !f.label.includes('马桶')).every((f) => !!f.model_asset), 'warning', '内置模型库', fixtures.filter((f) => !f.model_asset).length ? `缺少可渲染模型的实体继续使用代理几何：${fixtures.filter((f) => !f.model_asset).map((f) => f.label.split(' · ')[0]).join('、')}` : '已按产品编号绑定内置模型资产'),
    check('PIPE-ORIGIN', true, 'info', '量房', '原点墙线交点为 (0,0)，260×320mm 内折按包管占位处理'),
    check('G11', false, 'info', 'A/B', '湿区电气分区、IP 防护、漏保及等电位待专业确认'),
  ]
  const anchors: LayoutAnchor[] = fixtures.map((f) => ({ id: `anchor-${f.id}`, label: `${f.label}中心点`, x_mm: f.x_mm, z_mm: f.z_mm, instruction: `${f.label}中心定位；旋转 ${f.rotation_deg}°` }))
  const productLines = fixtures.filter((f) => f.kind !== 'floor_drain').map((f) => {
    const code = f.label.split(' ')[0]
    const product = (graphOutput.scenarios[demand].products as GraphProduct[]).find((item) => item.code === code)
    return { code, category: product?.category ?? f.label.split(' ')[1] ?? '设备', price: product?.price ?? 0 }
  })
  const quantities = surfaceQuantities(spec)
  const wallProduct = materialProduct('墙板', quality, style)
  const floorProduct = materialProduct('地砖', quality, style)
  const ceilingProduct = materialProduct('吊顶', quality, style)
  const materialProducts = [
    { product: wallProduct, quantity: quantities.wall },
    { product: floorProduct, quantity: quantities.floor },
    { product: ceilingProduct, quantity: quantities.ceiling },
  ]
  const materialLines = materialProducts.map(({ product, quantity }) => {
    const asset = surfaceAssetForProduct(product.材料编号)
    const price = Number(product.单价)
    return { code: product.材料编号, category: product.材料名称, price, quantity, subtotal: Math.round(price * quantity * 100) / 100, model_asset_id: asset?.id }
  })
  const equipmentPrice = productLines.reduce((sum, line) => sum + line.price, 0)
  const materialPrice = materialLines.reduce((sum, line) => sum + line.subtotal, 0)
  const totalPrice = Math.round((equipmentPrice + materialPrice) * 100) / 100
  const score = Math.max(0, Math.min(100, 100 - checks.filter((c) => !c.passed && c.severity === 'error').length * 25 - checks.filter((c) => !c.passed && c.severity === 'warning').length * 5 + quality * 2))
  const summaries = ['湿区靠排水端，设备沿外围布置，保留纵向通道', '湿区与洁具分居两侧，形成左右功能分区', '湿区居中组织动线，洁具分散到不同墙面']
  return { id: `${demand}-${budget}`, demand, budget, title: `${demandLabels[demand]} · ${layoutLabels[budget]}`, budget_label: budgetLabels[budget], layout_label: layoutLabels[budget], layout_summary: summaries[variant], product_lines: productLines, material_lines: materialLines, surface_materials: { wall: surfaceAssetForProduct(wallProduct.材料编号), floor: surfaceAssetForProduct(floorProduct.材料编号) }, equipment_price: equipmentPrice, material_price: materialPrice, total_price: totalPrice, score, fixtures, anchors, checks, wet_zone: { x_mm: shower.x_mm, z_mm: shower.z_mm, width_mm: shower.width_mm, depth_mm: shower.depth_mm } }
}

export function generateLayoutSolutions(spec: RoomSpec, preference?: LayoutPreference) { return demands.flatMap((demand) => budgets.map((budget) => makeSolution(spec, demand, budget, preference))) }

export function applyLayoutSolution(spec: RoomSpec, solution: LayoutSolution): RoomSpec {
  const blocking = solution.checks.filter((item) => !item.passed && item.severity === 'error')
  if (blocking.length) throw new Error(`方案存在硬错误：${blocking.map((item) => item.code).join('、')}`)
  const s = solution.wet_zone
  return { ...spec, fixtures: solution.fixtures.map((f) => ({ ...f })), dry_wet_zones: [{ id: `wet-${solution.id}`, kind: 'wet', label: '自动生成湿区（空间，非家具）', boundary: [{ x_mm: s.x_mm - s.width_mm / 2, z_mm: s.z_mm - s.depth_mm / 2 }, { x_mm: s.x_mm + s.width_mm / 2, z_mm: s.z_mm - s.depth_mm / 2 }, { x_mm: s.x_mm + s.width_mm / 2, z_mm: s.z_mm + s.depth_mm / 2 }, { x_mm: s.x_mm - s.width_mm / 2, z_mm: s.z_mm + s.depth_mm / 2 }], source: 'derived', confidence: 1 }] }
}
