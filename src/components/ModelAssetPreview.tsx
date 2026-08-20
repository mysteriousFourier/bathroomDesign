import { Bounds, Grid, Html, OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas, useLoader } from '@react-three/fiber'
import { LoaderCircle, Rotate3d } from 'lucide-react'
import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react'
import { Box3, Group, Vector3 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import type { ModelAssetFormat } from '../types'
import { orientationFaceLabels, type ModelOrientationView, type OrientationFace } from '../modelOrientation'

type Dimensions = { width: number; depth: number; height: number }
const faceNames: Record<OrientationFace, string> = { front: '正面', back: '背面', top: '上面', bottom: '下面', left: '左面', right: '右面' }
const orientationFaces: OrientationFace[] = ['top', 'left', 'front', 'right', 'back', 'bottom']

function OrientationPicker({ selected, onSelect }: { selected: ModelOrientationView; onSelect: (view: OrientationFace) => void }) {
  const labels = orientationFaceLabels(selected)
  return <div className="orientation-picker" aria-label="选择模型正确正面">
    <span className="orientation-picker-title">选择正确正面</span>
    <div className="orientation-picker-faces">
      {orientationFaces.map((face) => <button key={face} type="button" className={`orientation-picker-face face-${face}${labels[face] === 'front' ? ' selected' : ''}`} aria-pressed={labels[face] === 'front'} title={`将当前${faceNames[face]}设为正面`} onClick={() => onSelect(face)}>
        <strong>{faceNames[face]}</strong><small>{faceNames[labels[face]]}</small>
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

function PreparedModel({ object, onDimensions }: { object: Group; onDimensions?: (dimensions: Dimensions) => void }) {
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
  return <primitive object={scene} />
}

function GltfPreview({ src, onDimensions }: PreviewModelProps) {
  const gltf = useGLTF(src)
  return <PreparedModel object={gltf.scene} onDimensions={onDimensions} />
}

function FbxPreview({ src, onDimensions }: PreviewModelProps) {
  const object = useLoader(FBXLoader, src)
  return <PreparedModel object={object} onDimensions={onDimensions} />
}

function TdsPreview({ src, onDimensions }: PreviewModelProps) {
  const object = useLoader(TDSLoader, src)
  return <PreparedModel object={object} onDimensions={onDimensions} />
}

function ObjPreview({ src, onDimensions }: PreviewModelProps) {
  const object = useLoader(OBJLoader, src)
  return <PreparedModel object={object} onDimensions={onDimensions} />
}

type PreviewModelProps = { src: string; format: ModelAssetFormat; orientationView: ModelOrientationView; onDimensions?: (dimensions: Dimensions) => void; onOrientationSelect?: (view: OrientationFace) => void }

function PreviewModel(props: PreviewModelProps) {
  if (props.format === 'glb' || props.format === 'gltf') return <GltfPreview {...props} />
  if (props.format === 'fbx') return <FbxPreview {...props} />
  if (props.format === '3ds') return <TdsPreview {...props} />
  return <ObjPreview {...props} />
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
              <PreviewModel src={src} format={format} orientationView={orientationView ?? null} onDimensions={onDimensions} onOrientationSelect={onOrientationSelect} />
            </Bounds>
          </Suspense>
          <Grid position={[0, -0.002, 0]} args={[10, 10]} cellSize={0.1} cellThickness={0.45} cellColor="#b9bbb5" sectionSize={0.5} sectionThickness={0.8} sectionColor="#999d96" fadeDistance={7} infiniteGrid />
          <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={0.4} maxDistance={12} />
        </Canvas>
      </PreviewErrorBoundary>
      {onOrientationSelect && <OrientationPicker selected={orientationView ?? null} onSelect={onOrientationSelect} />}
      <div className="model-preview-hint"><Rotate3d size={14} />{onOrientationSelect ? '右上角选择正确正面 · 拖动检查模型' : '拖动旋转 · 滚轮缩放'}</div>
    </div>
  )
}
