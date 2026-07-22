import fs from 'node:fs/promises'
import path from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { chromium } from 'playwright-core'

const outputDir = path.resolve('.tmp/ui-qa')
await fs.mkdir(outputDir, { recursive: true })
const apiBaseUrl = 'http://127.0.0.1:8000'
const measurementSchema = JSON.parse(await fs.readFile(path.resolve('schemas/measurement.schema.json'), 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
const validateDownloadedMeasurement = ajv.compile(measurementSchema)

async function apiRequest(url, init) {
  const response = await fetch(`${apiBaseUrl}${url}`, init)
  let body = null
  try {
    body = await response.json()
  } catch {
    // Some endpoints, such as downloads, may not return JSON on failure.
  }
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${body?.detail ?? response.statusText}`)
  }
  return body
}

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
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
])

async function createQaProject() {
  const createdResponse = await fetch(`${apiBaseUrl}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Verification' }),
  })
  if (!createdResponse.ok) throw new Error(`无法创建 QA 项目：${createdResponse.status}`)
  const created = await createdResponse.json()
  const spec = {
    schema_version: '1.0', name: 'QA Verification',
    boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 1840, z_mm: 0 }, { x_mm: 1840, z_mm: 2585 }, { x_mm: 0, z_mm: 2585 }],
    height_mm: 2610, wall_thickness_mm: 100,
    openings: [{ id: 'door', kind: 'door', wall_index: 0, offset_mm: 520, width_mm: 800, height_mm: 2100, sill_mm: 0, label: '入户门', source: 'measured', confidence: 0.96, evidence_ids: ['door-opening'] }],
    fixtures: [
      { id: 'toilet', kind: 'toilet', label: '马桶', x_mm: 1420, z_mm: 1900, width_mm: 380, depth_mm: 700, height_mm: 760, rotation_deg: 180, source: 'estimated', confidence: 0.82 },
      { id: 'vanity', kind: 'vanity', label: '浴室柜', x_mm: 1280, z_mm: 550, width_mm: 800, depth_mm: 520, height_mm: 850, rotation_deg: 0, source: 'estimated', confidence: 0.79 },
      { id: 'shower', kind: 'shower', label: '淋浴房', x_mm: 460, z_mm: 1900, width_mm: 900, depth_mm: 900, height_mm: 2000, rotation_deg: 0, source: 'estimated', confidence: 0.74 },
      { id: 'drain', kind: 'floor_drain', label: '地漏', x_mm: 770, z_mm: 1370, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'measured', confidence: 0.9 },
    ],
    observations: [
      { field: 'visual_evidence:wall-chain', value: '1840 x 2585 墙体轮廓尺寸链', source: 'measured', asset_id: null, bbox: { x_min: 120, y_min: 130, x_max: 880, y_max: 780 }, confidence: 0.94, confirmed: true, alternatives: [], note: 'boundary wall 轮廓 尺寸链' },
      { field: 'visual_evidence:room-height', value: '层高 2610', source: 'measured', asset_id: null, bbox: { x_min: 700, y_min: 72, x_max: 900, y_max: 128 }, confidence: 0.9, confirmed: true, alternatives: [], note: 'height 层高' },
      { field: 'visual_evidence:door-opening', value: '入户门 800 x 2100', source: 'measured', asset_id: null, bbox: { x_min: 300, y_min: 820, x_max: 540, y_max: 930 }, confidence: 0.92, confirmed: true, alternatives: [], note: 'door opening 门洞' },
    ],
    issues: [], confirmed: true,
  }
  const saved = await fetch(`${apiBaseUrl}/api/projects/${created.id}/spec`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
  })
  if (!saved.ok) throw new Error(`无法保存 QA 模型：${saved.status}`)
  const project = await saved.json()
  await verifyMeasurementContract(created.id, project.measurement)
  return created.id
}

async function verifyMeasurementContract(projectId, savedMeasurement) {
  if (!savedMeasurement) throw new Error('QA 项目保存后没有返回量房 JSON')
  const measurement = await apiRequest(`/api/projects/${projectId}/measurement`)
  if (measurement.measurement_id !== savedMeasurement.measurement_id) {
    throw new Error(`内部量房模型 ID 不一致：${measurement.measurement_id} !== ${savedMeasurement.measurement_id}`)
  }
  const validation = await apiRequest('/api/measurements/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(measurement),
  })
  const downloadedMeasurement = await apiRequest(`/api/projects/${projectId}/measurement/download`)
  if (!validateDownloadedMeasurement(downloadedMeasurement)) {
    throw new Error(`下载量房 JSON 不符合 measurement.schema.json：${JSON.stringify(validateDownloadedMeasurement.errors)}`)
  }
  if ('measurement_id' in downloadedMeasurement || 'schema_version' in downloadedMeasurement) {
    throw new Error('下载量房 JSON 泄漏了内部 MeasurementModel 字段')
  }
  const criticalGroups = [
    { label: 'walls', items: measurement.walls ?? [] },
    { label: 'openings', items: measurement.openings ?? [] },
    { label: 'heights', items: [measurement.heights].filter(Boolean) },
  ]
  const missingEvidence = criticalGroups.flatMap(({ label, items }) => (
    items.filter((item) => !Array.isArray(item.evidence_ids) || item.evidence_ids.length === 0)
      .map((item) => `${label}:${item.id ?? 'heights'}`)
  ))
  const evidenceById = new Map((measurement.evidence ?? []).map((item) => [item.id, item]))
  const unauditableEvidence = criticalGroups.flatMap(({ label, items }) => (
    items.flatMap((item) => (item.evidence_ids ?? []).map((id) => ({ label, item, id })))
      .filter(({ id }) => !evidenceById.has(id) || evidenceById.get(id).source === 'estimated')
      .map(({ label, item, id }) => `${label}:${item.id ?? 'heights'}:${id}`)
  ))
  if (missingEvidence.length || unauditableEvidence.length) {
    throw new Error(`量房 JSON 缺少可审计 evidence：${JSON.stringify({ missingEvidence, unauditableEvidence })}`)
  }
  if (!validation.sufficient) {
    throw new Error(`后端量房校验未通过：${JSON.stringify({ missing: validation.missing, issues: validation.issues })}`)
  }
  return { measurement, downloadedMeasurement, validation }
}

