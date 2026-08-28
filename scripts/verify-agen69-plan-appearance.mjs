import fs from 'node:fs/promises'
import { chromium } from 'playwright-core'

const outputDir = 'evidence/agen69-plan-appearance'
await fs.mkdir(outputDir, { recursive: true })

const spec = {
  schema_version: '1.0', name: '二维材质与家具俯视验证',
  boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 3200, z_mm: 0 }, { x_mm: 3200, z_mm: 2400 }, { x_mm: 0, z_mm: 2400 }],
  height_mm: 2600, wall_thickness_mm: 200,
  openings: [{ id: 'door-1', kind: 'door', wall_index: 3, offset_mm: 1200, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'measured', confidence: 1 }],
  fixtures: [
    { id: 'toilet-drain', kind: 'drain', point_usage: 'toilet', label: '马桶排水', x_mm: 700, z_mm: 450, width_mm: 110, depth_mm: 110, height_mm: 20, rotation_deg: 0, source: 'measured', confidence: 1 },
    { id: 'basin-water', kind: 'water', point_usage: 'basin', label: '台盆给水', x_mm: 2600, z_mm: 250, width_mm: 60, depth_mm: 60, height_mm: 600, rotation_deg: 0, source: 'measured', confidence: 1 },
    { id: 'shower-drain', kind: 'floor_drain', point_usage: 'shower', label: '淋浴地漏', x_mm: 2500, z_mm: 1850, width_mm: 100, depth_mm: 100, height_mm: 20, rotation_deg: 0, source: 'measured', confidence: 1 },
  ],
  observations: [], issues: [], confirmed: true,
}
const project = { id: 'agen69-live-plan', name: 'AGEN-69 二维美化验收', status: 'ready', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), spec, measurement: null, assets: [] }

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(60000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
const readAlignment = () => page.evaluate(() => {
  const svg = document.querySelector('.plan-canvas')
  const layer = document.querySelector('.fixture-model-top')
  const canvas = document.querySelector('.fixture-model-top canvas')
  const fixture = document.querySelector('.fixture-shape.selected')
  const hit = fixture?.querySelector('.fixture-model-hit')
  const box = (element) => element ? (({ x, y, width, height }) => ({ x, y, width, height }))(element.getBoundingClientRect()) : null
  const matrix = fixture?.getScreenCTM()
  return {
    svg: box(svg), layer: box(layer), canvas: box(canvas), fixture: box(fixture), hit: box(hit),
    canvasSize: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null,
    fixtureTransform: fixture?.getAttribute('transform'),
    fixtureMatrix: matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null,
    layerStyle: layer ? { width: getComputedStyle(layer).width, height: getComputedStyle(layer).height } : null,
  }
})
const assertLayerAlignment = (alignment, state) => {
  if (!alignment.layer || !alignment.canvas) throw new Error(`${state}：家具模型顶视层未加载`)
  const deltas = ['x', 'y', 'width', 'height'].map((key) => Math.abs(alignment.layer[key] - alignment.canvas[key]))
  if (Math.max(...deltas) > 1.5) throw new Error(`${state}：家具模型顶视层偏移 ${JSON.stringify({ deltas, alignment })}`)
}
await page.route('**/api/**', async (route) => {
  const url = route.request().url()
  const pathname = new URL(url).pathname
  if (pathname === '/api/health') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ai_configured: false }) })
  if (pathname === '/api/model-assets' || pathname.endsWith('/model-assets')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  if (pathname === '/api/projects') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([project]) })
  if (url.includes('/auto-layout')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(project) })
})

