import fs from 'node:fs/promises'
import { chromium } from 'playwright-core'

const raw=JSON.parse(await fs.readFile('evidence/measurement.json','utf8'))
const boundary=raw.boundary.map(p=>({x_mm:p.x,z_mm:p.y}))
const fixtures=raw.measurementPoints.map(p=>({id:p.pointId,kind:p.kind,label:p.label,x_mm:p.position.x,z_mm:p.position.y,width_mm:p.width,depth_mm:p.depth,height_mm:p.height,rotation_deg:p.rotation,point_usage:p.pointUsage,source:'measured',confidence:1}))
const spec={schema_version:'1.0',name:'真实量房自动布局验证',boundary,height_mm:raw.heights.roomHeight,wall_thickness_mm:200,openings:[{id:raw.openings[0].openingId,kind:'door',wall_index:1,offset_mm:400,width_mm:800,height_mm:2055,sill_mm:0,label:'D1',source:'measured',confidence:1}],fixtures,observations:[],issues:[],confirmed:true}
const project={id:'complete-layout',name:'完整技术链验证',status:'ready',created_at:'2026-08-11T00:00:00Z',updated_at:'2026-08-11T00:00:00Z',spec,measurement:null,assets:[]}
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--enable-webgl','--use-angle=swiftshader']})
const page=await browser.newPage({viewport:{width:1600,height:1100}})
const errors=[];page.on('pageerror',e=>{if(!/Could not load \/model-library/.test(e.message))errors.push(e.message)})
await page.route('**/api/**',route=>{const url=route.request().url(),body=url.endsWith('/api/health')?{ok:true,ai_configured:false,model:null}:url.endsWith('/api/projects')?[project]:project;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})})
await page.goto('http://127.0.0.1:5173',{waitUntil:'networkidle'})
await page.getByRole('button',{name:'二维审图'}).click();await page.getByRole('button',{name:'展开方案'}).click();await page.locator('.layout-grid').waitFor()
const cards=await page.locator('.layout-card').count(),blocking=await page.locator('.layout-card[data-blocking-count]:not([data-blocking-count="0"])').count(),method=await page.locator('.layout-method').innerText()
await page.getByRole('button',{name:/适老安全 · 左右分区型/}).click()
const scriptText=await page.locator('.layout-anchors').innerText()
await page.getByRole('button',{name:'执行自动布局并打开 3D'}).click();await page.locator('.model-canvas-wrap canvas').waitFor();await page.getByTestId('scene-fixture-summary').waitFor();await page.waitForTimeout(800)
const entities=await page.locator('[data-testid="scene-fixture-summary"] code').count();await fs.mkdir('evidence/agen47-complete-layout',{recursive:true});await page.screenshot({path:'evidence/agen47-complete-layout/requirement-script-solver-3d.png',fullPage:true})
await browser.close()
const result={cards,blocking,entities,method,scriptText,unexpectedErrors:errors};if(cards!==9||blocking!==0||entities<7||!scriptText.includes('layout-script-v1')||!scriptText.includes('求解：')||errors.length)throw new Error(JSON.stringify(result));console.log(JSON.stringify(result))
