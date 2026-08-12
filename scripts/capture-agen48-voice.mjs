import { chromium } from 'playwright-core'

const room={schema_version:'1.0',name:'语音通话验收卫生间',boundary:[{x_mm:0,z_mm:0},{x_mm:2400,z_mm:0},{x_mm:2400,z_mm:2000},{x_mm:0,z_mm:2000}],height_mm:2400,wall_thickness_mm:100,openings:[],fixtures:[],observations:[],issues:[],confirmed:true}
const project={id:'voice-demo',name:'需求助手语音验收',status:'confirmed',created_at:'2026-08-12T00:00:00Z',updated_at:'2026-08-12T00:00:00Z',spec:room,measurement:null,assets:[]}
const messages=[{id:'hello',role:'assistant',content:'您好，我是小和。我会读取主界面量房数据，您可以直接告诉我使用人群、功能、风格和预算。',quote:null,created_at:'2026-08-12T00:00:00Z'},{id:'user',role:'user',content:'给父母用，希望防滑，也需要扶手。',quote:null,created_at:'2026-08-12T00:01:00Z'},{id:'reply',role:'assistant',content:'明白，我记下了父母使用、防滑和扶手需求。平时还需要淋浴、坐便和洗漱吗？',quote:null,created_at:'2026-08-12T00:01:01Z'}]
const session={id:'voice-session',project_id:project.id,title:'父母适老需求',message_count:messages.length,last_message:messages.at(-1).content,created_at:'2026-08-12T00:00:00Z',updated_at:'2026-08-12T00:01:01Z',messages}
const browser=await chromium.launch({executablePath:'/home/node3/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1})
await page.route('**/api/health',route=>route.fulfill({json:{ok:true,ai_configured:true,chat_configured:true,model:'vision-model',chat_model:'chat-model',ocr_configured:true}}))
await page.route('**/api/projects',route=>route.fulfill({json:[project]}))
await page.route('**/api/projects/voice-demo/chat-sessions',route=>route.fulfill({json:[session]}))
await page.route('**/api/projects/voice-demo/chat-sessions/voice-session',route=>route.fulfill({json:session}))
await page.goto('http://127.0.0.1:5173',{waitUntil:'networkidle'})
await page.getByRole('button',{name:'Chat'}).click()
await page.getByRole('button',{name:'进入语音通话'}).click()
await page.getByText('正在与小和通话').waitFor()
await page.screenshot({path:'evidence/agen48-voice-connected.png',fullPage:true})
await page.getByRole('button',{name:'挂断',exact:true}).click()
await page.getByText('语音通话已结束，本次问答已保存到当前对话').waitFor()
await page.screenshot({path:'evidence/agen48-voice-ended.png',fullPage:true})
await browser.close()
