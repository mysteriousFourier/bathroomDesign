import { chromium } from 'playwright-core'
import fs from 'node:fs/promises'

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const evidenceDir = process.env.EVIDENCE_DIR ?? 'evidence/agen54-model-orientation'
await fs.mkdir(evidenceDir, { recursive: true })

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
await page.goto(baseUrl, { waitUntil: 'networkidle' })
await page.getByTitle('建立空间').click()
await page.getByRole('button', { name: '模型库', exact: true }).first().click()
await page.getByText('SheenChair', { exact: true }).first().click()
await page.getByText('拖动旋转 · 滚轮缩放').waitFor()
await page.waitForTimeout(2500)
try { await fs.access(`${evidenceDir}/01-uploaded-pending.png`) }
catch { await page.screenshot({ path: `${evidenceDir}/01-uploaded-pending.png`, fullPage: true }) }

for (const [name, label] of [['front', '正面'], ['top', '顶面'], ['side', '侧面']]) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByText('人工纠正完成；可点击其他面重新纠正').waitFor()
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${evidenceDir}/0${name === 'front' ? 2 : name === 'top' ? 3 : 4}-${name}.png`, fullPage: true })
}
await page.getByRole('button', { name: '加入房间', exact: true }).click()
await page.getByText('SheenChair 已加入房间').waitFor()
await page.waitForTimeout(1800)
await page.screenshot({ path: `${evidenceDir}/05-room-placement.png`, fullPage: true })

const state = await page.evaluate(async () => {
  const projects = await (await fetch('/api/projects')).json()
  const project = projects.find((item) => item.name === 'AGEN-54 模型方向全量验证')
  const assets = await (await fetch(`/api/projects/${project.id}/model-assets`)).json()
  return { project: { id: project.id, name: project.name }, asset: assets.find((item) => item.label === 'SheenChair') }
})
await fs.writeFile(`${evidenceDir}/verification.json`, `${JSON.stringify(state, null, 2)}\n`)
console.log(JSON.stringify({ screenshots: 5, orientation_view: state.asset.orientation_view, orientation_source: state.asset.orientation_source, orientation_corrected: state.asset.orientation_corrected }))
await browser.close()
