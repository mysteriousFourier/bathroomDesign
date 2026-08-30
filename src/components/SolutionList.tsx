import { BoxSelect, CheckCircle2, ChevronDown, ChevronUp, FileWarning, LoaderCircle, Ruler, ShieldAlert, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { LayoutSolution } from '../layoutEngine'
import { fixturePointUsage, fixturePointUsageLabels, roomBounds, structuralInnerBoundary, wallPanelCutList, WALL_PANEL_STANDARD_WIDTH_MM } from '../spec'
import type { FixtureSpec, RoomSpec } from '../types'

function formatFootprint(spec: RoomSpec) {
  const bounds = roomBounds(structuralInnerBoundary(spec))
  return `同一房型 ${Math.round(bounds.width)} × ${Math.round(bounds.depth)} × ${Math.round(spec.height_mm ?? 0)} mm`
}

function hardErrorCount(solution: LayoutSolution) {
  return solution.checks.filter((check) => !check.passed && check.severity === 'error').length
}

function isLockablePoint(fixture: FixtureSpec) {
  return ['floor_drain', 'drain', 'water', 'electric'].includes(fixture.kind)
    || fixture.kind === 'toilet'
}

function pointLabel(fixture: FixtureSpec) {
  const usage = fixturePointUsage(fixture)
  return usage && fixture.kind !== 'toilet' ? `${fixture.label} · ${fixturePointUsageLabels[usage]}` : fixture.label
}

/** Sub-level menu under the wall panels: per-piece cut widths after laying out 600 mm boards. */
function WallPanelCutMenu({ spec }: { spec: RoomSpec }) {
  const [open, setOpen] = useState(false)
  const walls = useMemo(() => wallPanelCutList(spec), [spec])
  const panelCount = walls.reduce((sum, wall) => sum + wall.runs.reduce((runSum, run) => runSum + run.panels.length, 0), 0)
  return <div className="wall-panel-menu">
    <button className="button layout-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{open ? '收起墙板切割' : `墙板切割明细（${panelCount} 块）`}
    </button>
    {open && <div className="wall-panel-list">
      {walls.map((wall) => wall.runs.length ? <div key={wall.wall_index}>
        <b>W{wall.wall_index + 1} 面墙 · 标准板 {WALL_PANEL_STANDARD_WIDTH_MM}mm</b>
        {wall.runs.map((run) => <code key={run.key}>{run.start_mm}–{run.end_mm}mm 段 · 共 {run.panels.length} 块：{run.panels.map((width, index) => `第 ${index + 1} 块切割后 ${width}mm`).join('；')}</code>)}
      </div> : null)}
    </div>}
  </div>
}

export function selectAutomaticLayoutSolution(solutions: LayoutSolution[]) {
  return solutions
    .filter((solution) => hardErrorCount(solution) === 0)
    .sort((left, right) => right.score - left.score || left.total_price - right.total_price)[0]
}

function LayoutPlan({ spec, solution }: { spec: RoomSpec; solution: LayoutSolution }) {
  const points = spec.boundary
  const xs = points.map((point) => point.x_mm); const zs = points.map((point) => point.z_mm)
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minZ = Math.min(...zs); const maxZ = Math.max(...zs)
  const pad = 120; const width = maxX - minX; const depth = maxZ - minZ
  const x = (value: number) => value - minX + pad
  const y = (value: number) => maxZ - value + pad
  const colors: Record<string, string> = { shower: '#b9dce3', vanity: '#dfc7a6', toilet: '#eee9df', floor_drain: '#6f8d91', other: '#c8d6c0' }
  return <svg className="layout-plan" viewBox={`0 0 ${width + pad * 2} ${depth + pad * 2}`} role="img" aria-label={`${solution.title} 2D 俯视布局`}>
    <polygon points={points.map((point) => `${x(point.x_mm)},${y(point.z_mm)}`).join(' ')} className="plan-room" />
    <rect x={x(solution.wet_zone.x_mm) - solution.wet_zone.width_mm / 2} y={y(solution.wet_zone.z_mm) - solution.wet_zone.depth_mm / 2} width={solution.wet_zone.width_mm} height={solution.wet_zone.depth_mm} rx="35" fill="#b9dce3" opacity="0.42" className="plan-wet-zone" />
    {solution.fixtures.map((fixture) => <g key={fixture.id} transform={`translate(${x(fixture.x_mm)} ${y(fixture.z_mm)}) rotate(${-fixture.rotation_deg})`}>
      <rect x={-fixture.width_mm / 2} y={-fixture.depth_mm / 2} width={fixture.width_mm} height={fixture.depth_mm} rx="35" fill={colors[fixture.kind] ?? colors.other} className="plan-fixture" />
      <text textAnchor="middle" dominantBaseline="middle">{fixture.kind === 'floor_drain' ? '地漏' : fixture.kind === 'shower' ? '淋浴' : fixture.kind === 'vanity' ? '台盆' : fixture.kind === 'toilet' ? '坐便' : '设备'}</text>
    </g>)}
  </svg>
}

export function SolutionList({ spec, solutions, selectedSolution, onSelectSolution, onOpenModel, onStartAutoLayout, onClearLayout, canClearLayout, onFocusSolution, onPointLocksChange, layoutRunning, layoutError }: {
  spec: RoomSpec
  solutions: LayoutSolution[]
  selectedSolution: LayoutSolution | null
  onSelectSolution: (solution: LayoutSolution) => void
  onOpenModel: () => void
  onStartAutoLayout: () => Promise<void>
  onClearLayout: () => void
  canClearLayout: boolean
  onFocusSolution?: (solution: LayoutSolution) => void
  onPointLocksChange?: (fixtureIds: string[]) => void
  layoutRunning?: boolean
  layoutError?: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const running = layoutRunning ?? false
  const error = layoutError ?? localError
  const errorCount = spec.issues.filter((issue) => issue.severity === 'error').length
  const lockablePoints = spec.fixtures.filter(isLockablePoint)
  const isLocked = (fixture: FixtureSpec) => fixture.placement_locked === true
  const allPointsLocked = lockablePoints.length > 0 && lockablePoints.every(isLocked)
  const selectedPointIds = lockablePoints.filter(isLocked).map((fixture) => fixture.id)
  useEffect(() => {
    if (!solutions.length) {
      setFocusedId(null)
      return
    }
    if (focusedId && solutions.some((item) => item.id === focusedId)) return
    setFocusedId(selectedSolution?.id ?? solutions[0].id)
  }, [focusedId, selectedSolution?.id, solutions])
  const solution = solutions.find((item) => item.id === focusedId) ?? selectedSolution ?? solutions[0] ?? null
  const blockingCount = solution ? hardErrorCount(solution) : 0

  async function start() {
    if (running) return
    setLocalError(null)
    try {
      await onStartAutoLayout()
    } catch (reason) {
      setLocalError((reason as Error).message)
    }
  }

  if (errorCount) return <section className="solution-list no-solution auto-layout">
    <div className="layout-header">
      <div className="solution-title"><span>大模型自动布局</span><strong>三维暂不可用</strong></div>
      {canClearLayout && <button className="button danger-text compact" onClick={onClearLayout}><Trash2 size={14} />清理布局</button>}
    </div>
    <p><FileWarning size={15} />请先修正量房阻断错误。</p>
  </section>
  return <section className="solution-list auto-layout" aria-label="大模型自动布局">
    <div className="layout-header">
      <div className="solution-title"><span>大模型自动布局</span><strong>{formatFootprint(spec)}{solutions.length ? ` · ${solutions.length} 档` : ''}</strong></div>
      <div className="layout-entry-actions">
        {lockablePoints.length > 0 && <div className="point-lock-control">
          <label className="checkbox-field compact"><input type="checkbox" checked={allPointsLocked} onChange={(event) => {
            const next = event.target.checked ? lockablePoints.map((fixture) => fixture.id) : []
            onPointLocksChange?.(next)
          }} /><span>固定点位自动布局</span></label>
          <details className="point-lock-menu">
            <summary>选择固定点位 ({selectedPointIds.length}/{lockablePoints.length})</summary>
            <div className="point-lock-options">{lockablePoints.map((fixture) => <label key={fixture.id} className="checkbox-field compact"><input type="checkbox" checked={isLocked(fixture)} onChange={(event) => {
              const next = new Set(selectedPointIds)
              if (event.target.checked) next.add(fixture.id)
              else next.delete(fixture.id)
              onPointLocksChange?.([...next])
            }} /><span>{pointLabel(fixture)}</span></label>)}</div>
          </details>
        </div>}
        <button className="button primary" disabled={running} onClick={() => void start()}>
          {running ? <LoaderCircle className="spin" size={14} /> : <Wand2 size={14} />}{running ? '正在调用大模型' : '开始自动布局'}
        </button>
        {canClearLayout && <button className="button danger-text compact" disabled={running} onClick={onClearLayout}><Trash2 size={14} />清理布局</button>}
        {solutions.length > 0 && <button className="button layout-toggle" aria-expanded={expanded} aria-controls="auto-layout-details" onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{expanded ? '收起布局方案' : `展开布局方案 (${solutions.length})`}</button>}
      </div>
    </div>
    {!solution && !error && <span className="layout-method">点击后调用 CHAT_MODEL 生成产品选择与布局脚本；未调用模型前不生成布局结果。</span>}
    {error && <p className="layout-run-error"><FileWarning size={15} />{error}</p>}
    {solution && expanded && <div id="auto-layout-details" className="layout-options">
      <div className="layout-grid">
        {solutions.map((item, index) => <button className={`layout-card${item.id === solution.id ? ' selected' : ''}${hardErrorCount(item) ? ' invalid' : ''}`} key={item.id} onClick={() => {
          setFocusedId(item.id)
          if (hardErrorCount(item) === 0) onFocusSolution?.(item)
        }}>
          <span>LEVEL {index + 1} · {item.title}</span><strong>¥{item.total_price.toLocaleString('zh-CN')}</strong><small>{hardErrorCount(item) ? `存在 ${hardErrorCount(item)} 个硬错误，不可应用` : '硬校验通过'} · {item.fixtures.length} 个实体</small>
        </button>)}
      </div>
      <div className="layout-detail">
        <div><LayoutPlan spec={spec} solution={solution} /><strong>{solution.title}</strong><span><Ruler size={13} />坐标单位 mm · 原点沿用量房数据</span><b>合计 ¥{solution.total_price.toLocaleString('zh-CN')}</b><small>设备 ¥{solution.equipment_price.toLocaleString('zh-CN')} · 材料 ¥{solution.material_price.toLocaleString('zh-CN')}</small></div>
        <div className="layout-anchors">
          <b>模型调用证据</b>
          <code>model: {solution.model_call?.model ?? '缺失'}</code>
          <code>response: {solution.model_call?.provider_response_id ?? '供应商未返回 ID'}</code>
          <code>tool call: {solution.model_call?.tool_call_id ?? '缺失'}</code>
          <code>generated: {solution.model_call?.generated_at ?? '缺失'} · tokens {solution.model_call?.usage?.total_tokens ?? '未返回'}</code>
          {solution.model_calls && solution.model_calls.length > 1 && <code>修复轮次: {solution.model_calls.length} · {solution.model_calls.map((call) => call.provider_response_id ?? '无 ID').join(' → ')}</code>}
          <b>布局脚本 {solution.layout_script.version} · {solution.layout_script.source}</b>
          {solution.layout_script.instructions.map((instruction) => <code key={instruction.fixture_role}>{instruction.fixture_role}: {instruction.zone} / {instruction.wall}{instruction.near ? ` / near ${instruction.near}` : ''}</code>)}
          <b>几何精调：{solution.solver_trace.feasible_candidates}/{solution.solver_trace.candidates_evaluated} 可行 · {solution.solver_trace.reachable ? '路径可达' : '路径阻断'}</b>
          {solution.solver_trace.alternating_rounds && <b>交替优化：{solution.solver_trace.alternating_rounds} 轮家具重排 × 管网重算 · 选中管长 {solution.solver_trace.selected_pipe_mm ?? 0}mm · 极差 {solution.solver_trace.selected_imbalance_mm ?? 0}mm</b>}
          {solution.solver_trace.iterations?.map((iteration) => <code key={`pipe-iteration-${iteration.iter}`}>第 {iteration.iter + 1} 轮 · {iteration.moved.length ? `重排 ${iteration.moved.join('、')}` : '初始完整家具'} · 管长 {iteration.total_pipe_mm} · 极差 {iteration.imbalance_mm} · J={iteration.objective} {iteration.accepted ? '✓ 接受' : '保留前轮'}</code>)}
          {solution.anchors.map((anchor) => <code key={anchor.id}>{anchor.label}: ({anchor.x_mm}, {anchor.z_mm}) · {anchor.instruction}</code>)}
        </div>
        <div className="layout-checks">{solution.checks.map((check) => <span className={check.passed ? 'pass' : check.severity === 'error' ? 'fail' : 'warn'} key={check.code}>{check.passed ? <CheckCircle2 size={12} /> : <ShieldAlert size={12} />}<b>{check.code}</b> [{check.severity}/{check.source}] {check.message}</span>)}</div>
        <div className="layout-actions"><button className="button" disabled={blockingCount > 0} onClick={() => { onSelectSolution(solution); onOpenModel() }}><BoxSelect size={14} />应用并查看 3D</button><b>{blockingCount ? '内部求解未完成' : '碰撞调整完成'}</b></div>
      </div>
      <WallPanelCutMenu spec={spec} />
      <span className="layout-method">LLM 工具调用 → 产品 ID / 语义布局脚本 → 量房锚点 → 候选搜索 → 碰撞/净空/门区/可达性校验 → 精确坐标 3D</span>
    </div>}
  </section>
}
