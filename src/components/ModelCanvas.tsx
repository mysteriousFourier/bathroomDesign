import { ContactShadows, Edges, Grid, OrbitControls, PerspectiveCamera, useGLTF, useTexture } from '@react-three/drei'
import { Canvas, type ThreeEvent, useFrame, useLoader, useThree } from '@react-three/fiber'
import { Eye, EyeOff, Focus, Layers, Move3d } from 'lucide-react'
import { Suspense, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Box3, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, RepeatWrapping, Shape, SRGBColorSpace, Vector3 } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { finishedRoomBoundary, hiddenWallIndexesForCutaway, roomBounds, roomCentroid, sliceWallQuadByDistance, wallLayerQuads, wallLength } from '../spec'
import type { FixtureModelAsset, FixtureSpec, Point2D, RoomSpec, Selection } from '../types'

export interface ModelCanvasHandle {
  exportGLB: (filename: string) => Promise<void>
}

type WallPart = { start: number; end: number; y: number; height: number }
type WallLayers = { finish: Point2D[]; wall: Point2D[] }
type SurfaceMaterials = { wall?: { textureSrc: string; widthMm: number; heightMm: number }; floor?: { textureSrc: string; widthMm: number; depthMm: number } }

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

function TexturedMaterial({ src, repeatX, repeatY, color = '#ffffff', opacity = 1 }: { src: string; repeatX: number; repeatY: number; color?: string; opacity?: number }) {
  const source = useTexture(src)
  const texture = useMemo(() => {
    const next = source.clone()
    next.wrapS = RepeatWrapping
    next.wrapT = RepeatWrapping
    next.repeat.set(Math.max(1, repeatX), Math.max(1, repeatY))
    next.colorSpace = SRGBColorSpace
    next.needsUpdate = true
    return next
  }, [repeatX, repeatY, source])
  useEffect(() => () => texture.dispose(), [texture])
  return <meshStandardMaterial color={color} map={texture} roughness={0.82} side={DoubleSide} transparent={opacity < 1} opacity={opacity} />
}

function WallPrism({ quad, part, color, edge, onSelect, surface }: { quad: Point2D[]; part: WallPart; color: string; edge: string; onSelect: () => void; surface?: SurfaceMaterials['wall'] }) {
  const geometry = useMemo(() => wallPrismGeometry(quad, part.y - part.height / 2, part.y + part.height / 2), [quad, part])
  const lengthMm = Math.hypot(quad[1].x_mm - quad[0].x_mm, quad[1].z_mm - quad[0].z_mm)
  return <mesh geometry={geometry} castShadow receiveShadow onClick={(event) => { event.stopPropagation(); onSelect() }}>
    {surface ? <TexturedMaterial src={surface.textureSrc} repeatX={lengthMm / surface.widthMm} repeatY={part.height / surface.heightMm} color={color} /> : <meshStandardMaterial color={color} roughness={0.84} side={DoubleSide} />}
    <Edges color={edge} threshold={20} />
  </mesh>
}

