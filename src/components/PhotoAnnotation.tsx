import { BoxSelect, Check, Eye, EyeOff, MousePointer2, PenLine, Plus, ScanText, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { drawableEvidence, observationId, reviewEvidence } from '../evidence'
import { reconcileBoundaryEdges, solveBoundaryEdges } from '../geometry'
import { cloneSpec, finishedRoomBoundary, fixtureCanBindWall, fixturePointShape, fixturePointUsage, generateDryWetZones, snapPointToNearestWall } from '../spec'
import type { Asset, BoundaryEdge, FixtureSpec, ImageBoundaryPoint, Point2D, RoomSpec } from '../types'

const canvasWidth = 1000
const canvasHeight = 750
type AnnotationTool = 'edit' | 'add' | 'draw' | 'label' | 'region'
type CanvasPoint = { x: number; y: number }
type WallRangeDrag = { wallIndex: number; startRatio: number; endRatio: number }

const toCanvas = (point: ImageBoundaryPoint): CanvasPoint => ({ x: point.x, y: point.y * canvasHeight / 1000 })
const toImage = (point: CanvasPoint): ImageBoundaryPoint => ({
  x: Math.max(0, Math.min(1000, Math.round(point.x))),
  y: Math.max(0, Math.min(1000, Math.round(point.y * 1000 / canvasHeight))),
  role: 'wall_corner', confidence: 1,
})

function segmentDistance(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y)
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(point.x - start.x - ratio * dx, point.y - start.y - ratio * dy)
}

function segmentRatio(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (!dx && !dy) return 0.5
  return Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
}

function pointAtRatio(start: CanvasPoint, end: CanvasPoint, ratio: number): CanvasPoint {
  return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }
}

function bounds<T>(items: T[], x: (item: T) => number, y: (item: T) => number) {
  return {
    minX: Math.min(...items.map(x)),
    maxX: Math.max(...items.map(x)),
    minY: Math.min(...items.map(y)),
    maxY: Math.max(...items.map(y)),
  }
}

function fixtureToCanvas(fixture: FixtureSpec, spec: RoomSpec, points: ImageBoundaryPoint[]): CanvasPoint | null {
  const evidenceId = fixture.evidence_ids?.[0]
  const observation = evidenceId
    ? spec.observations.find((item) => item.field === `visual_evidence:${evidenceId}` && item.bbox)
    : undefined
  if (observation?.bbox && fixture.source !== 'user') {
    return toCanvas({
      x: (observation.bbox.x_min + observation.bbox.x_max) / 2,
      y: (observation.bbox.y_min + observation.bbox.y_max) / 2,
    })
  }
  if (spec.boundary.length >= 3 && points.length >= 3) {
    const imageBounds = bounds(points, (point) => point.x, (point) => point.y)
    const roomBounds = bounds(spec.boundary, (point) => point.x_mm, (point) => point.z_mm)
    if (imageBounds.maxX > imageBounds.minX && imageBounds.maxY > imageBounds.minY && roomBounds.maxX > roomBounds.minX && roomBounds.maxY > roomBounds.minY) {
      return toCanvas({
        x: imageBounds.minX + (fixture.x_mm - roomBounds.minX) * (imageBounds.maxX - imageBounds.minX) / (roomBounds.maxX - roomBounds.minX),
        y: imageBounds.minY + (fixture.z_mm - roomBounds.minY) * (imageBounds.maxY - imageBounds.minY) / (roomBounds.maxY - roomBounds.minY),
      })
    }
  }
  if (points.length >= 3) {
    const imageBounds = bounds(points, (point) => point.x, (point) => point.y)
    if (imageBounds.maxX > imageBounds.minX && imageBounds.maxY > imageBounds.minY) {
      return toCanvas({
        x: imageBounds.minX + fixture.x_mm * (imageBounds.maxX - imageBounds.minX) / 1000,
        y: imageBounds.minY + fixture.z_mm * (imageBounds.maxY - imageBounds.minY) / 1000,
      })
    }
  }
  return null
}

