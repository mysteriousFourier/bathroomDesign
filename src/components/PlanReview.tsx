import { CircleDot, DoorOpen, Droplet, Focus, Grid2X2, Move, Plug, Square, Trash2, Waves, ZoomIn, ZoomOut } from 'lucide-react'
import { useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { dimensionChainParts, finishedRoomBoundary, fixtureBoundWallIndex, fixtureDefaults, fixturePointShape, openingLine, roomBounds, roomCentroid, snapPointToNearestWall, wallLayerPolygons, wallLength, wetZoneBoundaryValid } from '../spec'
import type { Asset, FixtureKind, FixturePointUsage, OpeningSpec, PlanLineKind, Point2D, RoomSpec, Selection } from '../types'

type OpeningDrag = { pointerId: number; id: string; mode: 'move' | 'start' | 'end'; startPointer: Point2D; originStart: Point2D; originEnd: Point2D; currentStart: Point2D; currentEnd: Point2D }
type OpeningCreate = { pointerId: number; start: Point2D; current: Point2D }

const canvasWidth = 920
const canvasHeight = 680
const pad = 92
const dimensionOffsetPx = 76
const dimensionOriginGapPx = 9
const dimensionOverrunPx = 10
const dimensionTextOffsetPx = 13
const dimensionTextGapMinPx = 28
const dimensionTickPx = 8
const lineKindLabels: Record<PlanLineKind, string> = { pipe_chase: '包管线', inner_wall: '内墙线', door_line: '门线' }

export function PlanReview({ spec, plan, selection, onSelect, onFixtureMove, onOpeningAdd, onOpeningChange, onOpeningDelete, onFixtureAdd, onPlanLineAdd, onPlanLineExtend, onZoneChange, onEvidenceSelect }: {
  spec: RoomSpec
  plan?: Asset
  selection: Selection
  onSelect: (selection: Selection) => void
  onFixtureMove: (id: string, xMm: number, zMm: number) => void
  onOpeningAdd?: (start: Point2D, end: Point2D) => void
  onOpeningChange?: (id: string, start: Point2D, end: Point2D) => void
  onOpeningDelete?: (id: string) => void
  onFixtureAdd?: (kind: FixtureKind, xMm: number, zMm: number, wallIndex: number | null, pointUsage?: FixturePointUsage) => void
  onPlanLineAdd?: (kind: PlanLineKind, points: Point2D[]) => string | null
  onPlanLineExtend?: (id: string, point: Point2D) => void
  onZoneChange?: (id: string, boundary: Point2D[]) => void
  onEvidenceSelect?: (id: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const [addFixture, setAddFixture] = useState<{ kind: FixtureKind; pointUsage?: FixturePointUsage } | null>(null)
  const [addOpening, setAddOpening] = useState(false)
  const [orthogonal, setOrthogonal] = useState(true)
  const [addLine, setAddLine] = useState<PlanLineKind | null>(null)
  const [lineDraft, setLineDraft] = useState<{ id: string | null; points: Point2D[] }>({ id: null, points: [] })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panSession = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const suppressCanvasClick = useRef(false)
  const [zoneDraft, setZoneDraft] = useState<{ id: string; boundary: Point2D[] } | null>(null)
  const zoneSession = useRef<{ pointerId: number; id: string; start: Point2D; original: Point2D[]; vertex: number | null; draft: Point2D[] } | null>(null)
  const openingDrag = useRef<OpeningDrag | null>(null)
  const [openingDragState, setOpeningDragState] = useState<OpeningDrag | null>(null)
  const openingCreate = useRef<OpeningCreate | null>(null)
  const [openingCreateState, setOpeningCreateState] = useState<OpeningCreate | null>(null)
  const roomBoundary = useMemo(() => finishedRoomBoundary(spec), [spec])
  const wallBodies = useMemo(() => wallLayerPolygons(spec), [spec])
  const bounds = useMemo(() => roomBounds([...spec.boundary, ...roomBoundary, ...wallBodies.flatMap((body) => [...body.finish, ...body.wall])]), [spec.boundary, roomBoundary, wallBodies])
  const scale = Math.min((canvasWidth - pad * 2) / Math.max(bounds.width, 1), (canvasHeight - pad * 2) / Math.max(bounds.depth, 1))
  const offsetX = (canvasWidth - bounds.width * scale) / 2 - bounds.minX * scale
  const offsetZ = (canvasHeight - bounds.depth * scale) / 2 - bounds.minZ * scale
  const sx = (x: number) => offsetX + x * scale
  const sz = (z: number) => offsetZ + z * scale
  const mmX = (x: number) => Math.round((x - offsetX) / scale / 10) * 10
  const mmZ = (z: number) => Math.round((z - offsetZ) / scale / 10) * 10
  const points = roomBoundary.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')
  const center = roomCentroid(roomBoundary)
  const labels = spec.plan_labels?.length ? spec.plan_labels : [{ id: 'default-room-label', text: spec.name, x_mm: Math.round(center.x), z_mm: Math.round(center.z), source: 'derived' as const, confidence: 1 }]
  const svgPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    return point.matrixTransform(svg.getScreenCTM()!.inverse())
  }
  const roomPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const point = svgPoint(svg, clientX, clientY)
    const canvasX = Number.isFinite(point.x) ? Math.max(0, Math.min(canvasWidth, point.x)) : canvasWidth / 2
    const canvasY = Number.isFinite(point.y) ? Math.max(0, Math.min(canvasHeight, point.y)) : canvasHeight / 2
    return { x_mm: mmX((canvasX - pan.x) / zoom), z_mm: mmZ((canvasY - pan.y) / zoom) }
  }
  const orthogonalPoint = (anchor: Point2D, candidate: Point2D) => (
    Math.abs(candidate.x_mm - anchor.x_mm) >= Math.abs(candidate.z_mm - anchor.z_mm)
      ? { x_mm: candidate.x_mm, z_mm: anchor.z_mm }
      : { x_mm: anchor.x_mm, z_mm: candidate.z_mm }
  )
  const startZoneDrag = (event: ReactPointerEvent<SVGGElement | SVGCircleElement>, id: string, boundary: Point2D[], vertex: number | null) => {
    if (!onZoneChange || event.button !== 0) return
    event.preventDefault(); event.stopPropagation()
    const svg = event.currentTarget.ownerSVGElement!
    const original = boundary.map((point) => ({ ...point }))
    zoneSession.current = { pointerId: event.pointerId, id, start: roomPoint(svg, event.clientX, event.clientY), original, vertex, draft: original }
    setZoneDraft({ id, boundary: original })
    onSelect({ type: 'dry_wet_zone', id })
    svg.setPointerCapture(event.pointerId)
  }
  const zoomAt = (factor: number, anchor = { x: canvasWidth / 2, y: canvasHeight / 2 }) => {
    const nextZoom = Math.min(6, Math.max(0.45, zoom * factor))
    const ratio = nextZoom / zoom
    setPan({ x: anchor.x - (anchor.x - pan.x) * ratio, y: anchor.y - (anchor.y - pan.y) * ratio })
    setZoom(nextZoom)
  }
  const fitView = () => { setZoom(1); setPan({ x: 0, y: 0 }) }
  const addFixtureAtEvent = (event: MouseEvent<SVGSVGElement>) => {
    if (!addFixture || !onFixtureAdd) return false
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
    const localX = (point.x - pan.x) / zoom
    const localZ = (point.y - pan.y) / zoom
    const xMm = mmX(localX), zMm = mmZ(localZ)
    const snap = snapPointToNearestWall(roomBoundary, { x_mm: xMm, z_mm: zMm })
    onFixtureAdd(addFixture.kind, snap?.point.x_mm ?? xMm, snap?.point.z_mm ?? zMm, snap?.wall_index ?? null, addFixture.pointUsage)
    setAddFixture(null)
    return true
  }
  const snapPlanPoint = (point: Point2D) => {
    const nodes = [
      ...roomBoundary,
      ...(spec.plan_lines ?? []).flatMap((line) => line.points),
      ...lineDraft.points,
    ]
    let best = point
    let distance = 60
    for (const node of nodes) {
      const candidate = Math.hypot(point.x_mm - node.x_mm, point.z_mm - node.z_mm)
      if (candidate < distance) { best = node; distance = candidate }
    }
    return { ...best }
  }
  const addLinePointAtEvent = (event: MouseEvent<SVGSVGElement>) => {
    if (!addLine) return false
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
    const rawPoint = { x_mm: mmX((point.x - pan.x) / zoom), z_mm: mmZ((point.y - pan.y) / zoom) }
    const alignedPoint = orthogonal && lineDraft.points.length ? orthogonalPoint(lineDraft.points.at(-1)!, rawPoint) : rawPoint
    const snappedPoint = snapPlanPoint(alignedPoint)
    const nextPoint = orthogonal && lineDraft.points.length ? orthogonalPoint(lineDraft.points.at(-1)!, snappedPoint) : snappedPoint
    if (!lineDraft.points.length) {
      setLineDraft({ id: null, points: [nextPoint] })
      return true
    }
    if (lineDraft.id) {
      onPlanLineExtend?.(lineDraft.id, nextPoint)
      setLineDraft((draft) => ({ ...draft, points: [...draft.points, nextPoint] }))
      return true
    }
    const id = onPlanLineAdd?.(addLine, [...lineDraft.points, nextPoint]) ?? null
    setLineDraft({ id, points: [...lineDraft.points, nextPoint] })
    if (id) onSelect({ type: 'plan_line', id })
    return true
  }
  const chooseLineTool = (kind: PlanLineKind) => {
    setAddFixture(null)
    setAddOpening(false)
    setAddLine((value) => value === kind ? null : kind)
    setLineDraft({ id: null, points: [] })
  }
  const pointAtWallOffset = (start: Point2D, end: Point2D, offsetMm: number, lengthMm: number) => {
    const t = Math.max(0, Math.min(1, offsetMm / Math.max(lengthMm, 1)))
    return { x_mm: start.x_mm + (end.x_mm - start.x_mm) * t, z_mm: start.z_mm + (end.z_mm - start.z_mm) * t }
  }
  const wallDimension = (start: Point2D, end: Point2D, key: string, label: string, kind: 'wall' | 'opening', wallIndex: number, startMm: number, endMm: number) => {
    const x1 = sx(start.x_mm)
    const y1 = sz(start.z_mm)
    const x2 = sx(end.x_mm)
    const y2 = sz(end.z_mm)
    const midX = (x1 + x2) / 2
    const midY = (y1 + y2) / 2
    const length = Math.max(Math.hypot(x2 - x1, y2 - y1), 1)
    const ux = (x2 - x1) / length
    const uy = (y2 - y1) / length
    let normalX = -uy
    let normalY = ux
    const centerX = sx(center.x)
    const centerY = sz(center.z)
    if ((midX - centerX) * normalX + (midY - centerY) * normalY < 0) {
      normalX *= -1
      normalY *= -1
    }
    const dimX1 = x1 + normalX * dimensionOffsetPx
    const dimY1 = y1 + normalY * dimensionOffsetPx
    const dimX2 = x2 + normalX * dimensionOffsetPx
    const dimY2 = y2 + normalY * dimensionOffsetPx
    const extStartX1 = x1 + normalX * dimensionOriginGapPx
    const extStartY1 = y1 + normalY * dimensionOriginGapPx
    const extStartX2 = x2 + normalX * dimensionOriginGapPx
    const extStartY2 = y2 + normalY * dimensionOriginGapPx
    const extEndX1 = dimX1 + normalX * dimensionOverrunPx
    const extEndY1 = dimY1 + normalY * dimensionOverrunPx
    const extEndX2 = dimX2 + normalX * dimensionOverrunPx
    const extEndY2 = dimY2 + normalY * dimensionOverrunPx
    const textGap = Math.max(dimensionTextGapMinPx, label.length * 5.5 + 14)
    const gap = Math.min(length / 2 - 4, textGap / 2)
    const tickX = (ux - uy) * dimensionTickPx / Math.SQRT2
    const tickY = (uy + ux) * dimensionTickPx / Math.SQRT2
    const textX = (dimX1 + dimX2) / 2 + normalX * dimensionTextOffsetPx
    const textY = (dimY1 + dimY2) / 2 + normalY * dimensionTextOffsetPx
    return <g key={key} className={`dimension-label ${kind}`} data-wall-index={wallIndex} data-part-kind={kind} data-start-mm={startMm} data-end-mm={endMm}>
      <line className="dimension-extension" x1={extStartX1} y1={extStartY1} x2={extEndX1} y2={extEndY1} />
      <line className="dimension-extension" x1={extStartX2} y1={extStartY2} x2={extEndX2} y2={extEndY2} />
      <line className="dimension-line" x1={dimX1} y1={dimY1} x2={midX + normalX * dimensionOffsetPx - ux * gap} y2={midY + normalY * dimensionOffsetPx - uy * gap} />
      <line className="dimension-line" x1={midX + normalX * dimensionOffsetPx + ux * gap} y1={midY + normalY * dimensionOffsetPx + uy * gap} x2={dimX2} y2={dimY2} />
      <line className="dimension-tick" x1={dimX1 - tickX} y1={dimY1 - tickY} x2={dimX1 + tickX} y2={dimY1 + tickY} />
      <line className="dimension-tick" x1={dimX2 - tickX} y1={dimY2 - tickY} x2={dimX2 + tickX} y2={dimY2 + tickY} />
      <text x={textX} y={textY}>{label}</text>
    </g>
  }
  const dimensionParts = useMemo(() => dimensionChainParts(spec), [spec])
  const wallDimensions = dimensionParts.map((part) => {
    const wallStart = spec.boundary[part.wall_index]
    const wallEnd = spec.boundary[(part.wall_index + 1) % spec.boundary.length]
    const lengthMm = wallLength(spec.boundary, part.wall_index)
    return wallDimension(
      pointAtWallOffset(wallStart, wallEnd, part.start_mm, lengthMm),
      pointAtWallOffset(wallStart, wallEnd, part.end_mm, lengthMm),
      `dimension-${part.wall_index}-${part.key}`,
      `${part.label} ${Math.round(part.length_mm)}`,
      part.kind,
      part.wall_index,
      part.start_mm,
      part.end_mm,
    )
  })
  const roomBoundaryRuns = dimensionParts.filter((part) => part.kind === 'wall').map((part) => {
    const wallStart = roomBoundary[part.wall_index]
    const wallEnd = roomBoundary[(part.wall_index + 1) % roomBoundary.length]
    const lengthMm = wallLength(spec.boundary, part.wall_index)
    return {
      ...part,
      start: pointAtWallOffset(wallStart, wallEnd, part.start_mm, lengthMm),
      end: pointAtWallOffset(wallStart, wallEnd, part.end_mm, lengthMm),
    }
  })

  return (
    <div className="plan-review">
      <div className="canvas-toolbar">
        <span><Move size={15} />拖动空白处平移，滚轮缩放</span>
        <div>
          <button className={`icon-button${addFixture?.kind === 'drain' && addFixture.pointUsage !== 'toilet' ? ' active-tool' : ''}`} title="添加排水点" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'drain' && value.pointUsage !== 'toilet' ? null : { kind: 'drain', pointUsage: 'general' }) }}><Droplet size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'drain' && addFixture.pointUsage === 'toilet' ? ' active-tool' : ''}`} title="添加马桶排水点并吸附马桶" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'drain' && value.pointUsage === 'toilet' ? null : { kind: 'drain', pointUsage: 'toilet' }) }}><CircleDot size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'water' ? ' active-tool' : ''}`} title="添加给水点" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'water' ? null : { kind: 'water', pointUsage: 'general' }) }}><Waves size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'floor_drain' ? ' active-tool' : ''}`} title="添加淋浴地漏" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'floor_drain' ? null : { kind: 'floor_drain', pointUsage: 'shower' }) }}><Square size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'electric' ? ' active-tool' : ''}`} title="添加电点" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'electric' ? null : { kind: 'electric' }) }}><Plug size={17} /></button>
          <button className={`icon-button${addLine === 'pipe_chase' ? ' active-tool' : ''}`} title="绘制包管线" onClick={() => chooseLineTool('pipe_chase')}><Square size={17} /></button>
          <button className={`icon-button${addLine === 'inner_wall' ? ' active-tool' : ''}`} title="绘制内墙线" onClick={() => chooseLineTool('inner_wall')}><Move size={17} /></button>
          <button className={`icon-button${addOpening ? ' active-tool' : ''}`} title="拖拽绘制门窗线" onClick={() => { setAddFixture(null); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddOpening((value) => !value) }}><DoorOpen size={17} /></button>
          <button className={`canvas-mode-toggle${orthogonal ? ' active-tool' : ''}`} title="限制新增和编辑的线为水平或垂直" aria-pressed={orthogonal} onClick={() => setOrthogonal((value) => !value)}><Grid2X2 size={15} /><span>正交</span></button>
          <button className="icon-button danger" title="删除选中的门窗洞口" disabled={selection.type !== 'opening'} onClick={() => selection.type === 'opening' && onOpeningDelete?.(selection.id)}><Trash2 size={17} /></button>
          <button className="icon-button" title="缩小" onClick={() => zoomAt(0.8)}><ZoomOut size={17} /></button>
          <button className="icon-button" title="放大" onClick={() => zoomAt(1.25)}><ZoomIn size={17} /></button>
          <button className="icon-button" title="适配视图" onClick={fitView}><Focus size={17} /></button>
        </div>
      </div>
      <svg
        className="plan-canvas"
        viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
        role="img"
        aria-label="二维测量图审图画布"
        onClickCapture={(event) => {
          if (suppressCanvasClick.current) { suppressCanvasClick.current = false; event.stopPropagation(); event.preventDefault(); return }
          if (addFixtureAtEvent(event) || addLinePointAtEvent(event)) { event.stopPropagation(); event.preventDefault() }
        }}
        onClick={(event) => {
          if (suppressCanvasClick.current) { suppressCanvasClick.current = false; return }
          if (event.target === event.currentTarget || (event.target instanceof SVGElement && event.target.dataset.panSurface === 'true')) onSelect({ type: 'room' })
        }}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={(event) => {
          event.preventDefault()
          zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, svgPoint(event.currentTarget, event.clientX, event.clientY))
        }}
        onPointerDown={(event) => {
          if (event.button === 0 && addOpening && onOpeningAdd) {
            event.preventDefault(); event.stopPropagation()
            const start = roomPoint(event.currentTarget, event.clientX, event.clientY)
            const draft = { pointerId: event.pointerId, start, current: start }
            openingCreate.current = draft
            setOpeningCreateState(draft)
            event.currentTarget.setPointerCapture(event.pointerId)
            return
          }
          const targetIsPanSurface = event.target === event.currentTarget || (event.target instanceof SVGElement && event.target.dataset.panSurface === 'true')
          if (event.button !== 0 || !targetIsPanSurface) return
          const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
          panSession.current = { pointerId: event.pointerId, x: point.x, y: point.y, panX: pan.x, panY: pan.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const creating = openingCreate.current
          if (creating?.pointerId === event.pointerId) {
            const candidate = roomPoint(event.currentTarget, event.clientX, event.clientY)
            const current = orthogonal ? orthogonalPoint(creating.start, candidate) : candidate
            const preview = { ...creating, current }
            openingCreate.current = preview
            setOpeningCreateState(preview)
            return
          }
          const zone = zoneSession.current
          if (zone?.pointerId === event.pointerId) {
            const current = roomPoint(event.currentTarget, event.clientX, event.clientY)
            const room = roomBounds(roomBoundary)
            let boundary: Point2D[]
            if (zone.vertex !== null) {
              boundary = zone.original.map((point, index) => index === zone.vertex ? {
                x_mm: Math.max(room.minX, Math.min(room.maxX, current.x_mm)),
                z_mm: Math.max(room.minZ, Math.min(room.maxZ, current.z_mm)),
              } : point)
            } else {
              const originalBounds = roomBounds(zone.original)
              const requestedX = current.x_mm - zone.start.x_mm
              const requestedZ = current.z_mm - zone.start.z_mm
              const deltaX = Math.max(room.minX - originalBounds.minX, Math.min(room.maxX - originalBounds.maxX, requestedX))
              const deltaZ = Math.max(room.minZ - originalBounds.minZ, Math.min(room.maxZ - originalBounds.maxZ, requestedZ))
              boundary = zone.original.map((point) => ({ x_mm: point.x_mm + deltaX, z_mm: point.z_mm + deltaZ }))
            }
            if (wetZoneBoundaryValid(spec, zone.id, boundary)) {
              zone.draft = boundary
              setZoneDraft({ id: zone.id, boundary })
            }
            return
          }
          const opening = openingDrag.current
          if (opening?.pointerId === event.pointerId) {
            const candidate = roomPoint(event.currentTarget, event.clientX, event.clientY)
            const current = opening.mode === 'start' && orthogonal
              ? orthogonalPoint(opening.originEnd, candidate)
              : opening.mode === 'end' && orthogonal
                ? orthogonalPoint(opening.originStart, candidate)
                : candidate
            const dx = current.x_mm - opening.startPointer.x_mm
            const dz = current.z_mm - opening.startPointer.z_mm
            const nextStart = opening.mode === 'start' ? current : { x_mm: opening.originStart.x_mm + (opening.mode === 'move' ? dx : 0), z_mm: opening.originStart.z_mm + (opening.mode === 'move' ? dz : 0) }
            const nextEnd = opening.mode === 'end' ? current : { x_mm: opening.originEnd.x_mm + (opening.mode === 'move' ? dx : 0), z_mm: opening.originEnd.z_mm + (opening.mode === 'move' ? dz : 0) }
            const preview = { ...opening, currentStart: nextStart, currentEnd: nextEnd }
            openingDrag.current = preview
            setOpeningDragState(preview)
            return
          }
          const session = panSession.current
          if (!session || session.pointerId !== event.pointerId) return
          const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
          setPan({ x: session.panX + point.x - session.x, y: session.panY + point.y - session.y })
        }}
        onPointerUp={(event) => {
          if (openingCreate.current?.pointerId === event.pointerId) {
            const draft = openingCreate.current
            if (Math.hypot(draft.current.x_mm - draft.start.x_mm, draft.current.z_mm - draft.start.z_mm) >= 100) {
              onOpeningAdd?.(draft.start, draft.current)
              setAddOpening(false)
            }
            openingCreate.current = null
            setOpeningCreateState(null)
            suppressCanvasClick.current = true
            window.setTimeout(() => { suppressCanvasClick.current = false }, 0)
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            return
          }
          const zone = zoneSession.current
          if (zone?.pointerId === event.pointerId) {
            suppressCanvasClick.current = true
            window.setTimeout(() => { suppressCanvasClick.current = false }, 0)
            onZoneChange?.(zone.id, zone.draft)
            zoneSession.current = null
            setZoneDraft(null)
            event.currentTarget.releasePointerCapture(event.pointerId)
            return
          }
          if (openingDrag.current?.pointerId === event.pointerId) {
            const opening = openingDrag.current
            onOpeningChange?.(opening.id, opening.currentStart, opening.currentEnd)
            openingDrag.current = null
            setOpeningDragState(null)
            suppressCanvasClick.current = true
            window.setTimeout(() => { suppressCanvasClick.current = false }, 0)
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            return
          }
          if (panSession.current?.pointerId !== event.pointerId) return
          panSession.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={(event) => {
          if (openingCreate.current?.pointerId === event.pointerId) { openingCreate.current = null; setOpeningCreateState(null) }
          if (openingDrag.current?.pointerId === event.pointerId) { openingDrag.current = null; setOpeningDragState(null) }
          if (zoneSession.current?.pointerId === event.pointerId) {
            zoneSession.current = null
            setZoneDraft(null)
          }
          if (panSession.current?.pointerId === event.pointerId) panSession.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => {
          openingCreate.current = null; setOpeningCreateState(null)
          openingDrag.current = null; setOpeningDragState(null)
          zoneSession.current = null; setZoneDraft(null)
          panSession.current = null
        }}
      >
        <defs>
          <pattern id="minor-grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" stroke="#d9dcd5" strokeWidth="0.7" /></pattern>
          <pattern id="major-grid" width="90" height="90" patternUnits="userSpaceOnUse"><rect width="90" height="90" fill="url(#minor-grid)" /><path d="M 90 0 L 0 0 0 90" fill="none" stroke="#c4c8bf" strokeWidth="1" /></pattern>
        </defs>
        <rect width={canvasWidth} height={canvasHeight} fill="url(#major-grid)" data-pan-surface="true" />
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {wallBodies.map((body) => <g key={`wall-body-${body.wall_index}-${body.run_key}`} className="wall-body-run" data-wall-index={body.wall_index} data-run-start-mm={body.start_mm} data-run-end-mm={body.end_mm} pointerEvents="none">
          <polygon points={body.finish.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} className="wall-finish-body" />
          <polygon points={body.wall.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} className="wall-body" />
        </g>)}
        <polygon points={points} className={selection.type === 'room' ? 'room-polygon selected' : 'room-polygon'} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'room' }) }} />
        <g className={selection.type === 'room' ? 'room-boundary-runs selected' : 'room-boundary-runs'} pointerEvents="none">
          {roomBoundaryRuns.map((run) => <line key={`room-boundary-${run.wall_index}-${run.key}`} data-wall-index={run.wall_index} data-run-start-mm={run.start_mm} data-run-end-mm={run.end_mm} x1={sx(run.start.x_mm)} y1={sz(run.start.z_mm)} x2={sx(run.end.x_mm)} y2={sz(run.end.z_mm)} />)}
        </g>
        {(spec.dry_wet_zones ?? []).filter((zone) => zone.kind === 'wet').map((zone) => {
          const boundary = zoneDraft?.id === zone.id ? zoneDraft.boundary : zone.boundary
          const zonePoints = boundary.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')
          const centerX = boundary.reduce((sum, point) => sum + sx(point.x_mm), 0) / boundary.length
          const centerZ = boundary.reduce((sum, point) => sum + sz(point.z_mm), 0) / boundary.length
          const selected = selection.type === 'dry_wet_zone' && selection.id === zone.id
          return <g key={zone.id} className={`dry-wet-zone ${zone.kind}${selected ? ' selected' : ''}`} onPointerDown={(event) => startZoneDrag(event, zone.id, boundary, null)} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'dry_wet_zone', id: zone.id }) }}>
            <polygon points={zonePoints} />
            <text x={centerX} y={centerZ + 4}>{zone.label}</text>
            {selected && boundary.map((point, index) => <circle key={`${zone.id}-handle-${index}`} className="dry-wet-zone-handle" cx={sx(point.x_mm)} cy={sz(point.z_mm)} r="7" onPointerDown={(event) => startZoneDrag(event, zone.id, boundary, index)} />)}
          </g>
        })}
        {(spec.ceiling_zones ?? []).map((zone) => {
          const zonePoints = zone.boundary.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')
          const centerX = zone.boundary.reduce((sum, point) => sum + sx(point.x_mm), 0) / zone.boundary.length
          const centerZ = zone.boundary.reduce((sum, point) => sum + sz(point.z_mm), 0) / zone.boundary.length
          return <g key={zone.id} className="ceiling-zone"><polygon points={zonePoints} /><text x={centerX} y={centerZ + 4}>吊顶 {zone.height_mm}</text></g>
        })}
        {wallDimensions}
        {(spec.plan_lines ?? []).map((line) => <g key={line.id} className={`plan-line ${line.kind}${selection.type === 'plan_line' && selection.id === line.id ? ' selected' : ''}`} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'plan_line', id: line.id }) }}>
          <polyline points={line.points.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} />
          {line.points.map((point, index) => <circle key={`${line.id}-${index}`} cx={sx(point.x_mm)} cy={sz(point.z_mm)} r="2.5" />)}
          {line.points.length >= 2 && <text x={sx(line.points[0].x_mm + (line.points.at(-1)!.x_mm - line.points[0].x_mm) / 2)} y={sz(line.points[0].z_mm + (line.points.at(-1)!.z_mm - line.points[0].z_mm) / 2) - 8}>{line.label || lineKindLabels[line.kind]}</text>}
        </g>)}
        {addLine && lineDraft.points.length > 0 && <g className={`plan-line ${addLine} draft`}>
          <polyline points={lineDraft.points.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} />
          {lineDraft.points.map((point, index) => <circle key={`draft-${index}`} cx={sx(point.x_mm)} cy={sz(point.z_mm)} r="2.5" />)}
        </g>}
        {roomBoundary.map((point, index) => <circle key={`wall-node-${index}`} className="wall-node" cx={sx(point.x_mm)} cy={sz(point.z_mm)} r="2.5" />)}
        {labels.filter((label) => label.text.trim()).map((label) => <text key={label.id} className="plan-center-label" x={sx(label.x_mm)} y={sz(label.z_mm)} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'plan_label', id: label.id }) }}>{label.text}</text>)}
        {openingCreateState && <g className="opening-segment draft" pointerEvents="none">
          <line className="opening-gap-part" x1={sx(openingCreateState.start.x_mm)} y1={sz(openingCreateState.start.z_mm)} x2={sx(openingCreateState.current.x_mm)} y2={sz(openingCreateState.current.z_mm)} />
          <circle className="opening-jamb" cx={sx(openingCreateState.start.x_mm)} cy={sz(openingCreateState.start.z_mm)} r="4" />
          <circle className="opening-jamb" cx={sx(openingCreateState.current.x_mm)} cy={sz(openingCreateState.current.z_mm)} r="4" />
        </g>}
        {spec.openings.map((opening) => {
          const sourceLine = opening.line ?? openingLine(spec, opening)
          const line = openingDragState?.id === opening.id ? { start: openingDragState.currentStart, end: openingDragState.currentEnd } : sourceLine
          const x1 = sx(line.start.x_mm), y1 = sz(line.start.z_mm)
          const x2 = sx(line.end.x_mm), y2 = sz(line.end.z_mm)
          const selected = selection.type === 'opening' && selection.id === opening.id
          const beginOpeningDrag = (event: ReactPointerEvent<SVGElement>, mode: OpeningDrag['mode']) => {
            if (!onOpeningChange || event.button !== 0) return
            event.preventDefault(); event.stopPropagation()
            const pointer = roomPoint(event.currentTarget.ownerSVGElement!, event.clientX, event.clientY)
            const alignedEnd = orthogonal ? orthogonalPoint(line.start, line.end) : line.end
            const drag = { pointerId: event.pointerId, id: opening.id, mode, startPointer: pointer, originStart: line.start, originEnd: alignedEnd, currentStart: line.start, currentEnd: alignedEnd }
            openingDrag.current = drag; setOpeningDragState(drag); onSelect({ type: 'opening', id: opening.id })
            event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
          }
          const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
          const dx = x2 - x1, dy = y2 - y1, length = Math.max(1, Math.hypot(dx, dy))
          const normal = { x: -dy / length, y: dx / length }
          return <g key={opening.id} className={selected ? 'opening-segment selected' : 'opening-segment'} data-opening-id={opening.id} data-wall-index={opening.wall_index} data-offset-mm={opening.offset_mm} data-width-mm={opening.width_mm} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'opening', id: opening.id }) }}>
            <line className="opening-gap-part" x1={x1} y1={y1} x2={x2} y2={y2} />
            <line className="opening-drag-hit" x1={x1} y1={y1} x2={x2} y2={y2} onPointerDown={(event) => beginOpeningDrag(event, 'move')} />
            <circle className="opening-jamb" cx={x1} cy={y1} r={selected ? 5 : 2.5} onPointerDown={(event) => beginOpeningDrag(event, 'start')} />
            <circle className="opening-jamb" cx={x2} cy={y2} r={selected ? 5 : 2.5} onPointerDown={(event) => beginOpeningDrag(event, 'end')} />
            {selected && <><circle className="opening-handle" cx={x1} cy={y1} r="7" onPointerDown={(event) => beginOpeningDrag(event, 'start')} /><circle className="opening-handle" cx={x2} cy={y2} r="7" onPointerDown={(event) => beginOpeningDrag(event, 'end')} /></>}
            <text className="opening-label" x={mid.x + normal.x * 14} y={mid.y + normal.y * 14}>{opening.label} {Math.round(opening.width_mm)}</text>
          </g>
        })}
        {spec.fixtures.map((fixture) => {
          const selected = selection.type === 'fixture' && selection.id === fixture.id
          const defaults = fixtureDefaults[fixture.kind]
          const width = Math.max((fixture.width_mm || defaults.width_mm) * scale, 18)
          const depth = Math.max((fixture.depth_mm || defaults.depth_mm) * scale, 18)
          const pointShape = fixturePointShape(fixture.kind)
          const pointSize = Math.max(width, depth)
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
              {pointShape === 'circle'
                ? <circle className="fixture-symbol" r={pointSize / 2} />
                : <rect className="fixture-symbol" x={-(pointShape === 'square' ? pointSize : width) / 2} y={-(pointShape === 'square' ? pointSize : depth) / 2} width={pointShape === 'square' ? pointSize : width} height={pointShape === 'square' ? pointSize : depth} rx={pointShape === 'square' ? 0 : 3} />}
              <text y="4">{fixture.label}</text>
              {fixtureBoundWallIndex(spec, fixture) !== null && <text className="fixture-wall-binding" y={depth / 2 + 13}>W{fixtureBoundWallIndex(spec, fixture)! + 1}</text>}
            </g>
          )
        })}
        </g>
      </svg>
    </div>
  )
}
