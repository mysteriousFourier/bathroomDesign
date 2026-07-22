import { ContactShadows, Edges, Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { Eye, EyeOff, Focus, Layers, Move3d } from 'lucide-react'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { DoubleSide, Group, Shape } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { roomBounds, roomCentroid, wallLength } from '../spec'
import type { FixtureSpec, RoomSpec, Selection } from '../types'

export interface ModelCanvasHandle {
  exportGLB: (filename: string) => Promise<void>
}

type BoxPart = { x: number; width: number; y: number; height: number }

function Wall({ spec, index, selected, onSelect }: { spec: RoomSpec; index: number; selected: boolean; onSelect: () => void }) {
  const start = spec.boundary[index]
  const end = spec.boundary[(index + 1) % spec.boundary.length]
  const lengthMm = wallLength(spec.boundary, index)
  const heightMm = spec.height_mm ?? 2600
  const angle = Math.atan2(end.z_mm - start.z_mm, end.x_mm - start.x_mm)
  const openings = spec.openings.filter((opening) => opening.wall_index === index).sort((a, b) => a.offset_mm - b.offset_mm)
  const parts: BoxPart[] = []
  let cursor = 0
  for (const opening of openings) {
    const begin = Math.max(cursor, Math.min(opening.offset_mm, lengthMm))
    const finish = Math.max(begin, Math.min(opening.offset_mm + opening.width_mm, lengthMm))
    if (begin > cursor) parts.push({ x: (cursor + begin) / 2, width: begin - cursor, y: heightMm / 2, height: heightMm })
    if (opening.sill_mm > 0) parts.push({ x: (begin + finish) / 2, width: finish - begin, y: opening.sill_mm / 2, height: opening.sill_mm })
    const openingTop = opening.sill_mm + opening.height_mm
    if (openingTop < heightMm) parts.push({ x: (begin + finish) / 2, width: finish - begin, y: (openingTop + heightMm) / 2, height: heightMm - openingTop })
    cursor = finish
  }
  if (cursor < lengthMm) parts.push({ x: (cursor + lengthMm) / 2, width: lengthMm - cursor, y: heightMm / 2, height: heightMm })

  return (
    <group position={[start.x_mm / 1000, 0, start.z_mm / 1000]} rotation={[0, -angle, 0]} onClick={(event) => { event.stopPropagation(); onSelect() }}>
      {parts.map((part, partIndex) => (
        <mesh key={partIndex} position={[part.x / 1000, part.y / 1000, 0]} castShadow receiveShadow>
          <boxGeometry args={[part.width / 1000, part.height / 1000, spec.wall_thickness_mm / 1000]} />
          <meshStandardMaterial color={selected ? '#d8c8a5' : '#e7e5df'} roughness={0.87} />
          <Edges color={selected ? '#8a6725' : '#b9bcb4'} threshold={20} />
        </mesh>
      ))}
    </group>
  )
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
      {fixture.kind === 'pipe' && <mesh {...common} position={[0, height / 2, 0]}><cylinderGeometry args={[width / 2, width / 2, height, 24]} /><meshStandardMaterial color={selected ? '#d4a650' : '#90958e'} metalness={0.35} roughness={0.4} /><Edges color={outline} /></mesh>}
      {fixture.kind === 'radiator' && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={ceramic} metalness={0.2} roughness={0.35} /><Edges color={outline} /></mesh>}
      {(fixture.kind === 'column' || fixture.kind === 'other') && <mesh {...common} position={[0, height / 2, 0]}><boxGeometry args={[width, height, depth]} /><meshStandardMaterial color={selected ? '#d8c8a5' : '#c9cbc5'} roughness={0.82} /><Edges color={outline} /></mesh>}
    </group>
  )
}

function RoomModel({ spec, selection, showCeiling, cutaway, onSelect, groupRef }: { spec: RoomSpec; selection: Selection; showCeiling: boolean; cutaway: boolean; onSelect: (selection: Selection) => void; groupRef: React.RefObject<Group> }) {
  const floorShape = useMemo(() => {
    const shape = new Shape()
    spec.boundary.forEach((point, index) => {
      const x = point.x_mm / 1000
      const y = -point.z_mm / 1000
      if (index === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    })
    shape.closePath()
    return shape
  }, [spec.boundary])
  const height = (spec.height_mm ?? 2600) / 1000
  const center = roomCentroid(spec.boundary)
  return (
    <group ref={groupRef} userData={{ schema_version: spec.schema_version, unit: 'meter', room_name: spec.name }} onClick={() => onSelect({ type: 'room' })}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[floorShape]} />
        <meshStandardMaterial color="#c8c6bd" roughness={0.84} side={DoubleSide} />
      </mesh>
      {showCeiling && <mesh position={[0, height, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[floorShape]} /><meshStandardMaterial color="#dedfd9" roughness={0.9} side={DoubleSide} transparent opacity={0.72} />
      </mesh>}
      {spec.boundary.map((start, index) => {
        const end = spec.boundary[(index + 1) % spec.boundary.length]
        const facesCamera = (start.x_mm + end.x_mm) / 2 > center.x + 1 || (start.z_mm + end.z_mm) / 2 > center.z + 1
        if (cutaway && facesCamera) return null
        return <Wall key={index} spec={spec} index={index} selected={selection.type === 'room'} onSelect={() => onSelect({ type: 'room' })} />
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
  const bounds = roomBounds(spec.boundary)
  const center = roomCentroid(spec.boundary)
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
