import fs from 'node:fs/promises'
import { chromium } from 'playwright-core'

const outputDir = 'evidence/model-binding-flow'
await fs.mkdir(outputDir, { recursive: true })

const spec = {
  schema_version: '1.0', name: '模型绑定验收',
  boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 3200, z_mm: 0 }, { x_mm: 3200, z_mm: 2400 }, { x_mm: 0, z_mm: 2400 }],
  height_mm: 2600, wall_thickness_mm: 200, openings: [], fixtures: [], observations: [], issues: [], confirmed: true,
}
const project = { id: 'binding-flow-project', name: '模型绑定验收', status: 'ready', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), spec, measurement: null, assets: [] }
let asset = {
  id: '0123456789abcdef0123456789abcdef', project_id: project.id, label: '智能坐便器模型', filename: '智能坐便器模型.gltf', format: 'gltf', bytes: 12000,
  sha256: 'a'.repeat(64), file_count: 1, created_at: new Date().toISOString(), src: '/model-library/surfaces/QB3-ZG/panel.gltf',
  orientation_view: null, orientation_mapping: null, orientation_corrected: false, orientation_source: null, correction_tag: 'standard',
  library_scope: 'shared', deduplicated: false, category: '马桶', dimensions_mm: { width: 380, depth: 680, height: 760 },
  catalog_codes: [], product_ids: [], binding_status: 'unbound', binding_note: '文件名提示可能属于“马桶”', product_attributes: null,
}
const options = {
  categories: ['墙板', '马桶', '浴室柜'],
  products: [
    { id: 'wall', code: 'QB1-SY', category: '墙板', model: '冰雪白 600x3000x10', price: '80', unit: '平米', attributes: { 材料编号: 'QB1-SY', 材料名称: '墙板', 规格型号: '冰雪白 600x3000x10', 单价: '80', 数量单位: '平米' } },
    { id: 'toilet', code: 'MT3', category: '马桶', model: '智能马桶（加热、感应冲水、臀洗、杀菌）', price: '1200', unit: '套', attributes: { 材料编号: 'MT3', 材料名称: '马桶', 规格型号: '智能马桶（加热、感应冲水、臀洗、杀菌）', 单价: '1200', 数量单位: '套' } },
    { id: 'vanity', code: 'YSG2-1', category: '浴室柜', model: '实木 银灰色', price: '2500', unit: '套', attributes: { 材料编号: 'YSG2-1', 材料名称: '浴室柜', 规格型号: '实木 银灰色', 单价: '2500', 数量单位: '套' } },
  ],
}
const bindingRequests = []

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(60000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const pathname = new URL(request.url()).pathname
  if (pathname === '/api/health') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ai_configured: false }) })
  if (pathname === '/api/projects') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([project]) })
  if (pathname === `/api/projects/${project.id}/model-assets` && request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([asset]) })
  if (pathname === '/api/knowledge/product-options') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(options) })
  if (pathname.endsWith(`/model-assets/${asset.id}/binding`) && request.method() === 'PUT') {
    const payload = request.postDataJSON()
    bindingRequests.push(payload)
    const attributes = payload.new_product
      ? { ...payload.new_product, 材料编号: payload.catalog_code }
      : options.products.find((product) => product.code === payload.catalog_code)?.attributes
    const id = `product-${payload.catalog_code}`
    if (payload.new_product) {
      const next = { id, code: payload.catalog_code, category: attributes.材料名称, model: attributes.规格型号, price: attributes.单价, unit: attributes.数量单位, attributes }
      if (!options.categories.includes(next.category)) options.categories.push(next.category)
      options.products.push(next)
    }
    asset = { ...asset, label: `${attributes.物品名称 ?? attributes.材料名称} ${payload.catalog_code}`, category: attributes.材料名称, catalog_codes: [payload.catalog_code], product_ids: [id], binding_status: 'bound', binding_note: '人工按目录 SKU 确认绑定', product_attributes: attributes }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(asset) })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(project) })
})

await page.goto(process.env.OPC_APP_URL ?? 'http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
await page.locator('.view-tabs').getByRole('button', { name: '模型库' }).click()
await page.locator('.model-binding-panel').waitFor()
await page.getByLabel('产品种类').selectOption('马桶')
await page.getByLabel('产品具体型号').selectOption('MT3')
await page.getByRole('button', { name: '绑定模型' }).click()
await page.locator('.binding-status.bound').waitFor()
await page.getByRole('button', { name: '知识图谱中没有对应项' }).click()
await page.getByLabel('新产品种类').fill('镜柜')
await page.getByLabel('新产品 SKU').fill('JG-NEW')
await page.getByLabel('新产品型号名称').fill('智能镜柜 800mm 雾灰色')
await page.getByLabel('新产品参考单价').fill('1680')
await page.getByLabel('新产品单位').selectOption('件')
await page.getByRole('button', { name: '新建并绑定' }).click()
await page.getByText('已绑定 镜柜 · JG-NEW').waitFor()
await page.screenshot({ path: `${outputDir}/01-category-model-and-create-flow.png`, fullPage: true })

if (bindingRequests.length !== 2 || bindingRequests[0].catalog_code !== 'MT3' || bindingRequests[0].new_product !== undefined || bindingRequests[1].catalog_code !== 'JG-NEW' || bindingRequests[1].new_product?.['材料名称'] !== '镜柜') {
  throw new Error(JSON.stringify({ bindingRequests }))
}
const unexpectedErrors = errors.filter((message) => !/THREE\.WebGLRenderer|Could not load/.test(message))
if (unexpectedErrors.length) throw new Error(JSON.stringify({ errors: unexpectedErrors }))
await browser.close()
console.log(JSON.stringify({ outputDir, bindingRequests, finalCategories: options.categories }, null, 2))