const verifyCurrentProject = process.argv.includes('--current')
const qaProjectId = verifyCurrentProject ? null : await createQaProject()

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader'],
})

async function verifyPage(viewport, label) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
  await page.locator('.project-heading strong').waitFor()
  const projectTitle = await page.locator('.project-heading strong').textContent()
  if (!projectTitle || projectTitle === '未选择项目') throw new Error(`${label}: QA 项目未加载`)
  await page.screenshot({ path: path.join(outputDir, `${label}-review.png`), fullPage: true })

  const layout = await page.evaluate(() => {
    const header = document.querySelector('.app-header')?.getBoundingClientRect()
    const workspace = document.querySelector('.workspace')?.getBoundingClientRect()
    const inspector = document.querySelector('.inspector')?.getBoundingClientRect()
    return { header, workspace, inspector, bodyWidth: document.body.scrollWidth, viewportWidth: window.innerWidth }
  })
  if (!layout.header || !layout.workspace || layout.workspace.width < 300) throw new Error(`${label}: 工作台布局无效`)
  if (layout.bodyWidth > layout.viewportWidth + 2) throw new Error(`${label}: 页面出现横向溢出`)

  if (label.endsWith('desktop')) {
    const plan = page.locator('.plan-canvas')
    const roomLayer = plan.locator('.room-polygon').locator('..')
    const transformBefore = await roomLayer.getAttribute('transform')
    const planBox = await plan.boundingBox()
    if (!planBox) throw new Error('二维画布没有可交互区域')
    const hitTarget = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)
      return element ? { tag: element.tagName, className: element.getAttribute('class'), panSurface: element.getAttribute('data-pan-surface') } : null
    }, { x: planBox.x + 24, y: planBox.y + 24 })
    await page.mouse.move(planBox.x + 24, planBox.y + 24)
    await page.mouse.down()
    await page.mouse.move(planBox.x + 84, planBox.y + 64, { steps: 6 })
    await page.mouse.up()
    const transformAfter = await roomLayer.getAttribute('transform')
    if (transformBefore === transformAfter) throw new Error(`二维画布拖动没有改变视图：${JSON.stringify({ hitTarget, transformBefore, transformAfter })}`)

    await page.getByRole('button', { name: '三维预览' }).click()
    const canvas = page.locator('canvas')
    await canvas.waitFor({ state: 'visible' })
    await page.waitForTimeout(1000)
    const pixels = await canvas.evaluate((element) => {
      const target = element
      const gl = target.getContext('webgl2') || target.getContext('webgl')
      if (!gl) return { width: target.width, height: target.height, unique: 0, error: 'no-webgl' }
      const data = new Uint8Array(target.width * target.height * 4)
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
      const colors = new Set()
      const stride = Math.max(4, Math.floor(data.length / 12000 / 4) * 4)
      for (let index = 0; index < data.length; index += stride) {
        colors.add(`${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`)
        if (colors.size > 40) break
      }
      return { width: target.width, height: target.height, unique: colors.size, error: null }
    })
    if (pixels.error || pixels.width < 500 || pixels.height < 400 || pixels.unique < 8) throw new Error(`3D 画布验证失败：${JSON.stringify(pixels)}`)
    const frameBefore = await canvas.evaluate((element) => element.toDataURL())
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('3D 画布没有可交互区域')
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.55, canvasBox.y + canvasBox.height * 0.5)
    await page.mouse.down()
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.7, canvasBox.y + canvasBox.height * 0.62, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(500)
    const frameAfter = await canvas.evaluate((element) => element.toDataURL())
    if (frameBefore === frameAfter) throw new Error('3D 画布拖动后画面没有变化')
    await page.screenshot({ path: path.join(outputDir, `${label}-3d.png`), fullPage: true })
    console.log(JSON.stringify({ canvas: pixels, layout }))
  }
  if (errors.length) throw new Error(`${label} 控制台错误：${errors.join(' | ')}`)
  await context.close()
}

try {
  const prefix = verifyCurrentProject ? 'current-' : ''
  await verifyPage({ width: 1440, height: 900 }, `${prefix}desktop`)
  await verifyPage({ width: 768, height: 1024 }, `${prefix}mobile`)
  console.log(`UI smoke verification passed with evidence-backed measurement export validation. This is not a real upload/AI-parse FastAPI E2E. Screenshots: ${outputDir}`)
} finally {
  await browser.close()
  if (qaProjectId) await fetch(`${apiBaseUrl}/api/projects/${qaProjectId}`, { method: 'DELETE' })
}
