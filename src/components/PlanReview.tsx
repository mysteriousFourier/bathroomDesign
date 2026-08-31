import { CircleDot, DoorOpen, Droplet, Eye, EyeOff, Focus, Grid2X2, Move, Plug, Spline, Square, Trash2, WashingMachine, Waves, ZoomIn, ZoomOut } from 'lucide-react'
import { Canvas } from '@react-three/fiber'
import { Suspense, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { dimensionChainParts, finishedRoomBoundary, fixtureBoundWallIndex, fixtureDefaults, fixturePointShape, nearestValidWetZoneBoundary, openingLine, roomBounds, roomCentroid, snapPointToNearestWall, wallLayerPolygons, wallLength } from '../spec'
import { resolveFixtureDrag } from '../layoutEngine'
import { builtInAssetAsRoomAsset, modelAssetForProduct } from '../modelLibrary'
import { fixtureTopAppearance, planModelPosition, planTextureLayout, planTopCamera } from '../planAppearance'
import { FixtureAssetBoundary, FixtureAssetModel } from './ModelCanvas'
import type { Asset, FixtureKind, FixturePointUsage, FixtureSpec, OpeningSpec, PlanLineKind, Point2D, RoomSpec, Selection } from '../types'

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

export type PlanSurfaceMaterials = {
  floor?: { textureSrc: string; widthMm: number; depthMm: number; rotationDeg?: 0 | 90; offsetXmm?: number; offsetZmm?: number; label?: string }
}

function FixtureTopSymbol({ appearance, width, depth, pointShape, pointSize }: { appearance: ReturnType<typeof fixtureTopAppearance>; width: number; depth: number; pointShape: ReturnType<typeof fixturePointShape>; pointSize: number }): ReactNode {
  if (appearance === 'toilet') return <g className="fixture-top toilet-top">
    <ellipse className="fixture-top-body" rx={width * .43} ry={depth * .49} />
    <ellipse className="fixture-top-detail" cy={depth * .08} rx={width * .28} ry={depth * .29} />
    <rect className="fixture-top-tank" x={-width * .4} y={-depth * .48} width={width * .8} height={depth * .25} rx={Math.min(7, width * .08)} />
  </g>
  if (appearance === 'vanity') return <g className="fixture-top vanity-top">
    <rect className="fixture-top-body" x={-width / 2} y={-depth / 2} width={width} height={depth} rx="4" />
    <ellipse className="fixture-top-detail" rx={width * .3} ry={depth * .28} />
    <circle className="fixture-top-accent" cy={-depth * .32} r={Math.max(2, Math.min(width, depth) * .04)} />
  </g>
  if (appearance === 'shower') return <g className="fixture-top shower-top">
    <rect className="fixture-top-body" x={-width / 2} y={-depth / 2} width={width} height={depth} rx="3" />
    <path className="fixture-top-detail" d={`M ${-width / 2} ${depth / 2} L ${width / 2} ${-depth / 2} M ${-width / 2} ${-depth / 2} L ${width / 2} ${depth / 2}`} />
    <circle className="fixture-top-accent" r={Math.max(3, Math.min(width, depth) * .06)} />
  </g>
  return pointShape === 'circle'
    ? <circle className="fixture-symbol" r={pointSize / 2} />
    : <rect className="fixture-symbol" x={-(pointShape === 'square' ? pointSize : width) / 2} y={-(pointShape === 'square' ? pointSize : depth) / 2} width={pointShape === 'square' ? pointSize : width} height={pointShape === 'square' ? pointSize : depth} rx={pointShape === 'square' ? 0 : 3} />
}

function FixtureModelsTopLayer({ fixtures, selection, scale, offsetX, offsetZ, viewportZoom }: { fixtures: FixtureSpec[]; selection: Selection; scale: number; offsetX: number; offsetZ: number; viewportZoom: number }) {
  const layerRef = useRef<SVGForeignObjectElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const camera = planTopCamera(canvasWidth, canvasHeight)
  const pointAsset = (fixture: FixtureSpec) => {
    if (fixture.model_asset) return fixture.model_asset
    // XYJ2-1 has verified dimensions but no SKU-bound asset in the static
    // catalog. Use the reviewed washer model as a top-view visual fallback so
    // the plan still shows the real appliance footprint instead of only a
    // generic marker.
    if (/洗衣机/.test(fixture.label)) {
      const washer = modelAssetForProduct('洗衣机', undefined, 'premium')
      return washer ? builtInAssetAsRoomAsset(washer) : undefined
    }
    const category = fixture.kind === 'floor_drain' || fixture.kind === 'drain'
      ? '地漏'
      : fixture.kind === 'water'
        ? '水龙头'
        : fixture.kind === 'electric'
          ? '电气面板'
          : null
    const asset = category ? modelAssetForProduct(category) : undefined
    return asset ? builtInAssetAsRoomAsset(asset) : undefined
  }
  // Utility points should use the reviewed library model in the plan even
  // when the measurement import did not embed a model snapshot.
  const modelFixtures = fixtures
    .map((fixture) => ({ fixture, asset: pointAsset(fixture) }))
    .filter((item): item is { fixture: FixtureSpec; asset: NonNullable<FixtureSpec['model_asset']> } => !!item.asset)

  useLayoutEffect(() => {
    const layer = layerRef.current
    const viewport = viewportRef.current
    const svg = layer?.ownerSVGElement
    if (!layer || !viewport || !svg) return
    const alignWithSvgUnits = () => {
      const matrix = layer.getScreenCTM()
      if (!matrix) return
      const screenScaleX = Math.hypot(matrix.a, matrix.b)
      const screenScaleY = Math.hypot(matrix.c, matrix.d)
      if (screenScaleX <= 0 || screenScaleY <= 0) return
      const baseScaleX = screenScaleX / viewportZoom
      const baseScaleY = screenScaleY / viewportZoom
      // The SVG transform affects both the foreignObject layout viewport and
      // its HTML contents. R3F then measures that transformed HTML box, so the
      // bridge scale enters twice; cancel one base-screen copy while retaining
      // the plan's intentional pan/zoom transform.
      viewport.style.transform = `scale(${1 / Math.sqrt(baseScaleX)}, ${1 / Math.sqrt(baseScaleY)})`
    }
    alignWithSvgUnits()
    const observer = new ResizeObserver(alignWithSvgUnits)
    observer.observe(svg)
    window.addEventListener('resize', alignWithSvgUnits)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', alignWithSvgUnits)
    }
  }, [viewportZoom])

  return <foreignObject ref={layerRef} className="fixture-model-top" x="0" y="0" width={canvasWidth} height={canvasHeight} style={{ width: canvasWidth, height: canvasHeight }} pointerEvents="none">
    <div ref={viewportRef} className="fixture-model-viewport" style={{ width: canvasWidth, height: canvasHeight }}>
      <Canvas orthographic frameloop="demand" dpr={[1, 2]} gl={{ alpha: true, antialias: true }} camera={camera} onCreated={({ camera: topCamera }) => topCamera.lookAt(canvasWidth / 2, 0, canvasHeight / 2)}>
        <ambientLight intensity={2.1} />
        <directionalLight position={[-3, 6, -4]} intensity={2.5} />
        <Suspense fallback={null}>{modelFixtures.map(({ fixture, asset }) => <group key={fixture.id} position={planModelPosition(fixture.x_mm, fixture.z_mm, scale, offsetX, offsetZ)} scale={1000 * scale} rotation={[0, -fixture.rotation_deg * Math.PI / 180, 0]}><FixtureAssetBoundary fixture={{ ...fixture, model_asset: asset }}><FixtureAssetModel fixture={{ ...fixture, model_asset: asset }} selected={selection.type === 'fixture' && selection.id === fixture.id} /></FixtureAssetBoundary></group>)}</Suspense>
      </Canvas>
    </div>
  </foreignObject>
}

