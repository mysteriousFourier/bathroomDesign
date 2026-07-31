import { AlertCircle, CheckCircle2, ChevronRight, CircleAlert, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { cloneSpec, finishedRoomBoundary, fixtureBoundWallIndex, fixtureCanBindWall, fixtureDefaults, fixtureLabels, fixturePointUsage, fixturePointUsageLabels, finishSurfaceOffset, generateDryWetZones, generateWallFinishProfiles, projectPointToWall, roomBounds, roomCentroid, stripsExistingFinish, structuralInnerBoundary, wallFinishBaseThickness, wallLength, wetZoneBoundaryValid } from '../spec'
import type { Asset, DryWetZone, EvidenceRole, FixtureKind, FixturePointUsage, RoomSpec, Selection, SourceKind } from '../types'
import { EvidenceReview } from './EvidenceReview'

const sourceLabels: Record<SourceKind, string> = { measured: '测量', derived: '推导', estimated: '估算', user: '用户' }

function NumberField({ label, value, unit = 'mm', min = 0, step = 10, disabled = false, onChange }: { label: string; value: number; unit?: string; min?: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <label className="number-field"><span>{label}</span><div><input type="number" value={Math.round(value)} min={min} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /><em>{unit}</em></div></label>
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
  const selectedZone = selection.type === 'dry_wet_zone' ? spec.dry_wet_zones?.find((item) => item.id === selection.id && item.kind === 'wet') : undefined
  const selectedFixtureWall = selectedFixture ? fixtureBoundWallIndex(spec, selectedFixture) : null
  const directBounds = roomBounds(spec.boundary)
  const structuralBounds = roomBounds(structuralInnerBoundary(spec))
  const finishedBoundary = finishedRoomBoundary(spec)
  const finishedBounds = roomBounds(finishedBoundary)
  const bounds = finishedBounds

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

  const addFixture = (kind: FixtureKind, pointUsage?: FixturePointUsage) => {
    const center = roomCentroid(finishedBoundary)
    const defaults = fixtureDefaults[kind]
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
    edit((draft) => {
      if (kind === 'floor_drain' && pointUsage === 'shower') draft.fixtures.forEach((fixture) => { if (fixture.kind === 'floor_drain') { fixture.point_usage = 'general'; if (fixture.label === '淋浴地漏') fixture.label = '地漏' } })
      draft.fixtures.push({
        id, kind, label: kind === 'floor_drain' && pointUsage === 'shower' ? '淋浴地漏' : fixtureLabels[kind], x_mm: Math.round(center.x), z_mm: Math.round(center.z),
        ...defaults, rotation_deg: 0, source: 'user', confidence: 1,
        point_usage: kind === 'floor_drain' || kind === 'drain' || kind === 'water' ? pointUsage ?? 'general' : undefined,
      })
      if (kind === 'floor_drain' && pointUsage === 'shower') draft.dry_wet_zones = generateDryWetZones(draft)
    })
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

  const addZone = () => {
    const id = `wet-${crypto.randomUUID().slice(0, 8)}`
    const center = roomCentroid(finishedBoundary)
    let boundary: DryWetZone['boundary'] | null = null
    for (const targetSize of [900, 650, 400]) {
      const width = Math.min(bounds.width, targetSize)
      const depth = Math.min(bounds.depth, targetSize)
      const starts = [{ x: center.x - width / 2, z: center.z - depth / 2 }]
      for (let z = bounds.minZ; z <= bounds.maxZ - depth; z += 100) for (let x = bounds.minX; x <= bounds.maxX - width; x += 100) starts.push({ x, z })
      const match = starts.map((start) => [
        { x_mm: Math.round(start.x), z_mm: Math.round(start.z) }, { x_mm: Math.round(start.x + width), z_mm: Math.round(start.z) },
        { x_mm: Math.round(start.x + width), z_mm: Math.round(start.z + depth) }, { x_mm: Math.round(start.x), z_mm: Math.round(start.z + depth) },
      ]).find((candidate) => wetZoneBoundaryValid(spec, id, candidate))
      if (match) { boundary = match; break }
    }
    if (!boundary) return
    edit((draft) => {
      const zone: DryWetZone = {
        id, kind: 'wet', label: '湿区', source: 'user', confidence: 1, boundary,
      }
      ;(draft.dry_wet_zones ??= []).push(zone)
    })
    onSelect({ type: 'dry_wet_zone', id })
  }

  const zoneBounds = selectedZone ? roomBounds(selectedZone.boundary) : null
  const updateZoneRect = (nextBounds: { minX: number; minZ: number; maxX: number; maxZ: number }) => edit((draft) => {
    const zone = draft.dry_wet_zones?.find((item) => item.id === selectedZone?.id)
    if (!zone) return
    const boundary = [
      { x_mm: Math.round(nextBounds.minX), z_mm: Math.round(nextBounds.minZ) }, { x_mm: Math.round(nextBounds.maxX), z_mm: Math.round(nextBounds.minZ) },
      { x_mm: Math.round(nextBounds.maxX), z_mm: Math.round(nextBounds.maxZ) }, { x_mm: Math.round(nextBounds.minX), z_mm: Math.round(nextBounds.maxZ) },
    ]
    if (!wetZoneBoundaryValid(draft, zone.id, boundary)) return
    zone.boundary = boundary
    zone.source = 'user'; zone.confidence = 1
  })

  return (
    <aside className="inspector">
      <EvidenceReview spec={spec} assets={assets} onApply={onEvidenceApply} onDelete={onEvidenceDelete} focusId={focusEvidenceId} />
      <section className="inspector-section">
        <div className="inspector-title"><span>属性</span><span className="selection-path">{selection.type === 'room' ? '空间' : selection.type === 'fixture' ? '设施' : selection.type === 'dry_wet_zone' ? '湿区' : '洞口'} <ChevronRight size={13} /></span></div>
        {selection.type === 'room' && (
          <div className="field-stack">
            <label className="text-field"><span>空间名称</span><input value={spec.name} onChange={(event) => edit((draft) => { draft.name = event.target.value })} /></label>
            <div className="surface-dimension-summary">
              <div><span>直测净尺寸</span><strong>{Math.round(directBounds.width)} x {Math.round(directBounds.depth)}</strong></div>
              <div><span>刨除后结构内尺寸</span><strong>{Math.round(structuralBounds.width)} x {Math.round(structuralBounds.depth)}</strong></div>
              <div><span>新完成面净尺寸</span><strong>{Math.round(finishedBounds.width)} x {Math.round(finishedBounds.depth)}</strong></div>
            </div>
            <NumberField label="直测净宽" value={directBounds.width} min={500} onChange={(value) => resizeBoundary(value, directBounds.depth)} />
            <NumberField label="直测净深" value={directBounds.depth} min={500} onChange={(value) => resizeBoundary(directBounds.width, value)} />
            <NumberField label="净高" value={spec.height_mm ?? 0} min={1000} onChange={(value) => edit((draft) => { draft.height_mm = value })} />
            <NumberField label="墙厚" value={spec.wall_thickness_mm} min={50} onChange={(value) => edit((draft) => { draft.wall_thickness_mm = value })} />
            <label className="checkbox-field"><input type="checkbox" checked={stripsExistingFinish(spec)} onChange={(event) => edit((draft) => { draft.strip_existing_finish = event.target.checked })} /><span>刨除原始完成面</span></label>
            <NumberField label="原饰面刨除" value={finishSurfaceOffset(spec)} min={0} disabled={!stripsExistingFinish(spec)} onChange={(value) => edit((draft) => { draft.finish_surface_offset_mm = value })} />
            <NumberField label="新饰面厚度" value={wallFinishBaseThickness(spec)} min={0} onChange={(value) => edit((draft) => { draft.wall_finish_thickness_mm = value })} />
            <div className="finish-editor">
              <button className="button secondary wide" onClick={() => edit((draft) => { draft.dry_wet_zones = generateDryWetZones(draft) })}>按淋浴地漏生成湿区</button>
              <button className="button secondary wide" disabled={(spec.dry_wet_zones ?? []).some((zone) => zone.kind === 'wet')} title={(spec.dry_wet_zones ?? []).some((zone) => zone.kind === 'wet') ? '当前房间已有湿区' : undefined} onClick={addZone}><Plus size={15} />添加湿区</button>
              <button className="button secondary wide" onClick={() => edit((draft) => { draft.wall_finish_profiles = generateWallFinishProfiles(draft) })}>生成逐墙饰面</button>
              {(spec.wall_finish_profiles ?? []).map((finish) => <div className="finish-row" key={`finish-row-${finish.wall_index}`}>
                <span>W{finish.wall_index + 1}{finish.generated_from_bound_point ? ' 绑定点' : ' 默认'}</span>
                <NumberField label="厚度" value={finish.thickness_mm} min={0} onChange={(value) => edit((draft) => {
                  const item = draft.wall_finish_profiles?.find((candidate) => candidate.wall_index === finish.wall_index)
                  if (item) { item.thickness_mm = value; item.source = 'user'; item.confidence = 1 }
                })} />
              </div>)}
            </div>
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
            {(selectedFixture.kind === 'floor_drain' || selectedFixture.kind === 'drain' || selectedFixture.kind === 'water') && <label className="text-field"><span>{selectedFixture.kind === 'floor_drain' ? '地漏类型' : '使用对象'}</span><select value={fixturePointUsage(selectedFixture) ?? 'general'} onChange={(event) => edit((draft) => {
              const usage = event.target.value as FixturePointUsage
              const item = draft.fixtures.find((candidate) => candidate.id === selectedFixture.id)!
              if (item.kind === 'floor_drain' && usage === 'shower') draft.fixtures.forEach((fixture) => { if (fixture.kind === 'floor_drain' && fixture.id !== item.id) { fixture.point_usage = 'general'; if (fixture.label === '淋浴地漏') fixture.label = '地漏' } })
              item.point_usage = usage
              if (item.kind === 'floor_drain') {
                if (usage === 'shower') item.label = '淋浴地漏'
                else if (item.label === '淋浴地漏') item.label = '地漏'
                draft.dry_wet_zones = generateDryWetZones(draft)
              }
            })}>{(selectedFixture.kind === 'floor_drain' ? (['general', 'shower'] as FixturePointUsage[]) : Object.keys(fixturePointUsageLabels) as FixturePointUsage[]).map((usage) => <option key={usage} value={usage}>{selectedFixture.kind === 'floor_drain' ? (usage === 'shower' ? '淋浴地漏' : '普通地漏') : `${fixturePointUsageLabels[usage]}${selectedFixture.kind === 'water' ? '给水' : '排水'}`}</option>)}</select></label>}
            {(['x_mm', 'z_mm', 'width_mm', 'depth_mm', 'height_mm', 'rotation_deg'] as const).map((field) => (
              <NumberField key={field} label={{ x_mm: 'X 位置', z_mm: 'Z 位置', width_mm: '宽度', depth_mm: '深度', height_mm: '高度', rotation_deg: '旋转' }[field]} value={selectedFixture[field]} unit={field === 'rotation_deg' ? '°' : 'mm'} step={field === 'rotation_deg' ? 5 : 10} onChange={(value) => edit((draft) => {
                const item = draft.fixtures.find((candidate) => candidate.id === selectedFixture.id)!
                item[field] = value
                if ((field === 'x_mm' || field === 'z_mm') && selectedFixtureWall !== null) {
                  const projection = projectPointToWall(finishedRoomBoundary(draft), selectedFixtureWall, item)
                  if (projection) { item.x_mm = projection.point.x_mm; item.z_mm = projection.point.z_mm }
                }
                if ((field === 'x_mm' || field === 'z_mm') && item.kind === 'floor_drain' && fixturePointUsage(item) === 'shower') draft.dry_wet_zones = generateDryWetZones(draft)
              })} />
            ))}
            {fixtureCanBindWall(selectedFixture.kind) && <label className="text-field"><span>绑定墙段</span><select value={selectedFixtureWall ?? ''} onChange={(event) => edit((draft) => {
              const item = draft.fixtures.find((candidate) => candidate.id === selectedFixture.id)!
              if (event.target.value === '') { item.bound_wall_index = null; return }
              const wallIndex = Number(event.target.value)
              const projection = projectPointToWall(finishedRoomBoundary(draft), wallIndex, item)
              item.bound_wall_index = projection ? wallIndex : null
              if (projection) { item.x_mm = projection.point.x_mm; item.z_mm = projection.point.z_mm }
            })}><option value="">未绑定</option>{spec.boundary.map((_, index) => <option key={index} value={index}>W{index + 1}</option>)}</select></label>}
            <button className="button danger-text wide" onClick={() => { edit((draft) => { draft.fixtures = draft.fixtures.filter((item) => item.id !== selectedFixture.id) }); onSelect({ type: 'room' }) }}><Trash2 size={15} />删除设施</button>
          </div>
        )}
        {selectedZone && zoneBounds && <div className="field-stack">
          <div className="object-heading"><strong>{selectedZone.label}</strong><SourceBadge source={selectedZone.source} confidence={selectedZone.confidence} /></div>
          <label className="text-field"><span>名称</span><input value={selectedZone.label} onChange={(event) => edit((draft) => { const zone = draft.dry_wet_zones?.find((item) => item.id === selectedZone.id); if (zone) zone.label = event.target.value })} /></label>
          <NumberField label="左边界 X" value={zoneBounds.minX} onChange={(value) => updateZoneRect({ ...zoneBounds, minX: Math.min(value, zoneBounds.maxX - 100) })} />
          <NumberField label="右边界 X" value={zoneBounds.maxX} onChange={(value) => updateZoneRect({ ...zoneBounds, maxX: Math.max(value, zoneBounds.minX + 100) })} />
          <NumberField label="上边界 Z" value={zoneBounds.minZ} onChange={(value) => updateZoneRect({ ...zoneBounds, minZ: Math.min(value, zoneBounds.maxZ - 100) })} />
          <NumberField label="下边界 Z" value={zoneBounds.maxZ} onChange={(value) => updateZoneRect({ ...zoneBounds, maxZ: Math.max(value, zoneBounds.minZ + 100) })} />
          <button className="button danger-text wide" onClick={() => { edit((draft) => { draft.dry_wet_zones = draft.dry_wet_zones?.filter((item) => item.id !== selectedZone.id) }); onSelect({ type: 'room' }) }}><Trash2 size={15} />删除分区</button>
        </div>}
        {selectedOpening && (
          <div className="field-stack">
            <div className="object-heading"><strong>{selectedOpening.label}</strong><SourceBadge source={selectedOpening.source} confidence={selectedOpening.confidence} /></div>
            <label className="text-field"><span>类型</span><select value={selectedOpening.kind} onChange={(event) => edit((draft) => { draft.openings.find((item) => item.id === selectedOpening.id)!.kind = event.target.value as typeof selectedOpening.kind })}><option value="door">门</option><option value="window">窗</option><option value="opening">洞口</option></select></label>
            {(['wall_index', 'offset_mm', 'sill_mm', 'width_mm', 'height_mm'] as const).map((field) => (
              <NumberField key={field} label={{ wall_index: '墙面编号', offset_mm: '距墙起点', sill_mm: 'CG 距地', width_mm: 'CK 内宽', height_mm: 'CH 内高' }[field]} value={selectedOpening[field]} unit={field === 'wall_index' ? '' : 'mm'} step={field === 'wall_index' ? 1 : 10} onChange={(value) => edit((draft) => { const item = draft.openings.find((candidate) => candidate.id === selectedOpening.id)!; item[field] = value })} />
            ))}
            <button className="button danger-text wide" onClick={() => { edit((draft) => { draft.openings = draft.openings.filter((item) => item.id !== selectedOpening.id) }); onSelect({ type: 'room' }) }}><Trash2 size={15} />删除洞口</button>
          </div>
        )}
      </section>

      <section className="inspector-section object-list-section">
        <div className="inspector-title"><span>模型对象</span><span>{spec.openings.length + spec.fixtures.length + (spec.dry_wet_zones?.filter((zone) => zone.kind === 'wet').length ?? 0)}</span></div>
        <button className={selection.type === 'room' ? 'object-row selected' : 'object-row'} onClick={() => onSelect({ type: 'room' })}><span className="object-icon room" />空间结构 <small>{spec.boundary.length} 面墙</small></button>
        {spec.openings.map((opening) => <button key={opening.id} className={selection.type === 'opening' && selection.id === opening.id ? 'object-row selected' : 'object-row'} onClick={() => onSelect({ type: 'opening', id: opening.id })}><span className="object-icon opening" />{opening.label}<small>{opening.width_mm} mm</small></button>)}
        {spec.fixtures.map((fixture) => <button key={fixture.id} className={selection.type === 'fixture' && selection.id === fixture.id ? 'object-row selected' : 'object-row'} onClick={() => onSelect({ type: 'fixture', id: fixture.id })}><span className={`object-icon ${fixture.source}`} />{fixture.label}<small>{Math.round(fixture.confidence * 100)}%</small></button>)}
        {(spec.dry_wet_zones ?? []).filter((zone) => zone.kind === 'wet').map((zone) => <button key={zone.id} className={selection.type === 'dry_wet_zone' && selection.id === zone.id ? 'object-row selected' : 'object-row'} onClick={() => onSelect({ type: 'dry_wet_zone', id: zone.id })}><span className="object-icon zone-wet" />{zone.label}<small>湿区</small></button>)}
        <div className="add-row">
          <select defaultValue="" onChange={(event) => { if (event.target.value === 'floor_drain:shower') addFixture('floor_drain', 'shower'); else if (event.target.value) addFixture(event.target.value as FixtureKind); event.target.value = '' }} aria-label="添加设施">
            <option value="" disabled>添加设施…</option>
            {Object.entries(fixtureLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
            <option value="floor_drain:shower">淋浴地漏</option>
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
