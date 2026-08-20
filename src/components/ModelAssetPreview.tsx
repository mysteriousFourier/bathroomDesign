import { Bounds, Edges, Grid, Html, OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas, useLoader } from '@react-three/fiber'
import { LoaderCircle, Rotate3d } from 'lucide-react'
import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react'
import { Box3, DoubleSide, Group, Vector3 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import type { ModelAssetFormat } from '../types'
import { orientationCubePlacement, type ModelOrientationView, type OrientationFace, type OrientationMapping } from '../modelOrientation'

type Dimensions = { width: number; depth: number; height: number }
const faceNames: Record<OrientationFace, string> = { front: '正面', back: '背面', top: '上面', bottom: '下面', left: '左面', right: '右面' }
const orientationFaces: OrientationFace[] = ['top', 'left', 'front', 'right', 'back', 'bottom']
const orientationCubeFaces: { face: OrientationFace; position: [number, number, number]; rotation: [number, number, number] }[] = [
  { face: 'front', position: [0, 0, 1], rotation: [0, 0, 0] }, { face: 'back', position: [0, 0, -1], rotation: [0, Math.PI, 0] },
  { face: 'top', position: [0, 1, 0], rotation: [-Math.PI / 2, 0, 0] }, { face: 'bottom', position: [0, -1, 0], rotation: [Math.PI / 2, 0, 0] },
  { face: 'left', position: [-1, 0, 0], rotation: [0, -Math.PI / 2, 0] }, { face: 'right', position: [1, 0, 0], rotation: [0, Math.PI / 2, 0] },
]

function OrientationCube({ mapping, onSelect, modelSize }: { mapping: OrientationMapping; onSelect: (view: OrientationFace) => void; modelSize: [number, number, number] }) {
  const { side, centerY } = orientationCubePlacement(modelSize)
  return <group position={[0, centerY, 0]} scale={side}>
    <mesh><boxGeometry args={[1, 1, 1]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /><Edges color="#315f49" lineWidth={2} /></mesh>
    {orientationCubeFaces.map(({ face, position, rotation }) => <group key={face} position={position.map((value) => value * 0.5) as [number, number, number]} rotation={rotation}>
      <mesh onClick={(event) => { event.stopPropagation(); onSelect(face) }} onPointerOver={(event) => { event.stopPropagation(); document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = '' }}>
        <planeGeometry args={[0.96, 0.96]} />
        <meshBasicMaterial color={mapping[face] ? '#b97816' : '#91aa9d'} transparent opacity={mapping[face] ? 0.26 : 0.075} side={DoubleSide} depthWrite={false} />
      </mesh>
    </group>)}
  </group>
}

function OrientationPicker({ target, mapping, onSelect }: { target: OrientationFace | null; mapping: OrientationMapping; onSelect: (view: OrientationFace) => void }) {
  const assigned = new Set(Object.values(mapping))
  return <div className="orientation-picker" aria-label="选择目标正确面">
    <span className="orientation-picker-title">① 选择目标正确面</span>
    <div className="orientation-picker-faces">
      {orientationFaces.map((face) => <button key={face} type="button" className={`orientation-picker-face face-${face}${target === face ? ' selected' : ''}${assigned.has(face) ? ' assigned' : ''}`} aria-pressed={target === face} title={`选择目标${faceNames[face]}`} onClick={() => onSelect(face)}>
        <strong>{faceNames[face]}</strong><small>{assigned.has(face) ? '已配对' : '待选择'}</small>
      </button>)}
    </div>
  </div>
}

class PreviewErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return <div className="model-preview-error"><strong>模型无法预览</strong><span>{this.state.error.message}</span></div>
    }
    return this.props.children
  }
}

function measuredDimensions(object: Group): Dimensions {
  const size = new Vector3()
  new Box3().setFromObject(object).getSize(size)
  const largest = Math.max(size.x, size.y, size.z)
  const millimetersPerUnit = largest > 20 ? 1 : 1000
  const normalize = (value: number) => Math.round(Math.min(10_000, Math.max(10, value * millimetersPerUnit)))
  return { width: normalize(size.x), depth: normalize(size.z), height: normalize(size.y) }
}

