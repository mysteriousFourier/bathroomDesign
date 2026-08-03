import { Bounds, Center, Grid, Html, OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas, useLoader } from '@react-three/fiber'
import { LoaderCircle, Rotate3d } from 'lucide-react'
import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react'
import { Box3, Group, Vector3 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import type { ModelAssetFormat } from '../types'

type Dimensions = { width: number; depth: number; height: number }

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
    return clone
  }, [object])
  const dimensions = useMemo(() => measuredDimensions(scene), [scene])
  useEffect(() => onDimensions?.(dimensions), [dimensions, onDimensions])
  return <Center bottom><primitive object={scene} /></Center>
}

function GltfPreview({ src, onDimensions }: { src: string; onDimensions?: (dimensions: Dimensions) => void }) {
  const gltf = useGLTF(src)
  return <PreparedModel object={gltf.scene} onDimensions={onDimensions} />
}

function FbxPreview({ src, onDimensions }: { src: string; onDimensions?: (dimensions: Dimensions) => void }) {
  const object = useLoader(FBXLoader, src)
  return <PreparedModel object={object} onDimensions={onDimensions} />
}

function TdsPreview({ src, onDimensions }: { src: string; onDimensions?: (dimensions: Dimensions) => void }) {
  const object = useLoader(TDSLoader, src)
  return <PreparedModel object={object} onDimensions={onDimensions} />
}

function ObjPreview({ src, onDimensions }: { src: string; onDimensions?: (dimensions: Dimensions) => void }) {
  const object = useLoader(OBJLoader, src)
  return <PreparedModel object={object} onDimensions={onDimensions} />
}

function PreviewModel({ src, format, onDimensions }: { src: string; format: ModelAssetFormat; onDimensions?: (dimensions: Dimensions) => void }) {
  if (format === 'glb' || format === 'gltf') return <GltfPreview src={src} onDimensions={onDimensions} />
  if (format === 'fbx') return <FbxPreview src={src} onDimensions={onDimensions} />
  if (format === '3ds') return <TdsPreview src={src} onDimensions={onDimensions} />
  return <ObjPreview src={src} onDimensions={onDimensions} />
}

export function ModelAssetPreview({ assetKey, src, format, onDimensions }: {
  assetKey: string
  src: string
  format: ModelAssetFormat
  onDimensions?: (dimensions: Dimensions) => void
}) {
  return (
    <div className="model-preview-stage">
      <PreviewErrorBoundary key={assetKey}>
        <Canvas camera={{ position: [2.8, 1.9, 2.8], fov: 38 }} dpr={[1, 1.5]} gl={{ antialias: true, preserveDrawingBuffer: true }} shadows frameloop="always">
          <color attach="background" args={['#e7e6e1']} />
          <ambientLight intensity={1.4} />
          <directionalLight position={[3, 5, 4]} intensity={2.1} castShadow />
          <directionalLight position={[-3, 2, -2]} intensity={0.7} />
          <Suspense fallback={<Html center><div className="model-preview-loading"><LoaderCircle className="spin" size={18} />正在读取模型</div></Html>}>
            <Bounds fit clip observe margin={1.35}>
              <PreviewModel src={src} format={format} onDimensions={onDimensions} />
            </Bounds>
          </Suspense>
          <Grid position={[0, -0.002, 0]} args={[10, 10]} cellSize={0.1} cellThickness={0.45} cellColor="#b9bbb5" sectionSize={0.5} sectionThickness={0.8} sectionColor="#999d96" fadeDistance={7} infiniteGrid />
          <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={0.4} maxDistance={12} />
        </Canvas>
      </PreviewErrorBoundary>
      <div className="model-preview-hint"><Rotate3d size={14} />拖动旋转 · 滚轮缩放</div>
    </div>
  )
}
