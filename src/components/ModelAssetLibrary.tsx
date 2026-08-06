import { Box, BoxSelect, FileBox, FolderOpen, HardDriveUpload, Plus, Trash2, UploadCloud } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { studioApi } from '../api'
import type { RoomModelAsset } from '../modelAssets'
import { droppedModelFiles, inputFiles, validateModelImport, type ModelImportFile } from '../modelImport'
import type { ImportedModelAsset } from '../types'
import { ModelAssetPreview } from './ModelAssetPreview'

type Dimensions = { width: number; depth: number; height: number }
type DisplayModelAsset = RoomModelAsset & {
  filename: string
  fileCount: number
}

const defaultDimensions: Dimensions = { width: 600, depth: 600, height: 600 }

function uploadedDisplayAsset(asset: ImportedModelAsset): DisplayModelAsset {
  return {
    id: asset.id,
    label: asset.label,
    src: asset.src,
    format: asset.format,
    unit: 'm',
    fit: 'contain',
    version: '1.0.0',
    sha256: asset.sha256,
    bytes: asset.bytes,
    source: '项目上传',
    source_asset_id: asset.id,
    lifecycle: 'approved',
    dimensions_mm: defaultDimensions,
    filename: asset.filename,
    fileCount: asset.file_count,
  }
}

