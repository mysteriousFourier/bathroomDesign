import fs from 'node:fs/promises'
import { chromium } from 'playwright-core'

const raw = JSON.parse(await fs.readFile('evidence/measurement.json', 'utf8'))
const graph = JSON.parse(await fs.readFile('src/generated-layout-products.json', 'utf8'))
const modelLibrary = JSON.parse(await fs.readFile('src/generated-model-library.json', 'utf8'))
const boundary = raw.boundary.map((point) => ({ x_mm:point.x, z_mm:point.y }))
const fixtures = raw.measurementPoints.map((point) => ({
  id:point.pointId, kind:point.kind, label:point.label, x_mm:point.position.x, z_mm:point.position.y,
  width_mm:point.width, depth_mm:point.depth, height_mm:point.height, rotation_deg:point.rotation,
  point_usage:point.pointUsage, source:'measured', confidence:1,
}))
const spec = {
  schema_version:'1.0', name:'真实量房自动布局验证', boundary, height_mm:raw.heights.roomHeight,
  wall_thickness_mm:200,
  openings:[{ id:raw.openings[0].openingId, kind:'door', wall_index:1, offset_mm:400, width_mm:800, height_mm:2055, sill_mm:0, label:'D1', source:'measured', confidence:1 }],
  fixtures, observations:[], issues:[], confirmed:true,
}
const project = { id:'complete-layout', name:'完整技术链验证', status:'ready', created_at:'2026-08-12T00:00:00Z', updated_at:'2026-08-12T00:00:00Z', spec, measurement:null, assets:[] }

function snapshot(product) {
  const asset = modelLibrary.assets.find((item) => item.asset_type === 'fixture' && item.catalog_codes.includes(product.code))
  return {
    product_id:product.graph_id, catalog_code:product.code, category:product.category, catalog_style:'通用',
    normalized_requested_style:'素雅', spec:product.spec, model_asset_id:asset?.id ?? null,
    model_asset_src:asset?.src ?? null, model_asset_format:asset?.format ?? null,
    model_asset_label:asset?.label ?? null, model_dimensions_mm:asset?.dimensions_mm ?? null,
    texture_src:asset?.texture_src ?? null, layout_fixture_kind:product.category,
    binding_status:asset ? 'bound' : 'awaiting_model_asset',
  }
}

const categories = ['花洒', '热水器', '马桶', '浴室柜']
const candidates = Object.fromEntries(categories.map((category) => [category, graph.scenarios.standard_shower.products.filter((product) => product.category === category).sort((a, b) => a.price - b.price)]))
const tierNames = ['经济精准版', '舒适分区版', '品质动线版']
const tiers = ['basic', 'comfort', 'premium']
const walls = [
  { wet:'east', vanity:'west', toilet:'north' },
  { wet:'west', vanity:'east', toilet:'north' },
  { wet:'south', vanity:'north', toilet:'east' },
]
const levels = tiers.map((tier, index) => {
  const products = categories.map((category) => candidates[category][Math.min(index, candidates[category].length - 1)]).map((product) => ({
    product_id:product.graph_id, catalog_code:product.code, category:product.category, spec:product.spec,
    unit_price:product.price, price_unit:'件', model_lookup:snapshot(product),
  }))
  return {
    id:`level${index + 1}`, name:tierNames[index], reason:`模型根据量房生成第 ${index + 1} 档真实产品布局`, demand_profile:'standard_shower', product_tier:tier,
    product_ids:products.map((product) => product.product_id), products,
    layout_script:{ version:'layout-script-v1', demand:'standard_shower', budget:tier, source:'model-assisted-rule-engine', instructions:[
      { fixture_role:'wet_zone', wall:walls[index].wet, zone:'wet', near:'shower_drain', min_clearance_mm:0 },
      { fixture_role:'vanity', wall:walls[index].vanity, zone:'dry', min_clearance_mm:200 },
      { fixture_role:'toilet', wall:walls[index].toilet, zone:'dry', near:'toilet_drain', min_clearance_mm:200 },
      { fixture_role:'heater', wall:walls[index].wet, zone:'service', near:'wet_zone', min_clearance_mm:0 },
    ] },
  }
})

