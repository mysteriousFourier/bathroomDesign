import { chromium } from 'playwright-core'

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
page.on('pageerror', error => errors.push(`pageerror: ${error.stack ?? error.message}`))
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
await page.evaluate(async () => {
  const projects = await fetch('http://127.0.0.1:8000/api/projects').then(response => response.json())
  const project = projects.find(item => item.name === 'QA Verification')
  const spec = project.spec
  spec.fixtures = spec.fixtures.filter(item => !['shower-cold', 'shower-hot'].includes(item.id))
  spec.fixtures.push(
    { id: 'shower-cold', kind: 'water', point_usage: 'shower', label: '花洒冷水', x_mm: 120, z_mm: 2100, width_mm: 40, depth_mm: 40, height_mm: 1100, elevation_mm: 1100, rotation_deg: 0, source: 'measured', confidence: 1, bound_wall_index: 3 },
    { id: 'shower-hot', kind: 'water', point_usage: 'shower', label: '花洒热水', x_mm: 120, z_mm: 1950, width_mm: 40, depth_mm: 40, height_mm: 1100, elevation_mm: 1100, rotation_deg: 0, source: 'measured', confidence: 1, bound_wall_index: 3 },
  )
  await fetch(`http://127.0.0.1:8000/api/projects/${project.id}/spec`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) })
})
await page.reload({ waitUntil: 'networkidle' })
const buttonNames = await page.getByRole('button').allTextContents()
const preview = page.getByRole('button', { name: /三维/ }).first()
await preview.click()
await page.waitForTimeout(2000)
const canvas = page.locator('canvas')
const pixels = await canvas.evaluate(element => {
  const gl = element.getContext('webgl2') || element.getContext('webgl')
  if (!gl) return { unique: 0, error: 'no-webgl' }
  const data = new Uint8Array(element.width * element.height * 4)
  gl.readPixels(0, 0, element.width, element.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
  const colors = new Set()
  for (let index = 0; index < data.length; index += Math.max(4, Math.floor(data.length / 10000 / 4) * 4)) colors.add(`${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`)
  return { width: element.width, height: element.height, unique: colors.size, error: null }
})
await page.getByTitle('给水管网详情').click()
const warning = await page.locator('[data-testid="plumbing-drawer"]').innerText()
if (errors.length || pixels.unique < 8 || !warning.includes('没有热水器出水角阀')) throw new Error(JSON.stringify({ errors, pixels, warning }))
await page.screenshot({ path: '.tmp/agen63-fixed-3d-plumbing.png', fullPage: true })
await page.getByTitle('隐藏给水管').click()
await page.screenshot({ path: '.tmp/agen63-fixed-3d-hidden.png', fullPage: true })
console.log(JSON.stringify({ buttonNames, errors, canvases: await page.locator('canvas').count(), pixels, warning }, null, 2))
await browser.close()
