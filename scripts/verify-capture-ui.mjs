import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const baseUrl = process.env.CAPTURE_UI_BASE_URL || 'http://127.0.0.1:8000'
const samplePath = path.resolve('微信图片_20260716091803_2_911.jpg')
const outputDir = path.resolve('.tmp/capture-ui-qa')
const pdfOutputDir = path.resolve('tmp/pdfs')
await fs.mkdir(outputDir, { recursive: true })
await fs.mkdir(pdfOutputDir, { recursive: true })

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

async function api(url, init) {
  const response = await fetch(`${baseUrl}${url}`, init)
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

const project = await api('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `样例采集验收 ${Date.now()}` }),
})
const upload = new FormData()
upload.append('role', 'floorplan')
upload.append('file', new Blob([await fs.readFile(samplePath)], { type: 'image/jpeg' }), path.basename(samplePath))
await api(`/api/projects/${project.id}/assets`, { method: 'POST', body: upload })

const browser = await chromium.launch({ executablePath: browserPath, headless: true })

async function verifyWorkspace(viewport, label) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const browserMessages = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') browserMessages.push(`${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => browserMessages.push(`pageerror: ${error.message}`))

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  const projectSelect = page.locator('.project-rail select').first()
  await projectSelect.waitFor()
  await projectSelect.selectOption(project.id)
  await page.locator('.project-heading strong').filter({ hasText: project.name }).waitFor()
  await page.locator('.capture-assessment.ready').waitFor()
  const headerTemplateLink = page.locator('.header-actions a[href="/measurement-template.html"]')
  await headerTemplateLink.waitFor()
  if (!(await headerTemplateLink.isVisible())) throw new Error(`${label}: 顶部量房模板入口不可见`)
  const qualityText = await page.locator('.capture-assessment.ready').innerText()
  if (!qualityText.includes('图片质量良好') || !qualityText.includes('4032 x 3024')) {
    throw new Error(`${label}: 样例图片质量结果不完整：${qualityText}`)
  }

  await page.locator('.capture-rules-link').click()
  const dialog = page.getByRole('dialog', { name: '让量房数据一次可识别' })
  await dialog.waitFor()
  const bounds = await dialog.boundingBox()
  if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > viewport.width + 1 || bounds.y + bounds.height > viewport.height + 1) {
    throw new Error(`${label}: 规则弹窗超出视口：${JSON.stringify(bounds)}`)
  }
  if (await dialog.locator('.capture-rule').count() !== 10) throw new Error(`${label}: 规则条目缺失`)
  if (await dialog.getByRole('link', { name: '打印量房纸' }).getAttribute('href') !== '/measurement-template.html') {
    throw new Error(`${label}: 打印模板链接错误`)
  }
  await page.screenshot({ path: path.join(outputDir, `${label}-guide.png`), fullPage: true })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })

  const pageWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: window.innerWidth }))
  if (pageWidth.body > pageWidth.viewport + 2) throw new Error(`${label}: 工作台出现横向页面溢出：${JSON.stringify(pageWidth)}`)
  if (browserMessages.length) throw new Error(`${label}: 浏览器控制台异常：${browserMessages.join(' | ')}`)
  await context.close()
}

async function verifyTemplate(viewport, label) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${baseUrl}/measurement-template.html`, { waitUntil: 'networkidle' })
  const sheet = page.locator('.sheet')
  await sheet.waitFor()
  const dimensions = await sheet.evaluate((element) => ({
    paperWidth: element.offsetWidth,
    paperHeight: element.offsetHeight,
    visibleWidth: element.getBoundingClientRect().width,
    visibleHeight: element.getBoundingClientRect().height,
    x: element.getBoundingClientRect().x,
    y: element.getBoundingClientRect().y,
    transform: getComputedStyle(element).transform,
    viewportWidth: window.innerWidth,
  }))
  console.log(JSON.stringify({ label, dimensions }))
  if (dimensions.paperWidth < 1100 || dimensions.paperHeight < 780) throw new Error(`${label}: A4 横向尺寸不正确：${JSON.stringify(dimensions)}`)
  if (label === 'mobile' && dimensions.visibleWidth > dimensions.viewportWidth - 34) throw new Error(`${label}: A4 预览未完整缩放到视口：${JSON.stringify(dimensions)}`)
  if (label === 'mobile' && dimensions.x < 16) throw new Error(`${label}: A4 预览左侧超出视口：${JSON.stringify(dimensions)}`)
  if (await page.locator('.marker').count() !== 4) throw new Error(`${label}: 四角定位标记缺失`)
  if (await page.locator('.panel').count() !== 3) throw new Error(`${label}: 量房记录区域缺失`)
  if (await page.locator('.drawing-grid i').count() !== 37) throw new Error(`${label}: 可打印网格线缺失`)
  const panels = page.locator('.panel')
  if (await panels.nth(0).locator('tr').count() !== 4) throw new Error(`${label}: D1/W1/W2 记录行数错误`)
  const openingHeaders = await panels.nth(0).locator('th').allTextContents()
  if (!['CG', 'CK', 'CH'].every((field) => openingHeaders.includes(field))) throw new Error(`${label}: 门窗 CG/CK/CH 字段缺失`)
  if (await page.getByText('点位', { exact: true }).count()) throw new Error(`${label}: 不应保留点位坐标表`)
  if (await page.locator('.point-symbols span').count() !== 4) throw new Error(`${label}: 点位符号说明缺失`)
  await page.screenshot({ path: path.join(outputDir, `${label}-template.png`), fullPage: true })
  if (label === 'desktop') {
    await page.pdf({
      path: path.join(pdfOutputDir, 'measurement-template-print-test.pdf'),
      preferCSSPageSize: true,
      printBackground: false,
    })
  }
  if (errors.length) throw new Error(`${label}: 模板控制台异常：${errors.join(' | ')}`)
  await context.close()
}

try {
  await verifyWorkspace({ width: 1440, height: 900 }, 'desktop')
  await verifyWorkspace({ width: 768, height: 1024 }, 'mobile')
  await verifyTemplate({ width: 1440, height: 1000 }, 'desktop')
  await verifyTemplate({ width: 390, height: 844 }, 'mobile')
  console.log(`Capture UI verification passed. Screenshots: ${outputDir}`)
} finally {
  await browser.close()
  await api(`/api/projects/${project.id}`, { method: 'DELETE' })
}
