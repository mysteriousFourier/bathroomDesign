import { Check, ChevronLeft, ChevronRight, SkipForward, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { observationId, reviewEvidence } from '../evidence'
import type { Asset, EvidenceRole, RoomSpec } from '../types'

const roleLabels: Record<EvidenceRole, string> = {
  room_dimension: '房间总尺寸',
  wall_segment: '墙段长度',
  wall_thickness: '墙体厚度',
  room_height: '室内净高',
  ceiling_height: '吊顶高度与范围',
  door_size: '门窗洞口 CG / CK / CH',
  door_position: '门洞位置',
  drain_position: '排水点',
  pipe_box: '包管 / 柱',
  fixture_dimension: '设施尺寸',
  fixture_label: '设施名称',
  other: '其他 / 不使用',
}

const roleOptions: EvidenceRole[] = [
  'room_dimension', 'wall_segment', 'wall_thickness', 'room_height', 'ceiling_height',
  'door_size', 'drain_position', 'pipe_box', 'fixture_dimension', 'other',
]

export function EvidenceReview({ spec, assets, onApply, onDelete, focusId, onActiveChange, onDraftChange }: {
  spec: RoomSpec
  assets: Asset[]
  onApply: (id: string, value: string, role: EvidenceRole, targetId?: string | null, ignored?: boolean) => void
  onDelete?: (id: string) => void
  focusId?: string | null
  onActiveChange?: (id: string | null) => void
  onDraftChange?: (id: string, role: EvidenceRole, targetId: string | null) => void
}) {
  const planId = assets.filter((asset) => asset.role === 'floorplan').at(-1)?.id
  const observations = useMemo(() => spec.observations.filter((item) => (
    item.field.startsWith('ocr:') && (!planId || item.asset_id === planId)
  )), [planId, spec.observations])
  const pending = useMemo(() => reviewEvidence(spec, planId), [planId, spec])
  const [index, setIndex] = useState(0)
  const focused = focusId ? observations.find((item) => observationId(item) === focusId) : undefined
  const active = focused ?? pending[Math.min(index, Math.max(0, pending.length - 1))]
  const [value, setValue] = useState(active?.value ?? '')
  const [role, setRole] = useState<EvidenceRole>(active?.semantic_role ?? 'other')
  const [targetId, setTargetId] = useState(active?.target_id ?? '')

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, pending.length - 1)))
  }, [pending.length])

  useEffect(() => {
    if (!focusId) return
    const focused = pending.findIndex((item) => observationId(item) === focusId)
    if (focused >= 0) setIndex(focused)
  }, [focusId, pending])

  useEffect(() => {
    setValue(active?.value ?? '')
    setRole(active?.semantic_role ?? 'other')
    setTargetId(active?.target_id ?? '')
    onActiveChange?.(active ? observationId(active) : null)
  }, [active?.asset_id, active?.field, active?.semantic_role, active?.target_id, active?.value])

  useEffect(() => {
    setTargetId(active?.target_id ?? '')
  }, [active?.target_id])

  if (!active) {
    return (
      <section className="inspector-section evidence-review empty">
        <div className="inspector-title"><span>图片校正</span><span>0</span></div>
        <div className="issue-ok"><Check size={15} />OCR 疑问项已处理，可点击图中蓝框复核</div>
      </section>
    )
  }

  const usedDrainIds = spec.observations.map((item) => item.target_id?.match(/^drain:(\d+)$/)?.[1]).filter(Boolean).map(Number)
  const usedFixtureIds = spec.observations.map((item) => item.target_id?.match(/^fixture:(\d+)$/)?.[1]).filter(Boolean).map(Number)
  const wallBinding = role === 'wall_segment' || role === 'wall_thickness' || role === 'door_size' || role === 'door_position'
  const regionBinding = role === 'ceiling_height' || role === 'pipe_box'
  const wallMatch = targetId.match(/^wall:(\d+)(?:@([01](?:\.\d+)?)(?::([01](?:\.\d+)?))?)?$/)
  const doorRangeMatch = role === 'door_size' ? targetId.match(/^wall:(\d+)@([01](?:\.\d+)?):([01](?:\.\d+)?)$/) : null
  const wallBindingLabel = doorRangeMatch
    ? `W${Number(doorRangeMatch[1]) + 1} · 洞口内宽 ${Math.round(Number(doorRangeMatch[2]) * 100)}%–${Math.round(Number(doorRangeMatch[3]) * 100)}%`
    : role === 'door_size'
      ? (wallMatch ? `W${Number(wallMatch[1]) + 1} · 使用尺寸链或拖选洞口内宽` : '点照片中的目标墙线或沿洞口内宽拖选')
      : wallMatch ? `W${Number(wallMatch[1]) + 1}${wallMatch[2] ? ` · ${Math.round(Number(wallMatch[2]) * 100)}%` : ''}` : '点照片中的目标墙线'
  const nextDrainTarget = `drain:${Math.max(0, ...usedDrainIds) + 1}`
  const nextFixtureTarget = `fixture:${Math.max(0, ...usedFixtureIds) + 1}`
  const requiresTarget = role !== 'other'

  const changeRole = (nextRole: EvidenceRole) => {
    let nextTarget = targetId
    setRole(nextRole)
    if (nextRole === 'room_height') nextTarget = 'room_height'
    else if (nextRole === 'drain_position') nextTarget = targetId.startsWith('drain:') ? targetId : nextDrainTarget
    else if (nextRole === 'fixture_dimension' || nextRole === 'fixture_label') nextTarget = targetId.startsWith('fixture:') ? targetId : nextFixtureTarget
    else if (nextRole === 'room_dimension') nextTarget = targetId.startsWith('room:') ? targetId : 'room:width'
    else if (nextRole === 'ceiling_height') nextTarget = targetId.startsWith('ceiling:') ? targetId : ''
    else if (nextRole === 'pipe_box') nextTarget = targetId.startsWith('pipe_box:') ? targetId : ''
    else if (nextRole === 'other') nextTarget = ''
    else if (nextRole === 'door_size' && !targetId.startsWith('wall:')) nextTarget = ''
    else if (!targetId.startsWith('wall:')) nextTarget = ''
    setTargetId(nextTarget)
    onDraftChange?.(observationId(active), nextRole, nextTarget || null)
  }
  return (
    <section className="inspector-section evidence-review">
      <div className="inspector-title"><span>{focused ? '图片校正' : '待校正'}</span><span>{focused ? `待处理 ${pending.length}` : `${index + 1} / ${pending.length}`}</span></div>
      <div className="evidence-meta">
        <span>{observationId(active)}</span>
        <span>OCR {Math.round(active.confidence * 100)}%</span>
      </div>
      <label className="evidence-field">
        <span>识别文字 / 数值</span>
        <input value={value} autoComplete="off" onChange={(event) => setValue(event.target.value)} />
      </label>
      <label className="evidence-field">
        <span>数据归属</span>
        <select value={role} onChange={(event) => changeRole(event.target.value as EvidenceRole)}>
          {roleOptions.map((key) => <option key={key} value={key}>{roleLabels[key]}</option>)}
        </select>
      </label>
      {role === 'room_dimension' ? <label className="evidence-field">
        <span>数据归属</span>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="room:width">房间总宽</option>
          <option value="room:depth">房间总深</option>
        </select>
      </label> : wallBinding ? <div className={`evidence-binding${role === 'door_size' ? (doorRangeMatch ? ' bound' : '') : (wallMatch ? ' bound' : '')}`}><span>{role === 'door_size' ? '洞口对应线段' : '对应墙线'}</span><strong>{wallBindingLabel}</strong></div>
        : regionBinding ? <div className={`evidence-binding${targetId.startsWith(`${role === 'ceiling_height' ? 'ceiling' : 'pipe_box'}:`) ? ' bound' : ''}`}><span>覆盖范围</span><strong>{targetId ? '已在照片圈定' : '在照片框选对应区域'}</strong></div>
        : role !== 'other' ? <div className="evidence-binding bound"><span>对应对象</span><strong>{role === 'room_height' ? '房间净高' : role === 'drain_position' ? `图中点位 ${targetId.split(':')[1]}` : `设施 ${targetId.split(':')[1]}`}</strong></div> : null}
      <div className="evidence-actions">
        <div className="evidence-nav">
          <button className="icon-button" title="上一项" disabled={Boolean(focused) || index === 0} onClick={() => setIndex((current) => current - 1)}><ChevronLeft size={16} /></button>
          {onDelete && <button className="icon-button danger" title="删除误识别标注" onClick={() => onDelete(observationId(active))}><Trash2 size={15} /></button>}
          <button className="icon-button" title="下一项" disabled={Boolean(focused) || index >= pending.length - 1} onClick={() => setIndex((current) => current + 1)}><ChevronRight size={16} /></button>
        </div>
        <div className="evidence-commands">
          <button className="button ghost compact" onClick={() => onApply(observationId(active), value, 'other', null, true)}><SkipForward size={14} />不用于建模</button>
          <button className="button primary compact" disabled={!value.trim() || (requiresTarget && (role === 'door_size' ? !wallMatch : !targetId))} onClick={() => onApply(observationId(active), value.trim(), role, targetId || null)}><Check size={14} />确认并应用</button>
        </div>
      </div>
    </section>
  )
}
