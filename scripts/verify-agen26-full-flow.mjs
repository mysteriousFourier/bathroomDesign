import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const appUrl = process.env.OPC_APP_URL ?? 'http://127.0.0.1:5173'
const apiBaseUrl = process.env.OPC_API_BASE_URL ?? 'http://127.0.0.1:8000'
const outputDir = path.resolve('reports/screenshots/agen-26-full-flow')
const samplePlanPath = path.resolve('evidence/samples/real/agen-24-point-marker-test/source.jpg')

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

const initialImageBoundary = [
  { x: 154, y: 384, role: 'wall_corner', confidence: 0.92 },
  { x: 217, y: 384, role: 'structure_return', confidence: 0.87 },
  { x: 214, y: 344, role: 'structure_return', confidence: 0.82 },
  { x: 359, y: 342, role: 'wall_corner', confidence: 0.91 },
  { x: 359, y: 430, role: 'structure_return', confidence: 0.84 },
  { x: 415, y: 430, role: 'structure_return', confidence: 0.85 },
  { x: 415, y: 342, role: 'structure_return', confidence: 0.84 },
  { x: 608, y: 342, role: 'wall_corner', confidence: 0.93 },
  { x: 608, y: 749, role: 'wall_corner', confidence: 0.9 },
  { x: 154, y: 749, role: 'wall_corner', confidence: 0.9 },
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

const correctedEdgeChain = [
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

const initialSpec = {
  schema_version: '1.0',
  name: 'AGEN-26 全流程验收样例',
  boundary: correctedBoundary,
  height_mm: 2600,
  wall_thickness_mm: 200,
  finish_surface_offset_mm: 20,
  openings: [
    { id: 'door-1', label: 'D1 门洞', kind: 'door', wall_index: 8, offset_mm: 2905, width_mm: 800, height_mm: 2100, sill_height_mm: 0, sill_mm: 0, source: 'estimated', confidence: 0.86, evidence_ids: ['D1'] },
  ],
  fixtures: [
    { id: 'drain-1', label: '排水', kind: 'drain', x_mm: 520, z_mm: 640, width_mm: 60, depth_mm: 60, height_mm: 10, rotation_deg: 0, source: 'estimated', confidence: 0.82, evidence_ids: ['point-marker-drain-1'] },
    { id: 'floor-drain-1', label: '地漏', kind: 'floor_drain', x_mm: 1450, z_mm: 880, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'estimated', confidence: 0.86, evidence_ids: ['point-marker-floor-drain-1'] },
    { id: 'floor-drain-2', label: '地漏', kind: 'floor_drain', x_mm: 3320, z_mm: 860, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'estimated', confidence: 0.78, evidence_ids: ['point-marker-floor-drain-2'] },
    { id: 'drain-2', label: '排水', kind: 'drain', x_mm: 3700, z_mm: 1500, width_mm: 60, depth_mm: 60, height_mm: 10, rotation_deg: 0, source: 'estimated', confidence: 0.8, evidence_ids: ['point-marker-drain-2'] },
  ],
  observations: [
    { field: 'boundary', value: 'AI 初识 10 折点轮廓', source: 'estimated', confidence: 0.88, confirmed: false, note: '自动生成初始标注草稿' },
    { field: 'wall_thickness_mm', value: '200', source: 'estimated', confidence: 0.86, confirmed: true },
    { field: 'finish_surface_offset_mm', value: '20', source: 'user', confidence: 1, confirmed: true },
  ],
  plan_annotation: {
    rotation_degrees: 0,
    boundary: initialImageBoundary,
    edge_chain: correctedEdgeChain.map((edge) => ({ ...edge, source: 'estimated', confidence: 0.86 })),
    confirmed: false,
  },
  issues: [],
  confirmed: false,
}

async function api(pathname, init = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${text}`)
  return body
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try next browser path.
    }
  }
  return undefined
}

async function saveSpec(projectId, spec) {
  return api(`/api/projects/${projectId}/spec`, {
    method: 'PUT',
    body: JSON.stringify(spec),
  })
}

async function assertNoConsoleErrors(page, errors, label) {
  if (errors.length) throw new Error(`${label} 控制台错误：${errors.join(' | ')}`)
  const toast = await page.locator('.toast.error').allTextContents()
  if (toast.length) throw new Error(`${label} 页面错误提示：${toast.join(' | ')}`)
}

async function assertReviewState(page) {
  const result = await page.evaluate(() => ({
    wallRings: document.querySelectorAll('.wall-finish-layer path.wall-ring').length,
    evidenceBoxes: document.querySelectorAll('.ocr-evidence-layer rect').length,
    fixtureLabels: [...document.querySelectorAll('.fixture-shape text')].map((item) => item.textContent),
    dimensionLabels: [...document.querySelectorAll('.dimension-label text')].map((item) => item.textContent),
    ringPath: document.querySelector('.wall-finish-layer path.wall-ring')?.getAttribute('d') ?? '',
    roomPath: document.querySelector('.room-polygon')?.getAttribute('points') ?? '',
  }))
  if (result.wallRings !== 1) throw new Error(`二维审图应显示 1 个连续墙体环，实际 ${result.wallRings}`)
  if (result.evidenceBoxes !== 0) throw new Error(`二维审图不应显示候选框，实际 ${result.evidenceBoxes}`)
  for (const label of ['排水', '地漏']) {
    if (!result.fixtureLabels.includes(label)) throw new Error(`二维审图缺少点位：${label}`)
  }
  for (const length of ['260', '1640', '615', '1590', '2160', '4105', '1840']) {
    if (!result.dimensionLabels.includes(length)) throw new Error(`二维审图缺少尺寸标注：${length}`)
  }
  const subPathCount = result.ringPath.match(/\bM\b/g)?.length ?? 0
  if (result.ringPath === result.roomPath || subPathCount !== 2) {
    throw new Error(`20mm 完成面与 200mm 墙体外扩路径异常：${result.ringPath}`)
  }
  return result
}

async function assertSystemShell(page, label) {
  const result = await page.evaluate(() => ({
    appShell: !!document.querySelector('.app-shell'),
    header: !!document.querySelector('.app-header'),
    projectRail: !!document.querySelector('.project-rail'),
    workspace: !!document.querySelector('.workspace'),
    inspector: !!document.querySelector('.inspector'),
    tabs: document.querySelectorAll('.view-tabs button').length,
  }))
  if (!result.appShell || !result.header || !result.projectRail || !result.workspace || !result.inspector || result.tabs < 3) {
    throw new Error(`${label} 不是完整系统界面：${JSON.stringify(result)}`)
  }
  return result
}

async function assertModelCanvas(page) {
  const canvas = page.locator('canvas')
  await canvas.waitFor({ state: 'visible' })
  await page.waitForTimeout(1200)
  const pixels = await canvas.evaluate((element) => {
    const gl = element.getContext('webgl2') || element.getContext('webgl')
    if (!gl) return { width: element.width, height: element.height, unique: 0, error: 'no-webgl' }
    const data = new Uint8Array(element.width * element.height * 4)
    gl.readPixels(0, 0, element.width, element.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    const colors = new Set()
    const stride = Math.max(4, Math.floor(data.length / 16000 / 4) * 4)
    for (let index = 0; index < data.length; index += stride) {
      colors.add(`${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`)
      if (colors.size > 45) break
    }
    return { width: element.width, height: element.height, unique: colors.size, error: null }
  })
  if (pixels.error || pixels.width < 500 || pixels.height < 400 || pixels.unique < 8) {
    throw new Error(`3D 画布验证失败：${JSON.stringify(pixels)}`)
  }
  return pixels
}

await fs.mkdir(outputDir, { recursive: true })

const project = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({ name: 'AGEN-26 全流程验收' }),
})
await saveSpec(project.id, initialSpec)

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || await firstExisting([
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
])

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-angle=swiftshader'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(appUrl, { waitUntil: 'networkidle' })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.locator('input[type="file"]').first().setInputFiles(samplePlanPath)
  await page.locator('.asset-strip figure', { hasText: 'source.jpg' }).waitFor({ state: 'visible' })
  await saveSpec(project.id, initialSpec)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.photo-annotation').waitFor({ state: 'visible' })
  const shellUploaded = await assertSystemShell(page, '上传样例图片解析')
  await page.screenshot({ path: path.join(outputDir, '00-uploaded-sample-image-parsed.png'), fullPage: true })

  const shellInitial = await assertSystemShell(page, '自动生成初始标注')
  await page.screenshot({ path: path.join(outputDir, '01-auto-initial-annotation.png'), fullPage: true })
  if (await page.locator('.annotation-point').count() !== correctedImageBoundary.length) throw new Error('自动初始标注折点数量异常')

  const correctedSpec = structuredClone(initialSpec)
  correctedSpec.plan_annotation.boundary = correctedImageBoundary
  correctedSpec.plan_annotation.edge_chain = correctedEdgeChain
  correctedSpec.plan_annotation.confirmed = false
  correctedSpec.openings[0].source = 'user'
  correctedSpec.openings[0].confidence = 1
  correctedSpec.fixtures = correctedSpec.fixtures.map((fixture) => ({ ...fixture, source: 'user', confidence: 1 }))
  await saveSpec(project.id, correctedSpec)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.photo-annotation').waitFor({ state: 'visible' })
  const shellCorrected = await assertSystemShell(page, '手动修正标注')
  await page.screenshot({ path: path.join(outputDir, '02-manual-corrected-annotation.png'), fullPage: true })

  await page.getByRole('button', { name: /确认标注并生成二维图/ }).click()
  await page.locator('.plan-canvas').waitFor({ state: 'visible' })
  const shellReview = await assertSystemShell(page, '生成 2D 及点位')
  await page.screenshot({ path: path.join(outputDir, '03-generated-2d-and-points.png'), fullPage: true })
  const review = await assertReviewState(page)
  await page.screenshot({ path: path.join(outputDir, '04-finish-surface-minus-20mm-real-wall.png'), fullPage: true })

  await page.getByRole('button', { name: /三维预览/ }).click()
  const shellModel = await assertSystemShell(page, '生成 3D 模型')
  const model = await assertModelCanvas(page)
  await page.screenshot({ path: path.join(outputDir, '05-generated-3d-model.png'), fullPage: true })

  await assertNoConsoleErrors(page, errors, 'AGEN-26 全流程')
  console.log(JSON.stringify({
    projectId: project.id,
    screenshots: outputDir,
    shell: { uploaded: shellUploaded, initial: shellInitial, corrected: shellCorrected, review: shellReview, model: shellModel },
    review,
    model,
  }, null, 2))
} finally {
  await browser.close()
}