function canvasToFixturePosition(location: CanvasPoint, spec: RoomSpec, points: ImageBoundaryPoint[]): Point2D | null {
  const imagePoint = toImage(location)
  if (spec.boundary.length >= 3 && points.length >= 3) {
    const imageBounds = bounds(points, (point) => point.x, (point) => point.y)
    const roomBounds = bounds(spec.boundary, (point) => point.x_mm, (point) => point.z_mm)
    if (imageBounds.maxX > imageBounds.minX && imageBounds.maxY > imageBounds.minY && roomBounds.maxX > roomBounds.minX && roomBounds.maxY > roomBounds.minY) {
      return {
        x_mm: Math.round(roomBounds.minX + (imagePoint.x - imageBounds.minX) * (roomBounds.maxX - roomBounds.minX) / (imageBounds.maxX - imageBounds.minX)),
        z_mm: Math.round(roomBounds.minY + (imagePoint.y - imageBounds.minY) * (roomBounds.maxY - roomBounds.minY) / (imageBounds.maxY - imageBounds.minY)),
      }
    }
  }
  if (points.length >= 3) {
    const imageBounds = bounds(points, (point) => point.x, (point) => point.y)
    if (imageBounds.maxX > imageBounds.minX && imageBounds.maxY > imageBounds.minY) {
      return {
        x_mm: Math.round((imagePoint.x - imageBounds.minX) * 1000 / (imageBounds.maxX - imageBounds.minX)),
        z_mm: Math.round((imagePoint.y - imageBounds.minY) * 1000 / (imageBounds.maxY - imageBounds.minY)),
      }
    }
  }
  return null
}

function edgeBreakdown(edge: BoundaryEdge, wallIndex: number, spec: RoomSpec) {
  if (!edge.length_mm) return null
  const openings = spec.openings
    .filter((opening) => opening.wall_index === wallIndex)
    .sort((left, right) => left.offset_mm - right.offset_mm)
  if (!openings.length) return null
  const parts: string[] = []
  let cursor = 0
  for (const opening of openings) {
    const before = Math.max(0, opening.offset_mm - cursor)
    if (before) parts.push(String(before))
    parts.push(`${opening.label} ${opening.width_mm}`)
    cursor = opening.offset_mm + opening.width_mm
  }
  const after = Math.max(0, edge.length_mm - cursor)
  if (after) parts.push(String(after))
  return parts.join(' + ')
}

