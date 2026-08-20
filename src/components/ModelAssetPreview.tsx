import { Bounds, Center, Edges, Grid, Html, OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas, useLoader } from '@react-three/fiber'
import { LoaderCircle, Rotate3d } from 'lucide-react'
import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react'
import { Box3, DoubleSide, Group, Vector3 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import type { ModelAssetFormat } from '../types'
import { modelOrientation, type ModelOrientationView } from '../modelOrientation'

type Dimensions = { width: number; depth: number; height: number }
type OrientationFace = Exclude<ModelOrientationView, null>
const orientationFaces: { view: OrientationFace; position: [number, number, number]; rotation: [number, number, number] }[] = [
  { view: 'front', position: [0, 0, 1], rotation: [0, 0, 0] }, { view: 'back', position: [0, 0, -1], rotation: [0, Math.PI, 0] },
  { view: 'top', position: [0, 1, 0], rotation: [-Math.PI / 2, 0, 0] }, { view: 'bottom', position: [0, -1, 0], rotation: [Math.PI / 2, 0, 0] },
  { view: 'left', position: [-1, 0, 0], rotation: [0, -Math.PI / 2, 0] }, { view: 'right', position: [1, 0, 0], rotation: [0, Math.PI / 2, 0] },
]
function OrientationCube({ selected, onSelect }: { selected: ModelOrientationView; onSelect: (view: OrientationFace) => void }) {
  return <group position={[0, 1, 0]}><mesh><boxGeometry args={[2, 2, 2]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /><Edges color="#527864" lineWidth={1.5} /></mesh>{orientationFaces.map((face) => <mesh key={face.view} position={face.position} rotation={face.rotation} onClick={(event) => { event.stopPropagation(); onSelect(face.view) }} onPointerOver={(event) => { event.stopPropagation(); document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = '' }}><planeGeometry args={[1.88, 1.88]} /><meshBasicMaterial color={selected === face.view ? '#4f8068' : '#91aa9d'} transparent opacity={selected === face.view ? 0.22 : 0.055} side={DoubleSide} depthWrite={false} /></mesh>)}</group>
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

function PreparedModel({ object, orientationView, onDimensions }: { object: Group; orientationView: ModelOrientationView; onDimensions?: (dimensions: Dimensions) => void }) {
  const scene = useMemo(() => {
    const clone = object.clone(true)
    clone.traverse((child) => {
      if ('castShadow' in child) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
    clone.rotation.copy(modelOrientation(orientationView))
    clone.updateMatrixWorld(true)
    return clone
  }, [object, orientationView])
  const dimensions = useMemo(() => measuredDimensions(scene), [scene])
  useEffect(() => onDimensions?.(dimensions), [dimensions, onDimensions])
  return <Center bottom><primitive object={scene} /></Center>
}

function GltfPreview({ src, orientationView, onDimensions }: { src: string; orientationView: ModelOrientationView; onDimensions?: (dimensions: Dimensions) => void }) {
  const gltf = useGLTF(src)
  return <PreparedModel object={gltf.scene} orientationView={orientationView} onDimensions={onDimensions} />
}

function FbxPreview({ src, orientationView, onDimensions }: { src: string; orientationView: ModelOrientationView; onDimensions?: (dimensions: Dimensions) => void }) {
  const object = useLoader(FBXLoader, src)
  return <PreparedModel object={object} orientationView={orientationView} onDimensions={onDimensions} />
}

function TdsPreview({ src, orientationView, onDimensions }: { src: string; orientationView: ModelOrientationView; onDimensions?: (dimensions: Dimensions) => void }) {
  const object = useLoader(TDSLoader, src)
  return <PreparedModel object={object} orientationView={orientationView} onDimensions={onDimensions} />
}

function ObjPreview({ src, orientationView, onDimensions }: { src: string; orientationView: ModelOrientationView; onDimensions?: (dimensions: Dimensions) => void }) {
  const object = useLoader(OBJLoader, src)
  return <PreparedModel object={object} orientationView={orientationView} onDimensions={onDimensions} />
}

function PreviewModel({ src, format, orientationView, onDimensions }: { src: string; format: ModelAssetFormat; orientationView: ModelOrientationView; onDimensions?: (dimensions: Dimensions) => void }) {
  if (format === 'glb' || format === 'gltf') return <GltfPreview src={src} orientationView={orientationView} onDimensions={onDimensions} />
  if (format === 'fbx') return <FbxPreview src={src} orientationView={orientationView} onDimensions={onDimensions} />
  if (format === '3ds') return <TdsPreview src={src} orientationView={orientationView} onDimensions={onDimensions} />
  return <ObjPreview src={src} orientationView={orientationView} onDimensions={onDimensions} />
}

export function ModelAssetPreview({ assetKey, src, format, orientationView, onDimensions, onPreviewReady, onOrientationSelect }: {
  assetKey: string
  src: string
  format: ModelAssetFormat
  orientationView?: ModelOrientationView
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
              <PreviewModel src={src} format={format} orientationView={orientationView ?? null} onDimensions={onDimensions} />
              {onOrientationSelect && <OrientationCube selected={orientationView ?? null} onSelect={onOrientationSelect} />}
            </Bounds>
          </Suspense>
          <Grid position={[0, -0.002, 0]} args={[10, 10]} cellSize={0.1} cellThickness={0.45} cellColor="#b9bbb5" sectionSize={0.5} sectionThickness={0.8} sectionColor="#999d96" fadeDistance={7} infiniteGrid />
          <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={0.4} maxDistance={12} />
        </Canvas>
      </PreviewErrorBoundary>
      <div className="model-preview-hint"><Rotate3d size={14} />{onOrientationSelect ? '点击线框面纠正 · 拖动旋转' : '拖动旋转 · 滚轮缩放'}</div>
    </div>
  )
}
