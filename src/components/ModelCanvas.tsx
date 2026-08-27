import { ContactShadows, Edges, Grid, OrbitControls, PerspectiveCamera, useGLTF, useTexture } from '@react-three/drei'
import { Canvas, type ThreeEvent, useFrame, useLoader, useThree } from '@react-three/fiber'
import { ChevronLeft, ChevronRight, Eye, EyeOff, Focus, Layers, Move3d, ReceiptText, SquareDashed, Waves } from 'lucide-react'
import { Component, Suspense, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box3, BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, Group, Path, RepeatWrapping, Shape, SRGBColorSpace, Vector3 } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { resolvedModelOrientation } from '../modelOrientation'
import { uniformModelScale } from '../modelScale'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { finishedRoomBoundary, hiddenWallIndexesForCutaway, roomBounds, roomCentroid, sliceWallQuadByDistance, wallFinishGap, wallLayerQuads, wallLength } from '../spec'
import { physicalTextureTransform, physicalWorldTextureTransform } from '../surfaceTexture'
import { routePlumbing, type PipeSegment, type PlumbingRoute } from '../plumbing'
import type { FixtureModelAsset, FixtureSpec, Point2D, RoomSpec, Selection } from '../types'

export interface ModelCanvasHandle {
  exportGLB: (filename: string) => Promise<void>
}

type WallPart = { start: number; end: number; y: number; height: number }
type WallLayers = { finish: Point2D[]; cavity: Point2D[]; wall: Point2D[] }
type SurfaceMaterials = { wall?: { textureSrc: string; widthMm: number; heightMm: number }; floor?: { textureSrc: string; widthMm: number; depthMm: number; rotationDeg?:0|90; offsetXmm?:number; offsetZmm?:number; layoutDescription?:string } }

