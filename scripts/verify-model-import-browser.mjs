import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const apiBaseUrl = process.env.OPC_API_BASE_URL ?? 'http://127.0.0.1:8000'
const appUrl = process.env.OPC_APP_URL ?? 'http://127.0.0.1:5173'
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const modelPath = path.resolve('public/assets/models/toilet-fbx-test-glb/model.glb')

async function api(url, init) {
  const response = await fetch(`${apiBaseUrl}${url}`, init)
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${body?.detail ?? ''}`)
  return body
}

const project = await api('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '模型导入浏览器验收' }),
})
const spec = {
  schema_version: '1.0',
  name: '模型导入浏览器验收',
  boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 2200, z_mm: 0 }, { x_mm: 2200, z_mm: 1800 }, { x_mm: 0, z_mm: 1800 }],
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const errors = []
  const network = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => { if (response.url().includes('/api/')) network.push(`${response.status()} ${response.url()}`) })
  await page.goto(appUrl, { waitUntil: 'networkidle' })
  await page.locator('.project-switcher select').selectOption(project.id)
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '模型库' }).first().click()
  await page.locator('.model-import-zone').waitFor({ state: 'visible' })
  await page.locator('.model-import-zone input[type=file]').first().setInputFiles(modelPath)
  try {
    await page.locator('.model-origin.uploaded').first().waitFor({ state: 'visible', timeout: 30000 })
  } catch (error) {
    await page.screenshot({ path: path.resolve('.tmp/model-import-browser-failure.png'), fullPage: true })
    console.log(JSON.stringify({ body: (await page.locator('body').innerText()).slice(-4000), network, errors }))
    throw error
  }
  const uploadedRow = page.locator('.model-asset-row').filter({ has: page.locator('.model-origin.uploaded') }).first()
  await uploadedRow.click()
  await page.locator('.model-preview-stage canvas').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(2400)
  const pixels = await page.locator('.model-preview-stage canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return { unique: 0, error: 'no-webgl' }
    const width = canvas.width
    const height = canvas.height
    const data = new Uint8Array(4)
    const colors = new Set()
    for (let y = 0.2; y < 0.85; y += 0.1) {
      for (let x = 0.2; x < 0.85; x += 0.1) {
        gl.readPixels(Math.floor(width * x), Math.floor(height * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data)
        colors.add(`${data[0]},${data[1]},${data[2]}`)
      }
    }
    return { unique: colors.size, error: null }
  })
  if (pixels.error || pixels.unique < 4) {
    await page.screenshot({ path: path.resolve('.tmp/model-import-preview-failure.png'), fullPage: true })
    const previewError = await page.locator('.model-preview-error').allTextContents()
    throw new Error(`uploaded model preview is blank: ${JSON.stringify({ pixels, previewError })}`)
  }
  await page.getByRole('button', { name: '加入房间' }).click()
  await page.getByRole('button', { name: '三维预览' }).click()
  await page.locator('.model-canvas-wrap canvas').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(1200)
  const roomPixels = await page.locator('.model-canvas-wrap canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return 0
    const data = new Uint8Array(4 * 64)
    gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return new Set(Array.from({ length: 64 }, (_, i) => `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}`)).size
  })
  if (roomPixels < 2) throw new Error(`room preview is blank: ${roomPixels}`)
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({ uploadedAsset: true, previewPixels: pixels.unique, roomPixels }))
} finally {
  await browser.close()
  await fetch(`${apiBaseUrl}/api/projects/${project.id}`, { method: 'DELETE' })
}
