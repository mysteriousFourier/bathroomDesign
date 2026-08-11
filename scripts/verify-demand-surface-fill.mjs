import { chromium, firefox } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const room = { schema_version: '1.0', name: '板块排布可视验收房间', boundary: [{ x_mm: 0, z_mm: 0 }, { x_mm: 4800, z_mm: 0 }, { x_mm: 4800, z_mm: 3600 }, { x_mm: 0, z_mm: 3600 }], height_mm: 3200, wall_thickness_mm: 100, openings: [], fixtures: [], observations: [], issues: [], confirmed: true }
const project = { id: 'surface-demo', name: '墙板地砖自动填充验收', status: 'confirmed', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z', spec: room, measurement: null, assets: [] }
const response = {
  message: '需求已齐，按清爽素雅风格和舒适预算生成材料清单，墙板与地砖已可应用到三维房间。',
  requirements: { collected: { 使用人群: ['成人'], 功能需求: ['淋浴'], 喜好风格: ['素雅'], 预期价格区间: '2万元' }, missing_fields: [], complete: true },
  style_match: { user_terms: ['清爽'], catalog_style: '素雅', confidence: 1, status: 'mapped', candidates: [], resolver_version: 'test' },
  surfaces: { source: '量房', floor_area_sqm: 4.8, ceiling_area_sqm: 4.8, wall_gross_area_sqm: 22.88, opening_area_sqm: 0, wall_net_area_sqm: 22.88, waste_rate: .1, floor_purchase_sqm: 5.28, ceiling_purchase_sqm: 5.28, wall_purchase_sqm: 25.17, floor_layout: '', ceiling_layout: '', wall_layout: '', warnings: [] },
  material_quotes: [
    { product_id: 'wall', 材料编号: 'QB2-SY', 材料名称: '墙板', 单价: 168, 单位: '㎡', 来源: '产品清单', 采购量: 25.17, 材料小计: 4228.56 },
    { product_id: 'floor', 材料编号: 'DB3-SY', 材料名称: '地砖', 单价: 128, 单位: '㎡', 来源: '产品清单', 采购量: 5.28, 材料小计: 675.84 },
  ],
  furniture_candidates: [],
  furniture_quotes: [
    { product_id: 'vanity', 材料编号: 'F-SY-01', 材料名称: '浴室柜', 家具名称: '浴室柜', 单价: 1880, 单位: '件', 数量: 1, 家具小计: 1880, 来源: '产品清单' },
  ],
  selected_furniture: [], material_total: 4904.4,
  furniture_price_range: { min: 1880, max: 1880 }, total_price_range: { min: 6784.4, max: 6784.4 }, furniture_total: 1880, quote_total: 6784.4,
  pricing_status: 'final', equipment: {}, products: [],
}

const sessionId = 'surface-demo-session'
const createdAt = '2026-08-10T00:00:00Z'
const greetingText = '你好，我会根据当前房型和量房信息协助整理需求与报价。'
let nextSessionNumber = 2
const sessions = new Map([[sessionId, createSessionRecord(sessionId)]])

function createSessionRecord(id) {
  const greeting = { id: `greeting-${id}`, role: 'assistant', content: greetingText, quote: null, created_at: createdAt }
  return {
    id, project_id: project.id, title: '新对话', message_count: 1,
    last_message: greeting.content, created_at: createdAt, updated_at: createdAt, messages: [greeting],
  }
}

function sessionSummary(session) {
  return {
    id: session.id, project_id: session.project_id, title: session.title,
    message_count: session.message_count, last_message: session.last_message,
    created_at: session.created_at, updated_at: session.updated_at,
  }
}

mkdirSync('reports/screenshots', { recursive: true })
const executablePath = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE ?? '/usr/bin/firefox'
const browserType = executablePath.includes('firefox') ? firefox : chromium
const browser = await browserType.launch({ executablePath, headless: true, args: browserType === chromium ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const consoleIssues = []
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(`${message.type()}: ${message.text()}`)
})
await page.route('**/api/health', route => route.fulfill({ json: { ok: true, ai_configured: true, chat_configured: true, model: 'test', chat_model: 'test' } }))
await page.route('**/api/projects', route => route.fulfill({ json: [project] }))
await page.route('**/api/projects/surface-demo/chat-sessions', async route => {
  if (route.request().method() === 'GET') return route.fulfill({ json: [...sessions.values()].reverse().map(sessionSummary) })
  const session = createSessionRecord(`surface-demo-session-${nextSessionNumber++}`)
  sessions.set(session.id, session)
  return route.fulfill({ status: 201, json: session })
})
await page.route(/\/api\/projects\/surface-demo\/chat-sessions\/[^/]+(?:\/messages)?$/, async route => {
  const segments = new URL(route.request().url()).pathname.split('/')
  const id = segments.at(-1) === 'messages' ? segments.at(-2) : segments.at(-1)
  const session = sessions.get(id)
  if (!session) return route.fulfill({ status: 404, json: { detail: '对话不存在' } })
  if (route.request().method() === 'DELETE') {
    sessions.delete(id)
    return route.fulfill({ status: 204, body: '' })
  }
  if (segments.at(-1) !== 'messages') return route.fulfill({ json: session })
  const payload = route.request().postDataJSON()
  const userMessage = { id: 'user-1', role: 'user', content: payload.content, quote: null, created_at: createdAt }
  const assistantMessage = { id: 'assistant-1', role: 'assistant', content: response.message, quote: response, created_at: createdAt }
  const updated = { ...session, title: payload.content.slice(0, 28), messages: [session.messages[0], userMessage, assistantMessage], message_count: 3, last_message: response.message, updated_at: '2026-08-10T00:01:00Z' }
  sessions.set(id, updated)
  return route.fulfill({ json: updated })
})
await page.goto(process.env.CAPTURE_UI_BASE_URL ?? 'http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: 'Chat' }).click()
await page.getByPlaceholder('描述家庭成员、功能、风格和预算…').fill('成人使用，要淋浴，喜欢清爽素雅，两万元以内。')
await page.screenshot({ path: 'reports/screenshots/agen-45-step-1-demand-input.png', fullPage: true })
await page.getByRole('button', { name: '发送' }).click()
await page.getByText('需求采集：已完整，已生成报价').waitFor()
await page.getByText(/需求方案材质已自动填充/).waitFor()
await page.getByTestId('quote-summary').getByText(/浴室柜/).waitFor()
await page.getByTestId('quote-summary').getByText(/报价合计 ¥6,784.40/).waitFor()
await page.screenshot({ path: 'reports/screenshots/agen-45-step-2-auto-filled.png', fullPage: true })
const firstSessionTitle = '成人使用，要淋浴，喜欢清爽素雅，两万元以内。'.slice(0, 28)
await page.getByRole('button', { name: '新建对话' }).click()
await page.locator('.chat-header-session').getByText('新对话', { exact: true }).waitFor()
if (await page.getByTestId('quote-summary').count() !== 0) throw new Error('新建对话错误继承了旧报价')
await page.locator('.chat-history-item').filter({ hasText: firstSessionTitle }).locator('.chat-history-open').click()
await page.getByTestId('quote-summary').getByText(/报价合计 ¥6,784.40/).waitFor()
await page.getByRole('button', { name: '删除对话：新对话' }).click()
await page.screenshot({ path: 'reports/screenshots/agen-45-step-2b-delete-confirm.png', fullPage: true })
await page.getByRole('button', { name: '确认删除' }).click()
await page.getByRole('button', { name: '删除对话：新对话' }).waitFor({ state: 'detached' })
await page.getByTestId('quote-summary').getByText(/报价合计 ¥6,784.40/).waitFor()
await page.locator('.design-chat header').getByRole('button', { name: '关闭' }).click()
await page.getByRole('button', { name: /三维预览/ }).click({ force: true })
await page.locator('canvas').waitFor()
await page.getByRole('button', { name: '关闭板缝加粗' }).waitFor()
if (await page.getByText(/板缝已加粗/).count() !== 1) throw new Error('板缝加粗状态未显示')
await page.waitForTimeout(1500)
await page.screenshot({ path: 'reports/screenshots/agen-45-step-3-textured-room.png', fullPage: true })
const textureRequests = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /surfaces\/(QB2-SY|DB3-SY)\/texture\.jpg/.test(name)))
await page.setViewportSize({ width: 390, height: 844 })
await page.getByRole('button', { name: 'Chat' }).click()
await page.locator('.chat-history-item').filter({ hasText: firstSessionTitle }).locator('.chat-history-open').click()
await page.getByTestId('quote-summary').waitFor()
const mobileLayout = await page.evaluate(() => {
  const chat = document.querySelector('.design-chat').getBoundingClientRect()
  const history = document.querySelector('.chat-history').getBoundingClientRect()
  const thread = document.querySelector('.chat-thread').getBoundingClientRect()
  const deleteButton = document.querySelector('.chat-history-delete').getBoundingClientRect()
  return {
    chatWithinViewport: chat.left >= 0 && chat.right <= innerWidth + 1 && chat.bottom <= innerHeight + 1,
    historyAboveThread: history.bottom <= thread.top + 1,
    quoteWithinThread: [...document.querySelectorAll('.quote-detail')].every(node => node.getBoundingClientRect().right <= thread.right + 1),
    deleteWithinHistory: deleteButton.left >= history.left && deleteButton.right <= history.right && deleteButton.bottom <= history.bottom,
  }
})
if (Object.values(mobileLayout).some(value => !value)) throw new Error(`手机布局越界：${JSON.stringify(mobileLayout)}`)
await page.screenshot({ path: 'reports/screenshots/agen-45-step-4-mobile-chat-history.png', fullPage: true })
await page.getByRole('button', { name: `删除对话：${firstSessionTitle}` }).click()
await page.getByRole('button', { name: '确认删除' }).click()
await page.locator('.chat-history-item.active').getByText('新对话', { exact: true }).waitFor()
if (await page.getByTestId('quote-summary').count() !== 0) throw new Error('删除当前会话后仍显示旧报价')
if (sessions.size !== 1 || [...sessions.values()][0].title !== '新对话') throw new Error('删除最后会话后未创建新的空白会话')
await browser.close()
if (textureRequests.length !== 2) throw new Error(`期望加载 2 个需求材质纹理，实际为 ${JSON.stringify(textureRequests)}`)
if (consoleIssues.length) throw new Error(`浏览器控制台存在问题：${JSON.stringify(consoleIssues)}`)
console.log(JSON.stringify({ screenshots: ['agen-45-step-1-demand-input.png', 'agen-45-step-2-auto-filled.png', 'agen-45-step-2b-delete-confirm.png', 'agen-45-step-3-textured-room.png', 'agen-45-step-4-mobile-chat-history.png'], textureRequests, mobileLayout }, null, 2))
