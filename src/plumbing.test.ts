import { describe, expect, it } from 'vitest'
import { manualRoom } from './spec'
import { routePlumbing } from './plumbing'

describe('routePlumbing',()=>{
  it('creates red/blue orthogonal ceiling routes from the door and heater outlet',()=>{
    const spec=manualRoom(3200,2400,2600)
    spec.openings.push({id:'door',kind:'door',wall_index:0,offset_mm:400,width_mm:800,height_mm:2100,sill_mm:0,label:'入户门',source:'user',confidence:1})
    spec.fixtures.push(
      {id:'basin-cold',kind:'water',label:'台盆冷水',x_mm:200,z_mm:500,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1,bound_wall_index:3},
      {id:'basin-hot',kind:'water',label:'台盆热水',x_mm:200,z_mm:650,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1,bound_wall_index:3},
      {id:'heater-outlet',kind:'water',label:'热水器热水出水角阀',x_mm:2800,z_mm:2200,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:1500,rotation_deg:0,source:'user',confidence:1,bound_wall_index:2},
    )
    const route=routePlumbing(spec)!
    expect(route.inlet).toEqual({x_mm:800,z_mm:0,y_mm:2540})
    expect(route.supply_origin).toEqual({x_mm:800,z_mm:-300,y_mm:2540})
    const penetration=route.segments.slice(0,2)
    expect(penetration.map(item=>[item.from.x_mm,item.from.z_mm,item.to.x_mm,item.to.z_mm])).toEqual([
      [800,-300,800,0],
      [800,0,800,300],
    ])
    expect(new Set(route.segments.map(item=>item.temperature))).toEqual(new Set(['cold','hot']))
    expect(route.segments.every(item=>Number(item.from.x_mm!==item.to.x_mm)+Number(item.from.z_mm!==item.to.z_mm)+Number(item.from.y_mm!==item.to.y_mm)===1)).toBe(true)
    expect(route.segments.filter(item=>item.id.endsWith('-drop'))).toHaveLength(2)
    expect(route.warnings).toEqual([])
  })

  it.each([
    {wall:0,offset:400,axis:'z'},
    {wall:1,offset:500,axis:'x'},
    {wall:2,offset:400,axis:'z'},
    {wall:3,offset:500,axis:'x'},
  ] as const)('crosses door wall $wall perpendicular to its plane',({wall,offset,axis})=>{
    const spec=manualRoom(3200,2400,2600)
    spec.openings.push({id:'door',kind:'door',wall_index:wall,offset_mm:offset,width_mm:800,height_mm:2100,sill_mm:0,label:'门',source:'user',confidence:1})
    spec.fixtures.push({id:'basin-cold',kind:'water',label:'台盆冷水',x_mm:1600,z_mm:1200,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1})
    const [outside,inside]=routePlumbing(spec)!.segments
    expect(outside.to).toEqual(inside.from)
    expect(axis==='x'?outside.from.z_mm:outside.from.x_mm).toBe(axis==='x'?outside.to.z_mm:outside.to.x_mm)
    expect(axis==='x'?inside.from.z_mm:inside.from.x_mm).toBe(axis==='x'?inside.to.z_mm:inside.to.x_mm)
  })

  it('never throws during 3D render when a hot point has no heater outlet',()=>{
    const spec=manualRoom(1840,2585,2610)
    spec.fixtures.push({id:'shower-hot',kind:'water',label:'花洒热水',x_mm:100,z_mm:1900,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:1100,rotation_deg:0,source:'user',confidence:1,bound_wall_index:3})
    expect(()=>routePlumbing(spec)).not.toThrow()
    expect(routePlumbing(spec)?.warnings).toEqual(['存在热水点位但没有热水器出水角阀，热水管暂不生成'])
  })

  it('renders a shared physical trunk once instead of stacking duplicate meshes',()=>{
    const spec=manualRoom(3200,2400,2600)
    spec.fixtures.push(
      {id:'cold-a',kind:'water',label:'冷水 A',x_mm:2800,z_mm:400,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1},
      {id:'cold-b',kind:'water',label:'冷水 B',x_mm:2800,z_mm:800,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1},
    )
    const route=routePlumbing(spec)!
    const keys=route.segments.map((item)=>{const ends=[`${item.from.x_mm},${item.from.y_mm},${item.from.z_mm}`,`${item.to.x_mm},${item.to.y_mm},${item.to.z_mm}`].sort();return `${item.temperature}:${ends.join('|')}`})
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps cold and hot manifolds independent and inside the finished ceiling plane',()=>{
    const spec=manualRoom(3200,2400,2600)
    spec.fixtures.push(
      {id:'basin-cold',kind:'water',label:'台盆冷水',x_mm:250,z_mm:400,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1},
      {id:'basin-hot',kind:'water',label:'台盆热水',x_mm:2700,z_mm:2100,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1},
      {id:'heater',kind:'other',label:'热水器',x_mm:2700,z_mm:300,width_mm:720,depth_mm:180,height_mm:430,elevation_mm:1800,rotation_deg:0,source:'derived',confidence:1},
    )
    const route=routePlumbing(spec)!
    expect(route.manifold_wall_index).toBeNull()
    expect(route.cold_manifold.y_mm).toBe(2540)
    expect(route.hot_manifold?.y_mm).toBe(2540)
    expect(route.cold_manifold.x_mm).not.toBe(0)
    expect(route.cold_manifold.z_mm).not.toBe(0)
    expect(route.segments.filter(item=>item.temperature==='hot').some(item=>item.id.startsWith('hot-source-rise'))).toBe(true)
    expect(route.segments.filter(item=>item.id.endsWith('-drop')).map(item=>item.fixture_id).sort()).toEqual(['basin-cold','basin-hot'])
  })
})