export function PlanReview({ spec, plan, selection, surfaceMaterials, onSelect, onFixtureMove, onOpeningAdd, onOpeningChange, onOpeningDelete, onFixtureAdd, onPlanLineAdd, onPlanLineExtend, onZoneChange, onEvidenceSelect }: {
  spec: RoomSpec
  plan?: Asset
  selection: Selection
  surfaceMaterials?: PlanSurfaceMaterials
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
  const patternId = `plan-floor-${useId().replace(/:/g, '')}`
  const [zoom, setZoom] = useState(1)
  const [showFurniture, setShowFurniture] = useState(true)
  const [addFixture, setAddFixture] = useState<{ kind: FixtureKind; pointUsage?: FixturePointUsage } | null>(null)
  const [addOpening, setAddOpening] = useState(false)
  const [orthogonal, setOrthogonal] = useState(true)
  const [addLine, setAddLine] = useState<PlanLineKind | null>(null)
  const [lineDraft, setLineDraft] = useState<{ id: string | null; points: Point2D[] }>({ id: null, points: [] })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panSession = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const suppressCanvasClick = useRef(false)
  const [zoneDraft, setZoneDraft] = useState<{ id: string; boundary: Point2D[] } | null>(null)
  const zoneSession = useRef<{ pointerId: number; id: string; start: Point2D; original: Point2D[]; vertices: number[] | null; draft: Point2D[] } | null>(null)
  const openingDrag = useRef<OpeningDrag | null>(null)
  const [openingDragState, setOpeningDragState] = useState<OpeningDrag | null>(null)
  const openingCreate = useRef<OpeningCreate | null>(null)
  const [openingCreateState, setOpeningCreateState] = useState<OpeningCreate | null>(null)
  const roomBoundary = useMemo(() => finishedRoomBoundary(spec), [spec])
  const wallBodies = useMemo(() => wallLayerPolygons(spec), [spec])
  const bounds = useMemo(() => roomBounds([...spec.boundary, ...roomBoundary, ...wallBodies.flatMap((body) => [...body.finish, ...body.cavity, ...body.wall])]), [spec.boundary, roomBoundary, wallBodies])
  const scale = Math.min((canvasWidth - pad * 2) / Math.max(bounds.width, 1), (canvasHeight - pad * 2) / Math.max(bounds.depth, 1))
  const offsetX = (canvasWidth - bounds.width * scale) / 2 - bounds.minX * scale
  const offsetZ = (canvasHeight - bounds.depth * scale) / 2 - bounds.minZ * scale
  const sx = (x: number) => offsetX + x * scale
  const sz = (z: number) => offsetZ + z * scale
  const mmX = (x: number) => Math.round((x - offsetX) / scale / 10) * 10
  const mmZ = (z: number) => Math.round((z - offsetZ) / scale / 10) * 10
  const points = roomBoundary.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')
  const floorTexture = surfaceMaterials?.floor
  const floorLayout = floorTexture ? planTextureLayout(floorTexture.widthMm, floorTexture.depthMm, floorTexture.rotationDeg, floorTexture.offsetXmm, floorTexture.offsetZmm) : null
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
  const startZoneDrag = (event: ReactPointerEvent<SVGGElement | SVGCircleElement>, id: string, boundary: Point2D[], vertices: number[] | null) => {
    if (!onZoneChange || event.button !== 0) return
    event.preventDefault(); event.stopPropagation()
    const svg = event.currentTarget.ownerSVGElement!
    const original = boundary.map((point) => ({ ...point }))
    zoneSession.current = { pointerId: event.pointerId, id, start: roomPoint(svg, event.clientX, event.clientY), original, vertices, draft: original }
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
    const washerDrain = addFixture.kind === 'floor_drain' && addFixture.pointUsage === 'washer'
    const snap = washerDrain ? null : snapPointToNearestWall(roomBoundary, { x_mm: xMm, z_mm: zMm })
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
  const chooseLineTool = (kind: PlanLineKind | null) => {
    setAddFixture(null)
    setAddOpening(false)
    setAddLine(kind)
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
          <button className={`icon-button${addFixture?.kind === 'floor_drain' && addFixture.pointUsage === 'shower' ? ' active-tool' : ''}`} title="添加淋浴地漏" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'floor_drain' && value.pointUsage === 'shower' ? null : { kind: 'floor_drain', pointUsage: 'shower' }) }}><Square size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'floor_drain' && addFixture.pointUsage === 'washer' ? ' active-tool' : ''}`} title="添加洗衣机地漏" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'floor_drain' && value.pointUsage === 'washer' ? null : { kind: 'floor_drain', pointUsage: 'washer' }) }}><WashingMachine size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'electric' ? ' active-tool' : ''}`} title="添加电点" onClick={() => { setAddOpening(false); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddFixture((value) => value?.kind === 'electric' ? null : { kind: 'electric' }) }}><Plug size={17} /></button>
          <label className={`canvas-tool-select${addLine ? ' active-tool' : ''}`} title="选择线型后在图中逐点绘制">
            <Spline size={16} />
            <select value={addLine ?? ''} aria-label="添加平面线条" onChange={(event) => chooseLineTool(event.target.value ? event.target.value as PlanLineKind : null)}>
              <option value="">添加线条…</option>
              <option value="pipe_chase">包管线</option>
              <option value="inner_wall">内墙线</option>
              <option value="door_line">门线（辅助）</option>
            </select>
          </label>
          <button className={`icon-button${addOpening ? ' active-tool' : ''}`} title="拖拽绘制门窗线" onClick={() => { setAddFixture(null); setAddLine(null); setLineDraft({ id: null, points: [] }); setAddOpening((value) => !value) }}><DoorOpen size={17} /></button>
          <button className={showFurniture ? 'icon-button active-tool' : 'icon-button'} title={showFurniture ? '隐藏家具模型（查看吊顶）' : '显示家具模型'} aria-label={showFurniture ? '隐藏家具模型' : '显示家具模型'} aria-pressed={showFurniture} onClick={() => setShowFurniture((value) => !value)}>{showFurniture ? <Eye size={17} /> : <EyeOff size={17} />}</button>
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
          event.preventDefault()
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
            if (zone.vertices !== null) {
              const horizontalEdge = zone.vertices.length === 2 && zone.original[zone.vertices[0]].z_mm === zone.original[zone.vertices[1]].z_mm
              const verticalEdge = zone.vertices.length === 2 && zone.original[zone.vertices[0]].x_mm === zone.original[zone.vertices[1]].x_mm
              boundary = zone.original.map((point, index) => !zone.vertices!.includes(index) ? point : {
                x_mm: verticalEdge || zone.vertices!.length === 1 ? Math.max(room.minX, Math.min(room.maxX, current.x_mm)) : point.x_mm,
                z_mm: horizontalEdge || zone.vertices!.length === 1 ? Math.max(room.minZ, Math.min(room.maxZ, current.z_mm)) : point.z_mm,
              })
            } else {
              const originalBounds = roomBounds(zone.original)
              const requestedX = current.x_mm - zone.start.x_mm
              const requestedZ = current.z_mm - zone.start.z_mm
              const deltaX = Math.max(room.minX - originalBounds.minX, Math.min(room.maxX - originalBounds.maxX, requestedX))
              const deltaZ = Math.max(room.minZ - originalBounds.minZ, Math.min(room.maxZ - originalBounds.maxZ, requestedZ))
              boundary = zone.original.map((point) => ({ x_mm: point.x_mm + deltaX, z_mm: point.z_mm + deltaZ }))
            }
            // Keep pointer interaction continuous. A vertex drag temporarily
            // produces a non-rectangular four-point draft; validation and
            // nearest-valid snapping belong to pointer-up, not every frame.
            const constrained = nearestValidWetZoneBoundary(spec, zone.id, boundary) ?? zone.draft
            zone.draft = constrained
            setZoneDraft({ id: zone.id, boundary: constrained })
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
          {floorTexture && floorLayout && <pattern id={patternId} x={sx(floorLayout.offsetXmm)} y={sz(floorLayout.offsetZmm)} width={floorLayout.tileWidthMm * scale} height={floorLayout.tileDepthMm * scale} patternUnits="userSpaceOnUse">
            <image href={floorTexture.textureSrc} width={floorLayout.tileWidthMm * scale} height={floorLayout.tileDepthMm * scale} preserveAspectRatio="none" />
            <rect width={floorLayout.tileWidthMm * scale} height={floorLayout.tileDepthMm * scale} className="plan-floor-joint" />
          </pattern>}
        </defs>
        <rect width={canvasWidth} height={canvasHeight} fill="url(#major-grid)" data-pan-surface="true" />
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {wallBodies.map((body) => <g key={`wall-body-${body.wall_index}-${body.run_key}`} className="wall-body-run" data-wall-index={body.wall_index} data-run-start-mm={body.start_mm} data-run-end-mm={body.end_mm} pointerEvents="none">
          <polygon points={body.finish.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} className="wall-finish-body" />
          <polygon points={body.wall.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} className="wall-body" />
        </g>)}
        <polygon points={points} className={`${selection.type === 'room' ? 'room-polygon selected' : 'room-polygon'}${floorTexture ? ' textured-floor' : ''}`} style={floorTexture ? { fill: `url(#${patternId})` } : undefined} data-floor-texture={floorTexture?.textureSrc} data-floor-label={floorTexture?.label} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'room' }) }} />
        <g className={selection.type === 'room' ? 'room-boundary-runs selected' : 'room-boundary-runs'} pointerEvents="none">
          {roomBoundaryRuns.map((run) => <line key={`room-boundary-${run.wall_index}-${run.key}`} data-wall-index={run.wall_index} data-run-start-mm={run.start_mm} data-run-end-mm={run.end_mm} x1={sx(run.start.x_mm)} y1={sz(run.start.z_mm)} x2={sx(run.end.x_mm)} y2={sz(run.end.z_mm)} />)}
        </g>
        {(spec.dry_wet_zones ?? []).filter((zone) => zone.kind === 'wet').map((zone) => {
          const boundary = zoneDraft?.id === zone.id ? zoneDraft.boundary : zone.boundary
          const zonePoints = boundary.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')
          const centerX = boundary.reduce((sum, point) => sum + sx(point.x_mm), 0) / boundary.length
          const centerZ = boundary.reduce((sum, point) => sum + sz(point.z_mm), 0) / boundary.length
          const selected = selection.type === 'dry_wet_zone' && selection.id === zone.id
          const edges = boundary.map((point, index) => ({ indices: [index, (index + 1) % boundary.length], x: (point.x_mm + boundary[(index + 1) % boundary.length].x_mm) / 2, z: (point.z_mm + boundary[(index + 1) % boundary.length].z_mm) / 2 }))
          return <g key={zone.id} className={`dry-wet-zone ${zone.kind}${selected ? ' selected' : ''}`} onPointerDown={(event) => startZoneDrag(event, zone.id, boundary, null)} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'dry_wet_zone', id: zone.id }) }}>
            <polygon points={zonePoints} />
            <text x={centerX} y={centerZ + 4}>{zone.label}</text>
            {boundary.map((point, index) => <circle key={`${zone.id}-handle-${index}`} className="dry-wet-zone-handle corner" cx={sx(point.x_mm)} cy={sz(point.z_mm)} r="7" onPointerDown={(event) => startZoneDrag(event, zone.id, boundary, [index])} />)}
            {edges.map((edge, index) => <circle key={`${zone.id}-edge-${index}`} className={`dry-wet-zone-handle edge ${edge.indices[0] % 2 === 0 ? 'horizontal' : 'vertical'}`} cx={sx(edge.x)} cy={sz(edge.z)} r="6" onPointerDown={(event) => startZoneDrag(event, zone.id, boundary, edge.indices)} />)}
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
        <FixtureModelsTopLayer fixtures={spec.fixtures.filter((fixture) => showFurniture || fixtureTopAppearance(fixture.kind) === 'utility-point')} selection={selection} scale={scale} offsetX={offsetX} offsetZ={offsetZ} viewportZoom={zoom} />
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
          const tangent = { x: dx / length, y: dy / length }
          const normal = { x: -tangent.y, y: tangent.x }
          const centerPx = { x: sx(center.x), y: sz(center.z) }
          const towardRoom = (centerPx.x - mid.x) * normal.x + (centerPx.y - mid.y) * normal.y >= 0 ? normal : { x: -normal.x, y: -normal.y }
          const symbolNormal = opening.swing_direction === 'outward' ? { x: -towardRoom.x, y: -towardRoom.y } : towardRoom
          const hingeAtEnd = opening.swing_direction === 'right'
          const hinge = hingeAtEnd ? { x: x2, y: y2 } : { x: x1, y: y1 }
          const closedTip = hingeAtEnd ? { x: x1, y: y1 } : { x: x2, y: y2 }
          const hingeTangent = { x: (closedTip.x - hinge.x) / length, y: (closedTip.y - hinge.y) / length }
          const leafEnd = { x: hinge.x + symbolNormal.x * length, y: hinge.y + symbolNormal.y * length }
          const arcSweep = hingeTangent.x * symbolNormal.y - hingeTangent.y * symbolNormal.x > 0 ? 1 : 0
          const form = opening.kind === 'door' && opening.opening_form && opening.opening_form !== 'unknown' ? opening.opening_form : opening.kind === 'door' ? 'hinged' : 'unknown'
          const foldDepth = Math.min(28, Math.max(12, length * 0.22))
          const foldPoints = Array.from({ length: 5 }, (_, index) => {
            const ratio = index / 4
            const depth = index === 0 || index === 4 ? 0 : index % 2 ? foldDepth : 4
            return `${x1 + tangent.x * length * ratio + symbolNormal.x * depth},${y1 + tangent.y * length * ratio + symbolNormal.y * depth}`
          }).join(' ')
          return <g key={opening.id} className={`opening-segment form-${form}${selected ? ' selected' : ''}`} data-opening-id={opening.id} data-wall-index={opening.wall_index} data-offset-mm={opening.offset_mm} data-width-mm={opening.width_mm} data-opening-form={form} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'opening', id: opening.id }) }}>
            <line className="opening-gap-part" x1={x1} y1={y1} x2={x2} y2={y2} />
            {opening.kind === 'window' ? <g className="opening-symbol window" pointerEvents="none">
              <line x1={x1 + towardRoom.x * 5} y1={y1 + towardRoom.y * 5} x2={x2 + towardRoom.x * 5} y2={y2 + towardRoom.y * 5} />
              <line x1={x1 + towardRoom.x * 11} y1={y1 + towardRoom.y * 11} x2={x2 + towardRoom.x * 11} y2={y2 + towardRoom.y * 11} />
            </g> : form === 'hinged' ? <g className="opening-symbol hinged" pointerEvents="none">
              <line className="door-leaf" x1={hinge.x} y1={hinge.y} x2={leafEnd.x} y2={leafEnd.y} />
              <path className="door-swing" d={`M ${closedTip.x} ${closedTip.y} A ${length} ${length} 0 0 ${arcSweep} ${leafEnd.x} ${leafEnd.y}`} />
            </g> : form === 'sliding' ? <g className="opening-symbol sliding" pointerEvents="none">
              <line className="door-rail" x1={x1 + symbolNormal.x * 5} y1={y1 + symbolNormal.y * 5} x2={x2 + symbolNormal.x * 5} y2={y2 + symbolNormal.y * 5} />
              <line className="door-panel" x1={x1 + symbolNormal.x * 11} y1={y1 + symbolNormal.y * 11} x2={mid.x + symbolNormal.x * 11} y2={mid.y + symbolNormal.y * 11} />
              <line className="door-panel" x1={mid.x + symbolNormal.x * 18} y1={mid.y + symbolNormal.y * 18} x2={x2 + symbolNormal.x * 18} y2={y2 + symbolNormal.y * 18} />
            </g> : form === 'folding' ? <g className="opening-symbol folding" pointerEvents="none">
              <polyline className="fold-panels" points={foldPoints} />
              {[1, 2, 3].map((index) => <circle key={`${opening.id}-fold-${index}`} cx={x1 + tangent.x * length * index / 4 + symbolNormal.x * (index % 2 ? foldDepth : 4)} cy={y1 + tangent.y * length * index / 4 + symbolNormal.y * (index % 2 ? foldDepth : 4)} r="2.2" />)}
            </g> : form === 'pocket' ? <g className="opening-symbol pocket" pointerEvents="none">
              <line className="pocket-track" x1={x1 + symbolNormal.x * 5} y1={y1 + symbolNormal.y * 5} x2={x2 + symbolNormal.x * 5} y2={y2 + symbolNormal.y * 5} />
              <line className="door-panel" x1={x1 + tangent.x * length * 0.48 + symbolNormal.x * 13} y1={y1 + tangent.y * length * 0.48 + symbolNormal.y * 13} x2={x2 + symbolNormal.x * 13} y2={y2 + symbolNormal.y * 13} />
            </g> : form === 'revolving' ? <g className="opening-symbol revolving" pointerEvents="none">
              <circle cx={mid.x} cy={mid.y} r={length * 0.42} />
              <line x1={mid.x - tangent.x * length * 0.42} y1={mid.y - tangent.y * length * 0.42} x2={mid.x + tangent.x * length * 0.42} y2={mid.y + tangent.y * length * 0.42} />
              <line x1={mid.x - symbolNormal.x * length * 0.42} y1={mid.y - symbolNormal.y * length * 0.42} x2={mid.x + symbolNormal.x * length * 0.42} y2={mid.y + symbolNormal.y * length * 0.42} />
            </g> : null}
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
          const topAppearance = fixtureTopAppearance(fixture.kind)
          if (!showFurniture && topAppearance !== 'utility-point') return null
          return (
            <g key={fixture.id} className={selected ? 'fixture-shape selected' : 'fixture-shape'} data-fixture-id={fixture.id} data-top-appearance={topAppearance} data-x-mm={fixture.x_mm} data-z-mm={fixture.z_mm} data-bound-wall-index={fixtureBoundWallIndex(spec, fixture) ?? ''} transform={`translate(${sx(fixture.x_mm)} ${sz(fixture.z_mm)}) rotate(${fixture.rotation_deg})`} onPointerDown={(event) => {
              event.preventDefault()
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
                const resolved = resolveFixtureDrag(spec, fixture.id, { x_mm: mmX(local.x), z_mm: mmZ(local.y) })
                if (resolved) target.setAttribute('transform', `translate(${sx(resolved.x_mm)} ${sz(resolved.z_mm)}) rotate(${resolved.rotation_deg})`)
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
              {fixture.model_asset && (showFurniture || topAppearance === 'utility-point')
                ? <rect className="fixture-model-hit" x={-width / 2} y={-depth / 2} width={width} height={depth} />
                : <FixtureTopSymbol appearance={topAppearance} width={width} depth={depth} pointShape={pointShape} pointSize={pointSize} />}
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