function fileSize(bytes?: number) {
  if (!bytes) return '未知大小'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function ModelAssetLibrary({ projectId, canAddToRoom, usedAssetIds, onAddToRoom, onOpenRoom }: {
  projectId: string
  canAddToRoom: boolean
  usedAssetIds: string[]
  onAddToRoom: (asset: RoomModelAsset) => void
  onOpenRoom: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [uploadedAssets, setUploadedAssets] = useState<ImportedModelAsset[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [dimensions, setDimensions] = useState<Record<string, Dimensions>>({})
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void studioApi.modelAssets(projectId)
      .then((assets) => {
        if (!active) return
        setUploadedAssets(assets)
        setSelectedId(assets[0]?.id ?? '')
      })
      .catch((requestError: Error) => { if (active) setError(requestError.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId])

  const assets = useMemo(() => uploadedAssets.map(uploadedDisplayAsset), [uploadedAssets])
  const selected = assets.find((asset) => asset.id === selectedId) ?? assets[0]
  const selectedDimensions = selected ? dimensions[selected.id] ?? selected.dimensions_mm : defaultDimensions
  const selectedForRoom = selected ? { ...selected, dimensions_mm: selectedDimensions } : null
  const selectedInUse = !!selected && usedAssetIds.includes(selected.id)

  const updateSelectedDimensions = useCallback((next: Dimensions) => {
    if (!selectedId) return
    setDimensions((current) => {
      const previous = current[selectedId]
      if (previous && previous.width === next.width && previous.depth === next.depth && previous.height === next.height) return current
      return { ...current, [selectedId]: next }
    })
  }, [selectedId])

  const importEntries = async (entries: ModelImportFile[]) => {
    try {
      validateModelImport(entries)
      setUploading(true)
      setError('')
      const uploaded = await studioApi.uploadModelAsset(projectId, entries)
      setUploadedAssets((current) => [uploaded, ...current])
      setSelectedId(uploaded.id)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '模型上传失败')
    } finally {
      setUploading(false)
    }
  }

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files?.length) void importEntries(inputFiles(event.currentTarget.files))
    event.currentTarget.value = ''
  }

  const dropFiles = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!uploading) await importEntries(await droppedModelFiles(event.dataTransfer))
  }

  const openFilePicker = () => { if (!uploading) fileInputRef.current?.click() }
  const importKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openFilePicker()
    }
  }

  const removeSelected = async () => {
    if (!selected || selectedInUse) return
    if (!window.confirm(`从项目模型库删除“${selected.label}”？`)) return
    try {
      setError('')
      await studioApi.deleteModelAsset(projectId, selected.id)
      const remaining = uploadedAssets.filter((asset) => asset.id !== selected.id)
      setUploadedAssets(remaining)
      setSelectedId(remaining[0]?.id ?? '')
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '模型删除失败')
    }
  }

  return (
    <div className="model-library">
      <div className="library-toolbar">
        <div>
          <strong>模型库</strong>
          <span>{assets.length} 个项目上传模型</span>
        </div>
        <button className="button secondary" onClick={onOpenRoom} disabled={!canAddToRoom}><Box size={16} />三维房间</button>
      </div>

      <div
        className={`model-import-zone${dragging ? ' dragging' : ''}${uploading ? ' uploading' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="拖放或选择模型文件"
        onKeyDown={importKeyDown}
        onClick={openFilePicker}
        onDragEnter={(event) => { event.preventDefault(); dragDepth.current += 1; setDragging(true) }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
        onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false) }}
        onDrop={(event) => void dropFiles(event)}
      >
        <UploadCloud size={28} />
        <div>
          <strong>{uploading ? '正在上传模型' : dragging ? '松开以导入模型' : '拖放模型或模型文件夹'}</strong>
          <span>支持 GLB、GLTF、FBX、3DS、OBJ；GLTF 可连同 BIN 与纹理一起导入</span>
        </div>
        <div className="model-import-actions">
          <button className="button secondary compact" type="button" disabled={uploading} onClick={(event) => { event.stopPropagation(); fileInputRef.current?.click() }}><FileBox size={15} />选择模型</button>
          <button className="button secondary compact" type="button" disabled={uploading} onClick={(event) => { event.stopPropagation(); folderInputRef.current?.click() }}><FolderOpen size={15} />选择文件夹</button>
        </div>
        <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept=".glb,.gltf,.fbx,.3ds,.obj,.bin,.mtl,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tga,.dds,.ktx,.ktx2,.basis" onChange={chooseFiles} />
        <input ref={folderInputRef} className="visually-hidden" type="file" multiple onChange={chooseFiles} />
      </div>

      {error && <div className="model-library-error" role="alert">{error}</div>}

      <div className="model-library-workbench">
        <section className="model-asset-list" aria-label="模型资产列表">
          <header><strong>资产</strong><span>{loading ? '读取中' : `${assets.length} 项`}</span></header>
          <div className="model-asset-scroll">
            {assets.map((asset) => (
              <button className={`model-asset-row${selected?.id === asset.id ? ' active' : ''}`} key={asset.id} onClick={() => setSelectedId(asset.id)}>
                <span className="model-asset-icon"><BoxSelect size={19} /></span>
                <span className="model-asset-copy"><strong>{asset.label}</strong><span>{asset.format.toUpperCase()} · {fileSize(asset.bytes)}</span></span>
                <span className="model-origin uploaded">项目</span>
              </button>
            ))}
          </div>
        </section>

        <section className="model-browser" aria-label="模型浏览器">
          {selected && selectedForRoom ? <>
            <header className="model-browser-header">
              <div><strong>{selected.label}</strong><span>{selected.filename}</span></div>
              <div>
                <button className="icon-button" type="button" title={selectedInUse ? '模型正在房间中使用，不能删除' : '删除上传模型'} disabled={selectedInUse} onClick={() => void removeSelected()}><Trash2 size={16} /></button>
                <button className="button primary compact" type="button" disabled={!canAddToRoom} onClick={() => onAddToRoom(selectedForRoom)}><Plus size={15} />加入房间</button>
              </div>
            </header>
            <ModelAssetPreview assetKey={selected.id} src={selected.src} format={selected.format} onDimensions={updateSelectedDimensions} />
            <div className="model-browser-meta">
              <div><span>格式</span><strong>{selected.format.toUpperCase()}</strong></div>
              <div><span>文件</span><strong>{selected.fileCount}</strong></div>
              <div><span>尺寸</span><strong>{selectedDimensions.width} × {selectedDimensions.depth} × {selectedDimensions.height} mm</strong></div>
              <div><span>校验</span><code>{selected.sha256?.slice(0, 12) ?? '暂无'}</code></div>
            </div>
          </> : <div className="model-browser-empty"><HardDriveUpload size={28} /><strong>尚无模型</strong></div>}
        </section>
      </div>
    </div>
  )
}
