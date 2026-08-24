import { describe, expect, it } from 'vitest'
import { manualRoom } from './spec'
import { routePlumbing } from './plumbing'

describe('routePlumbing',()=>{
  it('creates red/blue orthogonal ceiling routes with one manifold',()=>{
    const spec=manualRoom(3200,2400,2600)
    spec.fixtures.push(
      {id:'basin-cold',kind:'water',label:'台盆冷水',x_mm:200,z_mm:500,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1,bound_wall_index:3},
      {id:'basin-hot',kind:'water',label:'台盆热水',x_mm:200,z_mm:650,width_mm:40,depth_mm:40,height_mm:40,elevation_mm:500,rotation_deg:0,source:'user',confidence:1,bound_wall_index:3},
    )
    const route=routePlumbing(spec)!
    expect(new Set(route.segments.map(item=>item.temperature))).toEqual(new Set(['cold','hot']))
    expect(route.segments.every(item=>item.from.x_mm===item.to.x_mm||item.from.z_mm===item.to.z_mm||item.from.y_mm===item.to.y_mm)).toBe(true)
    expect(route.segments.filter(item=>item.id.endsWith('-drop'))).toHaveLength(2)
  })
})
