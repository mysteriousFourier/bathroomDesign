import { ContactShadows, Edges, Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { Eye, EyeOff, Focus, Layers, Move3d } from 'lucide-react'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Shape } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { finishedRoomBoundary, roomBounds, roomCentroid, wallLayerPolygons, wallLength } from '../spec'
import type { FixtureSpec, Point2D, RoomSpec, Selection } from '../types'

export interface ModelCanvasHandle {
  exportGLB: (filename: string) => Promise<void>
}

type WallPart = { start: number; end: number; y: number; height: number }
type WallLayers = { finish: Point2D[]; wall: Point2D[] }

function pointAt(start: Point2D, end: Point2D, ratio: number) {
  return { x_mm: start.x_mm + (end.x_mm - start.x_mm) * ratio, z_mm: start.z_mm + (end.z_mm - start.z_mm) * ratio }
}

function sliceWallQuad(quad: Point2D[], startRatio: number, endRatio: number) {
  return [
    pointAt(quad[0], quad[1], startRatio), pointAt(quad[0], quad[1], endRatio),
    pointAt(quad[3], quad[2], endRatio), pointAt(quad[3], quad[2], startRatio),
  ]
}

function wallPrismGeometry(quad: Point2D[], minY: number, maxY: number) {
  const geometry = new BufferGeometry()
  const vertices = [...quad.map((point) => [point.x_mm / 1000, minY / 1000, point.z_mm / 1000]), ...quad.map((point) => [point.x_mm / 1000, maxY / 1000, point.z_mm / 1000])].flat()
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  geometry.setIndex([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  geometry.computeVertexNormals()
  return geometry
}

function WallPrism({ quad, part, color, edge, onSelect }: { quad: Point2D[]; part: WallPart; color: string; edge: string; onSelect: () => void }) {
  const geometry = useMemo(() => wallPrismGeometry(quad, part.y - part.height / 2, part.y + part.height / 2), [quad, part])
  return <mesh geometry={geometry} castShadow receiveShadow onClick={(event) => { event.stopPropagation(); onSelect() }}>
    <meshStandardMaterial color={color} roughness={0.84} side={DoubleSide} />
    <Edges color={edge} threshold={20} />
  </mesh>
}

function Wall({ spec, index, layers, selected, onSelect }: { spec: RoomSpec; index: number; layers: WallLayers; selected: boolean; onSelect: () => void }) {
  const lengthMm = wallLength(spec.boundary, index)
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
        <WallPrism key={partIndex} quad={sliceWallQuad(layers.wall, part.start / lengthMm, part.end / lengthMm)} part={part} color={selected ? '#d8c8a5' : '#e7e5df'} edge={selected ? '#8a6725' : '#b9bcb4'} onSelect={onSelect} />
      ))}
      {parts.map((part, partIndex) => (
        <WallPrism key={`finish-${partIndex}`} quad={sliceWallQuad(layers.finish, part.start / lengthMm, part.end / lengthMm)} part={part} color={selected ? '#d8c8a5' : '#f2efe7'} edge={selected ? '#8a6725' : '#c8c1b2'} onSelect={onSelect} />
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

function Fixture({ fixture, selected, onSelect }: { fixture: FixtureSpec; selected: boolean; onSelect: () => void }) {
  const width = fixture.width_mm / 1000
  const depth = fixture.depth_mm / 1000
  const height = fixture.height_mm / 1000
  const select = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect() }
  const outline = selected ? '#a46d13' : '#6f756c'
  const ceramic = selected ? '#f2dcae' : '#f2f1ec'
  const common = { castShadow: true, receiveShadow: true, onClick: select }
  return (
    <group position={[fixture.x_mm / 1000, 0, fixture.z_mm / 1000]} rotation={[0, -fixture.rotation_deg * Math.PI / 180, 0]} userData={{ id: fixture.id, kind: fixture.kind, source: fixture.source }}>
      {fixture.kind === 'toilet' && <>
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
      {fixture.kind === 'floor_drain' && <mesh {...common} position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}><cylinderGeometry args={[width / 2, width / 2, 0.024, 24]} /><meshStandardMaterial color={selected ? '#c89638' : '#777d79'} metalness={0.75} roughness={0.25} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'drain' && <mesh {...common} position={[0, 0.018, 0]} rotation={[-Math.PI / 2, 0, 0]}><cylinderGeometry args={[Math.max(width / 2, 0.025), Math.max(width / 2, 0.025), 0.036, 24]} /><meshStandardMaterial color={selected ? '#c89638' : '#4f7180'} metalness={0.65} roughness={0.28} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'water' && <mesh {...common} position={[0, Math.max(height / 2, 0.04), 0]}><sphereGeometry args={[Math.max(width / 2, 0.025), 20, 14]} /><meshStandardMaterial color={selected ? '#d0a54e' : '#287d9c'} metalness={0.35} roughness={0.3} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'electric' && <mesh {...common} position={[0, Math.max(height / 2, 0.04), 0]}><boxGeometry args={[Math.max(width, 0.05), Math.max(height, 0.05), Math.max(depth, 0.018)]} /><meshStandardMaterial color={selected ? '#d0a54e' : '#bf8a26'} roughness={0.45} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'pipe' && <mesh {...common} position={[0, height / 2, 0]}><cylinderGeometry args={[width / 2, width / 2, height, 24]} /><meshStandardMaterial color={selected ? '#d4a650' : '#90958e'} metalness={0.35} roughness={0.4} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'radiator' && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={ceramic} metalness={0.2} roughness={0.35} /><Edges color={outline} /></mesh>}
      {(fixture.kind === 'column' || fixture.kind === 'other') && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={selected ? '#d8c8a5' : '#c9cbc5'} roughness={0.82} /><Edges color={outline} /></mesh>}
    </group>
  )
}

function RoomModel({ spec, selection, showCeiling, cutaway, onSelect, groupRef }: { spec: RoomSpec; selection: Selection; showCeiling: boolean; cutaway: boolean; onSelect: (selection: Selection) => void; groupRef: React.RefObject<Group> }) {
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
  const wallLayers = useMemo(() => wallLayerPolygons(spec), [spec])
  const height = (spec.height_mm ?? 2600) / 1000
  const center = roomCentroid(roomBoundary)
  return (
    <group ref={groupRef} userData={{ schema_version: spec.schema_version, unit: 'meter', room_name: spec.name }} onClick={() => onSelect({ type: 'room' })}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[floorShape]} />
        <meshStandardMaterial color="#c8c6bd" roughness={0.84} side={DoubleSide} />
      </mesh>
      {showCeiling && <mesh position={[0, height, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[floorShape]} /><meshStandardMaterial color="#dedfd9" roughness={0.9} side={DoubleSide} transparent opacity={0.72} />
      </mesh>}
      {showCeiling && (spec.ceiling_zones ?? []).map((zone) => <CeilingZoneMesh key={zone.id} boundary={zone.boundary} heightMm={zone.height_mm} />)}
      {spec.boundary.map((start, index) => {
        const end = spec.boundary[(index + 1) % spec.boundary.length]
        const facesCamera = (start.x_mm + end.x_mm) / 2 > center.x + 1 || (start.z_mm + end.z_mm) / 2 > center.z + 1
        if (cutaway && facesCamera) return null
        return <Wall key={index} spec={spec} index={index} layers={wallLayers[index]} selected={selection.type === 'room'} onSelect={() => onSelect({ type: 'room' })} />
      })}
      {spec.fixtures.map((fixture) => <Fixture key={fixture.id} fixture={fixture} selected={selection.type === 'fixture' && selection.id === fixture.id} onSelect={() => onSelect({ type: 'fixture', id: fixture.id })} />)}
    </group>
  )
}

export const ModelCanvas = forwardRef<ModelCanvasHandle, { spec: RoomSpec; selection: Selection; onSelect: (selection: Selection) => void }>(function ModelCanvas({ spec, selection, onSelect }, ref) {
  const [showCeiling, setShowCeiling] = useState(false)
  const [cutaway, setCutaway] = useState(false)
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
          <button className="icon-button" onClick={() => setShowCeiling((value) => !value)} title={showCeiling ? '隐藏顶板' : '显示顶板'}>{showCeiling ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          <button className={cutaway ? 'icon-button active-tool' : 'icon-button'} onClick={() => setCutaway((value) => !value)} title={cutaway ? '显示完整墙体' : '开启剖切视图'}><Layers size={17} /></button>
          <button className="icon-button" onClick={() => setCameraKey((value) => value + 1)} title="重置视角"><Focus size={17} /></button>
        </div>
      </div>
      <Canvas key={cameraKey} shadows dpr={[1, 2]} gl={{ antialias: true, preserveDrawingBuffer: true }} style={{ touchAction: 'none' }} onContextMenu={(event) => event.preventDefault()} onPointerMissed={() => onSelect({ type: 'room' })}>
        <color attach="background" args={['#ecece7']} />
        <PerspectiveCamera makeDefault position={[center.x / 1000 + extent * 1.65, extent * 2.05, center.z / 1000 + extent * 1.65]} fov={42} near={0.01} far={100} />
        <ambientLight intensity={1.3} />
        <directionalLight position={[4, 7, 3]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} />
        <RoomModel spec={spec} selection={selection} showCeiling={showCeiling} cutaway={cutaway} onSelect={onSelect} groupRef={groupRef} />
        <Grid position={[center.x / 1000, -0.006, center.z / 1000]} args={[12, 12]} cellSize={0.1} cellThickness={0.45} cellColor="#c4c7bf" sectionSize={1} sectionThickness={0.8} sectionColor="#aeb2aa" fadeDistance={12} fadeStrength={1.2} infiniteGrid />
        <ContactShadows position={[0, -0.002, 0]} opacity={0.3} scale={12} blur={2.3} far={5} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} screenSpacePanning panSpeed={0.9} rotateSpeed={0.75} zoomSpeed={0.9} target={[center.x / 1000, Math.min(1.05, extent * 0.38), center.z / 1000]} minDistance={0.7} maxDistance={Math.max(18, extent * 6)} maxPolarAngle={Math.PI / 2.02} />
      </Canvas>
    </div>
  )
})
