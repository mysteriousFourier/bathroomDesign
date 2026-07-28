import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const baseUrl = process.env.CAPTURE_UI_BASE_URL || 'http://127.0.0.1:8000'
const requestedProjectId = process.env.CAPTURE_PROJECT_ID
const outputDir = path.resolve('.tmp/current-project-browser-audit')
await fs.mkdir(outputDir, { recursive: true })

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

const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || await firstExisting([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
])
if (!browserPath) throw new Error('没有找到可用于界面验收的 Chromium 浏览器')

const response = await fetch(`${baseUrl}/api/projects`)
if (!response.ok) throw new Error(`读取项目失败：${response.status} ${await response.text()}`)
const projects = await response.json()
const target = requestedProjectId
  ? projects.find((project) => project.id === requestedProjectId)
  : projects.find((project) => project.spec?.plan_annotation?.boundary?.length)
if (!target) throw new Error(requestedProjectId ? `项目不存在：${requestedProjectId}` : '没有带识别轮廓的项目')

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const browserMessages = []
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') browserMessages.push(`${message.type()}: ${message.text()}`)
})
page.on('pageerror', (error) => browserMessages.push(`pageerror: ${error.message}`))

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  const projectSelect = page.locator('.project-rail select').first()
  await projectSelect.waitFor()
  await projectSelect.selectOption(target.id)
  await page.locator('.project-heading strong').filter({ hasText: target.name }).waitFor()
  await page.locator('.annotation-canvas').waitFor()
  await page.locator('.annotation-canvas image').waitFor({ state: 'visible' })

  const annotation = page.locator('.photo-annotation, .annotation-workspace').first()
  const evidencePanel = page.locator('.evidence-review').first()
  const report = {
    project_id: target.id,
    project_name: target.name,
    updated_at: target.updated_at,
    selected_project_id: await projectSelect.inputValue(),
    status_text: await page.locator('.annotation-status').innerText(),
    point_count: await page.locator('.annotation-point').count(),
    wall_count: await page.locator('.annotation-wall').count(),
    wall_labels: await page.locator('.annotation-wall text').allTextContents(),
    dimension_input_count: await page.locator('.annotation-dimensions input').count(),
    evidence_box_count: await page.locator('.annotation-evidence').count(),
    pending_evidence_box_count: await page.locator('.annotation-evidence.pending').count(),
    evidence_panel_text: await evidencePanel.innerText(),
    browser_messages: browserMessages,
  }

  await page.screenshot({ path: path.join(outputDir, 'full-page.png'), fullPage: true })
  if (await annotation.count()) await annotation.screenshot({ path: path.join(outputDir, 'annotation.png') })
  if (await evidencePanel.count()) await evidencePanel.screenshot({ path: path.join(outputDir, 'evidence-panel.png') })
  await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await context.close()
  await browser.close()
}
