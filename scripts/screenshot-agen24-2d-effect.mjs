import { chromium } from 'playwright-core'

const appUrl = process.env.OPC_APP_URL ?? 'http://127.0.0.1:5173'
const apiBaseUrl = process.env.OPC_API_BASE_URL ?? 'http://127.0.0.1:8000'
const annotationScreenshotPath = 'reports/screenshots/agen-24-corrected-photo-annotation.png'
const reviewScreenshotPath = 'reports/screenshots/agen-24-corrected-2d-wall-effect.png'

const correctedBoundary = [
  { x_mm: 0, z_mm: 320 },
  { x_mm: 260, z_mm: 320 },
  { x_mm: 260, z_mm: 0 },
  { x_mm: 1900, z_mm: 0 },
  { x_mm: 1900, z_mm: 610 },
  { x_mm: 2515, z_mm: 610 },
  { x_mm: 2515, z_mm: 0 },
  { x_mm: 4105, z_mm: 0 },
  { x_mm: 4105, z_mm: 2160 },
  { x_mm: 0, z_mm: 2160 },
]

const correctedImageBoundary = [
  { x: 154, y: 384, role: 'wall_corner', confidence: 1 },
  { x: 217, y: 384, role: 'structure_return', confidence: 1 },
  { x: 217, y: 342, role: 'structure_return', confidence: 1 },
  { x: 359, y: 342, role: 'wall_corner', confidence: 1 },
  { x: 359, y: 430, role: 'structure_return', confidence: 1 },
  { x: 415, y: 430, role: 'structure_return', confidence: 1 },
  { x: 415, y: 342, role: 'structure_return', confidence: 1 },
  { x: 608, y: 342, role: 'wall_corner', confidence: 1 },
  { x: 608, y: 749, role: 'wall_corner', confidence: 1 },
  { x: 154, y: 749, role: 'wall_corner', confidence: 1 },
]

const edgeChain = [
  { direction: 'right', length_mm: 260, measured_length_mm: 260, role: 'structure_return', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'up', length_mm: 320, measured_length_mm: 320, role: 'structure_return', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'right', length_mm: 1640, measured_length_mm: 1640, role: 'wall', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'down', length_mm: 610, measured_length_mm: 610, role: 'structure_return', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'right', length_mm: 615, measured_length_mm: 615, role: 'wall', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'up', length_mm: 610, measured_length_mm: 610, role: 'structure_return', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'right', length_mm: 1590, measured_length_mm: 1590, role: 'wall', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'down', length_mm: 2160, measured_length_mm: 2160, role: 'wall', evidence_ids: [], source: 'user', confidence: 1 },
  { direction: 'left', length_mm: 4105, measured_length_mm: 4110, closure_adjustment_mm: -5, role: 'wall', evidence_ids: [], source: 'derived', confidence: 1 },
  { direction: 'up', length_mm: 1840, measured_length_mm: 1840, role: 'wall', evidence_ids: [], source: 'user', confidence: 1 },
]

async function api(path, init = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`)
  if (response.status === 204) return null
  return response.json()
}

const spec = {
  schema_version: '1.0',
  name: 'AGEN-24 真实样例二维效果',
  boundary: correctedBoundary,
  height_mm: 2600,
  wall_thickness_mm: 200,
  finish_surface_offset_mm: 20,
  openings: [
    { id: 'door-1', label: 'D1 门洞', kind: 'door', wall_index: 8, offset_mm: 2905, width_mm: 800, height_mm: 2100, sill_height_mm: 0, sill_mm: 0, source: 'user', confidence: 1 },
  ],
  fixtures: [
    { id: 'drain-1', label: '排水', kind: 'drain', x_mm: 520, z_mm: 640, width_mm: 60, depth_mm: 60, height_mm: 10, rotation_deg: 0, source: 'vision', confidence: 0.82 },
    { id: 'floor-drain-1', label: '地漏', kind: 'floor_drain', x_mm: 1450, z_mm: 880, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'vision', confidence: 0.86 },
    { id: 'floor-drain-2', label: '地漏', kind: 'floor_drain', x_mm: 3320, z_mm: 860, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'vision', confidence: 0.78 },
    { id: 'drain-2', label: '排水', kind: 'drain', x_mm: 3700, z_mm: 1500, width_mm: 60, depth_mm: 60, height_mm: 10, rotation_deg: 0, source: 'vision', confidence: 0.8 },
  ],
  observations: [
    { field: 'boundary', value: '12边完成面轮廓', source: 'user', confidence: 1, confirmed: true },
    { field: 'wall_thickness_mm', value: '200', source: 'user', confidence: 1, confirmed: true },
    { field: 'finish_surface_offset_mm', value: '20', source: 'user', confidence: 1, confirmed: true },
  ],
  plan_annotation: {
    rotation_degrees: 0,
    boundary: correctedImageBoundary,
    edge_chain: edgeChain,
    confirmed: false,
  },
  issues: [],
  confirmed: true,
}

const project = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({
    name: 'AGEN-24 图片标注纠正结果',
    status: 'review',
    spec,
    assets: [{
      id: 'agen-24-test0',
      project_id: 'screenshot',
      role: 'floorplan',
      filename: 'test0.jpg',
      mime_type: 'image/jpeg',
      width: 4096,
      height: 3072,
      created_at: new Date().toISOString(),
      url: '/mock-assets/test0.jpg',
    }],
  }),
})

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })
await page.goto(appUrl, { waitUntil: 'networkidle' })
await page.locator('.annotation-canvas').waitFor({ state: 'visible' })
await page.locator('.annotation-canvas').screenshot({ path: annotationScreenshotPath })
await page.getByRole('button', { name: /确认标注并生成二维图/ }).click()
await page.getByRole('button', { name: /二维审图/ }).click()
await page.locator('.plan-canvas').waitFor({ state: 'visible' })
await page.locator('.plan-canvas').screenshot({ path: reviewScreenshotPath })

const result = await page.evaluate(() => ({
  wallRings: document.querySelectorAll('.wall-finish-layer path.wall-ring').length,
  evidenceBoxes: document.querySelectorAll('.ocr-evidence-layer rect').length,
  fixtureLabels: [...document.querySelectorAll('.fixture-shape text')].map((item) => item.textContent),
  dimensionLabels: [...document.querySelectorAll('.dimension-label text')].map((item) => item.textContent),
  nonOrthogonalWalls: [...document.querySelectorAll('.room-polygon')]
    .flatMap((item) => (item.getAttribute('points') ?? '').trim().split(/\s+/))
    .map((pair) => pair.split(',').map(Number))
    .filter((point) => point.length === 2 && point.every(Number.isFinite))
    .reduce((count, point, index, points) => {
      const next = points[(index + 1) % points.length]
      if (!next) return count
      return count + (point[0] !== next[0] && point[1] !== next[1] ? 1 : 0)
    }, 0),
}))
await browser.close()

if (result.wallRings !== 1) throw new Error(`外墙应为 1 个连续闭合墙体环：${result.wallRings}`)
if (result.evidenceBoxes !== 0) throw new Error(`二维审图不应显示候选框：${result.evidenceBoxes}`)
if (result.nonOrthogonalWalls !== 0) throw new Error(`二维审图仍存在非正交闭合墙段：${result.nonOrthogonalWalls}`)

console.log(JSON.stringify({ annotationScreenshotPath, reviewScreenshotPath, projectId: project.id, ...result }, null, 2))