function wallPrismGeometry(quad: Point2D[], minY: number, maxY: number) {
  const geometry = new BufferGeometry()
  const vertices = [...quad.map((point) => [point.x_mm / 1000, minY / 1000, point.z_mm / 1000]), ...quad.map((point) => [point.x_mm / 1000, maxY / 1000, point.z_mm / 1000])].flat()
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1], 2))
  geometry.setIndex([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  geometry.computeVertexNormals()
  return geometry
}

function TexturedMaterial({ src, repeatX, repeatY, offsetX = 0, offsetY = 0, color = '#ffffff', opacity = 1, emphasizeJoints = false }: { src: string; repeatX: number; repeatY: number; offsetX?: number; offsetY?: number; color?: string; opacity?: number; emphasizeJoints?: boolean }) {
  const source = useTexture(src)
  const texture = useMemo(() => {
    let next = source.clone()
    if (emphasizeJoints && source.image) {
      const image = source.image as CanvasImageSource & { width: number; height: number }
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      if (context) {
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const jointWidth = Math.max(6, Math.round(Math.min(canvas.width, canvas.height) * 0.012))
        context.strokeStyle = 'rgba(45, 39, 31, 0.92)'
        context.lineWidth = jointWidth
        context.strokeRect(jointWidth / 2, jointWidth / 2, canvas.width - jointWidth, canvas.height - jointWidth)
        next.dispose()
        next = new CanvasTexture(canvas)
      }
    }
    next.wrapS = RepeatWrapping
    next.wrapT = RepeatWrapping
    next.repeat.set(repeatX, repeatY)
    next.offset.set(offsetX, offsetY)
    next.colorSpace = SRGBColorSpace
    next.needsUpdate = true
    return next
  }, [emphasizeJoints, offsetX, offsetY, repeatX, repeatY, source])
  useEffect(() => () => texture.dispose(), [texture])
  return <meshStandardMaterial color={color} map={texture} roughness={0.82} side={DoubleSide} transparent={opacity < 1} opacity={opacity} emissive="#f4f1e8" emissiveIntensity={0.08} />
}

function WallPrism({ quad, part, color, edge, onSelect, surface, emphasizeJoints, opacity = 1 }: { quad: Point2D[]; part: WallPart; color: string; edge: string; onSelect: () => void; surface?: SurfaceMaterials['wall']; emphasizeJoints?: boolean; opacity?: number }) {
  const geometry = useMemo(() => wallPrismGeometry(quad, part.y - part.height / 2, part.y + part.height / 2), [quad, part])
  const lengthMm = Math.hypot(quad[1].x_mm - quad[0].x_mm, quad[1].z_mm - quad[0].z_mm)
  const textureTransform = surface ? physicalTextureTransform(lengthMm, part.height, surface.widthMm, surface.heightMm, part.start, part.y - part.height / 2) : null
  return <mesh geometry={geometry} castShadow receiveShadow onClick={(event) => { event.stopPropagation(); onSelect() }}>
    {surface && textureTransform ? <TexturedMaterial src={surface.textureSrc} {...textureTransform} color={color} opacity={opacity} emphasizeJoints={emphasizeJoints} /> : <meshStandardMaterial color={color} roughness={0.84} side={DoubleSide} transparent={opacity < 1} opacity={opacity} />}
    <Edges color={edge} threshold={20} />
  </mesh>
}

function Wall({ spec, index, layers, selected, onSelect, surface, emphasizeJoints }: { spec: RoomSpec; index: number; layers: WallLayers; selected: boolean; onSelect: () => void; surface?: SurfaceMaterials['wall']; emphasizeJoints?: boolean }) {
  const lengthMm = wallLength(spec.boundary, index)
  const wallStart = spec.boundary[index]
  const wallEnd = spec.boundary[(index + 1) % spec.boundary.length]
  const heightMm = spec.height_mm ?? 2600
  const hasCavity = wallFinishGap(spec, index) > 0
  const openings = spec.openings.filter((opening) => opening.wall_index === index).sort((a, b) => a.offset_mm - b.offset_mm)
  const parts: WallPart[] = []
  let cursor = 0
  for (const opening of openings) {
    const begin = Math.max(cursor, Math.min(opening.offset_mm, lengthMm))
    const finish = Math.max(begin, Math.min(opening.offset_mm + opening.width_mm, lengthMm))
    if (begin > cursor) parts.push({ start: cursor, end: begin, y: heightMm / 2, height: heightMm })
    if (opening.sill_mm > 0) parts.push({ start: begin, end: finish, y: opening.sill_mm / 2, height: opening.sill_mm })
    const openingTop = opening.sill_mm + opening.height_mm
    if (openingTop < heightMm) parts.push({ start: begin, end: finish, y: (openingTop + heightMm) / 2, height: heightMm - openingTop })
    cursor = finish
  }
  if (cursor < lengthMm) parts.push({ start: cursor, end: lengthMm, y: heightMm / 2, height: heightMm })

  return (
    <group>
      {parts.map((part, partIndex) => (
        <WallPrism key={partIndex} quad={sliceWallQuadByDistance(layers.wall, wallStart, wallEnd, part.start, part.end)} part={part} color={selected ? '#d8c8a5' : '#e7e5df'} edge={selected ? '#8a6725' : '#b9bcb4'} onSelect={onSelect} />
      ))}
      {hasCavity && parts.map((part, partIndex) => (
        <WallPrism key={`cavity-${partIndex}`} quad={sliceWallQuadByDistance(layers.cavity, wallStart, wallEnd, part.start, part.end)} part={part} color="#8e9898" edge="#5d6969" onSelect={onSelect} opacity={0.28} />
      ))}
      {parts.map((part, partIndex) => (
        <WallPrism key={`finish-${partIndex}`} quad={sliceWallQuadByDistance(layers.finish, wallStart, wallEnd, part.start, part.end)} part={part} color="#f4f1e8" edge={selected ? '#8a6725' : '#c8c1b2'} onSelect={onSelect} surface={surface} emphasizeJoints={emphasizeJoints} />
      ))}
    </group>
  )
}

function CeilingZoneMesh({ boundary, heightMm }: { boundary: { x_mm: number; z_mm: number }[]; heightMm: number }) {
  const shape = useMemo(() => {
    const zone = new Shape()
    boundary.forEach((point, index) => {
      if (index === 0) zone.moveTo(point.x_mm / 1000, -point.z_mm / 1000)
      else zone.lineTo(point.x_mm / 1000, -point.z_mm / 1000)
    })
    zone.closePath()
    return zone
  }, [boundary])
  return <mesh position={[0, heightMm / 1000, 0]} rotation={[-Math.PI / 2, 0, 0]}>
    <shapeGeometry args={[shape]} />
    <meshStandardMaterial color="#d4c69f" roughness={0.9} side={DoubleSide} />
    <Edges color="#8a6725" />
  </mesh>
}

function FloorZoneMesh({ boundary }: { boundary: Point2D[] }) {
  const shape = useMemo(() => {
    const zone = new Shape()
    boundary.forEach((point, index) => index === 0 ? zone.moveTo(point.x_mm / 1000, -point.z_mm / 1000) : zone.lineTo(point.x_mm / 1000, -point.z_mm / 1000))
    zone.closePath()
    return zone
  }, [boundary])
  return <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
    <shapeGeometry args={[shape]} />
    <meshStandardMaterial color="#739bb6" transparent opacity={0.28} roughness={0.82} side={DoubleSide} />
    <Edges color="#47738f" />
  </mesh>
}

function ceilingCutoutPath(fixture: FixtureSpec) {
  const halfWidth = fixture.width_mm / 2
  const halfDepth = fixture.depth_mm / 2
  const angle = (fixture.rotation_deg ?? 0) * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const corners = [[-halfWidth, -halfDepth], [halfWidth, -halfDepth], [halfWidth, halfDepth], [-halfWidth, halfDepth]]
    .map(([x, z]) => ({ x_mm: fixture.x_mm + x * cos - z * sin, z_mm: fixture.z_mm + x * sin + z * cos }))
  const path = new Path()
  corners.forEach((point, index) => {
    const x = point.x_mm / 1000
    const y = -point.z_mm / 1000
    if (index === 0) path.moveTo(x, y)
    else path.lineTo(x, y)
  })
  path.closePath()
  return path
}

function modelAssetFormat(asset: FixtureModelAsset) {
  if (asset.format) return asset.format
  return /\.glb($|\?)/i.test(asset.src) ? 'glb' : 'gltf'
}

function NormalizedFixtureAsset({ fixture, selected, object }: { fixture: FixtureSpec; selected: boolean; object: Group }) {
  const { scene, scale, position } = useMemo(() => {
    const scene = object.clone(true)
    scene.rotation.copy(resolvedModelOrientation(fixture.model_asset?.orientation_mapping, fixture.model_asset?.orientation_view ?? null))
    scene.updateMatrixWorld(true)
    scene.traverse((child) => {
      if ('castShadow' in child) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
    const box = new Box3().setFromObject(scene)
    const size = new Vector3()
    const center = new Vector3()
    box.getSize(size)
    box.getCenter(center)
    // The outer fixture group applies rotation exactly once. Keep the model's
    // native proportions and use one scale only for unit/envelope fitting.
    const target = new Vector3(fixture.width_mm / 1000, fixture.height_mm / 1000, fixture.depth_mm / 1000)
    const scale = uniformModelScale(size, target)
    return {
      scene,
      scale,
      position: new Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale),
    }
  }, [fixture.depth_mm, fixture.height_mm, fixture.width_mm, fixture.model_asset?.orientation_mapping, fixture.model_asset?.orientation_view, object])

  return <>
    <primitive object={scene} position={position} scale={scale} />
    <mesh position={[0, 0.01, 0]} visible={selected}>
      <boxGeometry args={[fixture.width_mm / 1000, 0.02, fixture.depth_mm / 1000]} />
      <meshStandardMaterial color="#c89638" transparent opacity={0.22} />
      <Edges color="#8a6725" />
    </mesh>
  </>
}

function GltfFixtureAsset({ fixture, selected, src }: { fixture: FixtureSpec; selected: boolean; src: string }) {
  const gltf = useGLTF(src)
  return <NormalizedFixtureAsset fixture={fixture} selected={selected} object={gltf.scene} />
}

function FbxFixtureAsset({ fixture, selected, src }: { fixture: FixtureSpec; selected: boolean; src: string }) {
  const object = useLoader(FBXLoader, src)
  return <NormalizedFixtureAsset fixture={fixture} selected={selected} object={object} />
}

function TdsFixtureAsset({ fixture, selected, src }: { fixture: FixtureSpec; selected: boolean; src: string }) {
  const object = useLoader(TDSLoader, src)
  return <NormalizedFixtureAsset fixture={fixture} selected={selected} object={object} />
}

function ObjFixtureAsset({ fixture, selected, src }: { fixture: FixtureSpec; selected: boolean; src: string }) {
  const object = useLoader(OBJLoader, src)
  return <NormalizedFixtureAsset fixture={fixture} selected={selected} object={object} />
}

function WasherProxy({ fixture, selected, onSelect }: { fixture: FixtureSpec; selected: boolean; onSelect: (event: ThreeEvent<MouseEvent>) => void }) {
  const width = fixture.width_mm / 1000
  const depth = fixture.depth_mm / 1000
  const height = fixture.height_mm / 1000
  const outline = selected ? '#a46d13' : '#5d6668'
  const body = selected ? '#b9c3c5' : '#8f9a9d'
  return <>
    <mesh position={[0, height / 2, 0]} castShadow receiveShadow onClick={onSelect}>
      <boxGeometry args={[width, height, depth]} />
      <meshStandardMaterial color={body} metalness={0.2} roughness={0.38} />
      <Edges color={outline} />
    </mesh>
    <mesh position={[0, height * 0.82, depth / 2 + 0.006]} castShadow receiveShadow onClick={onSelect}>
      <boxGeometry args={[width * 0.88, height * 0.12, 0.012]} />
      <meshStandardMaterial color="#626d70" roughness={0.34} />
      <Edges color={outline} />
    </mesh>
    <mesh position={[0, height * 0.43, depth / 2 + 0.012]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow onClick={onSelect}>
      <cylinderGeometry args={[Math.min(width, height) * 0.29, Math.min(width, height) * 0.29, 0.018, 40]} />
      <meshStandardMaterial color="#263236" metalness={0.35} roughness={0.22} />
      <Edges color={outline} />
    </mesh>
    <mesh position={[0, height * 0.43, depth / 2 + 0.023]} rotation={[Math.PI / 2, 0, 0]} onClick={onSelect}>
      <torusGeometry args={[Math.min(width, height) * 0.25, Math.min(width, height) * 0.025, 12, 40]} />
      <meshStandardMaterial color="#c4ced0" metalness={0.5} roughness={0.2} />
    </mesh>
    <mesh position={[width * 0.29, height * 0.85, depth / 2 + 0.018]} onClick={onSelect}>
      <cylinderGeometry args={[Math.min(width, height) * 0.045, Math.min(width, height) * 0.045, 0.026, 24]} />
      <meshStandardMaterial color="#d9e0df" metalness={0.45} roughness={0.24} />
    </mesh>
  </>
}

function FixtureAssetModel({ fixture, selected }: { fixture: FixtureSpec; selected: boolean }) {
  const asset = fixture.model_asset
  if (!asset) return null
  const format = modelAssetFormat(asset)
  if (format === 'gltf' || format === 'glb') return <GltfFixtureAsset fixture={fixture} selected={selected} src={asset.src} />
  if (format === 'fbx') return <FbxFixtureAsset fixture={fixture} selected={selected} src={asset.src} />
  if (format === '3ds') return <TdsFixtureAsset fixture={fixture} selected={selected} src={asset.src} />
  if (format === 'obj') return <ObjFixtureAsset fixture={fixture} selected={selected} src={asset.src} />
  return null
}

class FixtureAssetBoundary extends Component<{fixture:FixtureSpec;children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return{failed:true}}componentDidCatch(){}render(){return this.state.failed ? null : this.props.children}}
class SceneBoundary extends Component<{children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return{failed:true}}componentDidCatch(error:Error){console.error('3D scene failed safely',error)}render(){return this.state.failed?<div className="empty-state" role="alert">三维场景加载失败，请检查点位或管网数据后重试；二维设计数据未丢失。</div>:this.props.children}}

function Fixture({ fixture, selected, onSelect }: { fixture: FixtureSpec; selected: boolean; onSelect: () => void }) {
  const width = fixture.width_mm / 1000
  const depth = fixture.depth_mm / 1000
  const height = fixture.height_mm / 1000
  const select = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect() }
  const outline = selected ? '#a46d13' : '#6f756c'
  const ceramic = selected ? '#f2dcae' : '#f2f1ec'
  const common = { castShadow: true, receiveShadow: true, onClick: select }
  // Product assets are the source of truth for the room overview. Selection
  // only changes the highlight; it must never switch every other fixture to a
  // box proxy. A per-asset error boundary below still keeps malformed imports
  // from taking down the complete scene.
  const renderModel = !!fixture.model_asset
  return (
    <group position={[fixture.x_mm / 1000, (fixture.elevation_mm ?? 0) / 1000, fixture.z_mm / 1000]} rotation={[0, -fixture.rotation_deg * Math.PI / 180, 0]} userData={{ id: fixture.id, kind: fixture.kind, source: fixture.source, model_asset: fixture.model_asset?.id }} onClick={select}>
      {!renderModel && /洗衣机/.test(fixture.label) && <WasherProxy fixture={fixture} selected={selected} onSelect={select} />}
      {renderModel && <FixtureAssetBoundary fixture={fixture}><FixtureAssetModel fixture={fixture} selected={selected} /></FixtureAssetBoundary>}
      {!renderModel && fixture.kind === 'vanity' && <>
        <mesh {...common} position={[0, height * 0.45, 0]}><boxGeometry args={[width, height * 0.9, depth]} /><meshStandardMaterial color={selected ? '#b28757' : '#8b6241'} roughness={0.65} /><Edges color={outline} /></mesh>
        <mesh {...common} position={[0, height * 0.93, 0]} scale={[width * 0.72, 0.08, depth * 0.65]}><sphereGeometry args={[0.5, 24, 14]} /><meshStandardMaterial color={ceramic} roughness={0.2} /><Edges color={outline} threshold={30} /></mesh>
      </>}
      {!renderModel && fixture.kind === 'shower' && <>
        <mesh {...common} position={[0, height / 2, -depth / 2]}><boxGeometry args={[width, height, 0.018]} /><meshPhysicalMaterial color="#c7d7d3" transparent opacity={0.34} roughness={0.05} transmission={0.35} /><Edges color={outline} /></mesh>
        <mesh {...common} position={[-width / 2, height / 2, 0]}><boxGeometry args={[0.018, height, depth]} /><meshPhysicalMaterial color="#c7d7d3" transparent opacity={0.34} roughness={0.05} transmission={0.35} /><Edges color={outline} /></mesh>
        <mesh {...common} position={[0, 0.025, 0]}><boxGeometry args={[width, 0.05, depth]} /><meshStandardMaterial color="#d9dcd5" roughness={0.7} /><Edges color={outline} /></mesh>
      </>}
      {!fixture.model_asset && fixture.kind === 'floor_drain' && <mesh {...common} position={[0, 0.012, 0]}><boxGeometry args={[Math.max(width, depth), 0.024, Math.max(width, depth)]} /><meshStandardMaterial color={selected ? '#c89638' : '#777d79'} metalness={0.75} roughness={0.25} /><Edges color={outline} /></mesh>}
      {!fixture.model_asset && fixture.kind === 'drain' && <mesh {...common} position={[0, 0.018, 0]}><cylinderGeometry args={[Math.max(width / 2, 0.025), Math.max(width / 2, 0.025), 0.036, 24]} /><meshStandardMaterial color={selected ? '#c89638' : '#4f7180'} metalness={0.65} roughness={0.28} /><Edges color={outline} /></mesh>}
      {!fixture.model_asset && fixture.kind === 'water' && <mesh {...common} position={[0, Math.max(height / 2, 0.04), 0]}><sphereGeometry args={[Math.max(width / 2, 0.025), 20, 14]} /><meshStandardMaterial color={selected ? '#d0a54e' : '#287d9c'} metalness={0.35} roughness={0.3} /><Edges color={outline} /></mesh>}
      {!fixture.model_asset && fixture.kind === 'electric' && <mesh {...common} position={[0, Math.max(height / 2, 0.04), 0]}><boxGeometry args={[Math.max(width, 0.05), Math.max(height, 0.05), Math.max(depth, 0.018)]} /><meshStandardMaterial color={selected ? '#d0a54e' : '#bf8a26'} roughness={0.45} /><Edges color={outline} /></mesh>}
      {!fixture.model_asset && fixture.kind === 'pipe' && !/分水器/.test(fixture.label) && <mesh {...common} position={[0, height / 2, 0]}><cylinderGeometry args={[width / 2, width / 2, height, 24]} /><meshStandardMaterial color={selected ? '#d4a650' : '#90958e'} metalness={0.35} roughness={0.4} /><Edges color={outline} /></mesh>}
      {!fixture.model_asset && fixture.kind === 'radiator' && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={ceramic} metalness={0.2} roughness={0.35} /><Edges color={outline} /></mesh>}
      {!fixture.model_asset && (fixture.kind === 'column' || fixture.kind === 'other') && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={selected ? '#d8c8a5' : '#c9cbc5'} roughness={0.82} /><Edges color={outline} /></mesh>}
    </group>
  )
}

