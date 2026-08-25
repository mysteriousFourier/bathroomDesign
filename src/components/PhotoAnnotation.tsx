import { BoxSelect, Check, DoorOpen, Eye, EyeOff, Grid2X2, MousePointer2, PenLine, Plus, ScanText, Spline, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { drawableEvidence, observationId, reviewEvidence } from '../evidence'
import { reconcileBoundaryEdges, solveBoundaryEdges } from '../geometry'
import { cloneSpec, dimensionChainParts, finishedRoomBoundary, fixtureCanBindWall, fixturePointShape, fixturePointUsage, imagePointToRoom, nextOpeningLabel, openingHostLength, polylineSegmentLength, rebindOpeningsToImageBoundary, resizePolylineSegment, roomPointToImage, setOpeningOnWall, snapPointToNearestWall, wallLength, wallRunParts } from '../spec'
import type { Asset, BoundaryEdge, FixtureSpec, ImageBoundaryPoint, OpeningSpec, PlanLineKind, Point2D, RoomSpec } from '../types'

const canvasWidth = 1000
const canvasHeight = 750
type AnnotationTool = 'edit' | 'add' | 'draw' | 'opening' | 'line' | 'label' | 'region'
type CanvasPoint = { x: number; y: number }
type WallRangeDrag = { wallIndex: number; startRatio: number; endRatio: number }
type OpeningDrag = { pointerId: number; id: string; wallIndex: number; startRatio: number; endRatio: number; originStartRatio: number; originEndRatio: number; pointerRatio: number; mode: 'move' | 'start' | 'end' }
type OpeningCreate = { pointerId: number; start: CanvasPoint; current: CanvasPoint }
const planLineLabels: Record<PlanLineKind, string> = { pipe_chase: '包管线', inner_wall: '内墙线', door_line: '门线（辅助）' }

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

function orthogonalCanvasPoint(anchor: CanvasPoint, candidate: CanvasPoint): CanvasPoint {
  return Math.abs(candidate.x - anchor.x) >= Math.abs(candidate.y - anchor.y)
    ? { x: candidate.x, y: anchor.y }
    : { x: anchor.x, y: candidate.y }
}

function segmentProjection(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint) {
  const ratio = segmentRatio(point, start, end)
  const projected = pointAtRatio(start, end, ratio)
  return { ratio, point: projected, distance: Math.hypot(point.x - projected.x, point.y - projected.y) }
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
  const [selectedOpeningId, setSelectedOpeningId] = useState<string | null>(null)
  const [dragFixtureId, setDragFixtureId] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [boxStart, setBoxStart] = useState<CanvasPoint | null>(null)
  const [boxEnd, setBoxEnd] = useState<CanvasPoint | null>(null)
  const [wallRangeDrag, setWallRangeDrag] = useState<WallRangeDrag | null>(null)
  const [openingDrag, setOpeningDrag] = useState<OpeningDrag | null>(null)
  const [openingCreate, setOpeningCreate] = useState<OpeningCreate | null>(null)
  const [lineKind, setLineKind] = useState<PlanLineKind | null>(null)
  const [lineDraft, setLineDraft] = useState<{ id: string | null; points: Point2D[] }>({ id: null, points: [] })
  const openingCreateRef = useRef<OpeningCreate | null>(null)
  const [openingKind, setOpeningKind] = useState<OpeningSpec['kind']>('door')
  const [orthogonal, setOrthogonal] = useState(true)
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
  const edgeLengths = useMemo(() => edgeChain.map((edge, index) => edge.measured_length_mm ?? edge.length_mm ?? (index < spec.boundary.length ? wallLength(spec.boundary, index) : 0)), [edgeChain, spec.boundary])
  const dimensionParts = useMemo(() => dimensionChainParts(spec, edgeLengths), [edgeLengths, spec])
  const closurePreview = useMemo(() => solveBoundaryEdges(edgeChain), [edgeChain])
  const closureAdjustments = closurePreview?.filter((edge) => edge.closure_adjustment_mm).length ?? 0
  const pointString = canvasPoints.map((point) => `${point.x},${point.y}`).join(' ')
  const lineDraftCanvasPoints = lineDraft.points.map((point) => {
    const imagePoint = roomPointToImage(spec, point)
    return imagePoint ? toCanvas({ ...imagePoint, role: 'other', confidence: 1 }) : null
  }).filter((point): point is CanvasPoint => !!point)
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

  const chooseLineTool = (kind: PlanLineKind | null) => {
    setLineKind(kind)
    setLineDraft({ id: null, points: [] })
    setSelectedPoint(null)
    setSelectedOpeningId(null)
    setTool(kind ? 'line' : 'edit')
  }

  useEffect(() => {
    if (regionRole && !activeEvidence?.target_id?.startsWith(`${regionRole}:`)) setTool('region')
  }, [activeEvidence?.field, activeEvidence?.target_id, regionRole])

  const localPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current!
    const point = svg.createSVGPoint()
    point.x = clientX; point.y = clientY
    const transformed = point.matrixTransform(svg.getScreenCTM()!.inverse())
    return {
      x: Number.isFinite(transformed.x) ? Math.max(0, Math.min(canvasWidth, transformed.x)) : canvasWidth / 2,
      y: Number.isFinite(transformed.y) ? Math.max(0, Math.min(canvasHeight, transformed.y)) : canvasHeight / 2,
    }
  }

  const commitBoundary = (next: ImageBoundaryPoint[]) => {
    const draft = cloneSpec(spec)
    const previousBoundary = draft.plan_annotation?.boundary ?? []
    const previousEdges = draft.plan_annotation?.edge_chain ?? []
    const nextEdges = reconcileBoundaryEdges(next, previousBoundary, previousEdges)
    draft.plan_annotation = {
      rotation_degrees: rotation as 0 | 90 | 180 | 270,
      boundary: next,
      edge_chain: nextEdges,
      confirmed: false,
    }
    rebindOpeningsToImageBoundary(draft, previousBoundary, next, previousEdges)
    onChange(draft)
  }

  const orthogonalBoundaryLocation = (index: number, candidate: CanvasPoint) => {
    if (!orthogonal || canvasPoints.length < 3) return candidate
    const previous = canvasPoints[(index - 1 + canvasPoints.length) % canvasPoints.length]
    const next = canvasPoints[(index + 1) % canvasPoints.length]
    const candidates = [
      { x: previous.x, y: next.y },
      { x: next.x, y: previous.y },
    ]
    return candidates.sort((left, right) => (
      Math.hypot(left.x - candidate.x, left.y - candidate.y)
      - Math.hypot(right.x - candidate.x, right.y - candidate.y)
    ))[0]
  }

  const createOpeningLine = (rawStart: CanvasPoint, rawEnd: CanvasPoint) => {
    if (canvasPoints.length < 2 || Math.hypot(rawEnd.x - rawStart.x, rawEnd.y - rawStart.y) < 8) return
    const dx = rawEnd.x - rawStart.x
    const dy = rawEnd.y - rawStart.y
    const lineLength = Math.max(1, Math.hypot(dx, dy))
    const center = { x: (rawStart.x + rawEnd.x) / 2, y: (rawStart.y + rawEnd.y) / 2 }
    const candidates = canvasPoints.map((wallStart, wallIndex) => {
      const wallEnd = canvasPoints[(wallIndex + 1) % canvasPoints.length]
      const wallDx = wallEnd.x - wallStart.x
      const wallDy = wallEnd.y - wallStart.y
      const wallLength = Math.max(1, Math.hypot(wallDx, wallDy))
      return {
        wallIndex,
        wallStart,
        wallEnd,
        alignment: Math.abs((dx * wallDx + dy * wallDy) / (lineLength * wallLength)),
        centerProjection: segmentProjection(center, wallStart, wallEnd),
      }
    }).sort((left, right) => right.alignment - left.alignment || left.centerProjection.distance - right.centerProjection.distance)
    const host = candidates[0]
    if (!host) return
    const startProjection = segmentProjection(rawStart, host.wallStart, host.wallEnd)
    const endProjection = segmentProjection(rawEnd, host.wallStart, host.wallEnd)
    const imageHostLength = Math.max(1, Math.hypot(host.wallEnd.x - host.wallStart.x, host.wallEnd.y - host.wallStart.y))
    const ratioSpan = Math.max(0.005, Math.min(1, lineLength / imageHostLength))
    const knownHostLength = edgeLengths[host.wallIndex] ?? 0
    const metricLength = knownHostLength > 1 ? knownHostLength : Math.max(800, Math.round(800 / ratioSpan))
    const width = knownHostLength > 1
      ? Math.max(10, Math.min(metricLength, Math.round(ratioSpan * metricLength / 10) * 10))
      : 800
    const offset = Math.max(0, Math.min(metricLength - width, Math.round((host.centerProjection.ratio * metricLength - width / 2) / 10) * 10))
    const snapToWall = host.centerProjection.distance <= 28
    const imageStart = toImage(snapToWall ? startProjection.point : rawStart)
    const imageEnd = toImage(snapToWall ? endProjection.point : rawEnd)
    const draft = cloneSpec(spec)
    if (knownHostLength <= 1 && draft.plan_annotation) {
      const edges = reconcileBoundaryEdges(
        points,
        draft.plan_annotation.boundary,
        draft.plan_annotation.edge_chain ?? [],
      )
      const hostEdge = edges[host.wallIndex]
      if (hostEdge) {
        edges[host.wallIndex] = {
          ...hostEdge,
          length_mm: metricLength,
          measured_length_mm: null,
          closure_adjustment_mm: 0,
          source: 'estimated',
          confidence: Math.min(hostEdge.confidence, 0.5),
        }
        draft.plan_annotation.edge_chain = edges
        draft.plan_annotation.confirmed = false
      }
    }
    const id = `opening-${crypto.randomUUID().slice(0, 8)}`
    const opening: OpeningSpec = {
      id,
      kind: openingKind,
      wall_index: host.wallIndex,
      offset_mm: offset,
      width_mm: width,
      height_mm: openingKind === 'door' ? 2100 : 1305,
      sill_mm: openingKind === 'window' ? 735 : 0,
      label: nextOpeningLabel(draft, openingKind),
      source: 'user' as const,
      confidence: 1,
    }
    draft.openings.push(opening)
    setOpeningOnWall(draft, opening, host.wallIndex, offset, width, metricLength)
    opening.line = null
    if (opening.wall_binding) {
      opening.wall_binding.image_start = { x: imageStart.x, y: imageStart.y }
      opening.wall_binding.image_end = { x: imageEnd.x, y: imageEnd.y }
    }
    onChange(draft)
    setSelectedPoint(null)
    setSelectedOpeningId(id)
  }

  const updateDimensionPartLength = (wallIndex: number, partKey: string, value: string) => {
    const draft = cloneSpec(spec)
    if (!draft.plan_annotation) return
    const edges = reconcileBoundaryEdges(
      points,
      draft.plan_annotation.boundary,
      draft.plan_annotation.edge_chain ?? [],
    )
    const parsed = Number(value)
    const currentLength = edges[wallIndex]?.measured_length_mm ?? edges[wallIndex]?.length_mm ?? (wallIndex < draft.boundary.length ? wallLength(draft.boundary, wallIndex) : 0)
    const parts = wallRunParts(draft, wallIndex, currentLength)
    const targetIndex = parts.findIndex((part) => part.key === partKey)
    if (targetIndex < 0) return
    if (!Number.isFinite(parsed) || parsed <= 0) {
      if (parts.length !== 1 || parts[0].kind !== 'wall') return
      edges[wallIndex] = { ...edges[wallIndex], length_mm: null, measured_length_mm: null, closure_adjustment_mm: 0, source: 'user', confidence: 0.5 }
      draft.plan_annotation.edge_chain = edges
      draft.plan_annotation.confirmed = false
      onChange(draft)
      return
    }
    const lengths = parts.map((part, index) => index === targetIndex ? Math.round(parsed) : part.length_mm)
    const total = lengths.reduce((sum, length) => sum + length, 0)
    let cursor = 0
    parts.forEach((part, index) => {
      const length = lengths[index]
      if (part.kind === 'opening' && part.opening_id) {
        const opening = draft.openings.find((item) => item.id === part.opening_id)
        if (opening) {
          setOpeningOnWall(draft, opening, wallIndex, cursor, length, total)
          opening.source = 'user'; opening.confidence = 1
        }
      }
      cursor += length
    })
    edges[wallIndex] = {
      ...edges[wallIndex],
      length_mm: total,
      measured_length_mm: total,
      closure_adjustment_mm: 0,
      source: 'user',
      confidence: 1,
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

  const addPlanLinePoint = (location: CanvasPoint) => {
    if (!lineKind || canvasPoints.length < 3) return
    const anchor = lineDraftCanvasPoints.at(-1)
    const aligned = orthogonal && anchor ? orthogonalCanvasPoint(anchor, location) : location
    const imagePoint = toImage(aligned)
    const nextPoint = imagePointToRoom(spec, imagePoint.x, imagePoint.y)
    const nextPoints = [...lineDraft.points, nextPoint]
    if (!lineDraft.points.length) {
      setLineDraft({ id: null, points: nextPoints })
      return
    }
    if (lineDraft.id) {
      const draft = cloneSpec(spec)
      const line = draft.plan_lines?.find((item) => item.id === lineDraft.id)
      if (!line) return
      line.points.push(nextPoint)
      line.source = 'user'; line.confidence = 1
      onChange(draft)
      setLineDraft({ id: lineDraft.id, points: nextPoints })
      return
    }
    const id = `line-${lineKind}-${crypto.randomUUID().slice(0, 8)}`
    const draft = cloneSpec(spec)
    ;(draft.plan_lines ??= []).push({ id, kind: lineKind, label: planLineLabels[lineKind], points: nextPoints, source: 'user', confidence: 1 })
    onChange(draft)
    setLineDraft({ id, points: nextPoints })
  }

  const updatePlanLineLength = (segmentIndex: number, value: number) => {
    if (!lineDraft.id || !Number.isFinite(value) || value <= 0) return
    const draft = cloneSpec(spec)
    const line = draft.plan_lines?.find((item) => item.id === lineDraft.id)
    if (!line) return
    line.points = resizePolylineSegment(line.points, segmentIndex, value)
    line.source = 'user'; line.confidence = 1
    onChange(draft)
    setLineDraft({ id: lineDraft.id, points: line.points })
  }

  const addPoint = (location: CanvasPoint) => {
    if (tool === 'draw' || points.length < 2) {
      const aligned = orthogonal && canvasPoints.length ? orthogonalCanvasPoint(canvasPoints.at(-1)!, location) : location
      const point = toImage(aligned)
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
    const point = toImage(orthogonal ? segmentProjection(location, canvasPoints[edgeIndex], canvasPoints[(edgeIndex + 1) % canvasPoints.length]).point : location)
    const next = [...points]
    next.splice(edgeIndex + 1, 0, point)
    setPoints(next); setSelectedPoint(edgeIndex + 1); commitBoundary(next)
  }

  const deletePoint = () => {
    if (selectedPoint === null || points.length <= 3) return
    const next = points.filter((_, index) => index !== selectedPoint)
    setPoints(next); setSelectedPoint(null); commitBoundary(next)
  }

  const deleteOpening = () => {
    if (!selectedOpeningId) return
    const draft = cloneSpec(spec)
    draft.openings = draft.openings.filter((opening) => opening.id !== selectedOpeningId)
    onChange(draft)
    setOpeningDrag(null)
    setSelectedOpeningId(null)
  }

  const deleteSelection = () => {
    if (selectedOpeningId) deleteOpening()
    else deletePoint()
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
    fixture.layout_generated = false
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
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedOpeningId) {
          event.preventDefault()
          deleteOpening()
        } else if (selectedPoint !== null && points.length > 3) {
          event.preventDefault()
          const next = points.filter((_, index) => index !== selectedPoint)
          setPoints(next); setSelectedPoint(null); commitBoundary(next)
        }
      } else if (event.key === 'Escape') {
        setSelectedPoint(null)
        setSelectedOpeningId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [points, selectedOpeningId, selectedPoint, spec, rotation])

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
        <label className={`annotation-line-select${tool === 'line' ? ' active' : ''}`} title="在原图上逐点绘制包管线、内墙线或辅助门线">
          <Spline size={15} />
          <select aria-label="照片标注线型" value={lineKind ?? ''} onChange={(event) => chooseLineTool(event.target.value ? event.target.value as PlanLineKind : null)}>
            <option value="">加线条…</option>
            <option value="pipe_chase">包管线</option>
            <option value="inner_wall">内墙线</option>
            <option value="door_line">门线（辅助）</option>
          </select>
        </label>
        <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}><Plus size={15} />加折点</button>
        <button className={tool === 'draw' ? 'active' : ''} onClick={() => { setTool('draw'); setPoints([]); setSelectedPoint(null) }}><PenLine size={15} />重画轮廓</button>
        <button className={tool === 'opening' ? 'active' : ''} onClick={() => setTool('opening')}><DoorOpen size={15} />加门窗</button>
        {tool === 'opening' && <select className="annotation-opening-kind" aria-label="新增门窗类型" value={openingKind} onChange={(event) => setOpeningKind(event.target.value as OpeningSpec['kind'])}><option value="door">门</option><option value="window">窗</option><option value="opening">洞口</option></select>}
        <button className={orthogonal ? 'active' : ''} title="限制新增和编辑的线为水平或垂直" aria-pressed={orthogonal} onClick={() => setOrthogonal((value) => !value)}><Grid2X2 size={15} />正交</button>
        <button className={tool === 'label' ? 'active' : ''} onClick={() => setTool('label')}><ScanText size={15} />补录数据</button>
        {regionRole && <button className={tool === 'region' ? 'active' : ''} onClick={() => setTool('region')}><BoxSelect size={15} />圈定范围</button>}
        <button className={showEvidence ? 'active' : ''} title={showEvidence ? '隐藏有效候选框' : '显示有效候选框'} aria-pressed={showEvidence} onClick={() => setShowEvidence((current) => !current)}>{showEvidence ? <EyeOff size={15} /> : <Eye size={15} />}{showEvidence ? '隐藏候选' : '显示候选'}</button>
        <button className="icon-button danger" title={selectedOpeningId ? '删除所选门窗' : '删除所选折点'} disabled={!selectedOpeningId && (selectedPoint === null || points.length <= 3)} onClick={deleteSelection}><Trash2 size={15} /></button>
      </div>
      <div className="annotation-status">
        <span>AI 初识草稿 · {points.length} 个折点 · 缺少 {pendingDimensions} 段尺寸{closureAdjustments ? ` · 自动闭合调整 ${closureAdjustments} 段` : ''}{pendingEvidence ? ` · 待校正 ${pendingEvidence} 项` : ''}</span>
        <button className="button primary compact" title={pendingEvidence ? '请先处理右侧全部待校正项' : pendingDimensions ? '请补全每段墙长' : undefined} disabled={points.length < 3 || pendingEvidence > 0 || pendingDimensions > 0} onClick={() => onConfirm(points, edgeChain)}><Check size={15} />确认标注并生成二维图</button>
      </div>
      <div className="annotation-dimensions">
        {tool === 'line' && lineDraft.id && lineDraft.points.slice(1).map((_point, index) => <label key={`${lineDraft.id}-length-${index}`} className="plan-line-dimension">
          <span>L{index + 1}</span>
          <input type="number" min="1" step="10" inputMode="numeric" value={polylineSegmentLength(lineDraft.points, index)} aria-label={`线段 ${index + 1} 长度（毫米）`} onChange={(event) => updatePlanLineLength(index, Number(event.target.value))} />
          <small>mm</small>
        </label>)}
        {dimensionParts.map((part) => <label key={`${part.wall_index}:${part.key}`} data-wall-index={part.wall_index} data-part-kind={part.kind} className={`${part.kind === 'opening' ? 'opening-dimension' : 'wall-dimension'}${part.opening_id === selectedOpeningId ? ' selected' : ''}`}>
          <span>{part.label}</span>
          <input type="number" min="1" step="1" inputMode="numeric" value={part.length_mm || ''} placeholder="mm" aria-label={`${part.label} 实测长度（毫米）`} onFocus={() => { if (part.opening_id) { setSelectedPoint(null); setSelectedOpeningId(part.opening_id) } }} onChange={(event) => updateDimensionPartLength(part.wall_index, part.key, event.target.value)} />
          {dimensionParts.filter((item) => item.wall_index === part.wall_index).at(-1)?.key === part.key && closurePreview?.[part.wall_index]?.closure_adjustment_mm ? <small title="原始分段实测值保持不变">建模 {closurePreview[part.wall_index].length_mm} ({closurePreview[part.wall_index].closure_adjustment_mm! > 0 ? '+' : ''}{closurePreview[part.wall_index].closure_adjustment_mm})</small> : null}
        </label>)}
      </div>
    </div>
    <svg ref={svgRef} className={`annotation-canvas tool-${tool}`} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} aria-label="手绘测量图照片标注画布"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        const location = localPoint(event.clientX, event.clientY)
        if (tool === 'opening') {
          const draft = { pointerId: event.pointerId, start: location, current: location }
          openingCreateRef.current = draft
          setOpeningCreate(draft)
          event.currentTarget.setPointerCapture(event.pointerId)
          return
        }
        if (tool === 'line') {
          addPlanLinePoint(location)
          return
        }
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
        if (openingCreateRef.current?.pointerId === event.pointerId) {
          const active = openingCreateRef.current
          const next = { ...active, current: orthogonal ? orthogonalCanvasPoint(active.start, location) : location }
          openingCreateRef.current = next
          setOpeningCreate(next)
        }
        else if (dragIndex !== null) setPoints((current) => current.map((point, index) => index === dragIndex ? toImage(orthogonalBoundaryLocation(index, location)) : point))
        else if (dragFixtureId) {
          const target = event.currentTarget.querySelector(`[data-fixture-id="${dragFixtureId}"]`)
          target?.setAttribute('transform', `translate(${location.x} ${location.y})`)
        }
        else if (openingDrag) {
          const start = canvasPoints[openingDrag.wallIndex]
          const end = canvasPoints[(openingDrag.wallIndex + 1) % canvasPoints.length]
          const ratio = segmentRatio(location, start, end)
          let startRatio = openingDrag.startRatio
          let endRatio = openingDrag.endRatio
          if (openingDrag.mode === 'move') {
            const delta = ratio - openingDrag.pointerRatio
            const width = openingDrag.originEndRatio - openingDrag.originStartRatio
            startRatio = Math.max(0, Math.min(1 - width, openingDrag.originStartRatio + delta))
            endRatio = startRatio + width
          } else if (openingDrag.mode === 'start') startRatio = Math.max(0, Math.min(openingDrag.originEndRatio - 0.005, ratio))
          else endRatio = Math.max(openingDrag.originStartRatio + 0.005, Math.min(1, ratio))
          setOpeningDrag({ ...openingDrag, startRatio, endRatio })
        }
        else if (wallRangeDrag) {
          const start = canvasPoints[wallRangeDrag.wallIndex]
          const end = canvasPoints[(wallRangeDrag.wallIndex + 1) % canvasPoints.length]
          setWallRangeDrag({ ...wallRangeDrag, endRatio: segmentRatio(location, start, end) })
        }
        else if (boxStart) setBoxEnd(location)
      }}
      onPointerUp={(event) => {
        if (openingCreateRef.current?.pointerId === event.pointerId) {
          createOpeningLine(openingCreateRef.current.start, openingCreateRef.current.current)
          openingCreateRef.current = null
          setOpeningCreate(null)
        }
        if (dragIndex !== null) {
          const location = localPoint(event.clientX, event.clientY)
          const next = points.map((point, index) => index === dragIndex ? toImage(orthogonalBoundaryLocation(index, location)) : point)
          setPoints(next); commitBoundary(next); setDragIndex(null)
        }
        if (dragFixtureId) {
          movePointFixture(dragFixtureId, localPoint(event.clientX, event.clientY))
          setDragFixtureId(null)
        }
        if (openingDrag) {
          const draft = cloneSpec(spec)
          const opening = draft.openings.find((item) => item.id === openingDrag.id)
          if (opening) {
            const length = openingHostLength(draft, openingDrag.wallIndex)
            setOpeningOnWall(draft, opening, openingDrag.wallIndex, Math.round(openingDrag.startRatio * length / 10) * 10, Math.max(10, Math.round((openingDrag.endRatio - openingDrag.startRatio) * length / 10) * 10), length)
            const imageWallStart = points[openingDrag.wallIndex]
            const imageWallEnd = points[(openingDrag.wallIndex + 1) % points.length]
            if (imageWallStart && imageWallEnd && opening.wall_binding) {
              opening.wall_binding.image_start = {
                x: imageWallStart.x + (imageWallEnd.x - imageWallStart.x) * openingDrag.startRatio,
                y: imageWallStart.y + (imageWallEnd.y - imageWallStart.y) * openingDrag.startRatio,
              }
              opening.wall_binding.image_end = {
                x: imageWallStart.x + (imageWallEnd.x - imageWallStart.x) * openingDrag.endRatio,
                y: imageWallStart.y + (imageWallEnd.y - imageWallStart.y) * openingDrag.endRatio,
              }
            }
            opening.source = 'user'; opening.confidence = 1
            onChange(draft)
          }
        }
        if (wallRangeDrag) bindDoorRange(wallRangeDrag)
        if (boxStart && boxEnd) {
          if (tool === 'region') bindEvidenceRegion(boxStart, boxEnd)
          else createMissingLabel(boxStart, boxEnd)
        }
        setBoxStart(null); setBoxEnd(null)
        setWallRangeDrag(null); setOpeningDrag(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={(event) => {
        openingCreateRef.current = null
        setDragIndex(null); setDragFixtureId(null); setBoxStart(null); setBoxEnd(null); setWallRangeDrag(null); setOpeningDrag(null); setOpeningCreate(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onLostPointerCapture={() => {
        openingCreateRef.current = null
        setDragIndex(null); setDragFixtureId(null); setBoxStart(null); setBoxEnd(null); setWallRangeDrag(null); setOpeningDrag(null); setOpeningCreate(null)
      }}>
      <rect width={canvasWidth} height={canvasHeight} className="annotation-background" />
      {plan && <image href={plan.url} x="0" y="0" width={sourceImage.width} height={sourceImage.height} transform={sourceImage.transform} preserveAspectRatio="none" />}
      <g className="annotation-plan-lines" pointerEvents="none">
        {(spec.plan_lines ?? []).map((line) => {
          const linePoints = line.points.map((point) => {
            const imagePoint = roomPointToImage(spec, point)
            return imagePoint ? toCanvas({ ...imagePoint, role: 'other', confidence: 1 }) : null
          }).filter((point): point is CanvasPoint => !!point)
          if (linePoints.length < 2) return null
          const pointString = linePoints.map((point) => `${point.x},${point.y}`).join(' ')
          const labelPoint = linePoints[Math.floor((linePoints.length - 1) / 2)]
          return <g key={`annotation-line-${line.id}`} className={`annotation-plan-line ${line.kind}`} data-plan-line-id={line.id}>
            <polyline points={pointString} />
            {linePoints.map((point, index) => <circle key={`${line.id}-${index}`} cx={point.x} cy={point.y} r="4" />)}
            <text x={labelPoint.x} y={labelPoint.y - 10}>{line.label || planLineLabels[line.kind]}</text>
          </g>
        })}
        {!lineDraft.id && lineDraftCanvasPoints.length > 0 && <g className={`annotation-plan-line ${lineKind ?? 'inner_wall'} draft`}>
          <polyline points={lineDraftCanvasPoints.map((point) => `${point.x},${point.y}`).join(' ')} />
          {lineDraftCanvasPoints.map((point, index) => <circle key={`annotation-line-draft-${index}`} cx={point.x} cy={point.y} r="5" />)}
        </g>}
      </g>
      <g className="annotation-evidence-layer">{visibleEvidence.map((item) => {
        const bbox = item.bbox!, id = item.field.slice(4), pending = item.review_required && !item.confirmed
        const bindingActive = id === activeEvidenceId && ['wall_segment', 'wall_thickness', 'door_size', 'door_position', 'ceiling_height', 'pipe_box'].includes(item.semantic_role ?? '')
        return <rect key={id} data-evidence-id={id} pointerEvents={bindingActive ? 'none' : undefined} className={pending ? 'annotation-evidence pending' : 'annotation-evidence'} x={bbox.x_min} y={bbox.y_min * canvasHeight / 1000} width={bbox.x_max - bbox.x_min} height={(bbox.y_max - bbox.y_min) * canvasHeight / 1000}
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onEvidenceSelect(id) }} />
      })}</g>
      {points.length >= 2 && (tool === 'draw' ? <polyline points={pointString} className="annotation-boundary open" /> : <polygon points={pointString} className="annotation-boundary segmented" />)}
      {openingCreate && <g className="annotation-opening-create" pointerEvents="none">
        <line x1={openingCreate.start.x} y1={openingCreate.start.y} x2={openingCreate.current.x} y2={openingCreate.current.y} />
        <circle cx={openingCreate.start.x} cy={openingCreate.start.y} r="6" />
        <circle cx={openingCreate.current.x} cy={openingCreate.current.y} r="6" />
      </g>}
      {tool !== 'draw' && canvasPoints.flatMap((wallStart, wallIndex) => {
        const wallEnd = canvasPoints[(wallIndex + 1) % canvasPoints.length]
        const hostLength = Math.max(1, edgeLengths[wallIndex])
        const selected = activeWallIndex === String(wallIndex)
        const wallParts = dimensionParts.filter((part) => part.wall_index === wallIndex)
        const openingImageRange = (openingId?: string) => {
          const opening = openingId ? spec.openings.find((item) => item.id === openingId) : undefined
          const imageStart = opening?.wall_binding?.image_start
          const imageEnd = opening?.wall_binding?.image_end
          if (!imageStart || !imageEnd) return null
          const startRatio = segmentRatio(toCanvas({ ...imageStart, role: 'wall_corner', confidence: 1 }), wallStart, wallEnd)
          const endRatio = segmentRatio(toCanvas({ ...imageEnd, role: 'wall_corner', confidence: 1 }), wallStart, wallEnd)
          return { startRatio: Math.min(startRatio, endRatio), endRatio: Math.max(startRatio, endRatio) }
        }
        return wallParts.filter((part) => part.kind === 'wall').map((part) => {
          const unknownWholeWall = edgeLengths[wallIndex] <= 0 && part.length_mm === 0
          const partIndex = wallParts.findIndex((item) => item.key === part.key)
          const previousOpening = wallParts[partIndex - 1]
          const nextOpening = wallParts[partIndex + 1]
          const previousRange = previousOpening?.kind === 'opening' ? openingImageRange(previousOpening.opening_id) : null
          const nextRange = nextOpening?.kind === 'opening' ? openingImageRange(nextOpening.opening_id) : null
          const startRatio = previousRange?.endRatio ?? (unknownWholeWall ? 0 : part.start_mm / hostLength)
          const endRatio = nextRange?.startRatio ?? (unknownWholeWall ? 1 : part.end_mm / hostLength)
          const start = pointAtRatio(wallStart, wallEnd, startRatio)
          const end = pointAtRatio(wallStart, wallEnd, endRatio)
          return <g key={`annotation-wall-${wallIndex}-${part.key}`} className={selected ? 'annotation-wall selected' : 'annotation-wall'}>
            <line className="annotation-wall-hit" x1={start.x} y1={start.y} x2={end.x} y2={end.y} onPointerDown={(event) => {
              if (tool !== 'edit') return
              event.preventDefault(); event.stopPropagation()
              const location = localPoint(event.clientX, event.clientY)
              if (activeEvidence?.semantic_role === 'door_size') {
                const ratio = segmentRatio(location, wallStart, wallEnd)
                setWallRangeDrag({ wallIndex, startRatio: ratio, endRatio: ratio })
                event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
              }
            }} onClick={(event) => {
              if (tool !== 'edit' || activeEvidence?.semantic_role === 'door_size') return
              event.preventDefault(); event.stopPropagation(); bindEvidenceToWall(wallIndex, localPoint(event.clientX, event.clientY))
            }} />
            <line className="annotation-wall-line" data-wall-index={wallIndex} data-run-start-mm={part.start_mm} data-run-end-mm={part.end_mm} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
            <text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 + 4}>{part.label}</text>
          </g>
        })
      })}
      {canvasPoints.map((point, index) => <g key={`annotation-point-${index}`} className={selectedPoint === index ? 'annotation-point selected' : 'annotation-point'} transform={`translate(${point.x} ${point.y})`}
        onPointerDown={(event) => {
          if (tool !== 'edit') return
          event.preventDefault()
          if (activeEvidence?.semantic_role === 'door_size') return
          event.stopPropagation(); setSelectedOpeningId(null); setSelectedPoint(index); setDragIndex(index); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
        }}>
        <circle className="annotation-point-hit" r="20" />
        <circle className="annotation-point-dot" r="8" />
      </g>)}
      {spec.openings.map((rawOpening) => {
        const part = dimensionParts.find((item) => item.opening_id === rawOpening.id)
        const wallIndex = part?.wall_index ?? rawOpening.wall_index
        const wallStart = canvasPoints[wallIndex]
        const wallEnd = canvasPoints[(wallIndex + 1) % canvasPoints.length]
        if (!wallStart || !wallEnd) return null
        const hostLength = Math.max(1, edgeLengths[wallIndex] ?? openingHostLength(spec, wallIndex))
        const startRatio = openingDrag?.id === rawOpening.id ? openingDrag.startRatio : (part?.start_mm ?? rawOpening.offset_mm) / hostLength
        const endRatio = openingDrag?.id === rawOpening.id ? openingDrag.endRatio : (part?.end_mm ?? rawOpening.offset_mm + rawOpening.width_mm) / hostLength
        const imageStart = rawOpening.wall_binding?.image_start
        const imageEnd = rawOpening.wall_binding?.image_end
        const usePersistedImageLine = imageStart && imageEnd && openingDrag?.id !== rawOpening.id
        const openingStart = usePersistedImageLine ? toCanvas({ ...imageStart, role: 'wall_corner', confidence: 1 }) : pointAtRatio(wallStart, wallEnd, startRatio)
        const openingEnd = usePersistedImageLine ? toCanvas({ ...imageEnd, role: 'wall_corner', confidence: 1 }) : pointAtRatio(wallStart, wallEnd, endRatio)
        const dx = openingEnd.x - openingStart.x, dy = openingEnd.y - openingStart.y
        const distance = Math.max(1, Math.hypot(dx, dy))
        const normal = { x: -dy / distance, y: dx / distance }
        const mid = { x: (openingStart.x + openingEnd.x) / 2, y: (openingStart.y + openingEnd.y) / 2 }
        const roomCenter = canvasPoints.reduce((center, point) => ({ x: center.x + point.x / canvasPoints.length, y: center.y + point.y / canvasPoints.length }), { x: 0, y: 0 })
        const towardRoom = (roomCenter.x - mid.x) * normal.x + (roomCenter.y - mid.y) * normal.y >= 0 ? normal : { x: -normal.x, y: -normal.y }
        const symbolNormal = rawOpening.swing_direction === 'outward' ? { x: -towardRoom.x, y: -towardRoom.y } : towardRoom
        const hingeAtEnd = rawOpening.swing_direction === 'right'
        const hinge = hingeAtEnd ? openingEnd : openingStart
        const closedTip = hingeAtEnd ? openingStart : openingEnd
        const hingeTangent = { x: (closedTip.x - hinge.x) / distance, y: (closedTip.y - hinge.y) / distance }
        const leafEnd = { x: hinge.x + symbolNormal.x * distance, y: hinge.y + symbolNormal.y * distance }
        const arcSweep = hingeTangent.x * symbolNormal.y - hingeTangent.y * symbolNormal.x > 0 ? 1 : 0
        const showHingedDoor = rawOpening.kind === 'door' && (!rawOpening.opening_form || rawOpening.opening_form === 'unknown' || rawOpening.opening_form === 'hinged')
        const selected = selectedOpeningId === rawOpening.id
        const beginOpeningDrag = (event: ReactPointerEvent<SVGElement>, mode: OpeningDrag['mode']) => {
          if (tool !== 'edit' || event.button !== 0) return
          event.preventDefault(); event.stopPropagation()
          setSelectedPoint(null)
          setSelectedOpeningId(rawOpening.id)
          const pointerRatio = segmentRatio(localPoint(event.clientX, event.clientY), wallStart, wallEnd)
          setOpeningDrag({ pointerId: event.pointerId, id: rawOpening.id, wallIndex, startRatio, endRatio, originStartRatio: startRatio, originEndRatio: endRatio, pointerRatio, mode })
          event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
        }
        return <g key={`annotation-opening-${rawOpening.id}`} className={`annotation-opening-segments${selected ? ' selected' : ''}`} data-opening-id={rawOpening.id} data-wall-index={wallIndex} data-offset-mm={part?.start_mm ?? rawOpening.offset_mm} data-width-mm={part?.length_mm ?? rawOpening.width_mm} onClick={(event) => {
          if (tool !== 'edit') return
          event.stopPropagation(); setSelectedPoint(null); setSelectedOpeningId(rawOpening.id)
        }}>
          <line className="opening-part" x1={openingStart.x} y1={openingStart.y} x2={openingEnd.x} y2={openingEnd.y} />
          {showHingedDoor && <g className="opening-symbol hinged" pointerEvents="none">
            <line className="door-leaf" x1={hinge.x} y1={hinge.y} x2={leafEnd.x} y2={leafEnd.y} />
            <path className="door-swing" d={`M ${closedTip.x} ${closedTip.y} A ${distance} ${distance} 0 0 ${arcSweep} ${leafEnd.x} ${leafEnd.y}`} />
          </g>}
          <line className="opening-drag-hit" x1={openingStart.x} y1={openingStart.y} x2={openingEnd.x} y2={openingEnd.y} onPointerDown={(event) => beginOpeningDrag(event, 'move')} />
          <line className="opening-tick" x1={openingStart.x - normal.x * 10} y1={openingStart.y - normal.y * 10} x2={openingStart.x + normal.x * 10} y2={openingStart.y + normal.y * 10} />
          <line className="opening-tick" x1={openingEnd.x - normal.x * 10} y1={openingEnd.y - normal.y * 10} x2={openingEnd.x + normal.x * 10} y2={openingEnd.y + normal.y * 10} />
          <circle className="opening-handle" cx={openingStart.x} cy={openingStart.y} r="8" onPointerDown={(event) => beginOpeningDrag(event, 'start')} />
          <circle className="opening-handle" cx={openingEnd.x} cy={openingEnd.y} r="8" onPointerDown={(event) => beginOpeningDrag(event, 'end')} />
          <text className="opening-label" x={mid.x + normal.x * 12} y={mid.y + normal.y * 12}>{part?.label ?? rawOpening.label} {Math.round((endRatio - startRatio) * hostLength)}</text>
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
    {!plan && <div className="annotation-empty-state"><strong>尚未上传平面图</strong><span>请先在左侧“测量图”中上传图片，照片标注会显示原图。</span></div>}
  </div>
}
