import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const apiBaseUrl = process.env.OPC_API_BASE_URL ?? 'http://127.0.0.1:8000'
const appUrl = process.env.OPC_APP_URL ?? 'http://127.0.0.1:5173'
const outputDir = path.resolve('reports/screenshots/agen-31-cutaway-upgrade')
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

async function createProject() {
  const createdResponse = await fetch(`${apiBaseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AGEN-31 cutaway upgrade demo' }),
  })
  if (!createdResponse.ok) throw new Error(`create project failed: ${createdResponse.status}`)
  const created = await createdResponse.json()
  const spec = {
    schema_version: '1.0',
    name: 'Cutaway Demo',
    boundary: [
      { x_mm: 0, z_mm: 0 },
      { x_mm: 2600, z_mm: 0 },
      { x_mm: 2600, z_mm: 1900 },
      { x_mm: 0, z_mm: 1900 },
    ],
    height_mm: 2600,
    wall_thickness_mm: 180,
    openings: [
      { id: 'door-1', kind: 'door', label: '入户门', wall_index: 0, offset_mm: 840, width_mm: 820, height_mm: 2100, sill_mm: 0, source: 'user', confidence: 1 },
      { id: 'window-1', kind: 'window', label: '高窗', wall_index: 2, offset_mm: 780, width_mm: 900, height_mm: 700, sill_mm: 1500, source: 'user', confidence: 1 },
    ],
    fixtures: [
      { id: 'toilet-1', kind: 'toilet', label: '坐便器', x_mm: 590, z_mm: 1330, width_mm: 380, depth_mm: 700, height_mm: 760, rotation_deg: 180, source: 'user', confidence: 1 },
      { id: 'vanity-1', kind: 'vanity', label: '浴室柜', x_mm: 2020, z_mm: 470, width_mm: 760, depth_mm: 500, height_mm: 850, rotation_deg: 0, source: 'user', confidence: 1 },
      { id: 'shower-1', kind: 'shower', label: '淋浴区', x_mm: 1980, z_mm: 1360, width_mm: 820, depth_mm: 820, height_mm: 2000, rotation_deg: 0, source: 'user', confidence: 1 },
    ],
    observations: [
      { field: 'boundary', value: '2600 x 1900 mm', source: 'user', confidence: 1, confirmed: true },
      { field: 'height_mm', value: '2600', source: 'user', confidence: 1, confirmed: true },
    ],
    issues: [],
    confirmed: true,
  }
  const saved = await fetch(`${apiBaseUrl}/api/projects/${created.id}/spec`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  })
  if (!saved.ok) throw new Error(`save spec failed: ${saved.status}`)
  return created.id
}

async function canvasPixelSummary(page) {
  const canvas = page.locator('canvas')
  await canvas.waitFor({ state: 'visible' })
  await page.waitForTimeout(900)
  return canvas.evaluate((element) => {
    const target = element
    const gl = target.getContext('webgl2') || target.getContext('webgl')
    if (!gl) return { width: target.width, height: target.height, unique: 0, error: 'no-webgl' }
    const data = new Uint8Array(target.width * target.height * 4)
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    const colors = new Set()
    const stride = Math.max(4, Math.floor(data.length / 12000 / 4) * 4)
    for (let index = 0; index < data.length; index += stride) {
      colors.add(`${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`)
      if (colors.size > 36) break
    }
    return { width: target.width, height: target.height, unique: colors.size, error: null }
  })
}

const projectId = await createProject()
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(appUrl, { waitUntil: 'networkidle' })
  await page.locator('.project-heading strong').waitFor()
  await page.getByRole('button', { name: '三维预览' }).click()
  const fullPixels = await canvasPixelSummary(page)
  if (fullPixels.error || fullPixels.unique < 8) throw new Error(`full-wall canvas is blank: ${JSON.stringify(fullPixels)}`)
  await page.screenshot({ path: path.join(outputDir, '01-full-walls.png'), fullPage: true })

  await page.getByTitle('开启剖切视图').click()
  await page.locator('.cutaway-status.active').waitFor()
  await page.waitForFunction(() => document.querySelector('.cutaway-status.active')?.textContent?.includes('W'))
  const firstStatus = await page.locator('.cutaway-status.active').textContent()
  await page.screenshot({ path: path.join(outputDir, '02-cutaway-camera-side.png'), fullPage: true })

  const canvasBox = await page.locator('canvas').boundingBox()
  if (!canvasBox) throw new Error('3D canvas has no bounding box')
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.58, canvasBox.y + canvasBox.height * 0.52)
  await page.mouse.down()
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.28, canvasBox.y + canvasBox.height * 0.48, { steps: 16 })
  await page.mouse.up()
  await page.waitForTimeout(900)
  const rotatedStatus = await page.locator('.cutaway-status.active').textContent()
  const rotatedPixels = await canvasPixelSummary(page)
  if (rotatedPixels.error || rotatedPixels.unique < 8) throw new Error(`rotated cutaway canvas is blank: ${JSON.stringify(rotatedPixels)}`)
  await page.screenshot({ path: path.join(outputDir, '03-cutaway-after-rotate.png'), fullPage: true })

  if (errors.length) throw new Error(`browser console errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({ screenshots: outputDir, firstStatus, rotatedStatus, fullPixels, rotatedPixels }))
} finally {
  await browser.close()
  await fetch(`${apiBaseUrl}/api/projects/${projectId}`, { method: 'DELETE' })
}
