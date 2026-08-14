import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const modelPath = process.env.MODEL_PATH
if (!modelPath) throw new Error('MODEL_PATH must point to a local test model')

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 })
page.on('response', async (response) => { if (response.url().includes('/orientation/auto')) console.log(JSON.stringify({ status: response.status(), response: await response.text() })) })
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
const create = page.getByRole('button', { name: /创建|新建/ }).first()
if (await create.count()) {
  await create.click()
  await page.waitForTimeout(500)
  const input = page.locator('input').first()
  if (await input.count()) await input.fill('模型方向验收项目')
  const confirm = page.getByRole('button', { name: /创建|确定|保存/ }).last()
  if (await confirm.count()) await confirm.click()
  await page.waitForTimeout(900)
}
const modelLibrary = page.getByRole('button', { name: '模型库', exact: true }).first()
const establish = page.getByTitle('建立空间')
if (await establish.count()) { await establish.click(); await page.waitForTimeout(500) }
if (await modelLibrary.count()) await modelLibrary.click()
await page.waitForTimeout(1200)
const modelInput = page.locator('.model-import-zone input[type=file]').first()
await modelInput.setInputFiles(modelPath)
await page.waitForTimeout(1800)
console.log(JSON.stringify(await page.locator('.model-browser canvas').evaluate((canvas) => { const value = canvas.toDataURL('image/jpeg', .86); return { width: canvas.width, height: canvas.height, prefix: value.slice(0, 30), length: value.length } })))
const autoButton = page.getByRole('button', { name: /一键纠正/ })
await autoButton.click()
await page.waitForTimeout(8000)
await fs.mkdir('evidence/agen47-4-model-orientation', { recursive: true })
await page.screenshot({ path: 'evidence/agen47-4-model-orientation/model-library-orientation.png', fullPage: true })
await page.getByRole('button', { name: '侧面', exact: true }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: 'evidence/agen47-4-model-orientation/model-library-manual-side.png', fullPage: true })
console.log(JSON.stringify({ title: await page.title(), url: page.url(), modelLibraryVisible: await page.getByText('模型库', { exact: true }).count(), oneClickVisible: await page.getByRole('button', { name: /一键纠正/ }).count(), corrected: await page.getByText(/视觉自动纠正完成/).count(), body: (await page.locator('body').innerText()).slice(-1400) }))
await browser.close()