function Pipe({ item }:{ item:PipeSegment }) {
  const dx=(item.to.x_mm-item.from.x_mm)/1000, dy=(item.to.y_mm-item.from.y_mm)/1000, dz=(item.to.z_mm-item.from.z_mm)/1000
  return <mesh position={[(item.from.x_mm+item.to.x_mm)/2000,(item.from.y_mm+item.to.y_mm)/2000,(item.from.z_mm+item.to.z_mm)/2000]}>
    <boxGeometry args={[Math.max(Math.abs(dx),.026),Math.max(Math.abs(dy),.026),Math.max(Math.abs(dz),.026)]}/>
    <meshStandardMaterial color={item.temperature==='hot'?'#dc3f36':'#1976d2'} roughness={.35}/><Edges color={item.temperature==='hot'?'#8e1f19':'#0c4380'}/>
  </mesh>
}

function PlumbingManifold({ route }:{ route:PlumbingRoute }) {
  const width=route.manifold_ports===8?.42:.32
  const rails=[{key:'cold',point:route.cold_manifold,color:'#1976d2',edge:'#0c4380'},...(route.hot_manifold?[{key:'hot',point:route.hot_manifold,color:'#dc3f36',edge:'#8e1f19'}]:[])]
  return <>{rails.map((rail)=><group key={rail.key} position={[rail.point.x_mm/1000,rail.point.y_mm/1000,rail.point.z_mm/1000]}>
    <mesh><boxGeometry args={[width,.06,.09]}/><meshStandardMaterial color={rail.color} metalness={.55} roughness={.28}/><Edges color={rail.edge}/></mesh>
    <mesh position={[-width/2-.018,0,0]}><boxGeometry args={[.036,.072,.072]}/><meshStandardMaterial color="#8b928e" metalness={.72} roughness={.2}/><Edges color="#4d5350"/></mesh>
    <mesh position={[width/2+.018,0,0]}><boxGeometry args={[.036,.072,.072]}/><meshStandardMaterial color="#8b928e" metalness={.72} roughness={.2}/><Edges color="#4d5350"/></mesh>
  </group>)}</>
}

