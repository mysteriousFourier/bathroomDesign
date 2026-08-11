import { chromium, firefox } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const room = { schema_version: '1.0', name: '板块排布可视验收房间', boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 4800, z_mm: 0 }, { x_mm: 4800, z_mm: 3600 }, { x_mm: 0, z_mm: 3600 }], height_mm: 3200, wall_thickness_mm: 100, openings: [], fixtures: [], observations: [], issues: [], confirmed: true }
const project = { id: 'surface-demo', name: '墙板地砖自动填充验收', status: 'confirmed', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z', spec: room, measurement: null, assets: [] }
const response = {
  message: '需求已齐，按清爽素雅风格和舒适预算生成材料清单，墙板与地砖已可应用到三维房间。',
  requirements: { collected: { 使用人群: ['成人'], 功能需求: ['淋浴'], 喜好风格: ['素雅'], 预期价格区间: '2万元' }, missing_fields: [], complete: true },
  style_match: { user_terms: ['清爽'], catalog_style: '素雅', confidence: 1, status: 'mapped', candidates: [], resolver_version: 'test' },
  surfaces: { source: '量房', floor_area_sqm: 4.8, ceiling_area_sqm: 4.8, wall_gross_area_sqm: 22.88, opening_area_sqm: 0, wall_net_area_sqm: 22.88, waste_rate: .1, floor_purchase_sqm: 5.28, ceiling_purchase_sqm: 5.28, wall_purchase_sqm: 25.17, floor_layout: '', ceiling_layout: '', wall_layout: '', warnings: [] },
  material_quotes: [
    { product_id: 'wall', 材料编号: 'QB2-SY', 材料名称: '墙板', 单价: 168, 单位: '㎡', 来源: '产品清单', 采购量: 25.17, 材料小计: 4228.56 },
    { product_id: 'floor', 材料编号: 'DB3-SY', 材料名称: '地砖', 单价: 128, 单位: '㎡', 来源: '产品清单', 采购量: 5.28, 材料小计: 675.84 },
  ],
  furniture_candidates: [], furniture_quotes: [], selected_furniture: [], material_total: 4904.4,
  furniture_price_range: { min: 0, max: 0 }, total_price_range: { min: 4904.4, max: 4904.4 }, furniture_total: null, quote_total: null,
  pricing_status: 'range_until_auto_layout_selection', equipment: {}, products: [],
}

mkdirSync('reports/screenshots', { recursive: true })
const executablePath = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE ?? '/usr/bin/firefox'
const browserType = executablePath.includes('firefox') ? firefox : chromium
const browser = await browserType.launch({ executablePath, headless: true, args: browserType === chromium ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.route('**/api/health', route => route.fulfill({ json: { ok: true, ai_configured: true, chat_configured: true, model: 'test', chat_model: 'test' } }))
await page.route('**/api/projects', route => route.fulfill({ json: [project] }))
await page.route('**/api/design-chat', route => route.fulfill({ json: response }))
await page.goto(process.env.CAPTURE_UI_BASE_URL ?? 'http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: 'Chat' }).click()
await page.getByPlaceholder('描述家庭成员、功能、风格和预算…').fill('成人使用，要淋浴，喜欢清爽素雅，两万元以内。')
await page.screenshot({ path: 'reports/screenshots/agen-45-step-1-demand-input.png', fullPage: true })
await page.getByRole('button', { name: '发送' }).click()
await page.getByText('需求采集：已完整，待确认提交').waitFor()
await page.getByText(/需求方案材质已自动填充/).waitFor()
await page.screenshot({ path: 'reports/screenshots/agen-45-step-2-auto-filled.png', fullPage: true })
await page.locator('.design-chat header').getByRole('button', { name: '关闭' }).click()
await page.getByRole('button', { name: /三维预览/ }).click({ force: true })
await page.locator('canvas').waitFor()
await page.getByRole('button', { name: '关闭板缝加粗' }).waitFor()
if (await page.getByText(/板缝已加粗/).count() !== 1) throw new Error('板缝加粗状态未显示')
await page.waitForTimeout(1500)
await page.screenshot({ path: 'reports/screenshots/agen-45-step-3-textured-room.png', fullPage: true })
const textureRequests = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /surfaces\/(QB2-SY|DB3-SY)\/texture\.jpg/.test(name)))
await browser.close()
if (textureRequests.length !== 2) throw new Error(`期望加载 2 个需求材质纹理，实际为 ${JSON.stringify(textureRequests)}`)
console.log(JSON.stringify({ screenshots: ['agen-45-step-1-demand-input.png', 'agen-45-step-2-auto-filled.png', 'agen-45-step-3-textured-room.png'], textureRequests }, null, 2))
