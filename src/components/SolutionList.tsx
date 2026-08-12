import { BoxSelect, CheckCircle2, ChevronDown, ChevronUp, FileWarning, Ruler, ShieldAlert, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { generateLayoutSolutions, type LayoutPreference, type LayoutSolution } from '../layoutEngine'
import { roomBounds, structuralInnerBoundary } from '../spec'
import type { RoomSpec } from '../types'

function formatFootprint(spec: RoomSpec) { const b = roomBounds(structuralInnerBoundary(spec)); return `同一房型 ${Math.round(b.width)} × ${Math.round(b.depth)} × ${Math.round(spec.height_mm ?? 0)} mm` }

function LayoutPlan({ spec, solution }: { spec: RoomSpec; solution: LayoutSolution }) {
  const points = spec.boundary
  const xs = points.map((p) => p.x_mm); const zs = points.map((p) => p.z_mm)
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minZ = Math.min(...zs); const maxZ = Math.max(...zs)
  const pad = 120; const width = maxX - minX; const depth = maxZ - minZ
  const x = (value: number) => value - minX + pad
  const y = (value: number) => maxZ - value + pad
  const colors: Record<string, string> = { shower: '#b9dce3', vanity: '#dfc7a6', toilet: '#eee9df', floor_drain: '#6f8d91', other: '#c8d6c0' }
  return <svg className="layout-plan" viewBox={`0 0 ${width + pad * 2} ${depth + pad * 2}`} role="img" aria-label={`${solution.title} 2D 俯视布局`}>
    <polygon points={points.map((p) => `${x(p.x_mm)},${y(p.z_mm)}`).join(' ')} className="plan-room" />
    <rect x={x(solution.wet_zone.x_mm) - solution.wet_zone.width_mm / 2} y={y(solution.wet_zone.z_mm) - solution.wet_zone.depth_mm / 2} width={solution.wet_zone.width_mm} height={solution.wet_zone.depth_mm} rx="35" fill="#b9dce3" opacity="0.42" className="plan-wet-zone" />
    {solution.fixtures.map((f) => <g key={f.id} transform={`translate(${x(f.x_mm)} ${y(f.z_mm)}) rotate(${-f.rotation_deg})`}>
      <rect x={-f.width_mm / 2} y={-f.depth_mm / 2} width={f.width_mm} height={f.depth_mm} rx="35" fill={colors[f.kind] ?? colors.other} className="plan-fixture" />
      <text textAnchor="middle" dominantBaseline="middle">{f.kind === 'floor_drain' ? '地漏' : f.kind === 'shower' ? '淋浴' : f.kind === 'vanity' ? '台盆' : f.kind === 'toilet' ? '坐便' : '收纳'}</text>
    </g>)}
    <path d={`M ${x(0)} ${y(0)} L ${x(260)} ${y(0)} L ${x(260)} ${y(320)} L ${x(0)} ${y(320)} Z`} className="plan-pipe" />
  </svg>
}

export function SolutionList({ spec, active, onOpenModel, onApplyLayout, preference, blockers, requireDecision = false }: { spec: RoomSpec; active: boolean; onOpenModel: () => void; onApplyLayout: (solution: LayoutSolution) => void; preference?: LayoutPreference; blockers?:string[]; requireDecision?:boolean }) {
  const errorCount = spec.issues.filter((x) => x.severity === 'error').length
  const solutions = useMemo(() => generateLayoutSolutions(spec, preference), [spec, preference])
  const [selectedId, setSelectedId] = useState(solutions[0]?.id ?? '')
  const [expanded, setExpanded] = useState(false)
  const selected = solutions.find((x) => x.id === selectedId) ?? solutions[0]
  useEffect(() => { if (selected && !solutions.some((x) => x.id === selectedId)) setSelectedId(selected.id) }, [selected, selectedId, solutions])
  const blockingCount = selected.checks.filter((x) => !x.passed && x.severity === 'error').length
  if (errorCount) return <section className="solution-list no-solution"><div className="solution-title"><span>智能布局</span><strong>三维暂不可用</strong></div><p><FileWarning size={15} />请先修正量房阻断错误。</p></section>
  if (blockers?.length) return <section className="solution-list no-solution" aria-label="自动布局阻断"><div className="solution-title"><span>需求驱动自动布局</span><strong>{formatFootprint(spec)}</strong></div><p><FileWarning size={15} />{blockers.join('；')}</p></section>
  if (requireDecision && preference?.levels?.length !== 3) return <section className="solution-list no-solution" aria-label="等待布局决策"><div className="solution-title"><span>需求驱动自动布局</span><strong>{formatFootprint(spec)}</strong></div><p><Wand2 size={15} />需求已确认，正在等待三个完整布局脚本。</p></section>
  return <section className="solution-list auto-layout" aria-label={preference?.levels?.length === 3 ? '三个需求驱动自动布局方案' : '三类需求九种独立布局'}>
    <div className="layout-header">
        <div className="solution-title"><span>{preference?.levels?.length === 3 ? '需求脚本 · 3 个真实产品布局' : '自动布局方案 · 3 类需求 × 3 种空间拓扑'}</span><strong>{formatFootprint(spec)}</strong></div>
      <div className="layout-entry-actions">
        {!expanded && <button className="button primary" onClick={() => setExpanded(true)}><Wand2 size={14} />开始自动布局</button>}
        <button className="button layout-toggle" aria-expanded={expanded} aria-controls="auto-layout-options" onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{expanded ? '收起方案' : '展开方案'}</button>
      </div>
    </div>
    {expanded && <div id="auto-layout-options" className="layout-options">
    <div className="layout-grid">{solutions.map((solution) => <button key={solution.id} data-level-id={solution.id} data-blocking-count={solution.checks.filter((x) => !x.passed && x.severity === 'error').length} className={solution.id === selected.id ? 'layout-card selected' : 'layout-card'} onClick={() => setSelectedId(solution.id)}><LayoutPlan spec={spec} solution={solution} /><span>{solution.title}</span><strong>方案价 ¥{solution.total_price.toLocaleString('zh-CN')}</strong><small>{solution.model_reason ?? solution.layout_summary}</small><small>{solution.product_lines.map((line) => line.code).join(' · ')}</small><small>{solution.budget_label}选品 · {solution.score} 分</small></button>)}</div>
    <div className="layout-detail">
      <div><strong>{selected.title}</strong><span><Ruler size={13} />坐标单位 mm · 原点沿用量房数据</span><b>方案合计 ¥{selected.total_price.toLocaleString('zh-CN')}</b><small>设备 ¥{selected.equipment_price.toLocaleString('zh-CN')} · 材料 ¥{selected.material_price.toLocaleString('zh-CN')}</small><small>{selected.product_lines.map((line) => `${line.code} ${line.category} ¥${line.price}`).join(' · ')}</small><small>{selected.material_lines.map((line) => `${line.code} ${line.quantity}㎡ ¥${line.subtotal}`).join(' · ')}</small></div>
      <div className="layout-anchors"><b>布局脚本 {selected.layout_script.version}</b>{selected.layout_script.instructions.map((i)=><code key={i.fixture_role}>{i.fixture_role}: {i.zone} / {i.wall}{i.near?` / near ${i.near}`:''}</code>)}<b>求解：{selected.solver_trace.feasible_candidates}/{selected.solver_trace.candidates_evaluated} 可行 · {selected.solver_trace.reachable?'路径可达':'路径阻断'}</b>{selected.anchors.map((a) => <code key={a.id}>{a.label}: ({a.x_mm}, {a.z_mm}) · {a.instruction}</code>)}</div>
      <div className="layout-checks">{selected.checks.map((c) => <span className={c.passed ? 'pass' : c.severity === 'error' ? 'fail' : 'warn'} key={c.code}>{c.passed ? <CheckCircle2 size={12} /> : <ShieldAlert size={12} />}<b>{c.code}</b> [{c.severity}/{c.source}] {c.message}</span>)}</div>
      <div className="layout-actions"><button className="button" onClick={onOpenModel}><BoxSelect size={14} />查看当前 3D</button><button className="button primary" disabled={blockingCount > 0} title={blockingCount ? `存在 ${blockingCount} 个硬错误` : undefined} onClick={() => onApplyLayout(selected)}><Wand2 size={14} />{blockingCount ? '硬错误未通过' : '执行自动布局并打开 3D'}</button></div>
    </div>
    <span className="layout-method">需求与量房 → layout-script-v1 → 真实产品尺寸 → 语义锚点 → 多边形/碰撞/门区/栅格可达性求解 → 精确坐标 3D 场景</span>
    </div>}
  </section>
}