function RoomModel({ spec, selection, showCeiling, showPlumbing, cutaway, hiddenWallIndexes, onSelect, groupRef, surfaceMaterials, emphasizeJoints }: { spec: RoomSpec; selection: Selection; showCeiling: boolean; showPlumbing:boolean; cutaway: boolean; hiddenWallIndexes: number[]; onSelect: (selection: Selection) => void; groupRef: React.RefObject<Group>; surfaceMaterials?: SurfaceMaterials; emphasizeJoints: boolean }) {
  const roomBoundary = useMemo(() => finishedRoomBoundary(spec), [spec])
  const floorShape = useMemo(() => {
    const shape = new Shape()
    roomBoundary.forEach((point, index) => {
      const x = point.x_mm / 1000
      const y = -point.z_mm / 1000
      if (index === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    })
    shape.closePath()
    return shape
  }, [roomBoundary])
  const ceilingShape = useMemo(() => {
    const shape = new Shape()
    roomBoundary.forEach((point, index) => {
      const x = point.x_mm / 1000
      const y = -point.z_mm / 1000
      if (index === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    })
    shape.closePath()
    spec.fixtures.filter((fixture) => fixture.mounting_surface === 'ceiling').forEach((fixture) => {
      shape.holes.push(ceilingCutoutPath(fixture))
    })
    return shape
  }, [roomBoundary, spec.fixtures])
  const wallLayers = useMemo(() => wallLayerQuads(spec), [spec])
  const bounds = useMemo(() => roomBounds(roomBoundary), [roomBoundary])
  const height = (spec.height_mm ?? 2600) / 1000
  const plumbing=useMemo(()=>routePlumbing(spec),[spec])
  return (
    <group ref={groupRef} userData={{ schema_version: spec.schema_version, unit: 'meter', room_name: spec.name }} onClick={() => onSelect({ type: 'room' })}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[floorShape]} />
        {surfaceMaterials?.floor ? <TexturedMaterial src={surfaceMaterials.floor.textureSrc} {...physicalWorldTextureTransform(surfaceMaterials.floor.rotationDeg?surfaceMaterials.floor.depthMm:surfaceMaterials.floor.widthMm, surfaceMaterials.floor.rotationDeg?surfaceMaterials.floor.widthMm:surfaceMaterials.floor.depthMm, bounds.minX-(surfaceMaterials.floor.offsetXmm??0), -bounds.minZ-(surfaceMaterials.floor.offsetZmm??0))} emphasizeJoints={emphasizeJoints} /> : <meshStandardMaterial color="#c8c6bd" roughness={0.84} side={DoubleSide} />}
      </mesh>
      {(spec.dry_wet_zones ?? []).filter((zone) => zone.kind === 'wet').map((zone) => <FloorZoneMesh key={zone.id} boundary={zone.boundary} />)}
      {showCeiling && <mesh position={[0, height, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[ceilingShape]} /><meshStandardMaterial color="#dedfd9" roughness={0.9} side={DoubleSide} transparent opacity={0.72} />
      </mesh>}
      {showCeiling && (spec.ceiling_zones ?? []).map((zone) => <CeilingZoneMesh key={zone.id} boundary={zone.boundary} heightMm={zone.height_mm} />)}
      {spec.boundary.map((start, index) => {
        if (cutaway && hiddenWallIndexes.includes(index)) return null
        return <Wall key={index} spec={spec} index={index} layers={wallLayers[index]} selected={selection.type === 'room'} onSelect={() => onSelect({ type: 'room' })} surface={surfaceMaterials?.wall} emphasizeJoints={emphasizeJoints} />
      })}
      {spec.fixtures.map((fixture) => <Fixture key={fixture.id} fixture={fixture} selected={selection.type === 'fixture' && selection.id === fixture.id} onSelect={() => onSelect({ type: 'fixture', id: fixture.id })} />)}
      {showPlumbing && plumbing&&<PlumbingManifold route={plumbing}/>}
      {showPlumbing && plumbing?.segments.map(item=><Pipe key={item.id} item={item}/>)}
    </group>
  )
}

function CameraAwareRoom({ spec, selection, showCeiling, showPlumbing, cutaway, onHiddenWallsChange, onSelect, groupRef, surfaceMaterials, emphasizeJoints }: { spec: RoomSpec; selection: Selection; showCeiling: boolean; showPlumbing:boolean; cutaway: boolean; onHiddenWallsChange: (indexes: number[]) => void; onSelect: (selection: Selection) => void; groupRef: React.RefObject<Group>; surfaceMaterials?: SurfaceMaterials; emphasizeJoints: boolean }) {
  const { camera } = useThree()
  const roomBoundary = useMemo(() => finishedRoomBoundary(spec), [spec])
  const [hiddenWallIndexes, setHiddenWallIndexes] = useState<number[]>([])
  const hiddenKeyRef = useRef('')

  useEffect(() => {
    if (cutaway) return
    hiddenKeyRef.current = ''
    setHiddenWallIndexes([])
    onHiddenWallsChange([])
  }, [cutaway, onHiddenWallsChange])

  useFrame(() => {
    if (!cutaway) return
    const next = hiddenWallIndexesForCutaway(roomBoundary, { x_mm: camera.position.x * 1000, z_mm: camera.position.z * 1000 }, 4)
    const key = next.join(',')
    if (key === hiddenKeyRef.current) return
    hiddenKeyRef.current = key
    setHiddenWallIndexes(next)
    onHiddenWallsChange(next)
  })

  return <RoomModel spec={spec} selection={selection} showCeiling={showCeiling} showPlumbing={showPlumbing} cutaway={cutaway} hiddenWallIndexes={hiddenWallIndexes} onSelect={onSelect} groupRef={groupRef} surfaceMaterials={surfaceMaterials} emphasizeJoints={emphasizeJoints} />
}

type QuoteLine = { name: string; quantity: number; unit: string; price: number; spec: string }
type LayoutInfo = { title: string; level: 'level1' | 'level2' | 'level3'; totalPrice: number; lines: QuoteLine[] }

export const ModelCanvas = forwardRef<ModelCanvasHandle, { spec: RoomSpec; selection: Selection; onSelect: (selection: Selection) => void; layoutInfo?: LayoutInfo | null; surfaceMaterials?: SurfaceMaterials }>(function ModelCanvas({ spec, selection, onSelect, layoutInfo, surfaceMaterials }, ref) {
  const [showCeiling, setShowCeiling] = useState(false)
  const [showPlumbing,setShowPlumbing]=useState(true)
  const [plumbingOpen,setPlumbingOpen]=useState(false)
  const [cutaway, setCutaway] = useState(true)
  const [hiddenWallIndexes, setHiddenWallIndexes] = useState<number[]>([])
  const [cameraKey, setCameraKey] = useState(0)
  const [emphasizeJoints, setEmphasizeJoints] = useState(true)
  const [quoteOpen, setQuoteOpen] = useState(true)
  const groupRef = useRef<Group>(null)
  const roomBoundary = finishedRoomBoundary(spec)
  const bounds = roomBounds(roomBoundary)
  const center = roomCentroid(roomBoundary)
  const extent = Math.max(bounds.width, bounds.depth, spec.height_mm ?? 2600) / 1000
  const plumbing=useMemo(()=>routePlumbing(spec),[spec])

  useImperativeHandle(ref, () => ({
    async exportGLB(filename: string) {
      if (!groupRef.current) throw new Error('三维模型尚未准备完成')
      const exporter = new GLTFExporter()
      const result = await exporter.parseAsync(groupRef.current, { binary: true, onlyVisible: true })
      if (!(result instanceof ArrayBuffer)) throw new Error('GLB 导出器返回了非二进制结果')
      const url = URL.createObjectURL(new Blob([result], { type: 'model/gltf-binary' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = filename; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  }), [])

  return (
    <div className="model-canvas-wrap">
      <div className="canvas-toolbar model-toolbar">
        <span><Move3d size={15} />左键旋转 · 右键平移 · 滚轮缩放</span>
        <div>
          <span className={cutaway ? 'cutaway-status active' : 'cutaway-status'}>{cutaway ? `剖切隐藏 ${hiddenWallIndexes.length ? hiddenWallIndexes.map((index) => `W${index + 1}`).join('、') : '自动判定中'}` : '完整墙体'}</span>
          <button className="icon-button" onClick={() => setShowCeiling((value) => !value)} title={showCeiling ? '隐藏顶板' : '显示顶板'}>{showCeiling ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          <button className={showPlumbing?'icon-button active-tool':'icon-button'} onClick={()=>setShowPlumbing(value=>!value)} title={showPlumbing?'隐藏给水管':'显示给水管'} aria-pressed={showPlumbing}><Waves size={17}/></button>
          <button className={plumbingOpen?'icon-button active-tool':'icon-button'} onClick={()=>setPlumbingOpen(value=>!value)} title="给水管网详情"><Layers size={17}/></button>
          <button className={cutaway ? 'icon-button active-tool' : 'icon-button'} onClick={() => setCutaway((value) => !value)} title={cutaway ? '显示完整墙体' : '开启剖切视图'}><Layers size={17} /></button>
          {surfaceMaterials && <button className={emphasizeJoints ? 'icon-button active-tool' : 'icon-button'} onClick={() => setEmphasizeJoints((value) => !value)} title={emphasizeJoints ? '关闭板缝加粗' : '开启板缝加粗'} aria-pressed={emphasizeJoints}><SquareDashed size={17} /></button>}
          <button className="icon-button" onClick={() => setCameraKey((value) => value + 1)} title="重置视角"><Focus size={17} /></button>
        </div>
      </div>
      {plumbingOpen&&plumbing&&<aside className="plumbing-drawer" data-testid="plumbing-drawer"><header><Waves size={16}/>给水管网</header><p>门外冷水源 ({plumbing.supply_origin.x_mm}, {plumbing.supply_origin.z_mm}) → 单根主管穿门 → 分水器</p><p>冷水上层 · 长方体分水器{plumbing.manifold_ports?`（${plumbing.manifold_ports}孔）`:''} ({plumbing.cold_manifold.x_mm}, {plumbing.cold_manifold.y_mm}, {plumbing.cold_manifold.z_mm})</p><p>热水下层 · 热水器出水后接热水设备{plumbing.hot_manifold?'，多路时经分水器下层':''}</p><p>总长 {plumbing.total_mm} mm · 末端距离极差 {plumbing.imbalance_mm} mm</p>{plumbing.warnings.map(item=><p className="validation-warning" key={item}>{item}</p>)}{plumbing.segments.filter(item=>item.fixture_id&&item.id.endsWith('-drop')).map(item=><code key={item.id}>{item.temperature==='hot'?'热水':'冷水'} · 点位上方 ({item.from.x_mm}, {item.from.z_mm}) → 设备点位 · {item.length_mm} mm</code>)}</aside>}
      {layoutInfo && <div className={quoteOpen ? 'quote-drawer-shell open' : 'quote-drawer-shell'}>
        <button className="quote-drawer-toggle" type="button" onClick={() => setQuoteOpen((value) => !value)} aria-label={quoteOpen ? '收起报价' : '展开报价'} aria-expanded={quoteOpen}>{quoteOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</button>
        <aside className="scene-fixture-summary quote-drawer" data-testid="scene-fixture-summary" aria-label="方案报价">
          <header><span><ReceiptText size={16} />方案报价</span><strong>{layoutInfo.title} - {layoutInfo.level}</strong></header>
          <section className="quote-total"><span>方案合计</span><strong>总价 ¥{layoutInfo.totalPrice.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</strong></section>
          <div className="quote-lines">{layoutInfo.lines.map((line, index) => <article className="quote-line" key={`${line.spec}-${index}`}>
            <div><strong>{line.name} × {line.quantity.toLocaleString('zh-CN')} {line.unit}</strong><b>{line.price.toLocaleString('zh-CN', { minimumFractionDigits: 2 })} 元</b></div>
            <code>{line.spec}</code>
          </article>)}</div>
        </aside>
      </div>}
      <SceneBoundary><Canvas key={cameraKey} shadows dpr={[1, 1.5]} gl={{ antialias: true, preserveDrawingBuffer: true }} style={{ touchAction: 'none' }} onContextMenu={(event) => event.preventDefault()} onPointerMissed={() => onSelect({ type: 'room' })}>
        <color attach="background" args={['#ecece7']} />
        <PerspectiveCamera makeDefault position={[center.x / 1000 + extent * 1.65, extent * 2.05, center.z / 1000 + extent * 1.65]} fov={42} near={0.01} far={100} />
        <ambientLight intensity={1.3} />
        <directionalLight position={[4, 7, 3]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} />
        <Suspense fallback={null}>
          <CameraAwareRoom spec={spec} selection={selection} showCeiling={showCeiling} showPlumbing={showPlumbing} cutaway={cutaway} onHiddenWallsChange={setHiddenWallIndexes} onSelect={onSelect} groupRef={groupRef} surfaceMaterials={surfaceMaterials} emphasizeJoints={emphasizeJoints} />
        </Suspense>
        <Grid position={[center.x / 1000, -0.006, center.z / 1000]} args={[12, 12]} cellSize={0.1} cellThickness={0.45} cellColor="#c4c7bf" sectionSize={1} sectionThickness={0.8} sectionColor="#aeb2aa" fadeDistance={12} fadeStrength={1.2} infiniteGrid />
        <ContactShadows position={[0, -0.002, 0]} opacity={0.3} scale={12} blur={2.3} far={5} frames={1} resolution={512} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} screenSpacePanning panSpeed={0.9} rotateSpeed={0.75} zoomSpeed={0.9} target={[center.x / 1000, Math.min(1.05, extent * 0.38), center.z / 1000]} minDistance={0.7} maxDistance={Math.max(18, extent * 6)} maxPolarAngle={Math.PI / 2.02} />
      </Canvas></SceneBoundary>
    </div>
  )
})
