import fs from 'node:fs/promises'
import { chromium } from 'playwright-core'

const raw = JSON.parse(await fs.readFile('evidence/measurement.json', 'utf8'))
const boundary = raw.boundary.map((p) => ({ x_mm:p.x, z_mm:p.y }))
const fixtures = raw.measurementPoints.map((p) => ({ id:p.pointId, kind:p.kind === 'drain' ? 'drain' : p.kind, label:p.label, x_mm:p.position.x, z_mm:p.position.y, width_mm:p.width, depth_mm:p.depth, height_mm:p.height, rotation_deg:p.rotation, point_usage:p.pointUsage, source:'measured', confidence:1 }))
const spec = { schema_version:'1.0', name:'用户量房 a91b2623', boundary, height_mm:raw.heights.roomHeight, wall_thickness_mm:200, openings:[{id:raw.openings[0].openingId,kind:'door',wall_index:1,offset_mm:400,width_mm:800,height_mm:2055,sill_mm:0,label:'D1',source:'measured',confidence:1}], fixtures, observations:[], issues:[], confirmed:true }
const project = { id:'layout-measurement', name:'用户量房布局验证', status:'ready', created_at:'2026-08-08T00:00:00Z', updated_at:'2026-08-08T00:00:00Z', spec, measurement:null, assets:[] }
await fs.mkdir('evidence/agen42-measurement-layout', { recursive:true })
const browser = await chromium.launch({ headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/google-chrome', args:['--no-sandbox','--enable-webgl','--use-angle=swiftshader'] })
const page = await browser.newPage({ viewport:{ width:1600, height:1100 }, deviceScaleFactor:1 })
page.on('pageerror', error => console.error(`PAGE_ERROR ${error.message}`))
page.on('crash', () => console.error('PAGE_CRASH'))
await page.route('**/api/**', async route => {
  const url = route.request().url(); const body = url.endsWith('/api/health') ? {ok:true,ai_configured:false,model:null} : url.endsWith('/api/projects') ? [project] : project
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})
})
await page.goto('http://127.0.0.1:5173', {waitUntil:'networkidle'})
await page.getByRole('button',{name:'二维审图'}).click()
await page.locator('.layout-grid').waitFor()
const thumbnails = await page.locator('.layout-plan').count()
const cards = await page.locator('.layout-card').evaluateAll((items) => items.map((item) => ({ text:item.textContent, blocking:item.getAttribute('data-blocking-count') })))
console.log(JSON.stringify({ cards }))
for (let index = 0; index < cards.length; index += 1) {
  if (cards[index].blocking === '0') continue
  await page.locator('.layout-card').nth(index).click()
  console.log(JSON.stringify({ candidate:cards[index].text, failures:await page.locator('.layout-checks .fail').allTextContents() }))
}
const scenarios = process.env.CAPTURE_SCENARIOS?.split(',').filter(Boolean) ?? ['标准淋浴', '洗衣复合', '适老安全']
const layouts = process.env.CAPTURE_LAYOUTS?.split(',').filter(Boolean) ?? ['沿墙通道型', '左右分区型', '中央岛式型']
const sceneCounts = {}
let captureIndex = 0
for (const label of scenarios) {
  sceneCounts[label] = []
  for (const layout of layouts) {
    captureIndex += 1
    await page.getByRole('button',{name:new RegExp(`${label} · ${layout}`)}).click()
    await page.locator('.model-canvas-wrap canvas').waitFor()
    await page.getByTestId('scene-fixture-summary').waitFor()
    await page.waitForTimeout(500)
    sceneCounts[label].push(await page.locator('[data-testid="scene-fixture-summary"] code').count())
    const filename = `${String(captureIndex).padStart(2, '0')}-${label}-${layout}.png`
    await page.screenshot({path:`evidence/agen42-measurement-layout/${filename}`,fullPage:true})
    await page.getByRole('button',{name:'二维审图'}).click()
  }
}
const mobile = await browser.newPage({ viewport:{ width:390, height:844 }, deviceScaleFactor:1 })
await mobile.route('**/api/**', async route => {
  const url = route.request().url(); const body = url.endsWith('/api/health') ? {ok:true,ai_configured:false,model:null} : url.endsWith('/api/projects') ? [project] : project
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})
})
await mobile.goto('http://127.0.0.1:5173', {waitUntil:'networkidle'})
await mobile.getByRole('button',{name:'二维审图'}).click()
await mobile.locator('.layout-grid').waitFor()
await mobile.getByRole('button',{name:/标准淋浴 · 沿墙通道型/}).click()
await mobile.locator('.model-canvas-wrap canvas').waitFor()
await mobile.waitForTimeout(700)
await mobile.screenshot({path:'evidence/agen42-measurement-layout/mobile-standard-shower.png',fullPage:true})
await mobile.locator('.model-canvas-wrap canvas').screenshot({path:'evidence/agen42-measurement-layout/mobile-standard-shower-canvas.png'})
const mobileResult = await mobile.evaluate(() => {
  const canvas = document.querySelector('.model-canvas-wrap canvas')
  const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
  let nonZeroPixels = 0
  if (canvas && gl) {
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 24) nonZeroPixels += 1
  }
  return { canvasWidth: canvas?.width ?? 0, canvasHeight: canvas?.height ?? 0, nonZeroPixels, scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }
})
await mobile.close()
const result = await page.evaluate(({thumbnails,sceneCounts}) => ({ thumbnails, sceneCounts, canvas:!!document.querySelector('.model-canvas-wrap canvas') }), {thumbnails,sceneCounts})
await browser.close()
if (result.thumbnails !== 9 || captureIndex !== scenarios.length * layouts.length || !Object.values(sceneCounts).every((counts) => counts.length === layouts.length && counts.every((count) => count > 0)) || mobileResult.canvasWidth === 0 || mobileResult.canvasHeight === 0 || mobileResult.nonZeroPixels === 0 || mobileResult.scrollWidth > mobileResult.viewportWidth) throw new Error(JSON.stringify({result,mobileResult}))
console.log(JSON.stringify({result,mobileResult}))
