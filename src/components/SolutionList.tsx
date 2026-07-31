import { BoxSelect, FileWarning, Ruler, Wand2 } from 'lucide-react'
import { roomBounds, structuralInnerBoundary } from '../spec'
import type { RoomSpec } from '../types'

function formatFootprint(spec: RoomSpec) {
  const bounds = roomBounds(structuralInnerBoundary(spec))
  return `结构 ${Math.round(bounds.width)} x ${Math.round(bounds.depth)} x ${Math.round(spec.height_mm ?? 0)} mm`
}

export function SolutionList({ spec, active, onOpenModel }: {
  spec: RoomSpec
  active: boolean
  onOpenModel: () => void
}) {
  const errorCount = spec.issues.filter((issue) => issue.severity === 'error').length
  const warningCount = spec.issues.filter((issue) => issue.severity === 'warning').length
  const measuredCount = [
    ...spec.openings.filter((item) => item.source === 'measured' || item.source === 'user'),
    ...spec.fixtures.filter((item) => item.source === 'measured' || item.source === 'user'),
  ].length

  if (errorCount) {
    return (
      <section className="solution-list no-solution" aria-label="方案列表">
        <div className="solution-title"><span>方案列表</span><strong>无可行方案</strong></div>
        <p><FileWarning size={15} />当前模型存在错误，三维详情和导出已锁定。请先修正墙体、净高或洞口问题。</p>
      </section>
    )
  }

  return (
    <section className="solution-list" aria-label="方案列表">
      <div className="solution-title"><span>方案列表</span><strong>{active ? '三维详情' : '二维复核'}</strong></div>
      <button className={active ? 'solution-card selected' : 'solution-card'} onClick={onOpenModel}>
        <BoxSelect size={17} />
        <span><strong>当前量房方案</strong><small>使用同一版房间轮廓、净高和洞口数据生成三维详情。</small></span>
      </button>
      <div className="solution-meta">
        <span><Ruler size={14} />{formatFootprint(spec)}</span>
        <span><Wand2 size={14} />{measuredCount} 个已确认对象</span>
        <span>{warningCount ? `${warningCount} 个警告` : '无阻断错误'}</span>
      </div>
    </section>
  )
}
