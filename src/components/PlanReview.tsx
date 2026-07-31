import { Droplet, Focus, Move, Plug, Square, Waves, ZoomIn, ZoomOut } from 'lucide-react'
import { useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { finishedRoomBoundary, fixtureBoundWallIndex, fixtureDefaults, fixtureLabels, fixturePointShape, roomBounds, snapPointToNearestWall, wallLayerPolygons, wallLength, wetZoneBoundaryValid } from '../spec'
import type { Asset, FixtureKind, FixturePointUsage, Point2D, RoomSpec, Selection } from '../types'

const canvasWidth = 920
const canvasHeight = 680
const pad = 92

export function PlanReview({ spec, plan, selection, onSelect, onFixtureMove, onFixtureAdd, onZoneChange, onEvidenceSelect }: {
  spec: RoomSpec
  plan?: Asset
  selection: Selection
  onSelect: (selection: Selection) => void
  onFixtureMove: (id: string, xMm: number, zMm: number) => void
  onFixtureAdd?: (kind: FixtureKind, xMm: number, zMm: number, wallIndex: number | null, pointUsage?: FixturePointUsage) => void
  onZoneChange?: (id: string, boundary: Point2D[]) => void
  onEvidenceSelect?: (id: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const [addFixture, setAddFixture] = useState<{ kind: FixtureKind; pointUsage?: FixturePointUsage } | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panSession = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const suppressCanvasClick = useRef(false)
  const [zoneDraft, setZoneDraft] = useState<{ id: string; boundary: Point2D[] } | null>(null)
  const zoneSession = useRef<{ pointerId: number; id: string; start: Point2D; original: Point2D[]; vertex: number | null; draft: Point2D[] } | null>(null)
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
  const svgPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    return point.matrixTransform(svg.getScreenCTM()!.inverse())
  }
  const roomPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const point = svgPoint(svg, clientX, clientY)
    return { x_mm: mmX((point.x - pan.x) / zoom), z_mm: mmZ((point.y - pan.y) / zoom) }
  }
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

  return (
    <div className="plan-review">
      <div className="canvas-toolbar">
        <span><Move size={15} />拖动空白处平移，滚轮缩放</span>
        <div>
          <button className={`icon-button${addFixture?.kind === 'drain' ? ' active-tool' : ''}`} title="添加排水点" onClick={() => setAddFixture((value) => value?.kind === 'drain' ? null : { kind: 'drain', pointUsage: 'general' })}><Droplet size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'water' ? ' active-tool' : ''}`} title="添加给水点" onClick={() => setAddFixture((value) => value?.kind === 'water' ? null : { kind: 'water', pointUsage: 'general' })}><Waves size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'floor_drain' ? ' active-tool' : ''}`} title="添加淋浴地漏" onClick={() => setAddFixture((value) => value?.kind === 'floor_drain' ? null : { kind: 'floor_drain', pointUsage: 'shower' })}><Square size={17} /></button>
          <button className={`icon-button${addFixture?.kind === 'electric' ? ' active-tool' : ''}`} title="添加电点" onClick={() => setAddFixture((value) => value?.kind === 'electric' ? null : { kind: 'electric' })}><Plug size={17} /></button>
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
          if (addFixtureAtEvent(event)) { event.stopPropagation(); event.preventDefault() }
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
          const targetIsPanSurface = event.target === event.currentTarget || (event.target instanceof SVGElement && event.target.dataset.panSurface === 'true')
          if (event.button !== 0 || !targetIsPanSurface) return
          const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
          panSession.current = { pointerId: event.pointerId, x: point.x, y: point.y, panX: pan.x, panY: pan.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
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
          const session = panSession.current
          if (!session || session.pointerId !== event.pointerId) return
          const point = svgPoint(event.currentTarget, event.clientX, event.clientY)
          setPan({ x: session.panX + point.x - session.x, y: session.panY + point.y - session.y })
        }}
        onPointerUp={(event) => {
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
          if (panSession.current?.pointerId !== event.pointerId) return
          panSession.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={(event) => {
          if (zoneSession.current?.pointerId === event.pointerId) {
            zoneSession.current = null
            setZoneDraft(null)
          }
          if (panSession.current?.pointerId === event.pointerId) panSession.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      >
        <defs>
          <pattern id="minor-grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" stroke="#d9dcd5" strokeWidth="0.7" /></pattern>
          <pattern id="major-grid" width="90" height="90" patternUnits="userSpaceOnUse"><rect width="90" height="90" fill="url(#minor-grid)" /><path d="M 90 0 L 0 0 0 90" fill="none" stroke="#c4c8bf" strokeWidth="1" /></pattern>
        </defs>
        <rect width={canvasWidth} height={canvasHeight} fill="url(#major-grid)" data-pan-surface="true" />
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {wallBodies.map((body, index) => <g key={`wall-body-${index}`} pointerEvents="none">
          <polygon points={body.finish.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} className="wall-finish-body" />
          <polygon points={body.wall.map((point) => `${sx(point.x_mm)},${sz(point.z_mm)}`).join(' ')} className="wall-body" />
        </g>)}
        <polygon points={points} className={selection.type === 'room' ? 'room-polygon selected' : 'room-polygon'} onClick={(event) => { event.stopPropagation(); onSelect({ type: 'room' }) }} />
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
