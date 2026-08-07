import { chromium, firefox } from 'playwright-core'
import { existsSync, readFileSync } from 'node:fs'
const executablePath=[process.env.PLAYWRIGHT_BROWSER_EXECUTABLE,process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/firefox'].filter(Boolean).find(existsSync)
if(!executablePath)throw new Error('未找到可用浏览器；请设置 PLAYWRIGHT_BROWSER_EXECUTABLE')
const room={schema_version:'1.0',name:'量房测试卫生间',boundary:[{x_mm:0,z_mm:0},{x_mm:2400,z_mm:0},{x_mm:2400,z_mm:2000},{x_mm:0,z_mm:2000}],height_mm:2400,wall_thickness_mm:100,openings:[{id:'D1',kind:'door',wall_index:2,offset_mm:600,width_mm:800,height_mm:2000,sill_mm:0,label:'门',source:'measured',confidence:1}],fixtures:[],observations:[],issues:[],confirmed:true}
const project={id:'measure-demo',name:'2.4m × 2.0m 量房测试',status:'confirmed',created_at:'2026-08-04T00:00:00Z',updated_at:'2026-08-04T00:00:00Z',spec:room,measurement:null,assets:[]}
let replies=[
 {message:'这次差点滑倒，确实应该先把安全处理好。目前我记下了是给父母用；他们洗澡或从马桶起身时，哪件事最费劲？',requirements:{collected:{使用人群:['父母'],功能需求:[],喜好风格:[],预期价格区间:null},missing_fields:['功能需求','喜好风格','预期价格区间'],complete:false}},
 {message:'明白，重点是湿地防滑、洗澡能坐着，起身也有地方借力。目前我记下了洗澡、坐便和扶手；家里有没有轮椅进出的需要？',requirements:{collected:{使用人群:['父母'],功能需求:['洗澡','坐便','扶手','坐浴'],喜好风格:[],预期价格区间:null},missing_fields:['喜好风格','预期价格区间'],complete:false}},
 {message:'那就按不影响走动、方便清洁来做，不上封闭淋浴隔断。目前安全需求清楚了；外观更想要明亮清爽、柔和温暖，还是沉稳复古？',requirements:{collected:{使用人群:['父母','轮椅'],功能需求:['洗澡','坐便','扶手','坐浴'],喜好风格:[],预期价格区间:null},missing_fields:['喜好风格','预期价格区间'],complete:false}},
 {message:'“别像医院、暖一点、好擦洗”更接近清单里的轻法，我会搭配通用的安全设备，不牺牲防滑和清洁。目前我记下了轻法；这次材料和家具加起来，预算大概想控制在哪个范围？',requirements:{collected:{使用人群:['父母','轮椅'],功能需求:['洗澡','坐便','扶手','坐浴'],喜好风格:['轻法'],预期价格区间:null},missing_fields:['预期价格区间'],complete:false}},
 {message:'可以，先按 2 万元以内控制，不为了凑预算增加设备。目前需求已齐：父母适老、轮椅通行、轻法、好清洁。家具不提前指定编号，按所有合规组合测算总价区间；请确认是否提交这版需求。',requirements:{collected:{使用人群:['父母','轮椅'],功能需求:['洗澡','坐便','扶手','坐浴'],喜好风格:['轻法'],预期价格区间:'2万元'},missing_fields:[],complete:true}}
]
let dialogueInputs=['给我爸妈弄的，前两天我妈洗完澡差点滑了一跤','主要是地上有水，她腿没劲，洗一会儿就累，马桶起来也要撑一下','轮椅偶尔用。地方本来就小，别弄一堆玻璃，水垢也难擦','我也说不清风格，反正别像医院，暖一点，但要好擦洗','两万以内吧，先看看材料家具一共多少，别为了花完硬塞东西']
if(process.env.LIVE_DIALOGUE_JSON){const live=JSON.parse(readFileSync(process.env.LIVE_DIALOGUE_JSON,'utf8'));replies=live.results;dialogueInputs=live.inputs}
const browserType=executablePath.includes('firefox')?firefox:chromium
const browser=await browserType.launch({executablePath,headless:true,args:browserType===chromium?['--disable-crash-reporter','--disable-crashpad']:[]});const page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1});let turn=0
await page.route('**/api/health',route=>route.fulfill({json:{ok:true,ai_configured:true,model:'vision-model',chat_model:'chat-model',ocr_configured:true}}));await page.route('**/api/projects',route=>route.fulfill({json:[project]}))
await page.route('**/api/design-chat',route=>{const index=Math.min(turn++,replies.length-1);route.fulfill({json:replies[index]})})
await page.goto(process.env.CAPTURE_UI_BASE_URL||'http://127.0.0.1:5173',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Chat'}).click()
for(const input of dialogueInputs){await page.getByPlaceholder('描述家庭成员、功能、风格和预算…').fill(input);await page.getByRole('button',{name:'发送'}).click();await page.waitForTimeout(100)}
await page.getByText('需求采集：已完整，待确认提交').waitFor();await page.getByText(/风格归一：轻法/).waitFor();await page.getByTestId('surface-areas').waitFor();const total=page.getByText(/总价区间：/);await total.waitFor();await total.scrollIntoViewIfNeeded();await page.screenshot({path:process.env.CAPTURE_OUTPUT||'evidence/agen36-furniture-price-range-dialogue.png',fullPage:true});await browser.close()
