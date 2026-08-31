import { describe, expect, it } from 'vitest'
import { manualRoom } from './spec'
import { routePlumbing } from './plumbing'
import type { FixtureSpec } from './types'

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
    expect(route.inlet).toEqual({x_mm:800,z_mm:0,y_mm:2760})
    expect(route.supply_origin).toEqual({x_mm:800,z_mm:-300,y_mm:2760})
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

  it('uses a single ceiling manifold with a 6/8-port count and no hot manifold',()=>{
    const spec=manualRoom(3200,2400,2600)
    spec.fixtures.push(
      {id:'basin-cold',kind:'water',label:'台盆冷水',x_mm:250,z_mm:400,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1},
      {id:'basin-hot',kind:'water',label:'台盆热水',x_mm:2700,z_mm:2100,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1},
      {id:'heater',kind:'other',label:'热水器',x_mm:2700,z_mm:300,width_mm:720,depth_mm:180,height_mm:430,elevation_mm:1800,rotation_deg:0,source:'derived',confidence:1},
    )
    const route=routePlumbing(spec)!
    expect(route.manifold_wall_index).toBeNull()
    expect(route.cold_manifold.y_mm).toBeGreaterThan(spec.height_mm!)
    expect(route.hot_manifold).toBeNull()
    expect(route.manifold_ports).toBe(6)
    expect(route.cold_manifold.x_mm).not.toBe(0)
    expect(route.cold_manifold.z_mm).not.toBe(0)
    expect(route.segments.filter(item=>item.temperature==='hot').some(item=>item.id.startsWith('hot-source-rise'))).toBe(true)
    expect(route.segments.filter(item=>item.id.endsWith('-drop')).map(item=>item.fixture_id).sort()).toEqual(['basin-cold','basin-hot'])
    const heater = spec.fixtures.find(item => item.id === 'heater')!
    const heaterHalfX = heater.width_mm / 2 + 75 + 13
    const heaterHalfZ = heater.depth_mm / 2 + 75 + 13
    route.segments.filter(item => item.temperature === 'hot').forEach((item) => {
      if (item.from.y_mm !== item.to.y_mm && item.from.x_mm === item.to.x_mm && item.from.z_mm === item.to.z_mm) {
        expect(Math.abs(item.from.x_mm - heater.x_mm) > heaterHalfX || Math.abs(item.from.z_mm - heater.z_mm) > heaterHalfZ).toBe(true)
      }
    })
  })

  it('serves more than six cold outlets with an 8-port manifold',()=>{
    const spec=manualRoom(3200,2400,2600)
    for(let index=0;index<7;index+=1){
      spec.fixtures.push({id:`cold-${index}`,kind:'water',label:`冷水点 ${index}`,x_mm:300+index*380,z_mm:2200,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:400,rotation_deg:0,source:'user',confidence:1})
    }
    const route=routePlumbing(spec)!
    expect(route.manifold_ports).toBe(8)
  })

  it('balances horizontal paths without allowing fixture elevations to move the manifold',()=>{
    const spec=manualRoom(4000,2000,2400)
    spec.openings.push({id:'door',kind:'door',wall_index:0,offset_mm:1600,width_mm:800,height_mm:2050,sill_mm:0,label:'D1',source:'measured',confidence:1})
    spec.fixtures.push(
      {id:'cold-low',kind:'water',label:'低位冷水',x_mm:600,z_mm:1000,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:100,rotation_deg:0,source:'user',confidence:1},
      {id:'cold-high',kind:'water',label:'高位冷水',x_mm:3400,z_mm:1000,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:2000,rotation_deg:0,source:'user',confidence:1},
    )
    const route=routePlumbing(spec)!
    expect(route.fixture_paths).toHaveLength(2)
    expect(route.balanced).toBe(true)
    expect(route.imbalance_ratio).toBeLessThanOrEqual(0.1)
    const lengths=route.fixture_paths.map(item=>item.length_mm)
    expect((Math.max(...lengths)-Math.min(...lengths))/Math.min(...lengths)).toBeLessThanOrEqual(0.1)
    const physicalLengths=route.fixture_paths.map(item=>item.physical_length_mm)
    expect(Math.max(...physicalLengths)-Math.min(...physicalLengths)).toBeGreaterThan(1000)
  })

  it('routes ceiling pipes around device footprints while walls stay passable',()=>{
    const spec=manualRoom(3200,2400,2600)
    spec.openings.push({id:'door',kind:'door',wall_index:0,offset_mm:400,width_mm:800,height_mm:2100,sill_mm:0,label:'入户门',source:'user',confidence:1})
    // A tall cabinet sitting exactly on the direct line between the door and the outlet.
    spec.fixtures.push(
      {id:'cabinet',kind:'vanity',label:'浴室柜',x_mm:800,z_mm:1200,width_mm:600,depth_mm:560,height_mm:900,elevation_mm:0,rotation_deg:0,source:'user',confidence:1},
      {id:'basin-cold',kind:'water',label:'台盆冷水',x_mm:2800,z_mm:1200,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1},
    )
    const route=routePlumbing(spec)!
    const horizontal=route.segments.filter(item=>item.from.y_mm===item.to.y_mm)
    expect(horizontal.length).toBeGreaterThan(0)
    horizontal.forEach((item)=>{
      expect(crossesObstacle(item.from,item.to,cabinetFixture(spec))).toBe(false)
    })
  })

  it('keeps every appliance connection vertical and uses the heater projection for the hot riser', () => {
    const spec = manualRoom(3200, 2400, 2600)
    spec.fixtures.push(
      { id:'heater', kind:'other', label:'热水器', x_mm:2800, z_mm:300, width_mm:720, depth_mm:180, height_mm:430, elevation_mm:1800, rotation_deg:0, source:'derived', confidence:1 },
      { id:'heater-hot', kind:'water', label:'热水器热水出水角阀', x_mm:2800, z_mm:300, width_mm:40, depth_mm:40, height_mm:40, elevation_mm:1800, rotation_deg:0, source:'user', confidence:1 },
      { id:'basin-hot-a', kind:'water', label:'台盆热水 A', x_mm:400, z_mm:2100, width_mm:40, depth_mm:40, height_mm:40, elevation_mm:500, rotation_deg:0, source:'user', confidence:1 },
      { id:'basin-hot-b', kind:'water', label:'台盆热水 B', x_mm:1200, z_mm:2100, width_mm:40, depth_mm:40, height_mm:40, elevation_mm:500, rotation_deg:0, source:'user', confidence:1 },
    )
    const route = routePlumbing(spec)!
    expect(route.hot_manifold).toBeTruthy()
    const hotDrops = route.segments.filter((item) => item.temperature === 'hot' && item.id.endsWith('-drop'))
    expect(hotDrops.map((item) => item.fixture_id).sort()).toEqual(['basin-hot-a', 'basin-hot-b'])
    hotDrops.forEach((item) => {
      expect(item.from.x_mm).toBe(item.to.x_mm)
      expect(item.from.z_mm).toBe(item.to.z_mm)
    })
    const riser = route.segments.find((item) => item.id === 'hot-source-rise')!
    expect(riser.from.x_mm).toBe(riser.to.x_mm)
    expect(riser.from.z_mm).toBe(riser.to.z_mm)
  })

  it('connects a wall terminal recorded on the finished face to its cabinet host', () => {
    const spec = manualRoom(2400, 1800, 2600)
    spec.fixtures.push(
      { id:'cabinet', kind:'vanity', label:'浴室柜', x_mm:1200, z_mm:300, width_mm:800, depth_mm:520, height_mm:900, elevation_mm:0, rotation_deg:0, source:'user', confidence:1, bound_wall_index:0 },
      { id:'cabinet-cold', kind:'water', label:'浴室柜冷水', x_mm:1200, z_mm:0, width_mm:40, depth_mm:40, height_mm:40, elevation_mm:500, rotation_deg:0, source:'user', confidence:1, bound_wall_index:0 },
    )
    const route = routePlumbing(spec)!
    expect(route.segments.some((item) => item.fixture_id === 'cabinet-cold' && item.from.x_mm === item.to.x_mm && item.from.z_mm === item.to.z_mm)).toBe(true)
  })

  it('retries outside the preferred center band when ceiling hardware blocks a complete shared network', () => {
    const spec = manualRoom(2135, 2150, 2400)
    spec.boundary = [
      { x_mm:0, z_mm:0 }, { x_mm:1790, z_mm:0 }, { x_mm:1790, z_mm:920 },
      { x_mm:2135, z_mm:920 }, { x_mm:2135, z_mm:2150 }, { x_mm:0, z_mm:2150 },
    ]
    spec.openings.push({ id:'door', kind:'door', wall_index:5, offset_mm:1205, width_mm:745, height_mm:2100, sill_mm:0, label:'D1', source:'user', confidence:1 })
    spec.fixtures.push(
      plumbingFixture('vanity', 'vanity', '浴室柜', 1600, 1850, 800, 520, 2000, { rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('toilet', 'toilet', '马桶', 1000, 1755, 380, 680, 760, { rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('shower-head', 'other', '花洒', 1508, 811, 285, 485, 1327, { elevation_mm:700, rotation_deg:90, bound_wall_index:1 }),
      plumbingFixture('heater', 'other', '热水器', 670, 1886, 781, 448, 525, { elevation_mm:1850, rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('ceiling-light', 'other', '浴霸', 1068, 1075, 600, 600, 120, { elevation_mm:2280, mounting_surface:'ceiling' }),
      plumbingFixture('washer', 'other', '洗衣机', 1332, 412, 608, 653, 860, { bound_wall_index:0 }),
      plumbingFixture('shower-cold', 'water', '花洒冷水点', 1755, 736, 40, 40, 10, { elevation_mm:1050, rotation_deg:90, bound_wall_index:1 }),
      plumbingFixture('shower-hot', 'water', '花洒热水点', 1755, 886, 40, 40, 10, { elevation_mm:1050, rotation_deg:90, bound_wall_index:1 }),
      plumbingFixture('toilet-water', 'water', '马桶进水阀', 800, 2115, 40, 40, 10, { elevation_mm:200, rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('heater-cold', 'water', '热水器冷水进水角阀', 745, 2115, 40, 40, 10, { elevation_mm:1850, rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('heater-hot', 'water', '热水器热水出水角阀', 595, 2115, 40, 40, 10, { elevation_mm:1850, rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('vanity-hot', 'water', '浴室柜热水进水点', 1525, 2115, 40, 40, 10, { elevation_mm:500, rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('vanity-cold', 'water', '浴室柜冷水进水点', 1675, 2115, 40, 40, 10, { elevation_mm:500, rotation_deg:180, bound_wall_index:4 }),
      plumbingFixture('washer-water', 'water', '洗衣机进水点', 1212, 35, 40, 40, 10, { elevation_mm:1050, bound_wall_index:0 }),
    )
    const route = routePlumbing(spec)!
    const expected = ['shower-cold', 'shower-hot', 'toilet-water', 'heater-cold', 'vanity-hot', 'vanity-cold', 'washer-water']
    expect(route.fixture_paths.map((item) => item.fixture_id).sort()).toEqual(expected.sort())
    expect(route.segments.filter((item) => item.id.endsWith('-drop')).map((item) => item.fixture_id).sort()).toEqual(expected.sort())
    expect(route.warnings).not.toContain('冷水吊顶分水器无法在家具碰撞约束下完成布管')
    expect(route.cold_manifold.x_mm).toBeGreaterThan(1750)
  })
})

function plumbingFixture(id: string, kind: FixtureSpec['kind'], label: string, x_mm: number, z_mm: number, width_mm: number, depth_mm: number, height_mm: number, extra: Partial<FixtureSpec> = {}): FixtureSpec {
  return { id, kind, label, x_mm, z_mm, width_mm, depth_mm, height_mm, elevation_mm:0, rotation_deg:0, source:'derived', confidence:1, ...extra }
}

function cabinetFixture(spec: ReturnType<typeof manualRoom>) {
  return spec.fixtures.find((fixture) => fixture.id === 'cabinet')!
}

function crossesObstacle(from: { x_mm: number; z_mm: number }, to: { x_mm: number; z_mm: number }, fixture: { x_mm: number; z_mm: number; width_mm: number; depth_mm: number }) {
  const halfX = fixture.width_mm / 2 + 75 + 13
  const halfZ = fixture.depth_mm / 2 + 75 + 13
  if (from.z_mm === to.z_mm) return from.z_mm >= fixture.z_mm - halfZ && from.z_mm <= fixture.z_mm + halfZ && Math.max(from.x_mm, to.x_mm) >= fixture.x_mm - halfX && Math.min(from.x_mm, to.x_mm) <= fixture.x_mm + halfX
  if (from.x_mm === to.x_mm) return from.x_mm >= fixture.x_mm - halfX && from.x_mm <= fixture.x_mm + halfX && Math.max(from.z_mm, to.z_mm) >= fixture.z_mm - halfZ && Math.min(from.z_mm, to.z_mm) <= fixture.z_mm + halfZ
  return false
}
