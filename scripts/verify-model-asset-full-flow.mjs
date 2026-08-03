import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const apiBaseUrl = process.env.OPC_API_BASE_URL ?? 'http://127.0.0.1:8000'
const appUrl = process.env.OPC_APP_URL ?? 'http://127.0.0.1:5174'
const outputDir = path.resolve('reports/screenshots/agen-31-model-asset-full-flow')
await fs.mkdir(outputDir, { recursive: true })

async function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next known browser location.
    }
  }
  return undefined
}

const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || await firstExisting([
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
])

async function api(url, init) {
  const response = await fetch(`${apiBaseUrl}${url}`, init)
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${body?.detail ?? response.statusText}`)
  return body
}

async function createProject() {
  const project = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AGEN-31 模型资产全流程' }),
  })
  const spec = {
    schema_version: '1.0',
    name: 'AGEN-31 模型资产全流程',
    boundary: [
      { x_mm: 0, z_mm: 0 },
      { x_mm: 2200, z_mm: 0 },
      { x_mm: 2200, z_mm: 2600 },
      { x_mm: 0, z_mm: 2600 },
    ],
    height_mm: 2600,
    wall_thickness_mm: 100,
    openings: [{ id: 'door-main', kind: 'door', wall_index: 0, offset_mm: 650, width_mm: 760, height_mm: 2100, sill_mm: 0, label: '门洞', source: 'measured', confidence: 1, evidence_ids: ['manual:door'] }],
    fixtures: [
      { id: 'floor-drain-main', kind: 'floor_drain', label: '地漏', x_mm: 1700, z_mm: 1900, width_mm: 110, depth_mm: 110, height_mm: 20, rotation_deg: 0, source: 'measured', confidence: 1 },
      { id: 'vanity-main', kind: 'vanity', label: '浴室柜', x_mm: 560, z_mm: 450, width_mm: 700, depth_mm: 500, height_mm: 850, rotation_deg: 0, source: 'measured', confidence: 1 },
    ],
    observations: [{ field: 'manual:boundary', value: '2200 x 2600', source: 'measured', asset_id: null, bbox: null, confidence: 1, confirmed: true, alternatives: [], note: '手工验证房间' }],
    issues: [],
    confirmed: true,
  }
  return api(`/api/projects/${project.id}/spec`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  })
}

function screenshotPath(name) {
  return path.join(outputDir, name)
}

async function assertCanvasRendered(page) {
  const canvas = page.locator('canvas').first()
  await canvas.waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(1500)
  const sample = await canvas.evaluate((node) => {
    const context = node.getContext('webgl2') || node.getContext('webgl')
    if (!context) return null
    const width = node.width
    const height = node.height
    const pixels = new Uint8Array(4 * 25)
    let offset = 0
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        context.readPixels(Math.floor(width * (x + 1) / 6), Math.floor(height * (y + 1) / 6), 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixels, offset)
        offset += 4
      }
    }
    return Array.from(pixels)
  })
  if (!sample || new Set(sample).size <= 2) throw new Error('三维画布像素检查失败，画面疑似空白')
}

const project = await createProject()
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })

await page.goto(appUrl, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /模型库/ }).first().click()
await page.locator('.model-library').waitFor({ state: 'visible' })
await page.screenshot({ path: screenshotPath('01-import-sources.png'), fullPage: true })

await page.locator('.library-flow').getByRole('button', { name: /转换/ }).click()
await page.screenshot({ path: screenshotPath('02-converted-glb-assets.png'), fullPage: true })

await page.locator('.library-flow').getByRole('button', { name: /去重/ }).click()
await page.screenshot({ path: screenshotPath('03-dedupe-result.png'), fullPage: true })

await page.locator('.library-card').first().getByRole('button', { name: /加入房间/ }).click()
await assertCanvasRendered(page)
await page.screenshot({ path: screenshotPath('04-added-to-room-3d.png'), fullPage: true })

await page.getByRole('button', { name: /^保存$/ }).click()
await page.getByText('项目已保存').waitFor({ state: 'visible', timeout: 10000 })
await page.screenshot({ path: screenshotPath('05-saved-room-with-asset.png'), fullPage: true })

const saved = await api(`/api/projects/${project.id}`)
const toilet = saved.spec.fixtures.find((fixture) => fixture.model_asset?.id === 'toilet-fbx-test-glb')
if (!toilet) throw new Error('保存后的房间未包含 toilet-fbx-test-glb 模型资产')
if (toilet.kind !== 'toilet') throw new Error(`模型资产加入房间后类型错误：${toilet.kind}`)

await browser.close()
console.log(`Model asset full-flow verification passed. Screenshots: ${outputDir}`)
