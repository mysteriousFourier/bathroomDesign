import { Box, BoxSelect, FileSearch, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { studioApi } from './api'
import { EmptyWorkspace } from './components/EmptyWorkspace'
import { Header } from './components/Header'
import { Inspector } from './components/Inspector'
import { ModelCanvas, type ModelCanvasHandle } from './components/ModelCanvas'
import { PlanReview } from './components/PlanReview'
import { ProjectRail } from './components/ProjectRail'
import { clientValidate, cloneSpec, manualRoom } from './spec'
import type { Health, Project, RoomSpec, Selection } from './types'

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
      showMessage(result.sufficient ? 'success' : 'info', result.sufficient ? '测量图解析完成，请核对尺寸' : `仍需补充：${result.missing.join('、')}`)
    } catch (error) {
      try {
        const failed = await studioApi.project(project.id)
        setProject(failed); setSpec(visibleSpec(failed)); setHistory([]); setFuture([]); setDirty(false)
      } catch { /* Keep the original API error as the actionable message. */ }
      showMessage('error', `本次识别失败，旧模型已标记为不可用，原图片无需删除：${(error as Error).message}`)
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
        {busy === 'boot' ? <div className="loading-screen"><LoaderCircle className="spin" size={28} /><span>正在打开工作台</span></div> : !project ? (
          <div className="no-project"><Box size={36} strokeWidth={1.2} /><h1>先创建一个项目</h1><p>项目会在本机保存测量图、现场照片和模型参数。</p></div>
        ) : !spec ? (
          <EmptyWorkspace hasPlan={!!plan} analysisFailed={project.status === 'analysis_failed'} canAnalyze={!!health?.ai_configured && !busy} onAnalyze={() => void analyzePlan()} onManual={(width, depth, height) => { const next = manualRoom(width, depth, height); setSpec(next); setProject((current) => current ? { ...current, spec: next } : current); setDirty(true) }} />
        ) : (
          <>
            <div className="view-tabs" role="tablist">
              <button className={mode === 'review' ? 'active' : ''} onClick={() => setMode('review')}><FileSearch size={16} />二维审图</button>
              <button className={mode === 'model' ? 'active' : ''} onClick={() => canPreview && setMode('model')} disabled={!canPreview}><BoxSelect size={16} />三维预览</button>
            </div>
            {mode === 'review' ? <PlanReview spec={spec} plan={plan} selection={selection} onSelect={setSelection} onFixtureMove={(id, x, z) => { const next = cloneSpec(spec); const fixture = next.fixtures.find((item) => item.id === id); if (fixture) { fixture.x_mm = x; fixture.z_mm = z; fixture.source = 'user'; fixture.confidence = 1; commitSpec(next) } }} /> : <ModelCanvas ref={modelRef} spec={spec} selection={selection} onSelect={setSelection} />}
          </>
        )}
      </main>
      {spec && <Inspector spec={spec} selection={selection} onSelect={setSelection} onChange={commitSpec} />}
      {message && <div className={`toast ${message.kind}`} role="status"><span>{message.text}</span><button className="icon-button" onClick={() => setMessage(null)} title="关闭"><X size={15} /></button></div>}
    </div>
  )
}
