import fs from 'node:fs/promises'
import { chromium, firefox } from 'playwright-core'

const raw = JSON.parse(await fs.readFile('evidence/measurement.json', 'utf8'))
const boundary = raw.boundary.map((point) => ({ x_mm: point.x, z_mm: point.y }))
const fixtures = raw.measurementPoints.map((point) => ({ id: point.pointId, kind: point.kind, label: point.label, x_mm: point.position.x, z_mm: point.position.y, width_mm: point.width, depth_mm: point.depth, height_mm: point.height, rotation_deg: point.rotation, point_usage: point.pointUsage, source: 'measured', confidence: 1 }))
const spec = { schema_version: '1.0', name: '真实量房自动布局验证', boundary, height_mm: raw.heights.roomHeight, wall_thickness_mm: 200, openings: [{ id: raw.openings[0].openingId, kind: 'door', wall_index: 1, offset_mm: 400, width_mm: 800, height_mm: 2055, sill_mm: 0, label: 'D1', source: 'measured', confidence: 1 }], fixtures, observations: [], issues: [], confirmed: true }
const project = { id: 'agen49-quote', name: '报价抽屉验证', status: 'ready', created_at: '2026-08-12T00:00:00Z', updated_at: '2026-08-12T00:00:00Z', spec, measurement: null, assets: [] }
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/firefox'
const browserType = browserPath.includes('firefox') ? firefox : chromium
const browser = await browserType.launch({ headless: true, executablePath: browserPath, args: browserType === chromium ? ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader'] : [] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
const errors = []
page.on('pageerror', (error) => { if (!/Could not load \/model-library/.test(error.message)) errors.push(error.message) })
await page.route('**/api/**', (route) => {
  const url = route.request().url()
  const body = url.endsWith('/api/health') ? { ok: true, ai_configured: false, model: null } : url.endsWith('/api/projects') ? [project] : project
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
})
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '二维审图' }).click()
await page.getByRole('button', { name: '展开方案' }).click()
await page.getByRole('button', { name: /适老安全 · 左右分区型/ }).click()
await page.getByRole('button', { name: '执行自动布局并打开 3D' }).click()
const drawer = page.getByTestId('scene-fixture-summary')
await drawer.waitFor()
await page.waitForTimeout(800)
const openBox = await drawer.boundingBox()
const workspaceBox = await page.locator('.workspace').boundingBox()
const openText = await drawer.innerText()
if (!openText.includes('level2') || !openText.includes('总价') || !openText.includes('元')) throw new Error(`报价字段不完整：${openText}`)
if (/\.(fbx|glb|gltf|obj|3ds)\b/i.test(openText)) throw new Error(`报价抽屉泄漏模型文件名：${openText}`)
await fs.mkdir('evidence/agen49-quote-drawer', { recursive: true })
await page.screenshot({ path: 'evidence/agen49-quote-drawer/quote-drawer-open.png', fullPage: true })
await page.getByRole('button', { name: '收起报价' }).click()
await page.waitForTimeout(900)
const shellBox = await page.locator('.quote-drawer-shell').boundingBox()
const toggleBox = await page.getByRole('button', { name: '展开报价' }).boundingBox()
await page.screenshot({ path: 'evidence/agen49-quote-drawer/quote-drawer-collapsed.png', fullPage: true })
if (!openBox || !workspaceBox || !shellBox || !toggleBox || Math.abs(openBox.x + openBox.width - workspaceBox.x - workspaceBox.width) > 2 || Math.abs(toggleBox.x + toggleBox.width - workspaceBox.x - workspaceBox.width) > 20) throw new Error(`抽屉位置错误：${JSON.stringify({ openBox, workspaceBox, shellBox, toggleBox })}`)
if (errors.length) throw new Error(errors.join(' | '))
const lineCount = await drawer.locator('.quote-line').count()
await browser.close()
console.log(JSON.stringify({ openBox, collapsedToggleBox: toggleBox, lineCount, modelFilenameHidden: true }))
