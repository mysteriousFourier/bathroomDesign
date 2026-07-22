import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const outputDir = path.resolve('.tmp/ui-qa')
await fs.mkdir(outputDir, { recursive: true })

async function createQaProject() {
  const createdResponse = await fetch('http://127.0.0.1:8000/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Verification' }),
  })
  if (!createdResponse.ok) throw new Error(`无法创建 QA 项目：${createdResponse.status}`)
  const created = await createdResponse.json()
  const spec = {
    schema_version: '1.0', name: 'QA Verification',
    boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 1840, z_mm: 0 }, { x_mm: 1840, z_mm: 2585 }, { x_mm: 0, z_mm: 2585 }],
    height_mm: 2610, wall_thickness_mm: 100,
    openings: [{ id: 'door', kind: 'door', wall_index: 0, offset_mm: 520, width_mm: 800, height_mm: 2100, sill_mm: 0, label: '入户门', source: 'measured', confidence: 0.96 }],
    fixtures: [
      { id: 'toilet', kind: 'toilet', label: '马桶', x_mm: 1420, z_mm: 1900, width_mm: 380, depth_mm: 700, height_mm: 760, rotation_deg: 180, source: 'estimated', confidence: 0.82 },
      { id: 'vanity', kind: 'vanity', label: '浴室柜', x_mm: 1280, z_mm: 550, width_mm: 800, depth_mm: 520, height_mm: 850, rotation_deg: 0, source: 'estimated', confidence: 0.79 },
      { id: 'shower', kind: 'shower', label: '淋浴房', x_mm: 460, z_mm: 1900, width_mm: 900, depth_mm: 900, height_mm: 2000, rotation_deg: 0, source: 'estimated', confidence: 0.74 },
      { id: 'drain', kind: 'floor_drain', label: '地漏', x_mm: 770, z_mm: 1370, width_mm: 120, depth_mm: 120, height_mm: 10, rotation_deg: 0, source: 'measured', confidence: 0.9 },
    ],
    observations: [], issues: [], confirmed: true,
  }
  const saved = await fetch(`http://127.0.0.1:8000/api/projects/${created.id}/spec`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
  })
  if (!saved.ok) throw new Error(`无法保存 QA 模型：${saved.status}`)
  return created.id
}

const verifyCurrentProject = process.argv.includes('--current')
const qaProjectId = verifyCurrentProject ? null : await createQaProject()

const browser = await chromium.launch({
  executablePath: edgePath,
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
  console.log(`UI verification passed. Screenshots: ${outputDir}`)
} finally {
  await browser.close()
  if (qaProjectId) await fetch(`http://127.0.0.1:8000/api/projects/${qaProjectId}`, { method: 'DELETE' })
}
