import { Box, BoxSelect, FileSearch, Image as ImageIcon, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { studioApi } from './api'
import { EmptyWorkspace } from './components/EmptyWorkspace'
import { Header } from './components/Header'
import { DesignChat } from './components/DesignChat'
import { Inspector } from './components/Inspector'
import { ModelCanvas, type ModelCanvasHandle } from './components/ModelCanvas'
import { ModelAssetLibrary } from './components/ModelAssetLibrary'
import { MeasurementImportDialog } from './components/MeasurementImportDialog'
import { PlanReview } from './components/PlanReview'
import { PhotoAnnotation } from './components/PhotoAnnotation'
import { ProjectRail } from './components/ProjectRail'
import { SolutionList } from './components/SolutionList'
import { WorkflowStatus } from './components/WorkflowStatus'
import { metricBoundaryFromEdges } from './geometry'
import { applyEvidenceToSpec, deleteEvidenceFromSpec, measurementNumbers, wallTarget } from './measurementDraft'
import { fixtureModelAssetFromLibrary, type RoomModelAsset } from './modelAssets'
import { applyLayoutSolution, type LayoutSolution } from './layoutEngine'
import { surfaceMaterialsForDesignQuote } from './modelLibrary'
import { clientValidate, cloneSpec, finishedRoomBoundary, fixtureDefaults, fixtureLabels, fixturePointUsage, generateDryWetZones, manualRoom, nextOpeningLabel, projectPointToWall, repairPendingOpeningImageBindings, setOpeningOnWall, snapPointToNearestWall, syncOpeningBindings, syncToiletWithDrain, updateOpeningFromLine, wallLength, wetZoneBoundaryValid } from './spec'
import type { BoundaryEdge, DesignChatResponse, EvidenceRole, FixtureKind, FixturePointUsage, Health, ImageBoundaryPoint, MeasurementImportResponse, PlanLineKind, Point2D, Project, RoomSpec, Selection } from './types'

type WorkspaceMode = 'annotation' | 'review' | 'model' | 'library'

const wetZonesOnly = (spec: RoomSpec) => {
  const wetZones = spec.dry_wet_zones?.filter((zone) => zone.kind === 'wet') ?? []
  if (wetZones.length <= 1 && wetZones.length === (spec.dry_wet_zones?.length ?? 0)) return spec
  return { ...spec, dry_wet_zones: wetZones.length > 1 ? generateDryWetZones(spec) : wetZones }
}

const visibleSpec = (value: Project | null) => {
  const spec = value?.spec ?? null
  if (!spec) return null
  const normalized = cloneSpec(spec)
  repairPendingOpeningImageBindings(normalized)
  syncOpeningBindings(normalized)
  return wetZonesOnly(normalized)
}

const imagePointToRoom = (spec: RoomSpec, x: number, y: number) => {
  const imageBoundary = spec.plan_annotation?.boundary ?? []
  const roomBoundary = spec.boundary
  if (!imageBoundary.length || !roomBoundary.length) return { x_mm: 0, z_mm: 0 }
  const imageMinX = Math.min(...imageBoundary.map((point) => point.x))
  const imageMaxX = Math.max(...imageBoundary.map((point) => point.x))
  const imageMinY = Math.min(...imageBoundary.map((point) => point.y))
  const imageMaxY = Math.max(...imageBoundary.map((point) => point.y))
  const roomMinX = Math.min(...roomBoundary.map((point) => point.x_mm))
  const roomMaxX = Math.max(...roomBoundary.map((point) => point.x_mm))
  const roomMinZ = Math.min(...roomBoundary.map((point) => point.z_mm))
  const roomMaxZ = Math.max(...roomBoundary.map((point) => point.z_mm))
  return {
    x_mm: Math.round(roomMinX + (x - imageMinX) * (roomMaxX - roomMinX) / Math.max(1, imageMaxX - imageMinX)),
    z_mm: Math.round(roomMinZ + (y - imageMinY) * (roomMaxZ - roomMinZ) / Math.max(1, imageMaxY - imageMinY)),
  }
}

const imageRegion = (spec: RoomSpec, targetId: string, prefix: 'ceiling' | 'pipe_box') => {
  const match = targetId.match(new RegExp(`^${prefix}:(\\d+),(\\d+),(\\d+),(\\d+)$`))
  if (!match) return null
  const leftTop = imagePointToRoom(spec, Number(match[1]), Number(match[2]))
  const rightBottom = imagePointToRoom(spec, Number(match[3]), Number(match[4]))
  const minX = Math.min(leftTop.x_mm, rightBottom.x_mm)
  const maxX = Math.max(leftTop.x_mm, rightBottom.x_mm)
  const minZ = Math.min(leftTop.z_mm, rightBottom.z_mm)
  const maxZ = Math.max(leftTop.z_mm, rightBottom.z_mm)
  return {
    minX, maxX, minZ, maxZ,
    boundary: [
      { x_mm: minX, z_mm: minZ }, { x_mm: maxX, z_mm: minZ },
      { x_mm: maxX, z_mm: maxZ }, { x_mm: minX, z_mm: maxZ },
    ],
  }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [spec, setSpec] = useState<RoomSpec | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [mode, setMode] = useState<WorkspaceMode>('annotation')
  const [selection, setSelection] = useState<Selection>({ type: 'room' })
  const [history, setHistory] = useState<RoomSpec[]>([])
  const [future, setFuture] = useState<RoomSpec[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>('boot')
  const [message, setMessage] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [pendingExport, setPendingExport] = useState(false)
  const [planRotation, setPlanRotation] = useState<number | null>(null)
  const [focusEvidenceId, setFocusEvidenceId] = useState<string | null>(null)
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [measurementImportOpen, setMeasurementImportOpen] = useState(false)
  const [activeLayout, setActiveLayout] = useState<LayoutSolution | null>(null)
  const [designQuote, setDesignQuote] = useState<DesignChatResponse | null>(null)
  const modelRef = useRef<ModelCanvasHandle>(null)
  const projectRef = useRef<Project | null>(null)
  projectRef.current = project
  const quotedSurfaces = surfaceMaterialsForDesignQuote(designQuote)
  const layoutSurfaces = activeLayout?.surface_materials
  const appliedSurfaces = (quotedSurfaces.wall || quotedSurfaces.floor)
    ? { wall: quotedSurfaces.wall ?? layoutSurfaces?.wall, floor: quotedSurfaces.floor ?? layoutSurfaces?.floor }
    : layoutSurfaces

  const showMessage = useCallback((kind: 'error' | 'success' | 'info', text: string) => {
    setMessage({ kind, text })
    window.setTimeout(() => setMessage((current) => current?.text === text ? null : current), 5000)
  }, [])

  const handleDesignQuote = useCallback((quote: DesignChatResponse | null, notify = false) => {
    setDesignQuote(quote)
    if (!quote || !notify) return
    const surfaces = surfaceMaterialsForDesignQuote(quote)
    if (quote.requirements.complete && (surfaces.wall || surfaces.floor)) {
      showMessage('success', `需求方案材质已自动填充：${surfaces.wall?.label ?? '墙板待匹配'} · ${surfaces.floor?.label ?? '地砖待匹配'}`)
    }
  }, [showMessage])

  const refreshProjects = useCallback(async (preferredId?: string) => {
    const list = await studioApi.projects()
    setProjects(list)
    const next = list.find((item) => item.id === preferredId) ?? list[0] ?? null
    setProject(next)
    const nextSpec = visibleSpec(next)
    setSpec(nextSpec)
    setMode(nextSpec?.plan_annotation && !nextSpec.plan_annotation.confirmed ? 'annotation' : 'review')
    setHistory([]); setFuture([]); setDirty(false); setSelection({ type: 'room' })
    setFocusEvidenceId(null); setActiveEvidenceId(null)
    setActiveLayout(null); setDesignQuote(null)
  }, [])

  useEffect(() => {
    Promise.all([studioApi.health(), studioApi.projects()]).then(([healthResult, projectList]) => {
      setHealth(healthResult)
      setProjects(projectList)
      const first = projectList[0] ?? null
      const firstSpec = visibleSpec(first)
      setProject(first); setSpec(firstSpec); setMode(firstSpec?.plan_annotation && !firstSpec.plan_annotation.confirmed ? 'annotation' : 'review')
    }).catch((error: Error) => showMessage('error', `无法连接后端：${error.message}`)).finally(() => setBusy(null))
  }, [showMessage])

  useEffect(() => {
    if (!project || project.status !== 'analysis_running') return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const refreshed = await studioApi.project(project.id)
        if (stopped) return
        setProject(refreshed)
        setProjects((items) => items.map((item) => item.id === refreshed.id ? refreshed : item))
        if (refreshed.status === 'analysis_running') {
          timer = window.setTimeout(() => void poll(), 3000)
          return
        }
        setSpec(visibleSpec(refreshed))
        setHistory([]); setFuture([]); setDirty(false)
        setFocusEvidenceId(null); setActiveEvidenceId(null)
        if (refreshed.spec) {
          const errors = refreshed.spec.issues.filter((issue) => issue.severity === 'error')
          showMessage(errors.length ? 'info' : 'success', errors.length ? `解析完成，请逐项校正：${errors[0].message}` : '测量图解析完成，请核对尺寸')
        }
      } catch {
        if (!stopped) timer = window.setTimeout(() => void poll(), 5000)
      }
    }
    timer = window.setTimeout(() => void poll(), 3000)
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [project?.id, project?.status, showMessage])

  const selectProject = async (id: string) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定切换项目吗？')) return
    setBusy('project')
    try {
      const next = await studioApi.project(id)
      const nextSpec = visibleSpec(next)
      setProject(next); setSpec(nextSpec); setHistory([]); setFuture([]); setDirty(false); setMode(nextSpec?.plan_annotation && !nextSpec.plan_annotation.confirmed ? 'annotation' : 'review'); setSelection({ type: 'room' })
      setFocusEvidenceId(null); setActiveEvidenceId(null)
      setPlanRotation(null)
      setActiveLayout(null); setDesignQuote(null)
    } catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const createProject = async (name: string) => {
    setBusy('project')
    try {
      const created = await studioApi.createProject(name)
      await refreshProjects(created.id)
      showMessage('success', '项目已创建')
    } catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const deleteProject = async () => {
    if (!project || !window.confirm(`删除“${project.name}”及其上传图片？此操作不可恢复。`)) return
    setBusy('project')
    try { await studioApi.deleteProject(project.id); await refreshProjects(); showMessage('success', '项目已删除') }
    catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const upload = async (role: 'floorplan' | 'photo', files: File[]) => {
    if (!project) return
    setBusy('upload')
    try {
      for (const file of files) await studioApi.upload(project.id, role, file)
      const refreshed = await studioApi.project(project.id)
      setProject(refreshed); setProjects((items) => items.map((item) => item.id === refreshed.id ? refreshed : item))
      if (role === 'floorplan') {
        setSpec(visibleSpec(refreshed)); setHistory([]); setFuture([]); setDirty(false); setMode('annotation')
        setPlanRotation(null); setFocusEvidenceId(null); setActiveEvidenceId(null)
      }
      showMessage('success', `${files.length} 张图片已上传`)
    } catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const applyMeasurementImport = (result: MeasurementImportResponse) => {
    const imported = result.project
    const nextSpec = visibleSpec(imported)
    setProject(imported)
    setProjects((items) => items.map((item) => item.id === imported.id ? imported : item))
    setSpec(nextSpec); setHistory([]); setFuture([]); setDirty(false); setMode('review'); setSelection({ type: 'room' })
    setFocusEvidenceId(null); setActiveEvidenceId(null); setPlanRotation(null)
    const warningSuffix = result.warnings.length ? `，有 ${result.warnings.length} 项需要复核` : ''
    showMessage('success', `${result.source_format.toUpperCase()} 已按 ${result.source_unit} 导入${warningSuffix}`)
  }

  const applyAnalysis = (result: Awaited<ReturnType<typeof studioApi.analyzePlan>>) => {
    const next = cloneSpec(result.spec)
    syncOpeningBindings(next)
    const visible = wetZonesOnly(next)
    setHistory(spec ? [cloneSpec(spec)] : []); setFuture([]); setSpec(visible); setDirty(true); setMode(visible.plan_annotation?.confirmed ? 'review' : 'annotation'); setSelection({ type: 'room' })
    setFocusEvidenceId(null); setActiveEvidenceId(null)
  }

  const analyzePlan = async () => {
    if (!project) return
    const requestProjectId = project.id
    const requestPlanId = project.assets.filter((asset) => asset.role === 'floorplan').at(-1)?.id
    setBusy('plan')
    try {
      const result = await studioApi.analyzePlan(requestProjectId, planRotation)
      const active = projectRef.current
      const activePlanId = active?.assets.filter((asset) => asset.role === 'floorplan').at(-1)?.id
      if (active?.id !== requestProjectId || activePlanId !== requestPlanId) return
      applyAnalysis(result)
      const heightMissing = result.missing.includes('房间净高')
      const unresolved = result.missing.filter((item) => item !== '房间净高')
      const firstError = result.spec.issues.find((issue) => issue.severity === 'error')
      showMessage(
        result.sufficient ? 'success' : 'info',
        result.sufficient
          ? '视觉模型已生成照片标注草稿，请先在原图上校正'
          : unresolved.length
            ? `照片标注仍有未绑定项：${unresolved.join('、')}${heightMissing ? '；二维可继续校正，进入三维前请补录净高' : ''}`
            : heightMissing
              ? '二维数据可继续编辑；缺少有效净高，进入三维前请补录'
              : `二维数据已生成，请继续校正：${firstError?.message ?? '存在未完成项'}`,
      )
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      showMessage(timedOut ? 'info' : 'error', timedOut ? error.message : `本次识别失败，上一轮结果已保留：${(error as Error).message}`)
    }
    finally { setBusy(null) }
  }

  const analyzePhotos = async () => {
    if (!project) return
    setBusy('photos')
    try {
      const result = await studioApi.analyzePhotos(project.id)
      applyAnalysis(result); showMessage('success', '现场照片识别草稿已生成；保存后才会替换当前结果')
    } catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const commitSpec = (next: RoomSpec) => {
    if (!spec) return
    const pendingAnnotationTopology = !!next.plan_annotation && !next.plan_annotation.confirmed && next.plan_annotation.boundary.length !== next.boundary.length
    if (!pendingAnnotationTopology) syncOpeningBindings(next, spec)
    next.issues = clientValidate(next)
    setHistory((items) => [...items.slice(-39), cloneSpec(spec)])
    setFuture([]); setSpec(next); setDirty(true)
    setProject((current) => current ? { ...current, spec: next } : current)
  }

  const applyEvidence = (id: string, value: string, role: EvidenceRole, targetId: string | null = null, ignored = false) => {
    if (!spec) return
    const next = applyEvidenceToSpec(spec, id, value, role, targetId, ignored)
    const observation = next.observations.find((item) => item.field === `ocr:${id}`)
    if (!observation) return
    if (!ignored) {
      const numbers = measurementNumbers(value)
      if (role === 'wall_thickness' && numbers[0] && targetId?.startsWith('wall:')) {
        const wallIndex = Number(targetId.slice(5).split('@')[0])
        if (Number.isInteger(wallIndex) && wallIndex >= 0 && wallIndex < next.boundary.length) {
          const profiles = next.wall_profiles ?? (next.wall_profiles = [])
          const profile = profiles.find((item) => item.wall_index === wallIndex)
          if (profile) { profile.thickness_mm = numbers[0]; profile.source = 'user'; profile.confidence = 1; profile.evidence_ids = [...new Set([...(profile.evidence_ids ?? []), id])] }
          else profiles.push({ wall_index: wallIndex, kind: 'interior', thickness_mm: numbers[0], source: 'user', confidence: 1, evidence_ids: [id] })
        }
      }
      if (role === 'door_position' && numbers[0]) {
        const door = next.openings.find((item) => item.kind === 'door')
        if (door) door.offset_mm = numbers[0]
      }
      if (role === 'drain_position' && targetId?.startsWith('drain:')) {
        const relatedEvidence = next.observations.filter((item) => item.target_id === targetId).map((item) => item.field.replace(/^ocr:/, ''))
        const fixture = next.fixtures.find((item) => item.evidence_ids?.some((evidenceId) => relatedEvidence.includes(evidenceId)))
        const bbox = observation.bbox
        const position = bbox ? imagePointToRoom(next, (bbox.x_min + bbox.x_max) / 2, (bbox.y_min + bbox.y_max) / 2) : { x_mm: numbers[0] ?? 0, z_mm: numbers[1] ?? 0 }
        if (fixture) { fixture.x_mm = position.x_mm; fixture.z_mm = position.z_mm; fixture.label = value; fixture.source = 'user'; fixture.confidence = 1; fixture.evidence_ids = [...new Set([...(fixture.evidence_ids ?? []), id])] }
        else next.fixtures.push({ id: `drain-${crypto.randomUUID().slice(0, 8)}`, kind: 'floor_drain', label: value || '排水点', x_mm: position.x_mm, z_mm: position.z_mm, width_mm: 75, depth_mm: 75, height_mm: 20, rotation_deg: 0, source: 'user', confidence: 1, evidence_ids: [id] })
      }
      if (role === 'pipe_box' && targetId) {
        const region = imageRegion(next, targetId, 'pipe_box')
        if (region) {
          const width = numbers.find((item) => item >= 80 && item <= 3000) ?? Math.max(80, region.maxX - region.minX)
          const depth = numbers.find((item) => item >= 80 && item <= 3000 && item !== width) ?? Math.max(80, region.maxZ - region.minZ)
          next.fixtures.push({ id: `pipe-box-${crypto.randomUUID().slice(0, 8)}`, kind: 'column', label: value || '包管', x_mm: Math.round((region.minX + region.maxX) / 2), z_mm: Math.round((region.minZ + region.maxZ) / 2), width_mm: width, depth_mm: depth, height_mm: next.height_mm ?? 2400, rotation_deg: 0, source: 'user', confidence: 1, evidence_ids: [id] })
        }
      }
      if (role === 'ceiling_height' && numbers[0] && targetId) {
        const region = imageRegion(next, targetId, 'ceiling')
        if (region) {
          const zones = next.ceiling_zones ?? (next.ceiling_zones = [])
          zones.push({ id: `ceiling-${crypto.randomUUID().slice(0, 8)}`, label: value, boundary: region.boundary, height_mm: numbers[0], source: 'user', confidence: 1, evidence_ids: [id] })
        }
      }
      if (role === 'fixture_dimension' && numbers.length >= 2) {
        const fixture = next.fixtures.find((item) => item.evidence_ids?.includes(id)) ?? next.fixtures[0]
        if (fixture) { fixture.width_mm = numbers[0]; fixture.depth_mm = numbers[1]; fixture.source = 'user'; fixture.confidence = 1 }
      }
      if (role === 'fixture_label') {
        const fixture = next.fixtures.find((item) => item.evidence_ids?.includes(id))
        if (fixture) fixture.label = value
      }
    }
    commitSpec(next)
    setFocusEvidenceId(null)
  }

  const deleteEvidence = (id: string) => {
    if (!spec) return
    commitSpec(deleteEvidenceFromSpec(spec, id))
    setFocusEvidenceId(null)
  }

  const updateEvidenceDraft = (id: string, role: EvidenceRole, targetId: string | null) => {
    if (!spec) return
    const next = cloneSpec(spec)
    const observation = next.observations.find((item) => item.field === `ocr:${id}`)
    if (!observation) return
    observation.semantic_role = role
    observation.target_id = targetId
    observation.review_required = role !== 'other'
    commitSpec(next)
  }

  const confirmAnnotation = (points: ImageBoundaryPoint[], edgeChain: BoundaryEdge[]) => {
    if (!spec || points.length < 3) return
    const closure = metricBoundaryFromEdges(edgeChain)
    if (!closure || closure.boundary.length !== points.length) {
      showMessage('error', '尺寸链无法唯一闭合，或同一方向测量误差超过允许范围，请核对对应毫米数')
      return
    }
    const next = cloneSpec(spec)
    next.boundary = closure.boundary
    next.plan_annotation = {
      rotation_degrees: next.plan_annotation?.rotation_degrees ?? 0,
      boundary: points,
      edge_chain: closure.edges,
      confirmed: true,
    }
    next.openings.forEach((opening) => {
      const evidence = next.observations.find((item) => opening.evidence_ids?.includes(item.field.replace(/^ocr:/, '')) && item.target_id?.startsWith('wall:'))
      const target = opening.source === 'user' || !evidence?.target_id ? null : wallTarget(evidence.target_id)
      let wallIndex = Math.max(0, Math.min(next.boundary.length - 1, opening.wall_index))
      let offset = opening.offset_mm
      if (target && target.wallIndex >= 0 && target.wallIndex < next.boundary.length) {
        wallIndex = target.wallIndex
        const length = wallLength(next.boundary, wallIndex)
        const ratio = target.startRatio ?? 0.5
        offset = target.endRatio === null
          ? Math.max(0, Math.round(ratio * length - opening.width_mm / 2))
          : Math.max(0, Math.round(Math.min(ratio, target.endRatio) * length))
      }
      setOpeningOnWall(next, opening, wallIndex, offset, opening.width_mm)
    })
    syncOpeningBindings(next, spec)
    commitSpec(next)
    setMode('review')
    showMessage('success', '照片标注已确认，已按确认轮廓生成二维图')
  }

  const undo = () => {
    const previous = history.at(-1)
    if (!previous || !spec) return
    setFuture((items) => [cloneSpec(spec), ...items]); setHistory((items) => items.slice(0, -1)); setSpec(previous); setDirty(true)
  }

  const redo = () => {
    const next = future[0]
    if (!next || !spec) return
    setHistory((items) => [...items, cloneSpec(spec)]); setFuture((items) => items.slice(1)); setSpec(next); setDirty(true)
  }

  const save = async (override?: RoomSpec) => {
    const value = override ?? spec
    if (!project || !value) return
    setBusy('save')
    try {
      const saved = await studioApi.saveSpec(project.id, value)
      setProject(saved); setSpec(saved.spec); setProjects((items) => items.map((item) => item.id === saved.id ? saved : item)); setDirty(false)
      showMessage('success', '项目已保存')
    } catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const confirm = async () => {
    if (!spec) return
    if (clientValidate(spec).some((issue) => issue.severity === 'error')) {
      showMessage('error', '轮廓校验未通过，不能进入建模')
      return
    }
    const next = cloneSpec(spec); next.confirmed = true
    setSpec(next); setMode('model'); await save(next)
  }

  const exportModel = () => {
    if (!spec) return
    if (clientValidate(spec).some((issue) => issue.severity === 'error')) {
      showMessage('error', '轮廓校验未通过，不能生成或导出模型')
      return
    }
    if (mode !== 'model') { setPendingExport(true); setMode('model'); return }
    void modelRef.current?.exportGLB(`${project?.name ?? 'bathroom-model'}.glb`).catch((error: Error) => showMessage('error', error.message))
  }

  const exportMeasurement = () => {
    if (!project?.measurement || dirty) return
    const anchor = document.createElement('a')
    anchor.href = studioApi.measurementDownloadUrl(project.id)
    anchor.download = `${project.name}-measurement.json`
    anchor.click()
    showMessage('success', '量房 JSON 已导出')
  }

  const addModelAssetToRoom = (asset: RoomModelAsset) => {
    if (!spec) return
    const center = finishedRoomBoundary(spec).length ? projectPointToWall(finishedRoomBoundary(spec), 0, { x_mm: 700, z_mm: 305 })?.point : null
    const isToilet = !!asset.tags?.includes('toilet') || /toilet|马桶|坐便/i.test(asset.label)
    const id = `${isToilet ? 'toilet' : 'model'}-${crypto.randomUUID().slice(0, 8)}`
    const next = cloneSpec(spec)
    const dimensions = asset.dimensions_mm
    next.fixtures.push({
      id,
      kind: isToilet ? 'toilet' : 'other',
      label: asset.label.replace(/\s+(GLB|GLTF|FBX|3DS|OBJ)$/i, ''),
      x_mm: center?.x_mm ?? 700,
      z_mm: center?.z_mm ?? 305,
      width_mm: dimensions.width,
      depth_mm: dimensions.depth,
      height_mm: dimensions.height,
      rotation_deg: 0,
      source: 'user',
      confidence: 1,
      bound_wall_index: center ? 0 : null,
      model_asset: fixtureModelAssetFromLibrary(asset),
    })
    commitSpec(next)
    setSelection({ type: 'fixture', id })
    setMode('model')
    showMessage('success', `${asset.label} 已加入房间`)
  }

  const applyAutoLayout = (solution: LayoutSolution) => {
    if (!spec) return
    const next = applyLayoutSolution(cloneSpec(spec), solution)
    commitSpec(next)
    setActiveLayout(solution)
    setSelection({ type: 'room' })
    setMode('model')
    showMessage('success', `已在三维房间显示“${solution.title}”，${solution.fixtures.length} 个实体按量房坐标和真实高度落地`)
  }

  useEffect(() => {
    if (!pendingExport || mode !== 'model') return
    const timer = window.setTimeout(() => {
      void modelRef.current?.exportGLB(`${project?.name ?? 'bathroom-model'}.glb`).then(() => showMessage('success', 'GLB 已导出')).catch((error: Error) => showMessage('error', error.message))
      setPendingExport(false)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [mode, pendingExport, project?.name, showMessage])

  const annotationConfirmed = !!spec && (!spec.plan_annotation || spec.plan_annotation.confirmed)
  const validationHasErrors = !!spec && clientValidate(spec).some((issue) => issue.severity === 'error')
  const canConfirm = annotationConfirmed && !!spec && !validationHasErrors
  const canPreview = annotationConfirmed && !!spec && !validationHasErrors
  const canModel = canConfirm && !!spec?.confirmed
  const canExportMeasurement = !!project?.measurement && project.status !== 'analysis_failed' && !dirty
  const plan = project?.assets.filter((asset) => asset.role === 'floorplan').at(-1)

  return (
    <div className="app-shell">
      <Header projectName={project?.name} dirty={dirty} canUndo={history.length > 0} canRedo={future.length > 0} canConfirm={canConfirm} canModel={canModel} canExportMeasurement={canExportMeasurement} saving={busy === 'save'} onUndo={undo} onRedo={redo} onSave={() => void save()} onConfirm={() => void confirm()} onExportMeasurement={exportMeasurement} onExport={exportModel} onOpenLibrary={() => setMode('library')} onOpenChat={() => setChatOpen(true)} />
      <DesignChat open={chatOpen} projectId={project?.id ?? null} room={spec} onClose={() => setChatOpen(false)} onQuote={handleDesignQuote} />
      <MeasurementImportDialog open={measurementImportOpen} projectId={project?.id ?? null} hasMeasurement={!!project?.measurement} onClose={() => setMeasurementImportOpen(false)} onImported={applyMeasurementImport} />
      <ProjectRail projects={projects} project={project} health={health} busy={busy} planRotation={planRotation} onPlanRotationChange={setPlanRotation} onSelectProject={(id) => void selectProject(id)} onCreateProject={createProject} onDeleteProject={() => void deleteProject()} onUpload={upload} onOpenMeasurementImport={() => setMeasurementImportOpen(true)} onAnalyzePlan={() => void analyzePlan()} onAnalyzePhotos={() => void analyzePhotos()} />
      <main className="workspace">
        <WorkflowStatus project={project} spec={spec} busy={busy} dirty={dirty} />
        {busy === 'boot' ? <div className="loading-screen"><LoaderCircle className="spin" size={28} /><span>正在打开工作台</span></div> : !project ? (
          <div className="no-project"><Box size={36} strokeWidth={1.2} /><h1>先创建一个项目</h1><p>项目会在本机保存测量图、现场照片和模型参数。</p></div>
        ) : !spec ? (
          <EmptyWorkspace hasPlan={!!plan} analysisFailed={project.status === 'analysis_failed'} canAnalyze={!!(health?.ocr_configured || health?.ai_configured) && !busy && project.status !== 'analysis_running'} onAnalyze={() => void analyzePlan()} onManual={(width, depth, height) => { const next = manualRoom(width, depth, height); setSpec(next); setProject((current) => current ? { ...current, spec: next } : current); setDirty(true) }} />
        ) : (
          <>
            <div className="view-tabs" role="tablist">
              <button className={mode === 'annotation' ? 'active' : ''} onClick={() => setMode('annotation')}><ImageIcon size={16} />照片标注</button>
              <button className={mode === 'review' ? 'active' : ''} onClick={() => annotationConfirmed && setMode('review')} disabled={!annotationConfirmed}><FileSearch size={16} />二维审图</button>
              <button className={mode === 'library' ? 'active' : ''} onClick={() => setMode('library')}><Box size={16} />模型库</button>
              <button className={mode === 'model' ? 'active' : ''} onClick={() => canPreview && setMode('model')} disabled={!canPreview}><BoxSelect size={16} />三维预览</button>
            </div>
            {mode === 'review' && <SolutionList spec={spec} active={false} onOpenModel={() => canPreview && setMode('model')} onApplyLayout={applyAutoLayout} preference={{ style: designQuote?.style_match.catalog_style }} />}
            {mode === 'annotation'
              ? <PhotoAnnotation key={`${project.id}:${plan?.id ?? 'none'}:${project.updated_at}`} spec={spec} plan={plan} activeEvidenceId={activeEvidenceId} onChange={commitSpec} onEvidenceSelect={setFocusEvidenceId} onConfirm={confirmAnnotation} />
              : mode === 'library'
                ? <ModelAssetLibrary projectId={project.id} canAddToRoom={!!spec && canPreview} usedAssetIds={spec.fixtures.flatMap((fixture) => fixture.model_asset?.id ? [fixture.model_asset.id] : [])} onAddToRoom={addModelAssetToRoom} onOpenRoom={() => canPreview && setMode('model')} />
              : mode === 'review' || !canPreview
                ? <PlanReview
                  key={`${project.id}:${plan?.id ?? 'none'}:${project.updated_at}`}
                  spec={spec}
                  plan={plan}
                  selection={selection}
                  onSelect={setSelection}
                  onOpeningAdd={(start, end) => {
                    const next = cloneSpec(spec)
                    const id = `door-${crypto.randomUUID().slice(0, 8)}`
                    const opening = { id, kind: 'door' as const, wall_index: 0, offset_mm: 0, width_mm: Math.max(1, Math.round(Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm))), height_mm: 2100, sill_mm: 0, label: nextOpeningLabel(next), opening_form: 'hinged' as const, swing_direction: 'unknown' as const, source: 'user' as const, confidence: 1 }
                    next.openings.push(opening)
                    updateOpeningFromLine(next, opening, { start, end })
                    commitSpec(next)
                    setSelection({ type: 'opening', id })
                  }}
                  onOpeningChange={(id, start, end) => {
                    const next = cloneSpec(spec)
                    const opening = next.openings.find((item) => item.id === id)
                    if (!opening) return
                    updateOpeningFromLine(next, opening, { start, end }, opening.wall_index)
                    opening.source = 'user'; opening.confidence = 1
                    commitSpec(next)
                  }}
                  onOpeningDelete={(id) => {
                    const next = cloneSpec(spec)
                    next.openings = next.openings.filter((item) => item.id !== id)
                    commitSpec(next)
                    setSelection({ type: 'room' })
                  }}
                  onEvidenceSelect={setFocusEvidenceId}
                  onFixtureAdd={(kind: FixtureKind, xMm, zMm, wallIndex, pointUsage?: FixturePointUsage) => {
                    const next = cloneSpec(spec)
                    const defaults = fixtureDefaults[kind]
                    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
                    const projected = wallIndex === null ? null : projectPointToWall(finishedRoomBoundary(next), wallIndex, { x_mm: xMm, z_mm: zMm })
                    if (kind === 'floor_drain' && pointUsage === 'shower') next.fixtures.forEach((fixture) => { if (fixture.kind === 'floor_drain') { fixture.point_usage = 'general'; if (fixture.label === '淋浴地漏') fixture.label = '地漏' } })
                    next.fixtures.push({ id, kind, label: kind === 'floor_drain' && pointUsage === 'shower' ? '淋浴地漏' : kind === 'drain' && pointUsage === 'toilet' ? '马桶排水' : fixtureLabels[kind], x_mm: projected?.point.x_mm ?? xMm, z_mm: projected?.point.z_mm ?? zMm, ...defaults, width_mm: kind === 'drain' && pointUsage === 'toilet' ? 110 : defaults.width_mm, depth_mm: kind === 'drain' && pointUsage === 'toilet' ? 110 : defaults.depth_mm, rotation_deg: 0, source: 'user', confidence: 1, bound_wall_index: projected ? wallIndex : null, point_usage: kind === 'floor_drain' || kind === 'drain' || kind === 'water' ? pointUsage ?? 'general' : undefined })
                    if (kind === 'floor_drain' && pointUsage === 'shower') next.dry_wet_zones = generateDryWetZones(next)
                    if (kind === 'drain' && pointUsage === 'toilet') syncToiletWithDrain(next, id)
                    commitSpec(next)
                    setSelection({ type: 'fixture', id: kind === 'drain' && pointUsage === 'toilet' ? `toilet-for-${id}` : id })
                  }}
                  onFixtureMove={(id, x, z) => {
                    const next = cloneSpec(spec)
                    const fixture = next.fixtures.find((item) => item.id === id)
                    if (fixture) {
                      const snap = snapPointToNearestWall(finishedRoomBoundary(next), { x_mm: x, z_mm: z })
                      fixture.x_mm = snap?.point.x_mm ?? x; fixture.z_mm = snap?.point.z_mm ?? z
                      fixture.bound_wall_index = snap?.wall_index ?? null
                      fixture.source = 'user'; fixture.confidence = 1
                      if (fixture.kind === 'floor_drain' && fixturePointUsage(fixture) === 'shower') next.dry_wet_zones = generateDryWetZones(next)
                      if (fixture.kind === 'drain' && fixturePointUsage(fixture) === 'toilet') syncToiletWithDrain(next, fixture.id)
                      commitSpec(next)
                    }
                  }}
                  onPlanLineAdd={(kind: PlanLineKind, points: Point2D[]) => {
                    const next = cloneSpec(spec)
                    const labels: Record<PlanLineKind, string> = { pipe_chase: '包管线', inner_wall: '内墙线', door_line: '门线' }
                    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
                    ;(next.plan_lines ??= []).push({ id, kind, label: labels[kind], points, source: 'user', confidence: 1 })
                    commitSpec(next)
                    return id
                  }}
                  onPlanLineExtend={(id, point) => {
                    const next = cloneSpec(spec)
                    const line = next.plan_lines?.find((item) => item.id === id)
                    if (!line) return
                    line.points.push(point)
                    line.source = 'user'; line.confidence = 1
                    commitSpec(next)
                  }}
                  onZoneChange={(id, boundary) => {
                    const next = cloneSpec(spec)
                    const zone = next.dry_wet_zones?.find((item) => item.id === id)
                    if (zone && wetZoneBoundaryValid(next, id, boundary)) { zone.boundary = boundary; zone.source = 'user'; zone.confidence = 1; commitSpec(next) }
                  }}
                />
                : <ModelCanvas ref={modelRef} spec={spec} selection={selection} onSelect={setSelection} layoutInfo={activeLayout ? { title: activeLayout.title, summary: activeLayout.layout_summary, totalPrice: activeLayout.total_price, products: [...activeLayout.product_lines.map((line) => `${line.code} ¥${line.price}`), ...activeLayout.material_lines.map((line) => `${line.code} ${line.quantity}㎡ ¥${line.subtotal}`)].join(' · ') } : null} surfaceMaterials={appliedSurfaces ? { wall: appliedSurfaces.wall?.texture_src ? { textureSrc: appliedSurfaces.wall.texture_src, widthMm: appliedSurfaces.wall.dimensions_mm.width, heightMm: appliedSurfaces.wall.dimensions_mm.height } : undefined, floor: appliedSurfaces.floor?.texture_src ? { textureSrc: appliedSurfaces.floor.texture_src, widthMm: appliedSurfaces.floor.dimensions_mm.width, depthMm: appliedSurfaces.floor.dimensions_mm.depth } : undefined } : undefined} />}
          </>
        )}
      </main>
      {spec && <Inspector key={`${project?.id ?? 'none'}:${plan?.id ?? 'none'}:${project?.updated_at ?? ''}`} spec={spec} assets={project?.assets ?? []} selection={selection} onSelect={setSelection} onChange={commitSpec} onEvidenceApply={applyEvidence} onEvidenceDelete={deleteEvidence} onEvidenceDraftChange={updateEvidenceDraft} focusEvidenceId={focusEvidenceId} onEvidenceActive={setActiveEvidenceId} annotationMode={mode === 'annotation'} />}
      {message && <div className={`toast ${message.kind}`} role="status"><span>{message.text}</span><button className="icon-button" onClick={() => setMessage(null)} title="关闭"><X size={15} /></button></div>}
    </div>
  )
}
