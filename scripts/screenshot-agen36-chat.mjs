import { chromium } from 'playwright-core'
import { existsSync, readFileSync } from 'node:fs'
const executablePath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].filter(Boolean).find(existsSync)
if(!executablePath)throw new Error('未找到 Chromium；请设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE')
const room={schema_version:'1.0',name:'量房测试卫生间',boundary:[{x_mm:0,z_mm:0},{x_mm:2400,z_mm:0},{x_mm:2400,z_mm:2000},{x_mm:0,z_mm:2000}],height_mm:2400,wall_thickness_mm:100,openings:[{id:'D1',kind:'door',wall_index:2,offset_mm:600,width_mm:800,height_mm:2000,sill_mm:0,label:'门',source:'measured',confidence:1}],fixtures:[],observations:[],issues:[],confirmed:true}
const project={id:'measure-demo',name:'2.4m × 2.0m 量房测试',status:'confirmed',created_at:'2026-08-04T00:00:00Z',updated_at:'2026-08-04T00:00:00Z',spec:room,measurement:null,assets:[]}
let replies=[
 {message:'已记录：父母使用，需要洗澡和坐便；适老场景已排除淋浴隔断。\n待确认：喜好风格、预期价格区间。您偏好素雅、轻法还是中古？预算大致是多少？',requirements:{collected:{使用人群:['父母'],功能需求:['洗澡','坐便'],喜好风格:[],预期价格区间:null},missing_fields:['喜好风格','预期价格区间'],complete:false}},
 {message:'我无法获得可靠的实时天气信息。我们接着确认方案：已记录中古风，目前只差预期价格区间。',requirements:{collected:{使用人群:['父母'],功能需求:['洗澡','坐便'],喜好风格:['中古'],预期价格区间:null},missing_fields:['预期价格区间'],complete:false}},
 {message:'需求已完整：父母使用；洗澡、坐便；中古风；预算 3 万元。适老约束下不配置淋浴隔断。当前知识图谱没有可用报价，因此我不会补造单价或总价。请确认是否按这份需求提交。',requirements:{collected:{使用人群:['父母'],功能需求:['洗澡','坐便'],喜好风格:['中古'],预期价格区间:'3万元'},missing_fields:[],complete:true}}
]
let dialogueInputs=['我爸妈使用，要洗澡和坐便','北京今天天气怎么样？我们喜欢中古风','预算3万元']
if(process.env.LIVE_DIALOGUE_JSON){const live=JSON.parse(readFileSync(process.env.LIVE_DIALOGUE_JSON,'utf8'));replies=live.results;dialogueInputs=live.inputs}
const browser=await chromium.launch({executablePath,headless:true,args:['--disable-crash-reporter','--disable-crashpad']});const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1});let turn=0
await page.route('**/api/health',route=>route.fulfill({json:{ok:true,ai_configured:true,model:'vision-model',chat_model:'chat-model',ocr_configured:true}}));await page.route('**/api/projects',route=>route.fulfill({json:[project]}))
await page.route('**/api/design-chat',route=>route.fulfill({json:{...replies[Math.min(turn++,replies.length-1)],surfaces:{source:'主界面量房 RoomSpec',floor_area_sqm:4.8,wall_gross_area_sqm:21.12,opening_area_sqm:1.6,wall_net_area_sqm:19.52,waste_rate:.1,floor_purchase_sqm:5.28,wall_purchase_sqm:21.47,floor_layout:'从里向门口直铺',wall_layout:'从左向右逐墙竖排',warnings:[]},quotes:[],equipment:{必须设备:['淋浴椅','花洒扶手','马桶扶手'],不能有的设备:['淋浴隔断']},products:[]}}))
await page.goto(process.env.CAPTURE_UI_BASE_URL||'http://127.0.0.1:5173',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Chat'}).click()
for(const input of dialogueInputs){await page.getByPlaceholder('描述家庭成员、功能、风格和预算…').fill(input);await page.getByRole('button',{name:'发送'}).click();await page.waitForTimeout(100)}
await page.getByText('需求采集：已完整，待确认提交').waitFor();await page.screenshot({path:process.env.CAPTURE_OUTPUT||'evidence/agen36-constraint-dialogue.png',fullPage:true});await browser.close()
