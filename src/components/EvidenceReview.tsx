import { Check, ChevronLeft, ChevronRight, ImageIcon, SkipForward } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Asset, EvidenceRole, Observation, RoomSpec } from '../types'

const roleLabels: Record<EvidenceRole, string> = {
  room_dimension: '房间总尺寸',
  wall_segment: '墙段 / 尺寸链',
  room_height: '房间层高',
  door_size: '门宽 / 门高',
  door_position: '门墙位置',
  drain_position: '排水 / 地漏 / 马桶孔',
  fixture_dimension: '洁具局部尺寸',
  fixture_label: '设施标签',
  other: '其他 / 不使用',
}

function evidenceId(observation: Observation) {
  return observation.field.startsWith('ocr:') ? observation.field.slice(4) : observation.field
}

function cropUrl(observation: Observation, assets: Asset[]) {
  if (!observation.asset_id || !observation.bbox) return null
  const asset = assets.find((item) => item.id === observation.asset_id)
  if (!asset) return null
  const params = new URLSearchParams({
    x_min: String(observation.bbox.x_min), y_min: String(observation.bbox.y_min),
    x_max: String(observation.bbox.x_max), y_max: String(observation.bbox.y_max),
    rotation_degrees: String(observation.rotation_degrees ?? 0),
  })
  return `${asset.url.replace(/\/content$/, '/crop')}?${params}`
}

export function EvidenceReview({ spec, assets, onApply }: {
  spec: RoomSpec
  assets: Asset[]
  onApply: (id: string, value: string, role: EvidenceRole, ignored?: boolean) => void
}) {
  const pending = useMemo(() => spec.observations.filter((item) => (
    item.field.startsWith('ocr:') && item.review_required && !item.confirmed
  )), [spec.observations])
  const [index, setIndex] = useState(0)
  const active = pending[Math.min(index, Math.max(0, pending.length - 1))]
  const [value, setValue] = useState(active?.value ?? '')
  const [role, setRole] = useState<EvidenceRole>(active?.semantic_role ?? 'other')

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, pending.length - 1)))
  }, [pending.length])

  useEffect(() => {
    setValue(active?.value ?? '')
    setRole(active?.semantic_role ?? 'other')
  }, [active?.field, active?.semantic_role, active?.value])

  if (!pending.length) {
    return (
      <section className="inspector-section evidence-review empty">
        <div className="inspector-title"><span>待校正</span><span>0</span></div>
        <div className="issue-ok"><Check size={15} />OCR 疑问项已处理</div>
      </section>
    )
  }

  const image = cropUrl(active, assets)
  return (
    <section className="inspector-section evidence-review">
      <div className="inspector-title"><span>待校正</span><span>{index + 1} / {pending.length}</span></div>
      <div className="evidence-crop">
        {image ? <img src={image} alt={`原图裁片 ${evidenceId(active)}`} /> : <ImageIcon size={22} />}
      </div>
      <div className="evidence-meta">
        <span>{evidenceId(active)}</span>
        <span>OCR {Math.round(active.confidence * 100)}%</span>
      </div>
      <label className="evidence-field">
        <span>识别文字 / 数值</span>
        <input value={value} autoComplete="off" onChange={(event) => setValue(event.target.value)} />
      </label>
      <label className="evidence-field">
        <span>数据归属</span>
        <select value={role} onChange={(event) => setRole(event.target.value as EvidenceRole)}>
          {Object.entries(roleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <div className="evidence-actions">
        <button className="icon-button" title="上一项" disabled={index === 0} onClick={() => setIndex((current) => current - 1)}><ChevronLeft size={16} /></button>
        <button className="button ghost compact" onClick={() => onApply(evidenceId(active), value, 'other', true)}><SkipForward size={14} />不用于建模</button>
        <button className="button primary compact" disabled={!value.trim()} onClick={() => onApply(evidenceId(active), value.trim(), role)}><Check size={14} />确认并应用</button>
        <button className="icon-button" title="下一项" disabled={index >= pending.length - 1} onClick={() => setIndex((current) => current + 1)}><ChevronRight size={16} /></button>
      </div>
    </section>
  )
}
