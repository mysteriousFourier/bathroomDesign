import { AlertTriangle, BookOpen, CheckCircle2, ChevronDown, CircleAlert, FileImage, ImagePlus, LoaderCircle, Plus, ScanLine, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { studioApi } from '../api'
import type { Asset, CaptureAssessment, Health, Project } from '../types'
import { CaptureGuide } from './CaptureGuide'

interface ProjectRailProps {
  projects: Project[]
  project: Project | null
  health: Health | null
  busy: string | null
  onSelectProject: (id: string) => void
  onCreateProject: (name: string) => Promise<void>
  onDeleteProject: () => void
  onUpload: (role: 'floorplan' | 'photo', files: File[]) => Promise<void>
  planRotation: number | null
  onPlanRotationChange: (rotation: number | null) => void
  onAnalyzePlan: () => void
  onAnalyzePhotos: () => void
}

function AssetStrip({ assets }: { assets: Asset[] }) {
  if (!assets.length) return <p className="empty-caption">尚未添加</p>
  return (
    <div className="asset-strip">
      {assets.map((asset) => (
        <figure key={asset.id} title={asset.filename}>
          <img src={asset.url} alt={asset.filename} />
          <figcaption>{asset.filename}</figcaption>
        </figure>
      ))}
    </div>
  )
}

export function ProjectRail(props: ProjectRailProps) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('卫生间测量')
  const planInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const plans = props.project?.assets.filter((asset) => asset.role === 'floorplan') ?? []
  const photos = props.project?.assets.filter((asset) => asset.role === 'photo') ?? []
  const latestPlan = plans.at(-1)
  const [guideOpen, setGuideOpen] = useState(false)
  const [assessment, setAssessment] = useState<CaptureAssessment | null>(null)

  useEffect(() => {
    let active = true
    setAssessment(null)
    if (!latestPlan) return () => { active = false }
    studioApi.captureAssessment(latestPlan.id)
      .then((result) => { if (active) setAssessment(result) })
      .catch(() => { if (active) setAssessment(null) })
    return () => { active = false }
  }, [latestPlan?.id])

  const create = async () => {
    if (!name.trim()) return
    await props.onCreateProject(name.trim())
    setCreating(false)
  }

  return (
    <aside className="project-rail">
      <section className="rail-section project-switcher">
        <label>当前项目</label>
        <div className="select-wrap">
          <select value={props.project?.id ?? ''} onChange={(event) => props.onSelectProject(event.target.value)} disabled={!props.projects.length || !!props.busy}>
            {!props.projects.length && <option value="">没有项目</option>}
            {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <ChevronDown size={15} />
        </div>
        {creating ? (
          <div className="create-project-form">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoFocus onKeyDown={(event) => event.key === 'Enter' && void create()} />
            <button className="button primary compact" onClick={() => void create()}>创建</button>
            <button className="button ghost compact" onClick={() => setCreating(false)}>取消</button>
          </div>
        ) : (
          <div className="inline-actions">
            <button className="text-button" onClick={() => setCreating(true)}><Plus size={15} />新建</button>
            <button className="icon-button danger" onClick={props.onDeleteProject} disabled={!props.project || !!props.busy || props.project.status === 'analysis_running'} title="删除项目"><Trash2 size={15} /></button>
          </div>
        )}
      </section>

      <section className="rail-section api-state">
        <div className="section-title"><span>模型服务</span>{props.health?.ai_configured ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}</div>
        <p>{props.health?.ai_configured ? `${props.health.model}${props.health.fallback_model ? ` → ${props.health.fallback_model}` : ''}` : '未配置兼容 API'}</p>
      </section>

      <section className="rail-section step-section">
        <div className="step-index">01</div>
        <div className="section-title"><span>测量图</span><FileImage size={16} /></div>
        <AssetStrip assets={plans} />
        <button className="capture-rules-link" onClick={() => setGuideOpen(true)}><BookOpen size={14} />查看量房规则与打印模板</button>
        {latestPlan && <div className={`capture-assessment ${assessment?.status ?? 'checking'}`}>
          {assessment?.status === 'ready' ? <CheckCircle2 size={15} /> : assessment ? <CircleAlert size={15} /> : <LoaderCircle className="spin" size={15} />}
          <div>
            <strong>{assessment?.status === 'ready' ? '图片质量良好' : assessment?.status === 'usable' ? '图片可用，建议复核' : assessment?.status === 'retake' ? '建议重新拍摄' : '正在检查图片'}</strong>
            {assessment && <span>{assessment.checks.filter((item) => item.status !== 'pass').map((item) => item.detail).join('；') || `${assessment.width} x ${assessment.height} · 清晰度通过`}</span>}
          </div>
        </div>}
        {!!plans.length && <div className="plan-rotation-field">
          <label htmlFor="plan-rotation">图片方向</label>
          <div className="select-wrap">
            <select id="plan-rotation" value={props.planRotation ?? 'auto'} onChange={(event) => props.onPlanRotationChange(event.target.value === 'auto' ? null : Number(event.target.value))} disabled={!!props.busy}>
              <option value="auto">自动判断</option>
              <option value="0">不旋转</option>
              <option value="90">顺时针 90°</option>
              <option value="180">倒转 180°</option>
              <option value="270">逆时针 90°</option>
            </select>
            <ChevronDown size={15} />
          </div>
        </div>}
        <input ref={planInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) void props.onUpload('floorplan', files)
          event.target.value = ''
        }} />
        <button className="button secondary wide" disabled={!props.project || !!props.busy} onClick={() => planInput.current?.click()}><Upload size={16} />上传平面图</button>
        <button className="button primary wide" disabled={!plans.length || !!props.busy || !props.health?.ai_configured} onClick={props.onAnalyzePlan}>
          {props.busy === 'plan' ? <LoaderCircle className="spin" size={16} /> : <ScanLine size={16} />}{props.busy === 'plan' ? '正在识别' : '识别照片标注'}
        </button>
      </section>

      <section className="rail-section step-section">
        <div className="step-index">02</div>
        <div className="section-title"><span>现场照片</span><ImagePlus size={16} /></div>
        <AssetStrip assets={photos} />
        <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) void props.onUpload('photo', files)
          event.target.value = ''
        }} />
        <button className="button secondary wide" disabled={!props.project || !!props.busy} onClick={() => photoInput.current?.click()}><Upload size={16} />添加现场照片</button>
        <button className="button secondary wide" disabled={!photos.length || !props.project?.spec || !!props.busy || !props.health?.ai_configured} onClick={props.onAnalyzePhotos}>
          {props.busy === 'photos' ? <LoaderCircle className="spin" size={16} /> : <ScanLine size={16} />}{props.busy === 'photos' ? '正在识别' : '补充固定设施'}
        </button>
      </section>
      <CaptureGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </aside>
  )
}
