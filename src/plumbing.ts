import type { FixtureSpec, Point2D, RoomSpec } from './types'
import { finishedRoomBoundary, roomBounds } from './spec'

export type PipeTemperature = 'cold' | 'hot'
export type PipePoint = Point2D & { y_mm: number }
export type PipeSegment = { id: string; temperature: PipeTemperature; from: PipePoint; to: PipePoint; length_mm: number; fixture_id?: string }
export type PlumbingRoute = { inlet: PipePoint; manifold: PipePoint; segments: PipeSegment[]; total_mm: number; imbalance_mm: number }

const isHot = (fixture: FixtureSpec) => /热|hot/i.test(fixture.label) || fixture.id.includes('hot')
const isHeater = (fixture: FixtureSpec) => /热水器|heater/i.test(fixture.label) || fixture.kind === 'radiator'
const length = (a: PipePoint, b: PipePoint) => Math.abs(a.x_mm-b.x_mm)+Math.abs(a.y_mm-b.y_mm)+Math.abs(a.z_mm-b.z_mm)
const segment = (id:string, temperature:PipeTemperature, from:PipePoint, to:PipePoint, fixture_id?:string):PipeSegment => ({id,temperature,from,to,length_mm:length(from,to),fixture_id})

/** Deterministic ceiling-level orthogonal tree. One manifold is shared by every branch. */
export function routePlumbing(spec: RoomSpec): PlumbingRoute | null {
  const targets = spec.fixtures.filter((item) => item.kind === 'water' || isHeater(item))
  if (!targets.length) return null
  const boundary = finishedRoomBoundary(spec), bounds = roomBounds(boundary)
  const ceiling = Math.max(2200, (spec.height_mm ?? 2600)-120)
  const inlet:PipePoint = {x_mm:Math.round(bounds.minX-120),z_mm:Math.round((bounds.minZ+bounds.maxZ)/2),y_mm:ceiling}
  const xs = targets.map(item=>item.x_mm).sort((a,b)=>a-b), zs=targets.map(item=>item.z_mm).sort((a,b)=>a-b)
  const manifold:PipePoint = {x_mm:Math.round(xs[Math.floor(xs.length/2)]),z_mm:Math.round(zs[Math.floor(zs.length/2)]),y_mm:ceiling}
  const segments:PipeSegment[] = []
  const elbow:PipePoint = {...inlet,x_mm:manifold.x_mm}
  segments.push(segment('cold-inlet-x','cold',inlet,elbow),segment('cold-inlet-z','cold',elbow,manifold))
  const branchLengths:number[]=[]
  targets.forEach((target,index)=>{
    const temperature:PipeTemperature=isHot(target)?'hot':'cold'
    const above:PipePoint={x_mm:target.x_mm,z_mm:target.z_mm,y_mm:ceiling}
    // Fixed X-then-Z ordering is orthogonal and deterministic; paired hot/cold points retain their measured left/right placement.
    const bend:PipePoint={x_mm:above.x_mm,z_mm:manifold.z_mm,y_mm:ceiling}
    const a=segment(`${temperature}-${index}-x`,temperature,manifold,bend,target.id)
    const b=segment(`${temperature}-${index}-z`,temperature,bend,above,target.id)
    const drop=segment(`${temperature}-${index}-drop`,temperature,above,{...above,y_mm:Math.max(0,target.elevation_mm??0)},target.id)
    segments.push(a,b,drop); branchLengths.push(a.length_mm+b.length_mm+drop.length_mm)
  })
  const total_mm=segments.reduce((sum,item)=>sum+item.length_mm,0)
  return {inlet,manifold,segments,total_mm,imbalance_mm:Math.max(...branchLengths)-Math.min(...branchLengths)}
}