const quoteBase = {
  message:'需求已确认，正在生成三个完整布局脚本。',
  requirements:{ collected:{ 使用人群:['成人'], 功能需求:['淋浴','坐便','洗漱','收纳'], 喜好风格:['素雅'], 预期价格区间:'2-4万' }, missing_fields:[], complete:true },
  style_match:{ user_terms:['素雅'], catalog_style:'素雅', confidence:1, status:'matched', candidates:[], resolver_version:'e2e' },
  surfaces:{ source:'room', floor_area_sqm:7, ceiling_area_sqm:7, wall_gross_area_sqm:24, opening_area_sqm:1.6, wall_net_area_sqm:22.4, waste_rate:.1, floor_purchase_sqm:7.7, ceiling_purchase_sqm:7.7, wall_purchase_sqm:24.64, floor_layout:'', ceiling_layout:'', wall_layout:'', warnings:[] },
  material_quotes:[], furniture_candidates:[], furniture_quotes:[], selected_furniture:[], material_total:0,
  furniture_price_range:{ min:0, max:0 }, total_price_range:{ min:0, max:0 }, furniture_total:0, quote_total:0,
  pricing_status:'final', equipment:{ 必须设备:categories, 可有可无设备:['淋浴隔断'], 不能有的设备:[] }, products:[], layout_blockers:[],
}
const pendingQuote = { ...quoteBase, layout_levels:[] }
const finalQuote = { ...quoteBase, message:'三个真实产品布局已完成几何求解。', layout_levels:levels }
const now = '2026-08-12T08:30:00Z'
const pendingSession = { id:'session-layout', project_id:project.id, title:'真实产品自动布局', message_count:1, last_message:pendingQuote.message, created_at:now, updated_at:now, messages:[{ id:'a0', role:'assistant', content:pendingQuote.message, quote:pendingQuote, created_at:now }] }
const finalSession = { ...pendingSession, message_count:3, last_message:finalQuote.message, messages:[...pendingSession.messages, { id:'u1', role:'user', content:'继续生成三个布局方案', quote:null, created_at:now }, { id:'a1', role:'assistant', content:finalQuote.message, quote:finalQuote, created_at:now }] }

const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const browser = await chromium.launch({ headless:true, executablePath:browserPath, args:['--no-sandbox','--enable-webgl','--use-angle=swiftshader'] })
const page = await browser.newPage({ viewport:{ width:1600, height:1100 } })
const errors = []
page.on('pageerror', (error) => { if (!/Could not load \/model-library/.test(error.message)) errors.push(error.message) })
await page.route('**/api/**', (route) => {
  const request = route.request(); const path = new URL(request.url()).pathname; let body
  if (path === '/api/health') body = { ok:true, ai_configured:true, chat_configured:true, model:'e2e-model' }
  else if (path === '/api/projects') body = [project]
  else if (path.endsWith('/chat-sessions') && request.method() === 'GET') body = [{ ...pendingSession, messages:undefined }]
  else if (path.endsWith('/chat-sessions/session-layout/messages')) body = finalSession
  else if (path.endsWith('/chat-sessions/session-layout')) body = pendingSession
  else body = project
  return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(body) })
})

