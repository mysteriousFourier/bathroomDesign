import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const outputDir = path.resolve('.tmp/ui-qa')
await fs.mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--no-sandbox'],
})

const combos = []
for (const skin of ['magazine', 'toolkit']) {
  for (const theme of ['light', 'dark']) {
    combos.push({ skin, theme, viewport: { width: 1440, height: 900 }, label: `${skin}-${theme}-desktop` })
  }
}
combos.push({ skin: 'magazine', theme: 'light', viewport: { width: 768, height: 1024 }, label: 'magazine-light-mobile' })
combos.push({ skin: 'toolkit', theme: 'dark', viewport: { width: 768, height: 1024 }, label: 'toolkit-dark-mobile' })

const results = []

async function capture({ skin, theme, viewport, label }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))

  await page.addInitScript(([s, t]) => {
    localStorage.setItem('liangjie-skin', s)
    localStorage.setItem('liangjie-theme', t)
  }, [skin, theme])

  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
  await page.locator('.project-heading strong').waitFor()
  const title = await page.locator('.project-heading strong').textContent()
  if (!title || title === '未选择项目') throw new Error(`${label}: 项目未加载`)

  const applied = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    skin: document.documentElement.dataset.skin,
    setting: document.documentElement.dataset.themeSetting,
  }))
  if (applied.skin !== skin || applied.theme !== theme) {
    throw new Error(`${label}: appearance mismatch ${JSON.stringify(applied)}`)
  }

  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(outputDir, `${label}-2d.png`), fullPage: true })

  if (label.endsWith('desktop')) {
    await page.getByRole('button', { name: '三维预览' }).click()
    const canvas = page.locator('canvas')
    await canvas.waitFor({ state: 'visible' })
    await page.waitForTimeout(1200)
    const pixels = await canvas.evaluate((el) => {
      const gl = el.getContext('webgl2') || el.getContext('webgl')
      if (!gl) return { unique: 0, error: 'no-webgl' }
      const data = new Uint8Array(el.width * el.height * 4)
      gl.readPixels(0, 0, el.width, el.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
      const colors = new Set()
      const stride = Math.max(4, Math.floor(data.length / 12000 / 4) * 4)
      for (let i = 0; i < data.length; i += stride) {
        colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`)
        if (colors.size > 40) break
      }
      return { width: el.width, height: el.height, unique: colors.size, error: null }
    })
    if (pixels.error || pixels.unique < 8) throw new Error(`${label}: 3D canvas failed ${JSON.stringify(pixels)}`)
    await page.screenshot({ path: path.join(outputDir, `${label}-3d.png`), fullPage: true })
    results.push({ label, canvas: pixels })
  }

  if (errors.length) throw new Error(`${label} console errors: ${errors.join(' | ')}`)
  await context.close()
  results.push({ label, ok: true })
}

for (const combo of combos) await capture(combo)

// Interaction check: click header switchers (atelier skin, start light -> dark via button)
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
  await page.locator('.project-heading strong').waitFor()

  await page.getByRole('button', { name: '深色', exact: true }).click()
  const afterTheme = await page.evaluate(() => document.documentElement.dataset.theme)
  if (afterTheme !== 'dark') throw new Error(`主题切换失败: ${afterTheme}`)

  await page.getByRole('button', { name: '工具', exact: true }).click()
  const afterSkin = await page.evaluate(() => document.documentElement.dataset.skin)
  if (afterSkin !== 'toolkit') throw new Error(`版式切换失败: ${afterSkin}`)

  await page.getByRole('button', { name: '系统', exact: true }).click()
  const setting = await page.evaluate(() => document.documentElement.dataset.themeSetting)
  if (setting !== 'system') throw new Error(`系统模式切换失败: ${setting}`)

  // system follows OS: emulate dark OS preference
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  const sysTheme = await page.evaluate(() => document.documentElement.dataset.theme)
  if (sysTheme !== 'dark') throw new Error(`系统跟随失败(暗): ${sysTheme}`)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(300)
  const sysTheme2 = await page.evaluate(() => document.documentElement.dataset.theme)
  if (sysTheme2 !== 'light') throw new Error(`系统跟随失败(亮): ${sysTheme2}`)

  if (errors.length) throw new Error(`交互检查控制台错误: ${errors.join(' | ')}`)
  await context.close()
  results.push({ label: 'interaction', ok: true, checks: ['theme-button', 'skin-button', 'system-follow'] })
}

console.log(JSON.stringify({ ok: true, results, outputDir }, null, 2))
await browser.close()
