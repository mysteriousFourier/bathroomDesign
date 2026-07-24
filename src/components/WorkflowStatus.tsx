import { AlertTriangle, CheckCircle2, Clock3, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { Project, RoomSpec } from '../types'

export function WorkflowStatus({ project, spec, busy, dirty }: {
  project: Project | null
  spec: RoomSpec | null
  busy: string | null
  dirty: boolean
}) {
  const errors = spec?.issues.filter((issue) => issue.severity === 'error') ?? []
  const warnings = spec?.issues.filter((issue) => issue.severity === 'warning') ?? []
  const busyText: Record<string, string> = {
    boot: '正在连接本地应用',
    project: '正在同步项目',
    upload: '正在上传图片',
    plan: 'OCR 与视觉模型正在生成照片标注草稿',
    photos: '正在识别现场照片',
    save: '正在保存修正',
  }

  if (busy && busyText[busy]) {
    return <div className="workflow-status working"><LoaderCircle className="spin" size={16} /><span>{busyText[busy]}</span></div>
  }
  if (!project) return null
  const hasPlan = project.assets.some((asset) => asset.role === 'floorplan')
  if (project.status === 'analysis_running') {
    return <div className="workflow-status working"><LoaderCircle className="spin" size={16} /><span>正在识别原图墙线、文字归属、门洞和排水标注；完成后先进入照片校正。</span></div>
  }
  if (project.status === 'analysis_failed') {
    return <div className="workflow-status error"><AlertTriangle size={16} /><span>{hasPlan ? '上次解析未完成；图片仍在项目中，可调整方向后重试。' : '解析未完成，请上传测量图或手动建立空间。'}</span></div>
  }
  if (!spec) {
    return <div className="workflow-status empty"><Clock3 size={16} /><span>{hasPlan ? '测量图已上传，先生成照片标注草稿；确认标注后才生成二维图。' : '等待上传测量图或手动录入基础尺寸。'}</span></div>
  }
  if (spec.plan_annotation && !spec.plan_annotation.confirmed) {
    return <div className="workflow-status warning"><Clock3 size={16} /><span>照片标注尚未确认；未绑定项不会进入二维图。</span></div>
  }
  if (errors.length) {
    const remaining = errors.length > 1 ? `（之后还有 ${errors.length - 1} 项）` : ''
    return <div className="workflow-status error"><TriangleAlert size={16} /><span>已生成可编辑模型，请先校正：{errors[0].message}{remaining}</span></div>
  }
  if (dirty) {
    return <div className="workflow-status warning"><Clock3 size={16} /><span>有未保存修正；保存后才可导出当前量房 JSON。</span></div>
  }
  return <div className="workflow-status ok"><CheckCircle2 size={16} /><span>{warnings.length ? `${warnings.length} 个警告可继续复核` : '数据可进入三维复核'}</span></div>
}