await page.goto(process.env.OPC_APP_URL ?? 'http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
console.log('loaded application')
const planReviewButton = page.getByRole('button', { name: '二维审图' })
await planReviewButton.waitFor()
await planReviewButton.click()
await page.locator('.plan-canvas').waitFor()
console.log('opened plan review')
await page.screenshot({ path: `${outputDir}/01-before-layout.png`, fullPage: true })

await page.getByRole('button', { name: '开始自动布局' }).click()
console.log('started auto layout')
await page.locator('.room-polygon.textured-floor').waitFor({ timeout: 15000 }).catch(async (error) => {
  console.log(JSON.stringify({ body: (await page.locator('body').innerText()).slice(0, 1600), errors }))
  throw error
})
await page.locator('.fixture-model-top canvas').first().waitFor({ state: 'visible', timeout: 15000 })
await page.waitForTimeout(1200)
await page.screenshot({ path: `${outputDir}/02-live-model-top-and-white-wet-zone.png`, fullPage: true })

const vanity = page.locator('[data-top-appearance="vanity"]').first()
const vanityBox = await vanity.boundingBox()
if (!vanityBox) throw new Error('自动布局未生成可拖拽的浴室柜')
await page.mouse.move(vanityBox.x + vanityBox.width / 2, vanityBox.y + vanityBox.height / 2)
await page.mouse.down()
await page.mouse.move(vanityBox.x + vanityBox.width / 2 + 45, vanityBox.y + vanityBox.height / 2 + 25, { steps: 6 })
await page.mouse.up()
await page.locator('.room-polygon.textured-floor').waitFor()
await page.screenshot({ path: `${outputDir}/03-dragged-model-top-live.png`, fullPage: true })

const alignment = await readAlignment()
assertLayerAlignment(alignment, '默认比例')
await page.getByTitle('放大').click()
await page.waitForTimeout(350)
const zoomAlignment = await readAlignment()
assertLayerAlignment(zoomAlignment, '放大后')
await page.screenshot({ path: `${outputDir}/03b-zoomed-model-top-aligned.png`, fullPage: true })
await page.getByTitle('适配视图').click()
await page.waitForTimeout(250)
console.log(JSON.stringify({ alignment, zoomAlignment }, null, 2))

const result = await page.evaluate(() => ({
  texture: document.querySelector('.room-polygon.textured-floor')?.getAttribute('data-floor-texture'),
  appearances: [...document.querySelectorAll('[data-top-appearance]')].map((node) => node.getAttribute('data-top-appearance')),
  images: document.querySelectorAll('pattern image').length,
  modelTopCanvases: document.querySelectorAll('.fixture-model-top canvas').length,
  utilityPoints: document.querySelectorAll('[data-top-appearance="utility-point"]').length,
}))

await page.getByRole('button', { name: '隐藏家具模型' }).click()
if (await page.locator('.fixture-model-top canvas').count()) throw new Error('二维家具隐藏开关未生效')
if (await page.locator('[data-top-appearance="utility-point"]').count() < 1) throw new Error('隐藏家具后点位不应消失')
await page.screenshot({ path: `${outputDir}/04-ceiling-view-points-with-furniture-hidden.png`, fullPage: true })
await page.getByRole('button', { name: '显示家具模型' }).click()

await page.getByRole('button', { name: '三维预览' }).click()
await page.locator('.model-canvas-wrap canvas').waitFor({ state: 'visible', timeout: 15000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${outputDir}/05-white-wet-zone-3d.png`, fullPage: true })
await page.getByRole('button', { name: '隐藏家具' }).click()
await page.screenshot({ path: `${outputDir}/06-ceiling-furniture-hidden-3d.png`, fullPage: true })

await browser.close()

const unexpectedErrors = errors.filter((message) => !/Could not load .*model-library\/models|Could not load \/api\/model-assets|The above error occurred in the <(?:Fbx|Gltf)FixtureAsset>/.test(message))
if (!result.texture || result.images !== 1 || result.modelTopCanvases !== 1 || result.utilityPoints < 1 || !result.appearances.includes('toilet') || !result.appearances.includes('vanity') || !result.appearances.includes('furniture') || unexpectedErrors.length) {
  throw new Error(JSON.stringify({ result, errors: unexpectedErrors }))
}
console.log(JSON.stringify({ outputDir, ...result, errors: unexpectedErrors }, null, 2))
