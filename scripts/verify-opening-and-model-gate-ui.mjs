import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const baseUrl = process.env.CAPTURE_UI_BASE_URL || 'http://127.0.0.1:8000'
const sourceProjectId = process.env.CAPTURE_PROJECT_ID || '3f6f2d602d5b433f9f0d315748a9ba5f'
const samplePath = path.resolve('微信图片_20260716091803_2_911.jpg')
const outputDir = path.resolve('.tmp/opening-model-gate-qa')
await fs.mkdir(outputDir, { recursive: true })

async function api(url, init) {
  const response = await fetch(`${baseUrl}${url}`, init)
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next installed browser.
    }
  }
  return undefined
}

const browserPath = await firstExisting([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
])
if (!browserPath) throw new Error('没有找到可用于界面验收的 Chromium 浏览器')

const source = await api(`/api/projects/${sourceProjectId}`)
const project = await api('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `门洞与建模门禁验收 ${Date.now()}` }),
})

const upload = new FormData()
upload.append('role', 'floorplan')
upload.append('file', new Blob([await fs.readFile(samplePath)], { type: 'image/jpeg' }), path.basename(samplePath))
await api(`/api/projects/${project.id}/assets`, { method: 'POST', body: upload })

const spec = structuredClone(source.spec)
spec.observations = []
spec.issues = []
spec.confirmed = false
spec.plan_annotation.confirmed = false
spec.plan_annotation.edge_chain[1].length_mm = 1255
spec.plan_annotation.edge_chain[1].measured_length_mm = 1255
spec.openings = [{
  id: 'door-d1', kind: 'door', wall_index: 1, offset_mm: 400, width_mm: 800,
  height_mm: 2055, thickness_mm: 100, sill_mm: 0, label: 'D1', source: 'user',
  confidence: 1, evidence_ids: [],
}]
await api(`/api/projects/${project.id}/spec`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
})

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await context.newPage()
const browserMessages = []
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') browserMessages.push(`${message.type()}: ${message.text()}`)
})
page.on('pageerror', (error) => browserMessages.push(`pageerror: ${error.message}`))

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  const projectSelect = page.locator('.project-rail select').first()
  await projectSelect.selectOption(project.id)
  await page.locator('.annotation-canvas').waitFor()

  const opening = page.locator('.annotation-opening-segments')
  await opening.waitFor()
  const openingLabels = await opening.locator('text').allTextContents()
  const openingLines = await opening.locator('line').count()
  const toolbarBreakdown = await page.locator('.annotation-dimensions label').nth(1).locator('.edge-breakdown').innerText()
  if (openingLines !== 5) throw new Error(`门洞应为三段墙线加两条分界刻度，实际 ${openingLines} 条`)
  if (JSON.stringify(openingLabels) !== JSON.stringify(['400', 'D1 800', '55'])) {
    throw new Error(`门洞三段标签错误：${JSON.stringify(openingLabels)}`)
  }
  if (toolbarBreakdown !== '400 + D1 800 + 55') throw new Error(`门洞尺寸链错误：${toolbarBreakdown}`)
  await page.screenshot({ path: path.join(outputDir, 'opening-three-segments.png'), fullPage: true })

  const diagonal = structuredClone(spec)
  diagonal.plan_annotation.confirmed = true
  diagonal.height_mm = 2600
  diagonal.boundary = [
    { x_mm: 0, z_mm: 0 }, { x_mm: 2400, z_mm: 100 },
    { x_mm: 2400, z_mm: 1800 }, { x_mm: 0, z_mm: 1800 },
  ]
  await api(`/api/projects/${project.id}/spec`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(diagonal),
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.project-rail select').first().selectOption(project.id)
  const modelTab = page.getByRole('button', { name: '三维预览' })
  const confirmButton = page.getByRole('button', { name: '确认数据' })
  if (!(await modelTab.isDisabled()) || !(await confirmButton.isDisabled())) {
    throw new Error('斜边轮廓没有被建模门禁拦截')
  }
  await page.screenshot({ path: path.join(outputDir, 'diagonal-model-gate.png'), fullPage: true })

  if (browserMessages.length) throw new Error(`浏览器控制台异常：${browserMessages.join(' | ')}`)
  console.log(JSON.stringify({ openingLabels, openingLines, toolbarBreakdown, diagonalModelBlocked: true }, null, 2))
} finally {
  await context.close()
  await browser.close()
  await api(`/api/projects/${project.id}`, { method: 'DELETE' })
}
