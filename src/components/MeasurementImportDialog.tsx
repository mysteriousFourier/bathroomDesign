import { AlertTriangle, CheckCircle2, ChevronDown, FileInput, FileJson, FileType2, LoaderCircle, Ruler, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { studioApi } from '../api'
import type { MeasurementImportInspection, MeasurementImportResponse } from '../types'

const accept = '.json,.geojson,.svg,.dxf,.dwg,application/json,image/svg+xml,application/dxf,application/dwg'
const unitOptions = [
  ['auto', '自动检测'], ['mm', '毫米 (mm)'], ['cm', '厘米 (cm)'], ['m', '米 (m)'],
  ['in', '英寸 (in)'], ['ft', '英尺 (ft)'], ['px', '像素 (96 DPI)'],
] as const

interface MeasurementImportDialogProps {
  open: boolean
  projectId: string | null
  hasMeasurement: boolean
  onClose: () => void
  onImported: (result: MeasurementImportResponse) => void
}

export function MeasurementImportDialog({ open, projectId, hasMeasurement, onClose, onImported }: MeasurementImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [inspection, setInspection] = useState<MeasurementImportInspection | null>(null)
  const [unit, setUnit] = useState('auto')
  const [layer, setLayer] = useState('')
  const [heightMm, setHeightMm] = useState(2600)
  const [busy, setBusy] = useState<'inspect' | 'import' | null>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose, open])

  useEffect(() => {
    if (!open) {
      setFile(null); setInspection(null); setUnit('auto'); setLayer(''); setHeightMm(2600); setError(''); setBusy(null)
    }
  }, [open])

  const inspect = async (next: File) => {
    if (!projectId) return
    setFile(next); setInspection(null); setError(''); setLayer(''); setBusy('inspect')
    try {
      const result = await studioApi.inspectMeasurementImport(projectId, next)
      setInspection(result)
      setUnit(result.detected_unit ? 'auto' : 'mm')
      const bestLayer = [...result.layers]
        .sort((a, b) => b.boundary_candidates - a.boundary_candidates || b.entity_count - a.entity_count)[0]
      setLayer(bestLayer?.name ?? '')
    } catch (inspectError) {
      setError((inspectError as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const choose = (files: FileList | null) => {
    const next = files?.[0]
    if (next) void inspect(next)
  }

  const submit = async () => {
    if (!projectId || !file || !inspection?.can_import || busy) return
    if (hasMeasurement && !window.confirm('导入会替换当前项目的量房数据，原上传图片仍保留。确定继续吗？')) return
    setError(''); setBusy('import')
    try {
      const result = await studioApi.importMeasurement(projectId, file, { unit, layer, heightMm })
      onImported(result)
      onClose()
    } catch (importError) {
      setError((importError as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null
  const requiresDrawingOptions = inspection && ['svg', 'dxf', 'dwg', 'geojson'].includes(inspection.format)
  const requiresLayer = !!inspection?.layers.some((item) => item.boundary_candidates > 0)
  const formatLabel = inspection?.format.replace('measurement-contract-json', '量房契约 JSON').replace('measurement-json', '内部量房 JSON').replace('room-spec-json', 'RoomSpec JSON').toUpperCase()

  return (
    <div className="guide-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="measurement-import-dialog" role="dialog" aria-modal="true" aria-labelledby="measurement-import-title">
        <header className="measurement-import-header">
          <div>
            <span className="guide-kicker">结构化量房导入</span>
            <h2 id="measurement-import-title">导入平面数据</h2>
          </div>
          <button className="icon-button" title="关闭" aria-label="关闭导入量房数据" disabled={!!busy} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="measurement-import-body">
          <button
            className={`measurement-import-dropzone${dragging ? ' dragging' : ''}${file ? ' selected' : ''}`}
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files) }}
          >
            {busy === 'inspect' ? <LoaderCircle className="spin" size={24} /> : file ? <FileType2 size={24} /> : <Upload size={24} />}
            <strong>{busy === 'inspect' ? '正在读取图层和单位' : file?.name ?? '选择或拖入量房文件'}</strong>
            <span>JSON、GeoJSON、SVG、DXF、DWG</span>
          </button>
          <input ref={inputRef} className="visually-hidden" type="file" accept={accept} onChange={(event) => { choose(event.target.files); event.target.value = '' }} />

          {inspection && <div className="measurement-import-summary">
            <div><FileJson size={15} /><span>格式</span><strong>{formatLabel}</strong></div>
            <div><Ruler size={15} /><span>检测单位</span><strong>{inspection.detected_unit ?? '未声明'}</strong></div>
            <div>{inspection.can_import ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}<span>状态</span><strong>{inspection.can_import ? '可以导入' : '需要处理'}</strong></div>
          </div>}

          {requiresDrawingOptions && <div className="measurement-import-fields">
            <label><span>坐标单位</span><div className="select-wrap"><select value={unit} onChange={(event) => setUnit(event.target.value)}>{unitOptions.map(([value, label]) => <option key={value} value={value} disabled={value === 'auto' && inspection.unit_required}>{label}</option>)}</select><ChevronDown size={15} /></div></label>
            {requiresLayer && <label><span>房间轮廓图层</span><div className="select-wrap"><select value={layer} onChange={(event) => setLayer(event.target.value)}>{inspection.layers.filter((item) => item.boundary_candidates > 0).map((item) => <option key={item.name} value={item.name}>{item.name} · {item.boundary_candidates} 个闭合轮廓</option>)}</select><ChevronDown size={15} /></div></label>}
            <label><span>默认层高 (mm)</span><input type="number" min={1800} max={6000} step={10} value={heightMm} onChange={(event) => setHeightMm(Number(event.target.value))} /></label>
          </div>}

          {inspection?.layers.length ? <div className="measurement-layer-table">
            <div className="measurement-layer-head"><span>图层</span><span>元素</span><span>轮廓</span><span>点位</span></div>
            {inspection.layers.slice(0, 12).map((item) => <div key={item.name} className={item.name === layer ? 'selected' : ''}><span title={item.name}>{item.name}</span><span>{item.entity_count}</span><span>{item.boundary_candidates}</span><span>{item.point_markers}</span></div>)}
          </div> : null}

          {!!inspection?.warnings.length && <div className="measurement-import-notice warning"><AlertTriangle size={16} /><div>{inspection.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}
          {error && <div className="measurement-import-notice error" role="alert"><AlertTriangle size={16} /><p>{error}</p></div>}
          <p className="measurement-import-footnote">导入数据先进入二维审图。墙体、门窗、点位和单位通过校验并人工确认后，才可进入三维建模。</p>
        </div>

        <footer className="measurement-import-actions">
          <button className="button ghost" type="button" disabled={!!busy} onClick={onClose}>取消</button>
          <button className="button primary" type="button" disabled={!file || !inspection?.can_import || !!busy || heightMm < 1800 || heightMm > 6000 || (requiresLayer && !layer)} onClick={() => void submit()}>
            {busy === 'import' ? <LoaderCircle className="spin" size={15} /> : <FileInput size={15} />}{busy === 'import' ? '正在导入' : '导入并进入审图'}
          </button>
        </footer>
      </section>
    </div>
  )
}