await page.goto('http://127.0.0.1:5173', { waitUntil:'networkidle' })
await page.getByRole('button', { name:'Chat' }).click()
await page.getByLabel('小和需求助手').waitFor()
await page.getByRole('button', { name:'关闭' }).click()
await page.getByRole('button', { name:'二维审图' }).click()
const waitingBeforeDecision = await page.getByLabel('等待布局决策').isVisible()
await page.getByRole('button', { name:'Chat' }).click()
await page.getByPlaceholder('描述家庭成员、功能、风格和预算…').fill('继续生成三个布局方案')
await page.getByRole('button', { name:'发送' }).click()
await page.locator('.chat-message.assistant').filter({ hasText:finalQuote.message }).waitFor()
await page.getByRole('button', { name:'关闭' }).click()
await page.getByRole('button', { name:'展开方案' }).click()
await page.locator('.layout-grid').waitFor()
const cards = await page.locator('.layout-card').count()
const levelIds = await page.locator('.layout-card').evaluateAll((nodes) => nodes.map((node) => node.dataset.levelId))
const cardText = (await page.locator('.layout-card').allTextContents()).join(' ')
const blocking = await page.locator('.layout-card[data-blocking-count]:not([data-blocking-count="0"])').count()
const applicable = await page.locator('.layout-card[data-blocking-count="0"]').count()
const method = await page.locator('.layout-method').innerText()
await fs.mkdir('evidence/agen47-complete-layout', { recursive:true })
await page.screenshot({ path:'evidence/agen47-complete-layout/real-product-three-levels.png', fullPage:true })
let blockedApplyDisabled = true
if (blocking) {
  await page.locator('.layout-card[data-blocking-count]:not([data-blocking-count="0"])').first().click()
  blockedApplyDisabled = await page.getByRole('button', { name:'硬错误未通过' }).isDisabled()
}
await page.locator('.layout-card[data-blocking-count="0"]').first().click()
const scriptText = await page.locator('.layout-anchors').innerText()
await page.getByRole('button', { name:'执行自动布局并打开 3D' }).click()
const canvas = page.locator('.model-canvas-wrap canvas')
await canvas.waitFor(); await page.getByTestId('scene-fixture-summary').waitFor(); await page.waitForTimeout(1000)
const entities = await page.locator('[data-testid="scene-fixture-summary"] code').count()
const canvasPixels = await page.evaluate(() => {
  const canvas = document.querySelector('.model-canvas-wrap canvas')
  const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
  if (!canvas || !gl) return { width:0, height:0, nonZero:0 }
  const pixels = new Uint8Array(canvas.width * canvas.height * 4)
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  let nonZero = 0
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 24) nonZero++
  return { width:canvas.width, height:canvas.height, nonZero }
})
await page.screenshot({ path:'evidence/agen47-complete-layout/exact-layout-3d.png', fullPage:true })

const mobile = await browser.newPage({ viewport:{ width:390, height:844 } })
await mobile.route('**/api/**', (route) => {
  const request = route.request(); const path = new URL(request.url()).pathname; let body
  if (path === '/api/health') body = { ok:true, ai_configured:true, chat_configured:true, model:'e2e-model' }
  else if (path === '/api/projects') body = [project]
  else if (path.endsWith('/chat-sessions')) body = [{ ...finalSession, messages:undefined }]
  else if (path.endsWith('/chat-sessions/session-layout')) body = finalSession
  else body = project
  return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(body) })
})
await mobile.goto('http://127.0.0.1:5173', { waitUntil:'networkidle' })
await mobile.getByRole('button', { name:'Chat' }).click(); await mobile.getByLabel('小和需求助手').waitFor(); await mobile.getByRole('button', { name:'关闭' }).click()
await mobile.getByRole('button', { name:'二维审图' }).click(); await mobile.getByRole('button', { name:'展开方案' }).click(); await mobile.locator('.layout-grid').waitFor()
const mobileViewport = await mobile.evaluate(() => ({ scrollWidth:document.documentElement.scrollWidth, viewportWidth:window.innerWidth }))
await mobile.screenshot({ path:'evidence/agen47-complete-layout/mobile-three-levels.png', fullPage:true })
await mobile.close(); await browser.close()

const realCodes = levels.flatMap((level) => level.products.map((product) => product.catalog_code))
const result = { waitingBeforeDecision, cards, levelIds, blocking, applicable, blockedApplyDisabled, entities, realCodes, method, scriptText, canvasPixels, mobileViewport, unexpectedErrors:errors }
if (!waitingBeforeDecision || cards !== 3 || levelIds.join(',') !== 'level1,level2,level3' || applicable < 1 || !blockedApplyDisabled || entities < 5 || !realCodes.every((code) => cardText.includes(code)) || !scriptText.includes('layout-script-v1') || !scriptText.includes('最小净距') || canvasPixels.nonZero === 0 || mobileViewport.scrollWidth > mobileViewport.viewportWidth || errors.length) throw new Error(JSON.stringify(result))
console.log(JSON.stringify(result))