export function PhotoAnnotation({ spec, plan, activeEvidenceId, onChange, onEvidenceSelect, onConfirm }: {
  spec: RoomSpec
  plan?: Asset
  activeEvidenceId?: string | null
  onChange: (spec: RoomSpec) => void
  onEvidenceSelect: (id: string) => void
  onConfirm: (points: ImageBoundaryPoint[], edgeChain: BoundaryEdge[]) => void
}) {
  const annotation = spec.plan_annotation
  const [tool, setTool] = useState<AnnotationTool>('edit')
  const [points, setPoints] = useState<ImageBoundaryPoint[]>(annotation?.boundary ?? [])
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null)
  const [dragFixtureId, setDragFixtureId] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [boxStart, setBoxStart] = useState<CanvasPoint | null>(null)
  const [boxEnd, setBoxEnd] = useState<CanvasPoint | null>(null)
  const [wallRangeDrag, setWallRangeDrag] = useState<WallRangeDrag | null>(null)
  const [showEvidence, setShowEvidence] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (dragIndex === null) setPoints(annotation?.boundary ?? [])
  }, [annotation?.boundary, dragIndex])

  const rotation = annotation?.rotation_degrees ?? spec.observations.find((item) => item.field.startsWith('ocr:'))?.rotation_degrees ?? 0
  const sourceImage = rotation === 90
    ? { width: canvasHeight, height: canvasWidth, transform: `translate(${canvasWidth} 0) rotate(90)` }
    : rotation === 270
      ? { width: canvasHeight, height: canvasWidth, transform: `translate(0 ${canvasHeight}) rotate(-90)` }
      : rotation === 180
        ? { width: canvasWidth, height: canvasHeight, transform: `translate(${canvasWidth} ${canvasHeight}) rotate(180)` }
        : { width: canvasWidth, height: canvasHeight, transform: undefined }
  const canvasPoints = useMemo(() => points.map(toCanvas), [points])
  const edgeChain = useMemo(
    () => reconcileBoundaryEdges(points, annotation?.boundary ?? [], annotation?.edge_chain ?? []),
    [annotation?.boundary, annotation?.edge_chain, points],
  )
  const closurePreview = useMemo(() => solveBoundaryEdges(edgeChain), [edgeChain])
  const closureAdjustments = closurePreview?.filter((edge) => edge.closure_adjustment_mm).length ?? 0
  const pointString = canvasPoints.map((point) => `${point.x},${point.y}`).join(' ')
  const pendingEvidence = useMemo(() => reviewEvidence(spec, plan?.id).length, [plan?.id, spec])
  const evidence = useMemo(() => drawableEvidence(spec, plan?.id), [plan?.id, spec])
  const visibleEvidence = showEvidence
    ? evidence
    : evidence.filter((item) => observationId(item) === activeEvidenceId)
  const pendingDimensions = edgeChain.filter((edge) => !edge.length_mm).length
  const pointFixtures = useMemo(() => spec.fixtures.filter((fixture) => fixtureCanBindWall(fixture.kind)), [spec.fixtures])
  const activeEvidence = spec.observations.find((item) => (
    item.field === `ocr:${activeEvidenceId}` && (!plan?.id || item.asset_id === plan.id)
  ))
  const activeWallIndex = activeEvidence?.target_id?.match(/^wall:(\d+)/)?.[1]
  const activeDoorRange = activeEvidence?.semantic_role === 'door_size'
    ? activeEvidence.target_id?.match(/^wall:(\d+)@(0(?:\.\d+)?|1(?:\.0+)?):(0(?:\.\d+)?|1(?:\.0+)?)$/)
    : null
  const regionRole = activeEvidence?.semantic_role === 'ceiling_height' ? 'ceiling' : activeEvidence?.semantic_role === 'pipe_box' ? 'pipe_box' : null

  useEffect(() => {
    if (regionRole && !activeEvidence?.target_id?.startsWith(`${regionRole}:`)) setTool('region')
  }, [activeEvidence?.field, activeEvidence?.target_id, regionRole])

  const localPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current!
    const point = svg.createSVGPoint()
    point.x = clientX; point.y = clientY
    return point.matrixTransform(svg.getScreenCTM()!.inverse())
  }

  const commitBoundary = (next: ImageBoundaryPoint[]) => {
    const draft = cloneSpec(spec)
    const previousBoundary = draft.plan_annotation?.boundary ?? []
    const previousEdges = draft.plan_annotation?.edge_chain ?? []
    draft.plan_annotation = {
      rotation_degrees: rotation as 0 | 90 | 180 | 270,
      boundary: next,
      edge_chain: reconcileBoundaryEdges(next, previousBoundary, previousEdges),
      confirmed: false,
    }
    onChange(draft)
  }

  const updateEdgeLength = (wallIndex: number, value: string) => {
    const draft = cloneSpec(spec)
    if (!draft.plan_annotation) return
    const edges = reconcileBoundaryEdges(
      points,
      draft.plan_annotation.boundary,
      draft.plan_annotation.edge_chain ?? [],
    )
    const parsed = Number(value)
    edges[wallIndex] = {
      ...edges[wallIndex],
      length_mm: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null,
      measured_length_mm: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null,
      closure_adjustment_mm: 0,
      source: 'user',
      confidence: Number.isFinite(parsed) && parsed > 0 ? 1 : 0.5,
    }
    draft.plan_annotation.edge_chain = edges
    draft.plan_annotation.confirmed = false
    onChange(draft)
  }

  const bindEvidenceToWall = (wallIndex: number, location: CanvasPoint) => {
    if (!activeEvidenceId || canvasPoints.length < 2) return
    const start = canvasPoints[wallIndex]
    const end = canvasPoints[(wallIndex + 1) % canvasPoints.length]
    const ratio = segmentRatio(location, start, end)
    const draft = cloneSpec(spec)
    const observation = draft.observations.find((item) => item.field === `ocr:${activeEvidenceId}`)
    if (!observation) return
    observation.target_id = `wall:${wallIndex}@${ratio.toFixed(3)}`
    observation.review_required = true
    onChange(draft)
  }

  const bindDoorRange = (range: WallRangeDrag) => {
    if (!activeEvidenceId) return
    let startRatio = Math.min(range.startRatio, range.endRatio)
    let endRatio = Math.max(range.startRatio, range.endRatio)
    if (endRatio - startRatio < 0.015) {
      startRatio = Math.max(0, startRatio - 0.04)
      endRatio = Math.min(1, endRatio + 0.04)
    }
    const draft = cloneSpec(spec)
    const observation = draft.observations.find((item) => item.field === `ocr:${activeEvidenceId}`)
    if (!observation) return
    observation.target_id = `wall:${range.wallIndex}@${startRatio.toFixed(3)}:${endRatio.toFixed(3)}`
    observation.review_required = true
    onChange(draft)
  }

  const bindEvidenceRegion = (start: CanvasPoint, end: CanvasPoint) => {
    if (!activeEvidenceId || !regionRole) return
    const left = Math.max(0, Math.min(start.x, end.x))
    const right = Math.min(1000, Math.max(start.x, end.x))
    const top = Math.max(0, Math.min(start.y, end.y) * 1000 / canvasHeight)
    const bottom = Math.min(1000, Math.max(start.y, end.y) * 1000 / canvasHeight)
    if (right - left < 8 || bottom - top < 8) return
    const draft = cloneSpec(spec)
    const observation = draft.observations.find((item) => item.field === `ocr:${activeEvidenceId}`)
    if (!observation) return
    observation.target_id = `${regionRole}:${Math.round(left)},${Math.round(top)},${Math.round(right)},${Math.round(bottom)}`
    observation.review_required = true
    onChange(draft)
    setTool('edit')
  }

  const addPoint = (location: CanvasPoint) => {
    const point = toImage(location)
    if (tool === 'draw' || points.length < 2) {
      const next = [...points, point]
      setPoints(next); setSelectedPoint(next.length - 1); commitBoundary(next)
      return
    }
    let edgeIndex = 0
    let nearest = Number.POSITIVE_INFINITY
    canvasPoints.forEach((start, index) => {
      const distance = segmentDistance(location, start, canvasPoints[(index + 1) % canvasPoints.length])
      if (distance < nearest) { nearest = distance; edgeIndex = index }
    })
    const next = [...points]
    next.splice(edgeIndex + 1, 0, point)
    setPoints(next); setSelectedPoint(edgeIndex + 1); commitBoundary(next)
  }

  const deletePoint = () => {
    if (selectedPoint === null || points.length <= 3) return
    const next = points.filter((_, index) => index !== selectedPoint)
    setPoints(next); setSelectedPoint(null); commitBoundary(next)
  }

  const movePointFixture = (fixtureId: string, location: CanvasPoint) => {
    const position = canvasToFixturePosition(location, spec, points)
    if (!position) return
    const draft = cloneSpec(spec)
    const fixture = draft.fixtures.find((item) => item.id === fixtureId)
    if (!fixture) return
    const snap = snapPointToNearestWall(finishedRoomBoundary(draft), position)
    fixture.x_mm = snap?.point.x_mm ?? position.x_mm
    fixture.z_mm = snap?.point.z_mm ?? position.z_mm
    fixture.bound_wall_index = snap?.wall_index ?? null
    fixture.source = 'user'
    fixture.confidence = 1
    if (fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'shower') draft.dry_wet_zones = generateDryWetZones(draft)
    const evidenceId = fixture.evidence_ids?.[0]
    const observation = evidenceId ? draft.observations.find((item) => item.field === `visual_evidence:${evidenceId}`) : undefined
    if (observation) {
      observation.review_required = false
    }
    onChange(draft)
  }


  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPoint !== null && points.length > 3) {
        event.preventDefault()
        const next = points.filter((_, index) => index !== selectedPoint)
        setPoints(next); setSelectedPoint(null); commitBoundary(next)
      } else if (event.key === 'Escape') {
        setSelectedPoint(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [points, selectedPoint, spec, rotation])

  const createMissingLabel = (start: CanvasPoint, end: CanvasPoint) => {
    const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x)
    const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y)
    if (right - left < 8 || bottom - top < 8) return
    const id = `U${Date.now().toString(36).toUpperCase()}`
    const draft = cloneSpec(spec)
    draft.observations.push({
      field: `ocr:${id}`, value: '', source: 'user', asset_id: plan?.id ?? null,
      bbox: { x_min: Math.round(left), y_min: Math.round(top * 1000 / canvasHeight), x_max: Math.round(right), y_max: Math.round(bottom * 1000 / canvasHeight) },
      confidence: 1, confirmed: false, alternatives: [], note: '用户在原图上补充的标注',
      semantic_role: 'other', review_required: true, rotation_degrees: rotation as 0 | 90 | 180 | 270,
    })
    onChange(draft); onEvidenceSelect(id)
  }

  return <div className="photo-annotation" onDragStart={(event) => event.preventDefault()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()}>
    <div className="annotation-toolbar">
      <div className="annotation-tools" role="toolbar" aria-label="照片标注工具">
        <button className={tool === 'edit' ? 'active' : ''} onClick={() => setTool('edit')}><MousePointer2 size={15} />选择</button>
        <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}><Plus size={15} />加折点</button>
        <button className={tool === 'draw' ? 'active' : ''} onClick={() => { setTool('draw'); setPoints([]); setSelectedPoint(null) }}><PenLine size={15} />重画轮廓</button>
        <button className={tool === 'label' ? 'active' : ''} onClick={() => setTool('label')}><ScanText size={15} />补录数据</button>
        {regionRole && <button className={tool === 'region' ? 'active' : ''} onClick={() => setTool('region')}><BoxSelect size={15} />圈定范围</button>}
        <button className={showEvidence ? 'active' : ''} title={showEvidence ? '隐藏有效候选框' : '显示有效候选框'} aria-pressed={showEvidence} onClick={() => setShowEvidence((current) => !current)}>{showEvidence ? <EyeOff size={15} /> : <Eye size={15} />}{showEvidence ? '隐藏候选' : '显示候选'}</button>
        <button className="icon-button danger" title="删除所选折点" disabled={selectedPoint === null || points.length <= 3} onClick={deletePoint}><Trash2 size={15} /></button>
      </div>
      <div className="annotation-status">
        <span>AI 初识草稿 · {points.length} 个折点 · 缺少 {pendingDimensions} 段尺寸{closureAdjustments ? ` · 自动闭合调整 ${closureAdjustments} 段` : ''}{pendingEvidence ? ` · 待校正 ${pendingEvidence} 项` : ''}</span>
        <button className="button primary compact" title={pendingEvidence ? '请先处理右侧全部待校正项' : pendingDimensions ? '请补全每段墙长' : undefined} disabled={points.length < 3 || pendingEvidence > 0 || pendingDimensions > 0} onClick={() => onConfirm(points, edgeChain)}><Check size={15} />确认标注并生成二维图</button>
      </div>
      <div className="annotation-dimensions">
        {edgeChain.map((edge, index) => <label key={`edge-length-${index}`}>
          <span>W{index + 1}</span>
          <input type="number" min="1" step="1" inputMode="numeric" value={edge.measured_length_mm ?? edge.length_mm ?? ''} placeholder="mm" aria-label={`W${index + 1} 实测长度（毫米）`} onChange={(event) => updateEdgeLength(index, event.target.value)} />
          {edgeBreakdown(edge, index, spec) ? <small className="edge-breakdown">{edgeBreakdown(edge, index, spec)}</small> : null}
          {closurePreview?.[index]?.closure_adjustment_mm ? <small title="原始实测值保持不变">建模 {closurePreview[index].length_mm} ({closurePreview[index].closure_adjustment_mm! > 0 ? '+' : ''}{closurePreview[index].closure_adjustment_mm})</small> : null}
        </label>)}
      </div>
    </div>
    <svg ref={svgRef} className={`annotation-canvas tool-${tool}`} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} aria-label="手绘测量图照片标注画布"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        const location = localPoint(event.clientX, event.clientY)
        if (tool === 'edit' && activeEvidence?.semantic_role === 'door_size' && canvasPoints.length >= 2) {
          let wallIndex = 0
          let nearest = Number.POSITIVE_INFINITY
          canvasPoints.forEach((start, index) => {
            const distance = segmentDistance(location, start, canvasPoints[(index + 1) % canvasPoints.length])
            if (distance < nearest) { nearest = distance; wallIndex = index }
          })
          if (nearest <= 28) {
            const start = canvasPoints[wallIndex]
            const end = canvasPoints[(wallIndex + 1) % canvasPoints.length]
            const ratio = segmentRatio(location, start, end)
            setWallRangeDrag({ wallIndex, startRatio: ratio, endRatio: ratio })
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          return
        }
        if (tool === 'add' || tool === 'draw') addPoint(location)
        if (tool === 'label' || tool === 'region') { setBoxStart(location); setBoxEnd(location); event.currentTarget.setPointerCapture(event.pointerId) }
      }}
      onPointerMove={(event) => {
        const location = localPoint(event.clientX, event.clientY)
        if (dragIndex !== null) setPoints((current) => current.map((point, index) => index === dragIndex ? toImage(location) : point))
        else if (dragFixtureId) {
          const target = event.currentTarget.querySelector(`[data-fixture-id="${dragFixtureId}"]`)
          target?.setAttribute('transform', `translate(${location.x} ${location.y})`)
        }
        else if (wallRangeDrag) {
          const start = canvasPoints[wallRangeDrag.wallIndex]
          const end = canvasPoints[(wallRangeDrag.wallIndex + 1) % canvasPoints.length]
          setWallRangeDrag({ ...wallRangeDrag, endRatio: segmentRatio(location, start, end) })
        }
        else if (boxStart) setBoxEnd(location)
      }}
      onPointerUp={(event) => {
        if (dragIndex !== null) {
          const location = localPoint(event.clientX, event.clientY)
          const next = points.map((point, index) => index === dragIndex ? toImage(location) : point)
          setPoints(next); commitBoundary(next); setDragIndex(null)
        }
        if (dragFixtureId) {
          movePointFixture(dragFixtureId, localPoint(event.clientX, event.clientY))
          setDragFixtureId(null)
        }
        if (wallRangeDrag) bindDoorRange(wallRangeDrag)
        if (boxStart && boxEnd) {
          if (tool === 'region') bindEvidenceRegion(boxStart, boxEnd)
          else createMissingLabel(boxStart, boxEnd)
        }
        setBoxStart(null); setBoxEnd(null)
        setWallRangeDrag(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={(event) => {
        setDragIndex(null); setDragFixtureId(null); setBoxStart(null); setBoxEnd(null); setWallRangeDrag(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}>
      <rect width={canvasWidth} height={canvasHeight} className="annotation-background" />
      {plan && <image href={plan.url} x="0" y="0" width={sourceImage.width} height={sourceImage.height} transform={sourceImage.transform} preserveAspectRatio="none" />}
      <g className="annotation-evidence-layer">{visibleEvidence.map((item) => {
        const bbox = item.bbox!, id = item.field.slice(4), pending = item.review_required && !item.confirmed
        return <rect key={id} data-evidence-id={id} className={pending ? 'annotation-evidence pending' : 'annotation-evidence'} x={bbox.x_min} y={bbox.y_min * canvasHeight / 1000} width={bbox.x_max - bbox.x_min} height={(bbox.y_max - bbox.y_min) * canvasHeight / 1000}
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onEvidenceSelect(id) }} />
      })}</g>
      {points.length >= 2 && (tool === 'draw' ? <polyline points={pointString} className="annotation-boundary open" /> : <polygon points={pointString} className="annotation-boundary" />)}
      {tool !== 'draw' && canvasPoints.map((start, index) => {
        const end = canvasPoints[(index + 1) % canvasPoints.length]
        const selected = activeWallIndex === String(index)
        return <g key={`annotation-wall-${index}`} className={selected ? 'annotation-wall selected' : 'annotation-wall'}>
          <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} onPointerDown={(event) => {
            if (tool !== 'edit') return
            event.preventDefault(); event.stopPropagation()
            const location = localPoint(event.clientX, event.clientY)
            if (activeEvidence?.semantic_role === 'door_size') {
              const ratio = segmentRatio(location, start, end)
              setWallRangeDrag({ wallIndex: index, startRatio: ratio, endRatio: ratio })
              event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
            }
          }} onClick={(event) => {
            if (tool !== 'edit' || activeEvidence?.semantic_role === 'door_size') return
            event.preventDefault(); event.stopPropagation(); bindEvidenceToWall(index, localPoint(event.clientX, event.clientY))
          }} />
          <text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 + 4}>W{index + 1}</text>
        </g>
      })}
      {spec.openings.map((opening) => {
        const edge = edgeChain[opening.wall_index]
        const start = canvasPoints[opening.wall_index]
        const end = canvasPoints[(opening.wall_index + 1) % canvasPoints.length]
        const edgeLength = edge?.length_mm
        if (!start || !end || !edgeLength || opening.offset_mm + opening.width_mm > edgeLength) return null
        const openingStart = pointAtRatio(start, end, opening.offset_mm / edgeLength)
        const openingEnd = pointAtRatio(start, end, (opening.offset_mm + opening.width_mm) / edgeLength)
        const beforeMiddle = pointAtRatio(start, openingStart, 0.5)
        const openingMiddle = pointAtRatio(openingStart, openingEnd, 0.5)
        const afterMiddle = pointAtRatio(openingEnd, end, 0.5)
        const before = opening.offset_mm
        const after = edgeLength - opening.offset_mm - opening.width_mm
        const vertical = edge.direction === 'up' || edge.direction === 'down'
        const tick = vertical ? { x: 10, y: 0 } : { x: 0, y: 10 }
        return <g key={`annotation-opening-${opening.id}`} className="annotation-opening-segments" pointerEvents="none">
          {before > 0 && <line className="wall-part" x1={start.x} y1={start.y} x2={openingStart.x} y2={openingStart.y} />}
          <line className="opening-part" x1={openingStart.x} y1={openingStart.y} x2={openingEnd.x} y2={openingEnd.y} />
          {after > 0 && <line className="wall-part" x1={openingEnd.x} y1={openingEnd.y} x2={end.x} y2={end.y} />}
          <line className="opening-tick" x1={openingStart.x - tick.x} y1={openingStart.y - tick.y} x2={openingStart.x + tick.x} y2={openingStart.y + tick.y} />
          <line className="opening-tick" x1={openingEnd.x - tick.x} y1={openingEnd.y - tick.y} x2={openingEnd.x + tick.x} y2={openingEnd.y + tick.y} />
          {before > 0 && <text x={beforeMiddle.x} y={beforeMiddle.y - 9}>{before}</text>}
          <text className="opening-label" x={openingMiddle.x} y={openingMiddle.y - 9}>{opening.label} {opening.width_mm}</text>
          {after > 0 && <text x={afterMiddle.x} y={afterMiddle.y - 9}>{after}</text>}
        </g>
      })}
      {(() => {
        const range = wallRangeDrag ?? (activeDoorRange ? { wallIndex: Number(activeDoorRange[1]), startRatio: Number(activeDoorRange[2]), endRatio: Number(activeDoorRange[3]) } : null)
        if (!range || range.wallIndex < 0 || range.wallIndex >= canvasPoints.length) return null
        const wallStart = canvasPoints[range.wallIndex]
        const wallEnd = canvasPoints[(range.wallIndex + 1) % canvasPoints.length]
        const start = pointAtRatio(wallStart, wallEnd, Math.min(range.startRatio, range.endRatio))
        const end = pointAtRatio(wallStart, wallEnd, Math.max(range.startRatio, range.endRatio))
        return <g className="annotation-door-range" pointerEvents="none">
          <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
          <circle cx={start.x} cy={start.y} r="7" />
          <circle cx={end.x} cy={end.y} r="7" />
        </g>
      })()}
      {canvasPoints.map((point, index) => <g key={`annotation-point-${index}`} className={selectedPoint === index ? 'annotation-point selected' : 'annotation-point'} transform={`translate(${point.x} ${point.y})`}
        onPointerDown={(event) => {
          if (tool !== 'edit') return
          event.preventDefault()
          if (activeEvidence?.semantic_role === 'door_size') return
          event.stopPropagation(); setSelectedPoint(index); setDragIndex(index); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
        }}>
        <circle className="annotation-point-hit" r="20" />
        <circle className="annotation-point-dot" r="8" />
      </g>)}
      {pointFixtures.map((fixture) => {
        const point = fixtureToCanvas(fixture, spec, points)
        if (!point) return null
        const pointShape = fixturePointShape(fixture.kind)
        return <g key={`annotation-fixture-${fixture.id}`} data-fixture-id={fixture.id} className="annotation-marker" transform={`translate(${point.x} ${point.y})`}
          onPointerDown={(event) => {
            if (tool !== 'edit') return
            event.preventDefault(); event.stopPropagation(); setDragFixtureId(fixture.id); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
          }}>
          <circle className="annotation-marker-hit" r="22" />
          {pointShape === 'square' ? <rect className="annotation-marker-dot" x="-10" y="-10" width="20" height="20" /> : <circle className="annotation-marker-dot" r="10" />}
          <text y="-14">{fixture.label}</text>
          <text className="annotation-marker-coordinate" y="26">X {fixture.x_mm} · Z {fixture.z_mm}</text>
        </g>
      })}
      {boxStart && boxEnd && <rect className="annotation-selection" x={Math.min(boxStart.x, boxEnd.x)} y={Math.min(boxStart.y, boxEnd.y)} width={Math.abs(boxEnd.x - boxStart.x)} height={Math.abs(boxEnd.y - boxStart.y)} />}
    </svg>
  </div>
}
