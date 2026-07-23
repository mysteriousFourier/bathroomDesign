import { Eye, EyeOff, Focus, Move, ZoomIn, ZoomOut } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { fixtureLabels, roomBounds, wallLength } from '../spec'
import type { Asset, RoomSpec, Selection } from '../types'

const canvasWidth = 920
const canvasHeight = 680
const pad = 92

export function PlanReview({ spec, plan, selection, onSelect, onFixtureMove }: {
  spec: RoomSpec
  plan?: Asset
  selection: Selection
  onSelect: (selection: Selection) => void
  onFixtureMove: (id: string, xMm: number, zMm: number) => void
}) {
  const [showSource, setShowSource] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panSession = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const bounds = useMemo(() => roomBounds(spec.boundary), [spec.boundary])
  const scale = Math.min((canvasWidth - pad * 2) / Math.max(bounds.width, 1), (canvasHeight - pad * 2) / Math.max(bounds.depth, 1))
  const offsetX = (canvasWidth - bounds.width * scale) / 2 - bounds.minX * scale
  const offsetZ = (canvasHeight - bounds.depth * scale) / 2 - bounds.minZ * scale
  const sx = (x: number) => offsetX + x * scale
  const sz = (z: number) => offsetZ + z * scale
  const mmX = (x: number) => Math.round((x - offsetX) / scale / 10) * 10
  const mmZ = (z: number) => Math.round((z - offsetZ) / scale / 10) * 10
  const points = spec.boundary.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')

  const svgPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    return point.matrixTransform(svg.getScreenCTM()!.inverse())
  }
  const zoomAt = (factor: number, anchor = { x: canvasWidth / 2, y: canvasHeight / 2 }) => {
    const nextZoom = Math.min(6, Math.max(0.45, zoom * factor))
    const ratio = nextZoom / zoom
    setPan({ x: anchor.x - (anchor.x - pan.x) * ratio, y: anchor.y - (anchor.y - pan.y) * ratio })
    setZoom(nextZoom)
  }
  const fitView = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  return (
    <div className="plan-review">
      <div className="canvas-toolbar">
        <span><Move size={15} />拖动空白处平移，滚轮缩放</span>
        <div>
          <button className="icon-button" title="缩小" onClick={() => zoomAt(0.8)}><ZoomOut size={17} /></button>
          <button className="icon-button" title="放大" onClick={() => zoomAt(1.25)}><ZoomIn size={17} /></button>
          <button className="icon-button" title="适配视图" onClick={fitView}><Focus size={17} /></button>
          <button className="icon-button" title={showSource ? '隐藏未配准原图' : '显示未配准原图'} onClick={() => setShowSource((value) => !value)}>
            {showSource ? <Eye size={17} /> : <EyeOff size={17} />}
          </button>
        </div>
      </div>
      <svg
        className="plan-canvas"
        viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
        role="img"
        aria-label="二维测量图审图画布"
        onClick={() => onSelect({ type: 'room' })}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => {
          event.preventDefault()
          zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, svgPoint(event.currentTarget, event.clientX, event.clientY))
        }}
        onPointerDown={(event) => {
          const targetIsPanSurface = event.target === event.currentTarget || (event.target instanceof SVGElement && event.target.dataset.panSurface === 'true')
          if (event.button !== 0 || !targetIsPanSurface) return
          const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
          panSession.current = { pointerId: event.pointerId, x: point.x, y: point.y, panX: pan.x, panY: pan.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const session = panSession.current
          if (!session || session.pointerId !== event.pointerId) return
          const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
          setPan({ x: session.panX + point.x - session.x, y: session.panY + point.y - session.y })
        }}
        onPointerUp={(event) => {
          if (panSession.current?.pointerId !== event.pointerId) return
          panSession.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      >
        <defs>
          <pattern id="minor-grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" style={{ stroke: 'var(--grid-minor)' }} strokeWidth="0.7" /></pattern>
          <pattern id="major-grid" width="90" height="90" patternUnits="userSpaceOnUse"><rect width="90" height="90" fill="url(#minor-grid)" /><path d="M 90 0 L 0 0 0 90" fill="none" style={{ stroke: 'var(--grid-major)' }} strokeWidth="1" /></pattern>
        </defs>
        <rect width={canvasWidth} height={canvasHeight} fill="url(#major-grid)" data-pan-surface="true" />
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {plan && showSource && <image href={plan.url} x="0" y="0" width={canvasHeight} height={canvasWidth} transform={`translate(${canvasWidth} 0) rotate(90)`} preserveAspectRatio="xMidYMid meet" opacity="0.14" />}
        <polygon points={points} className={selection.type === 'room' ? 'room-polygon selected' : 'room-polygon'} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'room' }) }} />
        {spec.boundary.map((start, index) => {
          const end = spec.boundary[(index + 1) % spec.boundary.length]
          const midX = (sx(start.x_mm) + sx(end.x_mm)) / 2
          const midZ = (sz(start.z_mm) + sz(end.z_mm)) / 2
          return <g key={`wall-${index}`} className="dimension-label"><circle cx={midX} cy={midZ} r="14" /><text x={midX} y={midZ + 4}>{Math.round(wallLength(spec.boundary, index))}</text></g>
        })}
        {spec.openings.map((opening) => {
          const start = spec.boundary[opening.wall_index]
          const end = spec.boundary[(opening.wall_index + 1) % spec.boundary.length]
          if (!start || !end) return null
          const length = wallLength(spec.boundary, opening.wall_index)
          const startT = opening.offset_mm / length
          const endT = (opening.offset_mm + opening.width_mm) / length
          const x1 = sx(start.x_mm + (end.x_mm - start.x_mm) * startT)
          const y1 = sz(start.z_mm + (end.z_mm - start.z_mm) * startT)
          const x2 = sx(start.x_mm + (end.x_mm - start.x_mm) * endT)
          const y2 = sz(start.z_mm + (end.z_mm - start.z_mm) * endT)
          return <line key={opening.id} x1={x1} y1={y1} x2={x2} y2={y2} className={selection.type === 'opening' && selection.id === opening.id ? 'opening-line selected' : 'opening-line'} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'opening', id: opening.id }) }} />
        })}
        {spec.fixtures.map((fixture) => {
          const selected = selection.type === 'fixture' && selection.id === fixture.id
          const width = Math.max(fixture.width_mm * scale, 18)
          const depth = Math.max(fixture.depth_mm * scale, 18)
          return (
            <g key={fixture.id} className={selected ? 'fixture-shape selected' : 'fixture-shape'} transform={`translate(${sx(fixture.x_mm)} ${sz(fixture.z_mm)}) rotate(${fixture.rotation_deg})`} onPointerDown={(event) => {
              event.stopPropagation()
              onSelect({ type: 'fixture', id: fixture.id })
              const target = event.currentTarget
              target.setPointerCapture(event.pointerId)
              const svg = target.ownerSVGElement!
              const layer = target.parentElement as unknown as SVGGraphicsElement
              const move = (moveEvent: PointerEvent) => {
                const point = svg.createSVGPoint()
                point.x = moveEvent.clientX; point.y = moveEvent.clientY
                const local = point.matrixTransform(layer.getScreenCTM()!.inverse())
                target.setAttribute('transform', `translate(${local.x} ${local.y}) rotate(${fixture.rotation_deg})`)
              }
              const up = (upEvent: PointerEvent) => {
                const point = svg.createSVGPoint()
                point.x = upEvent.clientX; point.y = upEvent.clientY
                const local = point.matrixTransform(layer.getScreenCTM()!.inverse())
                onFixtureMove(fixture.id, mmX(local.x), mmZ(local.y))
                target.removeEventListener('pointermove', move)
                target.removeEventListener('pointerup', up)
              }
              target.addEventListener('pointermove', move)
              target.addEventListener('pointerup', up)
            }}>
              <rect x={-width / 2} y={-depth / 2} width={width} height={depth} rx="3" />
              <text y="4">{fixtureLabels[fixture.kind]}</text>
            </g>
          )
        })}
        </g>
      </svg>
    </div>
  )
}