function PreparedModel({ object, orientationView, orientationMapping = {}, onDimensions, onOrientationSelect }: { object: Group; orientationView: ModelOrientationView; orientationMapping?: OrientationMapping; onDimensions?: (dimensions: Dimensions) => void; onOrientationSelect?: (view: OrientationFace) => void }) {
  const scene = useMemo(() => {
    const clone = object.clone(true)
    clone.traverse((child) => {
      if ('castShadow' in child) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
    clone.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(clone)
    const center = bounds.getCenter(new Vector3())
    clone.position.set(clone.position.x - center.x, clone.position.y - bounds.min.y, clone.position.z - center.z)
    return clone
  }, [object])
  const dimensions = useMemo(() => measuredDimensions(scene), [scene])
  useEffect(() => onDimensions?.(dimensions), [dimensions, onDimensions])
  const modelSize = useMemo(() => {
    const size = new Vector3()
    new Box3().setFromObject(scene).getSize(size)
    return [size.x, size.y, size.z] as [number, number, number]
  }, [scene])
  return <><primitive object={scene} />{onOrientationSelect && <OrientationCube mapping={orientationMapping} onSelect={onOrientationSelect} modelSize={modelSize} />}</>
}

function GltfPreview({ src, orientationView, orientationMapping, onDimensions, onOrientationSelect }: PreviewModelProps) {
  const gltf = useGLTF(src)
  return <PreparedModel object={gltf.scene} orientationView={orientationView} orientationMapping={orientationMapping} onDimensions={onDimensions} onOrientationSelect={onOrientationSelect} />
}

function FbxPreview({ src, orientationView, orientationMapping, onDimensions, onOrientationSelect }: PreviewModelProps) {
  const object = useLoader(FBXLoader, src)
  return <PreparedModel object={object} orientationView={orientationView} orientationMapping={orientationMapping} onDimensions={onDimensions} onOrientationSelect={onOrientationSelect} />
}

function TdsPreview({ src, orientationView, orientationMapping, onDimensions, onOrientationSelect }: PreviewModelProps) {
  const object = useLoader(TDSLoader, src)
  return <PreparedModel object={object} orientationView={orientationView} orientationMapping={orientationMapping} onDimensions={onDimensions} onOrientationSelect={onOrientationSelect} />
}

function ObjPreview({ src, orientationView, orientationMapping, onDimensions, onOrientationSelect }: PreviewModelProps) {
  const object = useLoader(OBJLoader, src)
  return <PreparedModel object={object} orientationView={orientationView} orientationMapping={orientationMapping} onDimensions={onDimensions} onOrientationSelect={onOrientationSelect} />
}

type PreviewModelProps = { src: string; format: ModelAssetFormat; orientationView: ModelOrientationView; orientationMapping?: OrientationMapping; onDimensions?: (dimensions: Dimensions) => void; onOrientationSelect?: (view: OrientationFace) => void }

function PreviewModel(props: PreviewModelProps) {
  if (props.format === 'glb' || props.format === 'gltf') return <GltfPreview {...props} />
  if (props.format === 'fbx') return <FbxPreview {...props} />
  if (props.format === '3ds') return <TdsPreview {...props} />
  return <ObjPreview {...props} />
}

export function ModelAssetPreview({ assetKey, src, format, orientationView, orientationMapping, orientationTarget, onOrientationTargetSelect, onDimensions, onPreviewReady, onOrientationSelect }: {
  assetKey: string
  src: string
  format: ModelAssetFormat
  orientationView?: ModelOrientationView
  orientationMapping?: OrientationMapping
  orientationTarget?: OrientationFace | null
  onOrientationTargetSelect?: (face: OrientationFace) => void
  onDimensions?: (dimensions: Dimensions) => void
  onPreviewReady?: (capture: () => string) => void
  onOrientationSelect?: (view: OrientationFace) => void
}) {
  return (
    <div className="model-preview-stage">
      <PreviewErrorBoundary key={assetKey}>
        <Canvas key={assetKey} onCreated={({ gl }) => onPreviewReady?.(() => gl.domElement.toDataURL('image/jpeg', 0.86))} camera={{ position: [2.8, 1.9, 2.8], fov: 38 }} dpr={[1, 1.5]} gl={{ antialias: true, preserveDrawingBuffer: true }} shadows frameloop="always">
          <color attach="background" args={['#e7e6e1']} />
          <ambientLight intensity={1.4} />
          <directionalLight position={[3, 5, 4]} intensity={2.1} castShadow />
          <directionalLight position={[-3, 2, -2]} intensity={0.7} />
          <Suspense fallback={<Html center><div className="model-preview-loading"><LoaderCircle className="spin" size={18} />正在读取模型</div></Html>}>
            <Bounds fit clip observe margin={1.35}>
              <PreviewModel src={src} format={format} orientationView={orientationView ?? null} orientationMapping={orientationMapping} onDimensions={onDimensions} onOrientationSelect={onOrientationSelect} />
            </Bounds>
          </Suspense>
          <Grid position={[0, -0.002, 0]} args={[10, 10]} cellSize={0.1} cellThickness={0.45} cellColor="#b9bbb5" sectionSize={0.5} sectionThickness={0.8} sectionColor="#999d96" fadeDistance={7} infiniteGrid />
          <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={0.4} maxDistance={12} />
        </Canvas>
      </PreviewErrorBoundary>
      {onOrientationTargetSelect && <OrientationPicker target={orientationTarget ?? null} mapping={orientationMapping ?? {}} onSelect={onOrientationTargetSelect} />}
      <div className="model-preview-hint"><Rotate3d size={14} />{onOrientationSelect ? '右上角选目标面，再点击模型外框对应面' : '拖动旋转 · 滚轮缩放'}</div>
    </div>
  )
}
