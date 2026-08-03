import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const apiBaseUrl = process.env.OPC_API_BASE_URL ?? 'http://127.0.0.1:8000'
const appUrl = process.env.OPC_APP_URL ?? 'http://127.0.0.1:5174'
const outputDir = path.resolve('reports/screenshots/agen-31-model-asset-full-flow')
const modelPath = path.resolve('public/assets/models/toilet-fbx-test-glb/model.glb')
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
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
])

async function api(url, init) {
  const response = await fetch(`${apiBaseUrl}${url}`, init)
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${body?.detail ?? response.statusText}`)
  return body
}

const project = await api('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'AGEN-31 模型资产全流程' }),
})
const spec = {
  schema_version: '1.0',
  name: 'AGEN-31 模型资产全流程',
  boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 2200, z_mm: 0 }, { x_mm: 2200, z_mm: 2600 }, { x_mm: 0, z_mm: 2600 }],
  height_mm: 2600,
  wall_thickness_mm: 100,
  openings: [],
  fixtures: [],
  observations: [],
  issues: [],
  confirmed: true,
}
await api(`/api/projects/${project.id}/spec`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) })

const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(appUrl, { waitUntil: 'networkidle' })
  await page.locator('.project-switcher select').selectOption(project.id)
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '模型库' }).first().click()
  await page.locator('.model-library').waitFor({ state: 'visible' })
  await page.locator('.model-import-zone input[type=file]').first().setInputFiles(modelPath)
  await page.locator('.model-origin.uploaded').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('.model-asset-row').filter({ has: page.locator('.model-origin.uploaded') }).first().click()
  await page.locator('.model-preview-stage canvas').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(1800)
  await page.screenshot({ path: path.join(outputDir, '01-uploaded-model-browser.png'), fullPage: true })
  await page.getByRole('button', { name: '加入房间' }).click()
  await page.getByRole('button', { name: '三维预览' }).click()
  await page.locator('.model-canvas-wrap canvas').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(outputDir, '02-added-to-room-3d.png'), fullPage: true })
  if (errors.length) throw new Error(`browser console errors: ${errors.join(' | ')}`)

  await page.getByRole('button', { name: /^保存$/ }).click()
  await page.getByText('项目已保存').waitFor({ state: 'visible', timeout: 10000 })
  const saved = await api(`/api/projects/${project.id}`)
  const imported = saved.spec.fixtures.find((fixture) => fixture.model_asset?.src.includes('/model-assets/'))
  if (!imported) throw new Error('保存后的房间未包含项目上传模型资产')
  if (!imported.model_asset?.src.includes('/model-assets/')) throw new Error('加入房间后的构件未绑定项目上传模型资产')
  await page.screenshot({ path: path.join(outputDir, '03-saved-room-with-asset.png'), fullPage: true })
  console.log(`Model asset full-flow verification passed. Screenshots: ${outputDir}`)
} finally {
  await browser.close()
  await fetch(`${apiBaseUrl}/api/projects/${project.id}`, { method: 'DELETE' })
}
