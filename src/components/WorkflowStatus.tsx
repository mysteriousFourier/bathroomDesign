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
    plan: '正在解析测量图，时间较长时可稍后重试',
    photos: '正在识别现场照片',
    save: '正在保存修正',
  }

  if (busy && busyText[busy]) {
    return <div className="workflow-status working"><LoaderCircle className="spin" size={16} /><span>{busyText[busy]}</span></div>
  }
  if (!project) return null
  if (project.status === 'analysis_failed') {
    return <div className="workflow-status error"><AlertTriangle size={16} /><span>上次识别失败，旧模型未继续展示；可调整图片方向后重新解析，或手动建立空间。</span></div>
  }
  if (!spec) {
    return <div className="workflow-status empty"><Clock3 size={16} /><span>等待上传测量图或手动录入基础尺寸。</span></div>
  }
  if (errors.length) {
    return <div className="workflow-status error"><TriangleAlert size={16} /><span>{errors.length} 个错误阻止进入最终建模，请在右侧校验结果中修正。</span></div>
  }
  if (dirty) {
    return <div className="workflow-status warning"><Clock3 size={16} /><span>有未保存修正；保存后才可导出当前量房 JSON。</span></div>
  }
  return <div className="workflow-status ok"><CheckCircle2 size={16} /><span>{warnings.length ? `${warnings.length} 个警告可继续复核` : '数据可进入三维复核'}</span></div>
}
