import { Box, BoxSelect, FileSearch, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { studioApi } from './api'
import { EmptyWorkspace } from './components/EmptyWorkspace'
import { Header } from './components/Header'
import { Inspector } from './components/Inspector'
import { ModelCanvas, type ModelCanvasHandle } from './components/ModelCanvas'
import { PlanReview } from './components/PlanReview'
import { ProjectRail } from './components/ProjectRail'
import { SolutionList } from './components/SolutionList'
import { WorkflowStatus } from './components/WorkflowStatus'
import { clientValidate, cloneSpec, manualRoom } from './spec'
import type { EvidenceRole, Health, Project, RoomSpec, Selection } from './types'

type WorkspaceMode = 'review' | 'model'

const visibleSpec = (value: Project | null) => value?.status === 'analysis_failed' ? null : value?.spec ?? null

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [spec, setSpec] = useState<RoomSpec | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [mode, setMode] = useState<WorkspaceMode>('review')
  const [selection, setSelection] = useState<Selection>({ type: 'room' })
  const [history, setHistory] = useState<RoomSpec[]>([])
  const [future, setFuture] = useState<RoomSpec[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>('boot')
  const [message, setMessage] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [pendingExport, setPendingExport] = useState(false)
  const [planRotation, setPlanRotation] = useState<number | null>(null)
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
    setSpec(visibleSpec(next))
    setHistory([]); setFuture([]); setDirty(false); setSelection({ type: 'room' })
  }, [])

  useEffect(() => {
    Promise.all([studioApi.health(), studioApi.projects()]).then(([healthResult, projectList]) => {
      setHealth(healthResult)
      setProjects(projectList)
      const first = projectList[0] ?? null
      setProject(first); setSpec(visibleSpec(first))
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
      setProject(next); setSpec(visibleSpec(next)); setHistory([]); setFuture([]); setDirty(false); setMode('review'); setSelection({ type: 'room' })
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
    setHistory([]); setFuture([]); setDirty(false); setMode('review'); setSelection({ type: 'room' })
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
          ? '测量图解析完成，请核对尺寸'
          : `已生成可编辑模型，请逐项校正：${result.missing.join('、')}`,
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

  const applyEvidence = (id: string, value: string, role: EvidenceRole, ignored = false) => {
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
    if (!ignored) {
      const numbers = [...value.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => {
        const raw = match[0].replace(',', '.')
        const parsed = Number(raw)
        return raw.includes('.') && parsed < 20 ? Math.round(parsed * 1000) : Math.round(parsed)
      }).filter((item) => item > 0)
      if (role === 'room_height' && numbers[0]) next.height_mm = numbers[0]
      if (role === 'door_size' && numbers.length >= 2) {
        const width = numbers.find((item) => item >= 500 && item <= 1600) ?? numbers[0]
        const height = numbers.find((item) => item >= 1800 && item <= 2800) ?? numbers[1]
        const door = next.openings.find((item) => item.kind === 'door')
        if (door) { door.width_mm = width; door.height_mm = height; door.source = 'user'; door.confidence = 1; door.evidence_ids = [...new Set([...(door.evidence_ids ?? []), id])] }
        else next.openings.push({ id: `door-${crypto.randomUUID().slice(0, 8)}`, kind: 'door', wall_index: 0, offset_mm: 0, width_mm: width, height_mm: height, sill_mm: 0, label: '门洞（用户确认）', source: 'user', confidence: 1, evidence_ids: [id] })
      }
      if (role === 'door_position' && numbers[0]) {
        const door = next.openings.find((item) => item.kind === 'door')
        if (door) door.offset_mm = numbers[0]
      }
      if (role === 'drain_position' && numbers.length >= 2) {
        const fixture = next.fixtures.find((item) => item.kind === 'floor_drain' || item.kind === 'toilet' || item.kind === 'pipe')
        if (fixture) { fixture.x_mm = numbers[0]; fixture.z_mm = numbers[1]; fixture.source = 'user'; fixture.confidence = 1; fixture.evidence_ids = [...new Set([...(fixture.evidence_ids ?? []), id])] }
        else next.fixtures.push({ id: `drain-${crypto.randomUUID().slice(0, 8)}`, kind: 'floor_drain', label: '排水点（用户确认）', x_mm: numbers[0], z_mm: numbers[1], width_mm: 75, depth_mm: 75, height_mm: 20, rotation_deg: 0, source: 'user', confidence: 1, evidence_ids: [id] })
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

  const canConfirm = !!spec && !!spec.height_mm && !spec.issues.some((issue) => issue.severity === 'error')
  const canPreview = !!spec && spec.boundary.length >= 3 && !!spec.height_mm
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
              <button className={mode === 'review' ? 'active' : ''} onClick={() => setMode('review')}><FileSearch size={16} />二维审图</button>
              <button className={mode === 'model' ? 'active' : ''} onClick={() => canPreview && setMode('model')} disabled={!canPreview}><BoxSelect size={16} />三维预览</button>
            </div>
            <SolutionList spec={spec} active={mode === 'model'} onOpenModel={() => canPreview && setMode('model')} />
            {mode === 'review' ? <PlanReview spec={spec} plan={plan} selection={selection} onSelect={setSelection} onFixtureMove={(id, x, z) => { const next = cloneSpec(spec); const fixture = next.fixtures.find((item) => item.id === id); if (fixture) { fixture.x_mm = x; fixture.z_mm = z; fixture.source = 'user'; fixture.confidence = 1; commitSpec(next) } }} /> : <ModelCanvas ref={modelRef} spec={spec} selection={selection} onSelect={setSelection} />}
          </>
        )}
      </main>
      {spec && <Inspector spec={spec} assets={project?.assets ?? []} selection={selection} onSelect={setSelection} onChange={commitSpec} onEvidenceApply={applyEvidence} />}
      {message && <div className={`toast ${message.kind}`} role="status"><span>{message.text}</span><button className="icon-button" onClick={() => setMessage(null)} title="关闭"><X size={15} /></button></div>}
    </div>
  )
}
