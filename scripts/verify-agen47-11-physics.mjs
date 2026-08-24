import fs from 'node:fs/promises'
import { chromium } from 'playwright-core'

const spec = {
  schema_version:'1.0', name:'物理碰撞与吸附验收',
  boundary:[{x_mm:0,z_mm:0},{x_mm:3200,z_mm:0},{x_mm:3200,z_mm:2400},{x_mm:0,z_mm:2400}],
  height_mm:2600, wall_thickness_mm:200,
  openings:[{id:'door',kind:'door',wall_index:0,offset_mm:1200,width_mm:800,height_mm:2100,sill_mm:0,label:'D1',source:'user',confidence:1,opening_form:'hinged',swing_direction:'inward'}],
  fixtures:[
    {id:'heater',kind:'other',label:'热水器',x_mm:400,z_mm:1200,width_mm:700,depth_mm:300,height_mm:500,elevation_mm:1600,rotation_deg:270,source:'user',confidence:1,bound_wall_index:3},
    {id:'washer',kind:'appliance',label:'洗衣机',x_mm:2800,z_mm:1700,width_mm:600,depth_mm:650,height_mm:850,rotation_deg:90,source:'user',confidence:1,bound_wall_index:1},
    {id:'toilet',kind:'toilet',label:'马桶',x_mm:2400,z_mm:500,width_mm:500,depth_mm:700,height_mm:760,rotation_deg:180,source:'user',confidence:1,bound_wall_index:0},
    {id:'drain',kind:'floor_drain',point_usage:'shower',label:'淋浴地漏',x_mm:2800,z_mm:2100,width_mm:75,depth_mm:75,height_mm:10,rotation_deg:0,source:'user',confidence:1},
  ],
  dry_wet_zones:[{id:'wet',kind:'wet',label:'湿区',source:'user',confidence:1,boundary:[{x_mm:2300,z_mm:1500},{x_mm:3150,z_mm:1500},{x_mm:3150,z_mm:2350},{x_mm:2300,z_mm:2350}]}],
  observations:[], issues:[], confirmed:true,
}
const project={id:'physics-review',name:'物理碰撞与吸附验收',status:'ready',created_at:'2026-08-24T00:00:00Z',updated_at:'2026-08-24T00:00:00Z',spec,measurement:null,assets:[]}
let saved=null
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
const browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1500,height:980}})
await page.route('**/api/**',async route=>{
  const request=route.request(); const path=new URL(request.url()).pathname
  if(path==='/api/health')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,ai_configured:false,chat_configured:false})})
  if(path==='/api/projects'&&request.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([project])})
  if(path==='/api/projects/physics-review/spec'&&request.method()==='PUT'){
    saved=request.postDataJSON(); return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...project,spec:saved})})
  }
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(project)})
})
await page.goto('http://127.0.0.1:5173',{waitUntil:'networkidle'})
const close=page.getByRole('button',{name:'关闭'})
if(await close.count())await close.first().click()
await page.getByRole('button',{name:'二维审图'}).click()
await page.locator('.plan-canvas').waitFor()
await fs.mkdir('evidence/agen47-11-physics',{recursive:true})
await page.screenshot({path:'evidence/agen47-11-physics/before-drag.png',fullPage:true})
const heater=page.locator('.fixture-shape').first()
const box=await heater.boundingBox()
if(!box)throw new Error('heater fixture is not rendered')
await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
await page.mouse.down()
await page.mouse.move(2,2,{steps:8})
await page.mouse.up()
await page.waitForTimeout(300)
await page.getByRole('button',{name:'保存',exact:true}).click()
await page.waitForTimeout(200)
await page.screenshot({path:'evidence/agen47-11-physics/after-constrained-drag.png',fullPage:true})
const css=await page.locator('.plan-canvas').evaluate(element=>getComputedStyle(element).userSelect)
const moved=saved?.fixtures?.find(item=>item.id==='heater')
const result={fixtureCount:await page.locator('.fixture-shape').count(),wetHandles:await page.locator('.dry-wet-zone-handle').count(),userSelect:css,moved}
if(!moved||moved.x_mm<0||moved.z_mm<0||moved.bound_wall_index==null||css!=='none')throw new Error(JSON.stringify(result))
await browser.close()
console.log(JSON.stringify(result))
