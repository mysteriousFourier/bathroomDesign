import { Box, BoxSelect, FileSearch, Image as ImageIcon, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { studioApi } from './api'
import { EmptyWorkspace } from './components/EmptyWorkspace'
import { Header } from './components/Header'
import { Inspector } from './components/Inspector'
import { ModelCanvas, type ModelCanvasHandle } from './components/ModelCanvas'
import { PlanReview } from './components/PlanReview'
import { PhotoAnnotation } from './components/PhotoAnnotation'
import { ProjectRail } from './components/ProjectRail'
import { SolutionList } from './components/SolutionList'
import { WorkflowStatus } from './components/WorkflowStatus'
import { clientValidate, cloneSpec, manualRoom } from './spec'
import type { EvidenceRole, Health, ImageBoundaryPoint, Project, RoomSpec, Selection } from './types'

type WorkspaceMode = 'annotation' | 'review' | 'model'

const visibleSpec = (value: Project | null) => value?.status === 'analysis_failed' ? null : value?.spec ?? null

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

const wallTarget = (targetId: string | null) => {
  const match = targetId?.match(/^wall:(\d+)(?:@(0(?:\.\d+)?|1(?:\.0+)?)(?::(0(?:\.\d+)?|1(?:\.0+)?))?)?$/)
  if (!match) return null
  return { wallIndex: Number(match[1]), startRatio: match[2] === undefined ? null : Number(match[2]), endRatio: match[3] === undefined ? null : Number(match[3]) }
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
  const modelRef = useRef<ModelCanvasHandle>(null)

  const showMessage = useCallback((kind: 'error' | 'success' | 'info', text: string) => {
    setMessage({ kind, text })
    window.setTimeout(() => setMessage((current) => current?.text === text ? null : current), 5000)
  }, [])

  const refreshProjects = useCallback(async (preferredId?: string) => {
    const list = await studioApi.projects()
    setProjects(list)
    const next = list.find((item) => item.id === preferredId) ?? list[0] ?? null
    setProject(next)
    const nextSpec = visibleSpec(next)
    setSpec(nextSpec)
    setMode(nextSpec?.plan_annotation && !nextSpec.plan_annotation.confirmed ? 'annotation' : 'review')
    setHistory([]); setFuture([]); setDirty(false); setSelection({ type: 'room' })
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
      setPlanRotation(null)
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
      if (role === 'floorplan') setPlanRotation(null)
      showMessage('success', `${files.length} 张图片已上传`)
    } catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const applyAnalysis = (result: Awaited<ReturnType<typeof studioApi.analyzePlan>>) => {
    const next = result.spec
    setSpec(next); setProject((current) => current ? { ...current, spec: next, measurement: result.measurement, status: 'review' } : current)
    setHistory([]); setFuture([]); setDirty(false); setMode(next.plan_annotation?.confirmed ? 'review' : 'annotation'); setSelection({ type: 'room' })
  }

  const analyzePlan = async () => {
    if (!project) return
    setBusy('plan')
    try {
      const result = await studioApi.analyzePlan(project.id, planRotation)
      applyAnalysis(result)
      showMessage(
        result.sufficient ? 'success' : 'info',
        result.sufficient
          ? '视觉模型已生成照片标注草稿，请先在原图上校正'
          : `照片标注仍有未绑定项：${result.missing.join('、')}`,
      )
    } catch (error) {
      try {
        const failed = await studioApi.project(project.id)
        setProject(failed); setSpec(visibleSpec(failed)); setHistory([]); setFuture([]); setDirty(false)
      } catch { /* Keep the original API error as the actionable message. */ }
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      showMessage(timedOut ? 'info' : 'error', timedOut ? error.message : `本次识别失败，旧模型已标记为不可用，原图片无需删除：${(error as Error).message}`)
    }
    finally { setBusy(null) }
  }

  const analyzePhotos = async () => {
    if (!project) return
    setBusy('photos')
    try {
      const result = await studioApi.analyzePhotos(project.id)
      applyAnalysis(result); showMessage('success', '现场照片识别完成，请核对新增设施')
    } catch (error) { showMessage('error', (error as Error).message) }
    finally { setBusy(null) }
  }

  const commitSpec = (next: RoomSpec) => {
    if (!spec) return
    next.issues = clientValidate(next)
    setHistory((items) => [...items.slice(-39), cloneSpec(spec)])
    setFuture([]); setSpec(next); setDirty(true)
    setProject((current) => current ? { ...current, spec: next } : current)
  }

  const applyEvidence = (id: string, value: string, role: EvidenceRole, targetId: string | null = null, ignored = false) => {
    if (!spec) return
    const next = cloneSpec(spec)
    const observation = next.observations.find((item) => item.field === `ocr:${id}`)
    if (!observation) return
    observation.value = value
    observation.source = 'user'
    observation.confidence = 1
    observation.confirmed = true
    observation.review_required = false
    observation.semantic_role = role
    observation.target_id = targetId
    if (!ignored) {
      const numbers = [...value.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => {
        const raw = match[0].replace(',', '.')
        const parsed = Number(raw)
        return raw.includes('.') && parsed < 20 ? Math.round(parsed * 1000) : Math.round(parsed)
      }).filter((item) => item > 0)
      if (role === 'room_height' && numbers[0]) next.height_mm = numbers[0]
      if (role === 'wall_thickness' && numbers[0] && targetId?.startsWith('wall:')) {
        const wallIndex = Number(targetId.slice(5).split('@')[0])
        if (Number.isInteger(wallIndex) && wallIndex >= 0 && wallIndex < next.boundary.length) {
          const profiles = next.wall_profiles ?? (next.wall_profiles = [])
          const profile = profiles.find((item) => item.wall_index === wallIndex)
          if (profile) { profile.thickness_mm = numbers[0]; profile.source = 'user'; profile.confidence = 1; profile.evidence_ids = [...new Set([...(profile.evidence_ids ?? []), id])] }
          else profiles.push({ wall_index: wallIndex, kind: 'interior', thickness_mm: numbers[0], source: 'user', confidence: 1, evidence_ids: [id] })
        }
      }
      if (role === 'door_size' && numbers.length >= 2) {
        const width = numbers.find((item) => item >= 500 && item <= 1600) ?? numbers[0]
        const height = numbers.find((item) => item >= 1800 && item <= 2800) ?? numbers[1]
        const target = wallTarget(targetId)
        if (target && Number.isInteger(target.wallIndex) && target.wallIndex >= 0 && target.wallIndex < next.boundary.length) {
          const thickness = numbers.find((item) => item >= 20 && item <= 600 && item !== width && item !== height) ?? null
          const door = next.openings.find((item) => item.evidence_ids?.includes(id))
          const start = next.boundary[target.wallIndex]
          const end = next.boundary[(target.wallIndex + 1) % next.boundary.length]
          const length = Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm)
          const offset = target.startRatio === null ? 0 : target.endRatio === null
            ? Math.max(0, Math.round(target.startRatio * length - width / 2))
            : Math.max(0, Math.round(Math.min(target.startRatio, target.endRatio) * length))
          if (door) {
            door.wall_index = target.wallIndex; door.offset_mm = offset; door.width_mm = width; door.height_mm = height; door.thickness_mm = thickness
            door.source = 'user'; door.confidence = 1; door.evidence_ids = [...new Set([...(door.evidence_ids ?? []), id])]
          } else next.openings.push({ id: `door-${crypto.randomUUID().slice(0, 8)}`, kind: 'door', wall_index: target.wallIndex, offset_mm: offset, width_mm: width, height_mm: height, thickness_mm: thickness, sill_mm: 0, label: '门洞（用户确认）', source: 'user', confidence: 1, evidence_ids: [id] })
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
    const next = cloneSpec(spec)
    next.observations = next.observations.filter((item) => item.field !== `ocr:${id}`)
    next.openings = next.openings.filter((item) => !(item.evidence_ids?.includes(id) && item.evidence_ids.length === 1))
    next.fixtures = next.fixtures.filter((item) => !(item.evidence_ids?.includes(id) && item.evidence_ids.length === 1))
    commitSpec(next)
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

  const confirmAnnotation = (points: ImageBoundaryPoint[]) => {
    if (!spec || points.length < 3) return
    const next = cloneSpec(spec)
    const minX = Math.min(...points.map((point) => point.x))
    const maxX = Math.max(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxY = Math.max(...points.map((point) => point.y))
    const currentBounds = next.boundary.length ? {
      width: Math.max(...next.boundary.map((point) => point.x_mm)) - Math.min(...next.boundary.map((point) => point.x_mm)),
      depth: Math.max(...next.boundary.map((point) => point.z_mm)) - Math.min(...next.boundary.map((point) => point.z_mm)),
    } : { width: 3000, depth: 2000 }
    next.boundary = points.map((point) => ({
      x_mm: Math.round((point.x - minX) * Math.max(currentBounds.width, 1) / Math.max(maxX - minX, 1)),
      z_mm: Math.round((point.y - minY) * Math.max(currentBounds.depth, 1) / Math.max(maxY - minY, 1)),
    }))
    next.plan_annotation = {
      rotation_degrees: next.plan_annotation?.rotation_degrees ?? 0,
      boundary: points,
      confirmed: true,
    }
    next.openings.forEach((opening) => {
      const evidence = next.observations.find((item) => opening.evidence_ids?.includes(item.field.replace(/^ocr:/, '')) && item.target_id?.startsWith('wall:'))
      if (!evidence?.target_id) return
      const target = wallTarget(evidence.target_id)
      if (!target) return
      const wallText = String(target.wallIndex)
      const wallIndex = Number(wallText)
      if (!Number.isInteger(wallIndex) || wallIndex < 0 || wallIndex >= next.boundary.length) return
      opening.wall_index = wallIndex
      const start = next.boundary[wallIndex]
      const end = next.boundary[(wallIndex + 1) % next.boundary.length]
      const length = Math.hypot(end.x_mm - start.x_mm, end.z_mm - start.z_mm)
      const ratio = target.startRatio ?? 0.5
      opening.offset_mm = target.endRatio === null
        ? Math.max(0, Math.round(ratio * length - opening.width_mm / 2))
        : Math.max(0, Math.round(Math.min(ratio, target.endRatio) * length))
    })
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
    const next = cloneSpec(spec); next.confirmed = true
    setSpec(next); setMode('model'); await save(next)
  }

  const exportModel = () => {
    if (!spec) return
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

  useEffect(() => {
    if (!pendingExport || mode !== 'model') return
    const timer = window.setTimeout(() => {
      void modelRef.current?.exportGLB(`${project?.name ?? 'bathroom-model'}.glb`).then(() => showMessage('success', 'GLB 已导出')).catch((error: Error) => showMessage('error', error.message))
      setPendingExport(false)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [mode, pendingExport, project?.name, showMessage])

  const annotationConfirmed = !!spec && (!spec.plan_annotation || spec.plan_annotation.confirmed)
  const canConfirm = annotationConfirmed && !!spec && !!spec.height_mm && !spec.issues.some((issue) => issue.severity === 'error')
  const canPreview = annotationConfirmed && !!spec && spec.boundary.length >= 3 && !!spec.height_mm
  const canModel = canConfirm && !!spec?.confirmed
  const canExportMeasurement = !!project?.measurement && project.status !== 'analysis_failed' && !dirty
  const plan = project?.assets.filter((asset) => asset.role === 'floorplan').at(-1)

  return (
    <div className="app-shell">
      <Header projectName={project?.name} dirty={dirty} canUndo={history.length > 0} canRedo={future.length > 0} canConfirm={canConfirm} canModel={canModel} canExportMeasurement={canExportMeasurement} saving={busy === 'save'} onUndo={undo} onRedo={redo} onSave={() => void save()} onConfirm={() => void confirm()} onExportMeasurement={exportMeasurement} onExport={exportModel} />
      <ProjectRail projects={projects} project={project} health={health} busy={busy} planRotation={planRotation} onPlanRotationChange={setPlanRotation} onSelectProject={(id) => void selectProject(id)} onCreateProject={createProject} onDeleteProject={() => void deleteProject()} onUpload={upload} onAnalyzePlan={() => void analyzePlan()} onAnalyzePhotos={() => void analyzePhotos()} />
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
              <button className={mode === 'model' ? 'active' : ''} onClick={() => canPreview && setMode('model')} disabled={!canPreview}><BoxSelect size={16} />三维预览</button>
            </div>
            {mode !== 'annotation' && <SolutionList spec={spec} active={mode === 'model'} onOpenModel={() => canPreview && setMode('model')} />}
            {mode === 'annotation'
              ? <PhotoAnnotation spec={spec} plan={plan} activeEvidenceId={activeEvidenceId} onChange={commitSpec} onEvidenceSelect={setFocusEvidenceId} onConfirm={confirmAnnotation} />
              : mode === 'review'
                ? <PlanReview spec={spec} plan={plan} selection={selection} onSelect={setSelection} onEvidenceSelect={setFocusEvidenceId} onFixtureMove={(id, x, z) => { const next = cloneSpec(spec); const fixture = next.fixtures.find((item) => item.id === id); if (fixture) { fixture.x_mm = x; fixture.z_mm = z; fixture.source = 'user'; fixture.confidence = 1; commitSpec(next) } }} />
                : <ModelCanvas ref={modelRef} spec={spec} selection={selection} onSelect={setSelection} />}
          </>
        )}
      </main>
      {spec && <Inspector spec={spec} assets={project?.assets ?? []} selection={selection} onSelect={setSelection} onChange={commitSpec} onEvidenceApply={applyEvidence} onEvidenceDelete={deleteEvidence} onEvidenceDraftChange={updateEvidenceDraft} focusEvidenceId={focusEvidenceId} onEvidenceActive={setActiveEvidenceId} annotationMode={mode === 'annotation'} />}
      {message && <div className={`toast ${message.kind}`} role="status"><span>{message.text}</span><button className="icon-button" onClick={() => setMessage(null)} title="关闭"><X size={15} /></button></div>}
    </div>
  )
}
