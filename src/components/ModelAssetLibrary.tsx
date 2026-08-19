import { Box, BoxSelect, FileBox, FolderOpen, HardDriveUpload, Plus, ScanSearch, Trash2, UploadCloud } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { studioApi } from '../api'
import type { RoomModelAsset } from '../modelAssets'
import { droppedModelFiles, inputFiles, validateModelImport, type ModelImportFile } from '../modelImport'
import { builtInRoomAssets } from '../modelLibrary'
import type { ImportedModelAsset } from '../types'
import { ModelAssetPreview } from './ModelAssetPreview'

type Dimensions = { width: number; depth: number; height: number }
type DisplayModelAsset = RoomModelAsset & {
  filename: string
  fileCount: number
  builtIn?: boolean
  orientation_view?: 'front' | 'top' | 'side' | null
  orientation_corrected?: boolean
  orientation_source?: 'auto' | 'manual' | null
  binding_status?: 'bound' | 'unbound'
  binding_note?: string | null
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
    source: asset.library_scope === 'builtin' ? '内置模型库' : '共享模型库',
    source_asset_id: asset.id,
    lifecycle: 'approved',
    dimensions_mm: asset.dimensions_mm ?? defaultDimensions,
    category: asset.category ?? undefined,
    asset_type: 'fixture',
    catalog_codes: asset.catalog_codes,
    filename: asset.filename,
    fileCount: asset.file_count,
    builtIn: asset.library_scope === 'builtin',
    orientation_view: asset.orientation_view,
    orientation_corrected: asset.orientation_corrected,
    orientation_source: asset.orientation_source,
    binding_status: asset.binding_status,
    binding_note: asset.binding_note,
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
  const previewCaptures = useRef<Record<string, () => string>>({})
  const [uploadedAssets, setUploadedAssets] = useState<ImportedModelAsset[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [dimensions, setDimensions] = useState<Record<string, Dimensions>>({})
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const [error, setError] = useState('')
  const [correctionNotice, setCorrectionNotice] = useState('')
  const [bindingSku, setBindingSku] = useState('')
  const [newProductCategory, setNewProductCategory] = useState('')

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

  const assets = useMemo(() => [
    ...builtInRoomAssets.map((asset): DisplayModelAsset => ({ ...asset, filename: asset.label, fileCount: 1, builtIn: true })),
    ...uploadedAssets.map(uploadedDisplayAsset),
  ], [uploadedAssets])
  const selected = assets.find((asset) => asset.id === selectedId) ?? assets[0]
  const selectedDimensions = selected ? dimensions[selected.id] ?? selected.dimensions_mm : defaultDimensions
  const selectedForRoom = selected && selected.asset_type !== 'surface' ? { ...selected, dimensions_mm: selectedDimensions } : null
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
      setCorrectionNotice('')
      const uploaded = await studioApi.uploadModelAsset(projectId, entries)
      setUploadedAssets((current) => uploaded.library_scope === 'builtin'
        ? current
        : [uploaded, ...current.filter((asset) => asset.id !== uploaded.id)])
      setSelectedId(uploaded.id)
      if (uploaded.deduplicated) setCorrectionNotice(`“${uploaded.label}”已在${uploaded.library_scope === 'builtin' ? '内置' : '共享'}模型库中，未重复入库`)
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
    if (!selected || selected.builtIn || selectedInUse) return
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

  const replaceAsset = (updated: ImportedModelAsset) => setUploadedAssets((current) => current.map((asset) => asset.id === updated.id ? updated : asset))
  const bindSelected = async (createProduct = false) => {
    if (!selected || selected.builtIn || !bindingSku.trim()) return
    try {
      setError('')
      const newProduct = createProduct ? { '材料名称': newProductCategory.trim(), '物品名称': selected.label } : undefined
      replaceAsset(await studioApi.bindModelAsset(projectId, selected.id, bindingSku.trim(), newProduct))
      setCorrectionNotice(`已按 SKU ${bindingSku.trim()} 完成产品绑定`)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'SKU 绑定失败') }
  }
  const correctSelected = async (view: 'front' | 'top' | 'side') => {
    if (!selected || selected.builtIn) return
    try { setError(''); setCorrectionNotice(''); replaceAsset(await studioApi.correctModelOrientation(projectId, selected.id, view)) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : '人工方向纠正失败') }
  }
  const autoCorrectAll = async () => {
    const pending = uploadedAssets.filter((asset) => !asset.orientation_corrected)
    setError('')
    if (!uploadedAssets.length) {
      setCorrectionNotice('请先上传需要纠正方向的模型')
      return
    }
    if (!pending.length) {
      setCorrectionNotice('当前模型均已完成方向纠正，无需重复处理')
      return
    }
    setCorrectionNotice('')
    setCorrecting(true)
    try {
      for (const asset of pending) {
        const capture = previewCaptures.current[asset.id]
        if (!capture) throw new Error(`模型“${asset.label}”预览尚未就绪`)
        replaceAsset(await studioApi.autoCorrectModelOrientation(projectId, asset.id, capture()))
      }
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '自动方向纠正失败') }
    finally { setCorrecting(false) }
  }

  return (
    <div className="model-library">
      <div className="library-toolbar">
        <div>
          <strong>模型库</strong>
          <span>{assets.filter((asset) => asset.asset_type === 'fixture').length} 个设备模型 · {assets.filter((asset) => asset.asset_type === 'surface').length} 个板块材质</span>
        </div>
        <button className="button secondary" type="button" disabled={correcting} onClick={() => void autoCorrectAll()}><ScanSearch size={16} />{correcting ? '视觉纠正中' : '一键纠正'}</button>
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
      {correctionNotice && <div className="model-library-notice" role="status">{correctionNotice}</div>}

      <div className="model-library-workbench">
        <section className="model-asset-list" aria-label="模型资产列表">
          <header><strong>资产</strong><span>{loading ? '读取中' : `${assets.length} 项`}</span></header>
          <div className="model-asset-scroll">
            {assets.map((asset) => (
              <button className={`model-asset-row${selected?.id === asset.id ? ' active' : ''}`} key={asset.id} onClick={() => setSelectedId(asset.id)}>
                <span className="model-asset-icon"><BoxSelect size={19} /></span>
                <span className="model-asset-copy"><strong>{asset.label}</strong><span>{asset.format.toUpperCase()} · {fileSize(asset.bytes)}</span></span>
                <span className={`model-origin ${asset.builtIn ? 'builtin' : 'uploaded'}`}>{asset.builtIn ? asset.asset_type === 'surface' ? '板块' : '内置' : asset.orientation_corrected ? '已纠正' : '待纠正'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="model-browser" aria-label="模型浏览器">
          {selected && selectedForRoom ? <>
            <header className="model-browser-header">
              <div><strong>{selected.label}</strong><span>{selected.filename}</span></div>
              <div>
                {!selected.builtIn && <button className="icon-button" type="button" title={selectedInUse ? '模型正在房间中使用，不能删除' : '删除上传模型'} disabled={selectedInUse} onClick={() => void removeSelected()}><Trash2 size={16} /></button>}
                <button className="button primary compact" type="button" disabled={!canAddToRoom} onClick={() => onAddToRoom(selectedForRoom)}><Plus size={15} />加入房间</button>
              </div>
            </header>
            <ModelAssetPreview assetKey={selected.id} src={selected.src} format={selected.format} orientationView={selected.orientation_view} onDimensions={updateSelectedDimensions} onPreviewReady={(capture) => { previewCaptures.current[selected.id] = capture }} />
            <div className="model-browser-meta">
              <div><span>格式</span><strong>{selected.format.toUpperCase()}</strong></div>
              <div><span>文件</span><strong>{selected.fileCount}</strong></div>
              <div><span>尺寸</span><strong>{selectedDimensions.width} × {selectedDimensions.depth} × {selectedDimensions.height} mm</strong></div>
              <div><span>校验</span><code>{selected.sha256?.slice(0, 12) ?? '暂无'}</code></div>
              {!selected.builtIn && <div><span>产品绑定</span><strong>{selected.catalog_codes?.length ? selected.catalog_codes.join('、') : '未绑定，不参与自动报价布局'}</strong></div>}
            </div>
            {!selected.builtIn && selected.binding_status === 'unbound' && <div className="model-orientation-controls">
              <span>{selected.binding_note ?? '文件名只作提示，请按 SKU 绑定'}</span>
              <input aria-label="产品 SKU" value={bindingSku} onChange={(event) => setBindingSku(event.target.value)} placeholder="目录 SKU" />
              <button type="button" className="button primary compact" disabled={!bindingSku.trim()} onClick={() => void bindSelected(false)}>绑定已有 SKU</button>
              <input aria-label="新产品品类" value={newProductCategory} onChange={(event) => setNewProductCategory(event.target.value)} placeholder="新产品品类" />
              <button type="button" className="button secondary compact" disabled={!bindingSku.trim() || !newProductCategory.trim()} onClick={() => void bindSelected(true)}>新增产品并绑定</button>
            </div>}
            {!selected.builtIn && <div className="model-orientation-controls"><span>将原模型的</span>{(['front', 'top', 'side'] as const).map((view) => <button key={view} type="button" className={`button compact ${selected.orientation_view === view ? 'primary' : 'secondary'}`} onClick={() => void correctSelected(view)}>{{ front: '正面', top: '顶面', side: '侧面' }[view]}</button>)}<span>设为标准正面</span><small>{selected.orientation_corrected ? `${selected.orientation_source === 'auto' ? '视觉自动' : '人工'}纠正完成；可点击其他面重新纠正` : '选择后预览会立即按固定 90° 轴变换更新'}</small></div>}
          </> : selected ? <>
            <header className="model-browser-header"><div><strong>{selected.label}</strong><span>{selected.filename} · 固定板块材质</span></div></header>
            <ModelAssetPreview assetKey={selected.id} src={selected.src} format={selected.format} onDimensions={updateSelectedDimensions} />
            <div className="model-browser-meta"><div><span>类别</span><strong>{selected.category}</strong></div><div><span>规格</span><strong>{selectedDimensions.width} × {selectedDimensions.depth} × {selectedDimensions.height} mm</strong></div><div><span>价位</span><strong>{selected.price_tier ?? '按报价表'}</strong></div></div>
          </> : <div className="model-browser-empty"><HardDriveUpload size={28} /><strong>尚无模型</strong></div>}
        </section>
      </div>
      <div className="orientation-preview-pool" aria-hidden="true">{uploadedAssets.filter((asset) => !asset.orientation_corrected && asset.id !== selected?.id).map((asset) => <ModelAssetPreview key={asset.id} assetKey={`orientation-${asset.id}`} src={asset.src} format={asset.format} onPreviewReady={(capture) => { previewCaptures.current[asset.id] = capture }} />)}</div>
    </div>
  )
}
