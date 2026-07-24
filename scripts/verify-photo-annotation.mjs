import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const outputDir = path.resolve('.tmp/ui-qa')
await fs.mkdir(outputDir, { recursive: true })
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ executablePath: browserPath, headless: true })

async function openPage(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
  await page.locator('.photo-annotation').waitFor()
  return { context, page, errors }
}

try {
  const desktop = await openPage({ width: 1440, height: 900 })
  const { page } = desktop
  const wallLabels = page.locator('.annotation-wall text')
  const wallCount = await wallLabels.count()
  if (wallCount < 5 || await page.locator('.annotation-point text').count()) {
    throw new Error(`墙线编号不一致：W=${wallCount}, P=${await page.locator('.annotation-point text').count()}`)
  }
  if (!await page.getByRole('button', { name: '二维审图' }).isDisabled()) throw new Error('照片确认前二维审图未禁用')
  if (!await page.getByRole('button', { name: '三维预览' }).isDisabled()) throw new Error('照片确认前三维预览未禁用')

  const nativeDragPrevented = await page.locator('.photo-annotation').evaluate((element) => {
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  if (!nativeDragPrevented) throw new Error('Edge 原生拖拽未被阻止')
  const canvasBehavior = await page.locator('.annotation-canvas').evaluate((element) => ({
    userSelect: getComputedStyle(element).userSelect,
    touchAction: getComputedStyle(element).touchAction,
  }))
  if (canvasBehavior.userSelect !== 'none' || canvasBehavior.touchAction !== 'none') throw new Error(`画布原生选择未禁用：${JSON.stringify(canvasBehavior)}`)

  const boundaryStroke = await page.locator('.annotation-boundary').evaluate((element) => getComputedStyle(element).stroke)
  if (!boundaryStroke.includes('194') && !boundaryStroke.includes('c2362d')) throw new Error(`未确认轮廓不是红色：${boundaryStroke}`)

  const firstEvidence = page.locator('.annotation-evidence.pending').first()
  await firstEvidence.click()
  await page.locator('.evidence-review').waitFor()
  await page.locator('.evidence-field select').first().selectOption('door_size')
  const targetWall = page.locator('.annotation-wall line').nth(2)
  const wallBox = await targetWall.boundingBox()
  if (!wallBox) throw new Error('照片墙线没有点击区域')
  const wallGeometry = await targetWall.evaluate((element) => ({
    x1: element.getAttribute('x1'), y1: element.getAttribute('y1'), x2: element.getAttribute('x2'), y2: element.getAttribute('y2'),
    box: element.getBoundingClientRect().toJSON(),
    screen: (() => {
      const svg = element.ownerSVGElement
      const matrix = element.getScreenCTM()
      if (!svg || !matrix) return null
      const start = svg.createSVGPoint(); start.x = Number(element.getAttribute('x1')); start.y = Number(element.getAttribute('y1'))
      const end = svg.createSVGPoint(); end.x = Number(element.getAttribute('x2')); end.y = Number(element.getAttribute('y2'))
      const screenStart = start.matrixTransform(matrix), screenEnd = end.matrixTransform(matrix)
      return { start: { x: screenStart.x, y: screenStart.y }, end: { x: screenEnd.x, y: screenEnd.y } }
    })(),
  }))
  if (!wallGeometry.screen) throw new Error('照片墙线无法转换为屏幕坐标')
  const wallPoint = (ratio) => ({
    x: wallGeometry.screen.start.x + (wallGeometry.screen.end.x - wallGeometry.screen.start.x) * ratio,
    y: wallGeometry.screen.start.y + (wallGeometry.screen.end.y - wallGeometry.screen.start.y) * ratio,
  })
  const doorStart = wallPoint(0.2), doorEnd = wallPoint(0.8)
  await page.mouse.move(doorStart.x, doorStart.y)
  await page.mouse.down()
  await page.mouse.move(doorEnd.x, doorEnd.y, { steps: 6 })
  await page.mouse.up()
  try {
    await page.getByText(/^W3 · 门宽 \d+%–\d+%$/).waitFor({ timeout: 2000 })
  } catch {
    const bindingText = await page.locator('.evidence-binding').allTextContents()
    throw new Error(`门宽拖选未绑定：geometry=${JSON.stringify(wallGeometry)} box=${JSON.stringify(wallBox)} binding=${JSON.stringify(bindingText)}`)
  }
  if (!await page.locator('.annotation-door-range').count()) throw new Error('门宽拖选范围未显示')
  const applyDoor = page.getByRole('button', { name: '确认并应用' })
  if (await applyDoor.isDisabled()) await page.getByLabel('识别文字 / 数值').fill('800×2055×40')
  await applyDoor.click()
  const nextRole = page.locator('.evidence-field select').first()
  if (await nextRole.count() && await nextRole.inputValue() === 'door_size') await nextRole.selectOption('other')

  const firstPoint = page.locator('.annotation-point').first()
  const pointBefore = await firstPoint.getAttribute('transform')
  const pointBox = await firstPoint.boundingBox()
  if (!pointBox) throw new Error('折点没有拖动区域')
  const pointHit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return { tag: element?.tagName, className: element?.getAttribute('class'), parentClass: element?.parentElement?.getAttribute('class') }
  }, { x: pointBox.x + pointBox.width / 2, y: pointBox.y + pointBox.height / 2 })
  await page.mouse.move(pointBox.x + pointBox.width / 2, pointBox.y + pointBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(pointBox.x + pointBox.width / 2 + 36, pointBox.y + pointBox.height / 2 + 24, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const pointAfter = await firstPoint.getAttribute('transform')
  if (pointBefore === pointAfter) throw new Error(`折点拖动没有提交最终位置：${pointBefore} -> ${pointAfter}; hit=${JSON.stringify(pointHit)}; canvas=${await page.locator('.annotation-canvas').getAttribute('class')}`)

  const pointCountBeforeDelete = await page.locator('.annotation-point').count()
  await page.keyboard.press('Delete')
  if (await page.locator('.annotation-point').count() !== pointCountBeforeDelete - 1) throw new Error('Delete 未删除所选折点')

  await page.getByRole('button', { name: '补录数据' }).click()
  const canvas = page.locator('.annotation-canvas')
  const canvasBox = await canvas.boundingBox()
  if (!canvasBox) throw new Error('照片画布不可用')
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.48, canvasBox.y + canvasBox.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.57, canvasBox.y + canvasBox.height * 0.56, { steps: 4 })
  await page.mouse.up()
  const valueInput = page.getByLabel('识别文字 / 数值')
  await valueInput.fill('吊顶2100')
  await page.locator('.evidence-field select').first().selectOption('ceiling_height')
  await page.getByRole('button', { name: '圈定范围' }).waitFor()
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.35, canvasBox.y + canvasBox.height * 0.32)
  await page.mouse.down()
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.72, canvasBox.y + canvasBox.height * 0.68, { steps: 5 })
  await page.mouse.up()
  await page.getByText('已在照片圈定').waitFor()

  await page.screenshot({ path: path.join(outputDir, 'photo-annotation-desktop.png'), fullPage: true })
  if (desktop.errors.length) throw new Error(`桌面端控制台错误：${desktop.errors.join(' | ')}`)
  await desktop.context.close()

  const mobile = await openPage({ width: 768, height: 1024 })
  const overflow = await mobile.page.evaluate(() => document.body.scrollWidth - window.innerWidth)
  if (overflow > 2) throw new Error(`移动端横向溢出 ${overflow}px`)
  await mobile.page.screenshot({ path: path.join(outputDir, 'photo-annotation-mobile.png'), fullPage: true })
  if (mobile.errors.length) throw new Error(`移动端控制台错误：${mobile.errors.join(' | ')}`)
  await mobile.context.close()

  console.log(JSON.stringify({ wallCount, boundaryStroke, screenshots: outputDir }))
} finally {
  await browser.close()
}