function Wall({ spec, index, layers, selected, onSelect, surface }: { spec: RoomSpec; index: number; layers: WallLayers; selected: boolean; onSelect: () => void; surface?: SurfaceMaterials['wall'] }) {
  const lengthMm = wallLength(spec.boundary, index)
  const wallStart = spec.boundary[index]
  const wallEnd = spec.boundary[(index + 1) % spec.boundary.length]
  const heightMm = spec.height_mm ?? 2600
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
      {parts.map((part, partIndex) => (
        <WallPrism key={`finish-${partIndex}`} quad={sliceWallQuadByDistance(layers.finish, wallStart, wallEnd, part.start, part.end)} part={part} color={selected ? '#eee2c5' : '#ffffff'} edge={selected ? '#8a6725' : '#c8c1b2'} onSelect={onSelect} surface={surface} />
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

function modelAssetFormat(asset: FixtureModelAsset) {
  if (asset.format) return asset.format
  return /\.glb($|\?)/i.test(asset.src) ? 'glb' : 'gltf'
}

function NormalizedFixtureAsset({ fixture, selected, object }: { fixture: FixtureSpec; selected: boolean; object: Group }) {
  const { scene, scale, position } = useMemo(() => {
    const scene = object.clone(true)
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
    const target = new Vector3(fixture.width_mm / 1000, fixture.height_mm / 1000, fixture.depth_mm / 1000)
    const scale = Math.min(
      target.x / Math.max(size.x, 0.001),
      target.y / Math.max(size.y, 0.001),
      target.z / Math.max(size.z, 0.001),
    )
    return {
      scene,
      scale,
      position: new Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale),
    }
  }, [fixture.depth_mm, fixture.height_mm, fixture.width_mm, object])

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

function Fixture({ fixture, selected, onSelect }: { fixture: FixtureSpec; selected: boolean; onSelect: () => void }) {
  const width = fixture.width_mm / 1000
  const depth = fixture.depth_mm / 1000
  const height = fixture.height_mm / 1000
  const select = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect() }
  const outline = selected ? '#a46d13' : '#6f756c'
  const ceramic = selected ? '#f2dcae' : '#f2f1ec'
  const common = { castShadow: true, receiveShadow: true, onClick: select }
  return (
    <group position={[fixture.x_mm / 1000, (fixture.elevation_mm ?? 0) / 1000, fixture.z_mm / 1000]} rotation={[0, -fixture.rotation_deg * Math.PI / 180, 0]} userData={{ id: fixture.id, kind: fixture.kind, source: fixture.source, model_asset: fixture.model_asset?.id }} onClick={select}>
      {fixture.model_asset && <FixtureAssetModel fixture={fixture} selected={selected} />}
      {!fixture.model_asset && fixture.kind === 'toilet' && <>
        <mesh {...common} position={[0, height * 0.28, depth * 0.08]} scale={[width, height * 0.55, depth * 0.7]}><sphereGeometry args={[0.5, 28, 20]} /><meshStandardMaterial color={ceramic} roughness={0.25} /><Edges color={outline} threshold={35} /></mesh>
        <mesh {...common} position={[0, height * 0.65, -depth * 0.3]}><boxGeometry args={[width * 0.9, height * 0.62, depth * 0.25]} /><meshStandardMaterial color={ceramic} roughness={0.25} /><Edges color={outline} /></mesh>
      </>}
      {fixture.kind === 'vanity' && <>
        <mesh {...common} position={[0, height * 0.45, 0]}><boxGeometry args={[width, height * 0.9, depth]} /><meshStandardMaterial color={selected ? '#b28757' : '#8b6241'} roughness={0.65} /><Edges color={outline} /></mesh>
        <mesh {...common} position={[0, height * 0.93, 0]} scale={[width * 0.72, 0.08, depth * 0.65]}><sphereGeometry args={[0.5, 24, 14]} /><meshStandardMaterial color={ceramic} roughness={0.2} /><Edges color={outline} threshold={30} /></mesh>
      </>}
      {fixture.kind === 'shower' && <>
        <mesh {...common} position={[0, height / 2, -depth / 2]}><boxGeometry args={[width, height, 0.018]} /><meshPhysicalMaterial color="#c7d7d3" transparent opacity={0.34} roughness={0.05} transmission={0.35} /><Edges color={outline} /></mesh>
        <mesh {...common} position={[-width / 2, height / 2, 0]}><boxGeometry args={[0.018, height, depth]} /><meshPhysicalMaterial color="#c7d7d3" transparent opacity={0.34} roughness={0.05} transmission={0.35} /><Edges color={outline} /></mesh>
        <mesh {...common} position={[0, 0.025, 0]}><boxGeometry args={[width, 0.05, depth]} /><meshStandardMaterial color="#d9dcd5" roughness={0.7} /><Edges color={outline} /></mesh>
      </>}
      {fixture.kind === 'floor_drain' && <mesh {...common} position={[0, 0.012, 0]}><boxGeometry args={[Math.max(width, depth), 0.024, Math.max(width, depth)]} /><meshStandardMaterial color={selected ? '#c89638' : '#777d79'} metalness={0.75} roughness={0.25} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'drain' && <mesh {...common} position={[0, 0.018, 0]}><cylinderGeometry args={[Math.max(width / 2, 0.025), Math.max(width / 2, 0.025), 0.036, 24]} /><meshStandardMaterial color={selected ? '#c89638' : '#4f7180'} metalness={0.65} roughness={0.28} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'water' && <mesh {...common} position={[0, Math.max(height / 2, 0.04), 0]}><sphereGeometry args={[Math.max(width / 2, 0.025), 20, 14]} /><meshStandardMaterial color={selected ? '#d0a54e' : '#287d9c'} metalness={0.35} roughness={0.3} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'electric' && <mesh {...common} position={[0, Math.max(height / 2, 0.04), 0]}><boxGeometry args={[Math.max(width, 0.05), Math.max(height, 0.05), Math.max(depth, 0.018)]} /><meshStandardMaterial color={selected ? '#d0a54e' : '#bf8a26'} roughness={0.45} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'pipe' && <mesh {...common} position={[0, height / 2, 0]}><cylinderGeometry args={[width / 2, width / 2, height, 24]} /><meshStandardMaterial color={selected ? '#d4a650' : '#90958e'} metalness={0.35} roughness={0.4} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'radiator' && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={ceramic} metalness={0.2} roughness={0.35} /><Edges color={outline} /></mesh>}
      {!fixture.model_asset && (fixture.kind === 'column' || fixture.kind === 'other') && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={selected ? '#d8c8a5' : '#c9cbc5'} roughness={0.82} /><Edges color={outline} /></mesh>}
    </group>
  )
}

function RoomModel({ spec, selection, showCeiling, cutaway, hiddenWallIndexes, onSelect, groupRef, surfaceMaterials }: { spec: RoomSpec; selection: Selection; showCeiling: boolean; cutaway: boolean; hiddenWallIndexes: number[]; onSelect: (selection: Selection) => void; groupRef: React.RefObject<Group>; surfaceMaterials?: SurfaceMaterials }) {
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
  const wallLayers = useMemo(() => wallLayerQuads(spec), [spec])
  const height = (spec.height_mm ?? 2600) / 1000
  return (
    <group ref={groupRef} userData={{ schema_version: spec.schema_version, unit: 'meter', room_name: spec.name }} onClick={() => onSelect({ type: 'room' })}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[floorShape]} />
        {surfaceMaterials?.floor ? <TexturedMaterial src={surfaceMaterials.floor.textureSrc} repeatX={(roomBounds(roomBoundary).width || surfaceMaterials.floor.widthMm) / surfaceMaterials.floor.widthMm} repeatY={(roomBounds(roomBoundary).depth || surfaceMaterials.floor.depthMm) / surfaceMaterials.floor.depthMm} /> : <meshStandardMaterial color="#c8c6bd" roughness={0.84} side={DoubleSide} />}
      </mesh>
      {showCeiling && <mesh position={[0, height, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[floorShape]} /><meshStandardMaterial color="#dedfd9" roughness={0.9} side={DoubleSide} transparent opacity={0.72} />
      </mesh>}
      {showCeiling && (spec.ceiling_zones ?? []).map((zone) => <CeilingZoneMesh key={zone.id} boundary={zone.boundary} heightMm={zone.height_mm} />)}
      {spec.boundary.map((start, index) => {
        if (cutaway && hiddenWallIndexes.includes(index)) return null
        return <Wall key={index} spec={spec} index={index} layers={wallLayers[index]} selected={selection.type === 'room'} onSelect={() => onSelect({ type: 'room' })} surface={surfaceMaterials?.wall} />
      })}
      {spec.fixtures.map((fixture) => <Fixture key={fixture.id} fixture={fixture} selected={selection.type === 'fixture' && selection.id === fixture.id} onSelect={() => onSelect({ type: 'fixture', id: fixture.id })} />)}
    </group>
  )
}

function CameraAwareRoom({ spec, selection, showCeiling, cutaway, onHiddenWallsChange, onSelect, groupRef, surfaceMaterials }: { spec: RoomSpec; selection: Selection; showCeiling: boolean; cutaway: boolean; onHiddenWallsChange: (indexes: number[]) => void; onSelect: (selection: Selection) => void; groupRef: React.RefObject<Group>; surfaceMaterials?: SurfaceMaterials }) {
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

  return <RoomModel spec={spec} selection={selection} showCeiling={showCeiling} cutaway={cutaway} hiddenWallIndexes={hiddenWallIndexes} onSelect={onSelect} groupRef={groupRef} surfaceMaterials={surfaceMaterials} />
}

export const ModelCanvas = forwardRef<ModelCanvasHandle, { spec: RoomSpec; selection: Selection; onSelect: (selection: Selection) => void; layoutInfo?: { title: string; summary: string; totalPrice: number; products: string } | null; surfaceMaterials?: SurfaceMaterials }>(function ModelCanvas({ spec, selection, onSelect, layoutInfo, surfaceMaterials }, ref) {
  const [showCeiling, setShowCeiling] = useState(false)
  const [cutaway, setCutaway] = useState(true)
  const [hiddenWallIndexes, setHiddenWallIndexes] = useState<number[]>([])
  const [cameraKey, setCameraKey] = useState(0)
  const groupRef = useRef<Group>(null)
  const roomBoundary = finishedRoomBoundary(spec)
  const bounds = roomBounds(roomBoundary)
  const center = roomCentroid(roomBoundary)
  const extent = Math.max(bounds.width, bounds.depth, spec.height_mm ?? 2600) / 1000

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
          <button className={cutaway ? 'icon-button active-tool' : 'icon-button'} onClick={() => setCutaway((value) => !value)} title={cutaway ? '显示完整墙体' : '开启剖切视图'}><Layers size={17} /></button>
          <button className="icon-button" onClick={() => setCameraKey((value) => value + 1)} title="重置视角"><Focus size={17} /></button>
        </div>
      </div>
      <aside className="scene-fixture-summary" data-testid="scene-fixture-summary" aria-label="三维实体清单">
        <strong>{layoutInfo?.title ?? '3D 实体布局'} · 全部落地</strong>
        {layoutInfo && <><span>{layoutInfo.summary}</span><strong>方案合计 ¥{layoutInfo.totalPrice.toLocaleString('zh-CN')}</strong><span>{layoutInfo.products}</span></>}
        <span>房间层高 {spec.height_mm ?? 2600} mm · 实体尺寸按 W×D×H</span>
        <div>{spec.fixtures.filter((fixture) => fixture.kind !== 'floor_drain').map((fixture) => (
          <code key={fixture.id} data-fixture-kind={fixture.kind}>{fixture.label} {fixture.width_mm}×{fixture.depth_mm}×{fixture.height_mm} mm</code>
        ))}</div>
      </aside>
      <Canvas key={cameraKey} shadows dpr={[1, 2]} gl={{ antialias: true, preserveDrawingBuffer: true }} style={{ touchAction: 'none' }} onContextMenu={(event) => event.preventDefault()} onPointerMissed={() => onSelect({ type: 'room' })}>
        <color attach="background" args={['#ecece7']} />
        <PerspectiveCamera makeDefault position={[center.x / 1000 + extent * 1.65, extent * 2.05, center.z / 1000 + extent * 1.65]} fov={42} near={0.01} far={100} />
        <ambientLight intensity={1.3} />
        <directionalLight position={[4, 7, 3]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} />
        <Suspense fallback={null}>
          <CameraAwareRoom spec={spec} selection={selection} showCeiling={showCeiling} cutaway={cutaway} onHiddenWallsChange={setHiddenWallIndexes} onSelect={onSelect} groupRef={groupRef} surfaceMaterials={surfaceMaterials} />
        </Suspense>
        <Grid position={[center.x / 1000, -0.006, center.z / 1000]} args={[12, 12]} cellSize={0.1} cellThickness={0.45} cellColor="#c4c7bf" sectionSize={1} sectionThickness={0.8} sectionColor="#aeb2aa" fadeDistance={12} fadeStrength={1.2} infiniteGrid />
        <ContactShadows position={[0, -0.002, 0]} opacity={0.3} scale={12} blur={2.3} far={5} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} screenSpacePanning panSpeed={0.9} rotateSpeed={0.75} zoomSpeed={0.9} target={[center.x / 1000, Math.min(1.05, extent * 0.38), center.z / 1000]} minDistance={0.7} maxDistance={Math.max(18, extent * 6)} maxPolarAngle={Math.PI / 2.02} />
      </Canvas>
    </div>
  )
})
