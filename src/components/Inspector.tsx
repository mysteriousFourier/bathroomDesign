import { AlertCircle, CheckCircle2, ChevronRight, CircleAlert, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { cloneSpec, fixtureDefaults, fixtureLabels, roomBounds, roomCentroid, wallLength } from '../spec'
import type { Asset, EvidenceRole, FixtureKind, RoomSpec, Selection, SourceKind } from '../types'
import { EvidenceReview } from './EvidenceReview'

const sourceLabels: Record<SourceKind, string> = { measured: '测量', derived: '推导', estimated: '估算', user: '用户' }

function NumberField({ label, value, unit = 'mm', min = 0, step = 10, onChange }: { label: string; value: number; unit?: string; min?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="number-field"><span>{label}</span><div><input type="number" value={Math.round(value)} min={min} step={step} onChange={(event) => onChange(Number(event.target.value))} /><em>{unit}</em></div></label>
}

function SourceBadge({ source, confidence }: { source: SourceKind; confidence: number }) {
  return <span className={`source-badge ${source}`}>{sourceLabels[source]} · {Math.round(confidence * 100)}%</span>
}

export function Inspector({ spec, assets, selection, onSelect, onChange, onEvidenceApply, onEvidenceDelete, onEvidenceDraftChange, focusEvidenceId, onEvidenceActive, annotationMode = false }: {
  spec: RoomSpec
  assets: Asset[]
  onEvidenceApply: (id: string, value: string, role: EvidenceRole, targetId?: string | null, ignored?: boolean) => void
  onEvidenceDelete?: (id: string) => void
  onEvidenceDraftChange?: (id: string, role: EvidenceRole, targetId: string | null) => void
  focusEvidenceId?: string | null
  onEvidenceActive?: (id: string | null) => void
  annotationMode?: boolean
  selection: Selection
  onSelect: (selection: Selection) => void
  onChange: (spec: RoomSpec) => void
}) {
  const selectedFixture = selection.type === 'fixture' ? spec.fixtures.find((item) => item.id === selection.id) : undefined
  const selectedOpening = selection.type === 'opening' ? spec.openings.find((item) => item.id === selection.id) : undefined
  const bounds = roomBounds(spec.boundary)

  if (annotationMode) {
    return <aside className="inspector"><EvidenceReview spec={spec} assets={assets} onApply={onEvidenceApply} onDelete={onEvidenceDelete} focusId={focusEvidenceId} onActiveChange={onEvidenceActive} onDraftChange={onEvidenceDraftChange} /></aside>
  }

  const edit = (mutate: (draft: RoomSpec) => void) => {
    const draft = cloneSpec(spec)
    mutate(draft)
    draft.confirmed = false
    onChange(draft)
  }

  const resizeBoundary = (width: number, depth: number) => edit((draft) => {
    const old = roomBounds(draft.boundary)
    const scaleX = width / Math.max(old.width, 1)
    const scaleZ = depth / Math.max(old.depth, 1)
    draft.boundary = draft.boundary.map((point) => ({
      x_mm: Math.round(old.minX + (point.x_mm - old.minX) * scaleX),
      z_mm: Math.round(old.minZ + (point.z_mm - old.minZ) * scaleZ),
    }))
  })

  const addBoundaryPoint = () => edit((draft) => {
    if (draft.boundary.length < 2) return
    let edgeIndex = 0
    for (let index = 1; index < draft.boundary.length; index += 1) {
      if (wallLength(draft.boundary, index) > wallLength(draft.boundary, edgeIndex)) edgeIndex = index
    }
    const start = draft.boundary[edgeIndex]
    const end = draft.boundary[(edgeIndex + 1) % draft.boundary.length]
    draft.boundary.splice(edgeIndex + 1, 0, {
      x_mm: Math.round((start.x_mm + end.x_mm) / 2),
      z_mm: Math.round((start.z_mm + end.z_mm) / 2),
    })
  })

  const addFixture = (kind: FixtureKind) => {
    const center = roomCentroid(spec.boundary)
    const defaults = fixtureDefaults[kind]
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
    edit((draft) => draft.fixtures.push({
      id, kind, label: fixtureLabels[kind], x_mm: Math.round(center.x), z_mm: Math.round(center.z),
      ...defaults, rotation_deg: 0, source: 'user', confidence: 1,
    }))
    onSelect({ type: 'fixture', id })
  }

  const addOpening = () => {
    const id = `door-${crypto.randomUUID().slice(0, 8)}`
    edit((draft) => draft.openings.push({
      id, kind: 'door', wall_index: 0, offset_mm: 200, width_mm: 800, height_mm: 2100,
      thickness_mm: null, sill_mm: 0, label: '门洞', source: 'user', confidence: 1,
    }))
    onSelect({ type: 'opening', id })
  }

  return (
    <aside className="inspector">
      <EvidenceReview spec={spec} assets={assets} onApply={onEvidenceApply} onDelete={onEvidenceDelete} focusId={focusEvidenceId} />
      <section className="inspector-section">
        <div className="inspector-title"><span>属性</span><span className="selection-path">{selection.type === 'room' ? '空间' : selection.type === 'fixture' ? '设施' : '洞口'} <ChevronRight size={13} /></span></div>
        {selection.type === 'room' && (
          <div className="field-stack">
            <label className="text-field"><span>空间名称</span><input value={spec.name} onChange={(event) => edit((draft) => { draft.name = event.target.value })} /></label>
            <NumberField label="净宽" value={bounds.width} min={500} onChange={(value) => resizeBoundary(value, bounds.depth)} />
            <NumberField label="净深" value={bounds.depth} min={500} onChange={(value) => resizeBoundary(bounds.width, value)} />
            <NumberField label="层高" value={spec.height_mm ?? 0} min={1000} onChange={(value) => edit((draft) => { draft.height_mm = value })} />
            <NumberField label="墙厚" value={spec.wall_thickness_mm} min={50} onChange={(value) => edit((draft) => { draft.wall_thickness_mm = value })} />
            <div className="boundary-editor">
              <div className="boundary-editor-heading"><strong>轮廓折点</strong><span>{spec.boundary.length} 点</span></div>
              {spec.boundary.map((point, index) => (
                <div className="boundary-point-row" key={`boundary-${index}`}>
                  <span className="boundary-point-index">P{index + 1}</span>
                  <NumberField label="X" value={point.x_mm} min={0} onChange={(value) => edit((draft) => { draft.boundary[index].x_mm = value })} />
                  <NumberField label="Z" value={point.z_mm} min={0} onChange={(value) => edit((draft) => { draft.boundary[index].z_mm = value })} />
                  <button className="icon-button danger" disabled={spec.boundary.length <= 3} title={`删除折点 P${index + 1}`} onClick={() => edit((draft) => { draft.boundary.splice(index, 1) })}><Trash2 size={14} /></button>
                </div>
              ))}
              <button className="button secondary wide" onClick={addBoundaryPoint}><Plus size={15} />添加折点</button>
            </div>
            <div className="property-note">折点按墙体顺序连接；调整净宽或净深会缩放全部折点，设施位置保持不变。</div>
          </div>
        )}
        {selectedFixture && (
          <div className="field-stack">
            <div className="object-heading"><strong>{selectedFixture.label}</strong><SourceBadge source={selectedFixture.source} confidence={selectedFixture.confidence} /></div>
            <label className="text-field"><span>名称</span><input value={selectedFixture.label} onChange={(event) => edit((draft) => { draft.fixtures.find((item) => item.id === selectedFixture.id)!.label = event.target.value })} /></label>
            {(['x_mm', 'z_mm', 'width_mm', 'depth_mm', 'height_mm', 'rotation_deg'] as const).map((field) => (
              <NumberField key={field} label={{ x_mm: 'X 位置', z_mm: 'Z 位置', width_mm: '宽度', depth_mm: '深度', height_mm: '高度', rotation_deg: '旋转' }[field]} value={selectedFixture[field]} unit={field === 'rotation_deg' ? '°' : 'mm'} step={field === 'rotation_deg' ? 5 : 10} onChange={(value) => edit((draft) => { const item = draft.fixtures.find((candidate) => candidate.id === selectedFixture.id)!; item[field] = value })} />
            ))}
            <button className="button danger-text wide" onClick={() => { edit((draft) => { draft.fixtures = draft.fixtures.filter((item) => item.id !== selectedFixture.id) }); onSelect({ type: 'room' }) }}><Trash2 size={15} />删除设施</button>
          </div>
        )}
        {selectedOpening && (
          <div className="field-stack">
            <div className="object-heading"><strong>{selectedOpening.label}</strong><SourceBadge source={selectedOpening.source} confidence={selectedOpening.confidence} /></div>
            <label className="text-field"><span>类型</span><select value={selectedOpening.kind} onChange={(event) => edit((draft) => { draft.openings.find((item) => item.id === selectedOpening.id)!.kind = event.target.value as typeof selectedOpening.kind })}><option value="door">门</option><option value="window">窗</option><option value="opening">洞口</option></select></label>
            {(['wall_index', 'offset_mm', 'width_mm', 'height_mm', 'sill_mm'] as const).map((field) => (
              <NumberField key={field} label={{ wall_index: '墙面编号', offset_mm: '距墙起点', width_mm: '宽度', height_mm: '高度', sill_mm: '离地高度' }[field]} value={selectedOpening[field]} unit={field === 'wall_index' ? '' : 'mm'} step={field === 'wall_index' ? 1 : 10} onChange={(value) => edit((draft) => { const item = draft.openings.find((candidate) => candidate.id === selectedOpening.id)!; item[field] = value })} />
            ))}
            <NumberField label="门厚" value={selectedOpening.thickness_mm ?? 0} min={0} step={5} onChange={(value) => edit((draft) => { draft.openings.find((candidate) => candidate.id === selectedOpening.id)!.thickness_mm = value || null })} />
            <button className="button danger-text wide" onClick={() => { edit((draft) => { draft.openings = draft.openings.filter((item) => item.id !== selectedOpening.id) }); onSelect({ type: 'room' }) }}><Trash2 size={15} />删除洞口</button>
          </div>
        )}
      </section>

      <section className="inspector-section object-list-section">
        <div className="inspector-title"><span>模型对象</span><span>{spec.openings.length + spec.fixtures.length}</span></div>
        <button className={selection.type === 'room' ? 'object-row selected' : 'object-row'} onClick={() => onSelect({ type: 'room' })}><span className="object-icon room" />空间结构 <small>{spec.boundary.length} 面墙</small></button>
        {spec.openings.map((opening) => <button key={opening.id} className={selection.type === 'opening' && selection.id === opening.id ? 'object-row selected' : 'object-row'} onClick={() => onSelect({ type: 'opening', id: opening.id })}><span className="object-icon opening" />{opening.label}<small>{opening.width_mm} mm</small></button>)}
        {spec.fixtures.map((fixture) => <button key={fixture.id} className={selection.type === 'fixture' && selection.id === fixture.id ? 'object-row selected' : 'object-row'} onClick={() => onSelect({ type: 'fixture', id: fixture.id })}><span className={`object-icon ${fixture.source}`} />{fixture.label}<small>{Math.round(fixture.confidence * 100)}%</small></button>)}
        <div className="add-row">
          <select defaultValue="" onChange={(event) => { if (event.target.value) addFixture(event.target.value as FixtureKind); event.target.value = '' }} aria-label="添加设施">
            <option value="" disabled>添加设施…</option>
            {Object.entries(fixtureLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
          <button className="icon-button" title="添加门窗洞口" onClick={addOpening}><Plus size={16} /></button>
        </div>
      </section>

      <section className="inspector-section issue-section">
        <div className="inspector-title"><span>校验结果</span><span>{spec.issues.length}</span></div>
        {!spec.issues.length ? <div className="issue-ok"><CheckCircle2 size={16} />没有发现几何问题</div> : spec.issues.map((issue) => (
          <div key={issue.id} className={`issue-row ${issue.severity}`}>
            {issue.severity === 'error' ? <AlertCircle size={15} /> : issue.severity === 'warning' ? <TriangleAlert size={15} /> : <CircleAlert size={15} />}
            <span>{issue.message}</span>
          </div>
        ))}
      </section>
    </aside>
  )
}
