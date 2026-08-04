import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'
const candidates=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].filter(Boolean)
const executablePath=candidates.find(existsSync)
if(!executablePath)throw new Error('未找到 Chromium；请设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE')
const room={schema_version:'1.0',name:'量房测试卫生间',boundary:[{x_mm:0,z_mm:0},{x_mm:2400,z_mm:0},{x_mm:2400,z_mm:2000},{x_mm:0,z_mm:2000}],height_mm:2400,wall_thickness_mm:100,openings:[{id:'D1',kind:'door',wall_index:2,offset_mm:600,width_mm:800,height_mm:2000,sill_mm:0,label:'门',source:'measured',confidence:1}],fixtures:[],observations:[],issues:[],confirmed:true}
const project={id:'measure-demo',name:'2.4m × 2.0m 量房测试',status:'confirmed',created_at:'2026-08-04T00:00:00Z',updated_at:'2026-08-04T00:00:00Z',spec:room,measurement:null,assets:[]}
const browser=await chromium.launch({executablePath,headless:true})
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1})
await page.route('**/api/health',route=>route.fulfill({json:{ok:true,ai_configured:true,model:'vision-model',chat_model:'chat-model',ocr_configured:true}}))
await page.route('**/api/projects',route=>route.fulfill({json:[project]}))
await page.route('**/api/design-chat',async route=>{const body=route.request().postDataJSON();if(!body.room)throw new Error('聊天请求缺少主界面量房数据');await route.fulfill({json:{message:'我已按主界面量房数据计算，不需要您另报面积：地面净面积 4.80㎡；墙面毛面积 21.12㎡，扣除门洞 1.60㎡后净面积 19.52㎡。直铺预留 10% 后，地砖采购 5.28㎡、墙板采购 21.47㎡。\n\n排布：地砖 3000×1200mm 大板从里向门口排，按 1200mm 模数为 2 排；墙板从左到右逐墙竖排，600×3000mm 整板优先、末端收非标板。中古风 DB1-ZG 地砖按 340元/㎡估算 1795.20元，QB1-ZG 墙板按 80元/㎡估算 1717.60元，材料合计 3512.80元（不含辅料、施工及现场增损）。老人使用时不配置淋浴隔断。接下来请确认预算和是否需要淋浴椅、扶手。',surfaces:{source:'主界面量房 RoomSpec',floor_area_sqm:4.8,wall_gross_area_sqm:21.12,opening_area_sqm:1.6,wall_net_area_sqm:19.52,waste_rate:.1,floor_purchase_sqm:5.28,wall_purchase_sqm:21.47,floor_layout:'从里向门口直铺',wall_layout:'从左向右逐墙竖排',warnings:[]},equipment:{'必须设备':['淋浴椅','花洒扶手','马桶扶手'],'不能有的设备':['淋浴隔断']},products:[]}})})
await page.goto(process.env.CAPTURE_UI_BASE_URL||'http://127.0.0.1:5173',{waitUntil:'networkidle'})
await page.screenshot({path:'evidence/agen36-step-1-measured-room.png',fullPage:true})
await page.getByRole('button',{name:'Chat'}).click()
await page.getByTestId('chat-room-source').waitFor()
await page.screenshot({path:'evidence/agen36-step-2-read-measurement.png',fullPage:true})
await page.getByPlaceholder('描述家庭成员、功能、风格和预算…').fill('是我爸妈用，想弄得有点中古那味儿。洗澡坐便都得有。哎你说秋天去哪里玩好？预算我还没想明白。')
await page.screenshot({path:'evidence/agen36-step-3-natural-input.png',fullPage:true})
await page.getByRole('button',{name:'发送'}).click()
await page.getByText('材料合计 3512.80元',{exact:false}).waitFor()
await page.screenshot({path:'evidence/agen36-step-4-layout-quote.png',fullPage:true})
await browser.close()
