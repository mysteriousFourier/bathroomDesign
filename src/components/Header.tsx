import { Box, Check, Download, FileJson, Redo2, Save, Undo2 } from 'lucide-react'

interface HeaderProps {
  projectName?: string
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  canConfirm: boolean
  canModel: boolean
  canExportMeasurement: boolean
  saving: boolean
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onConfirm: () => void
  onExportMeasurement: () => void
  onExport: () => void
}

export function Header({ projectName, dirty, canUndo, canRedo, canConfirm, canModel, canExportMeasurement, saving, onUndo, onRedo, onSave, onConfirm, onExportMeasurement, onExport }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="brand-block" aria-label="量界卫生间建模工作台">
        <span className="brand-mark"><Box size={19} strokeWidth={1.8} /></span>
        <div><strong>量界</strong><span>SPATIAL STUDIO</span></div>
      </div>
      <div className="project-heading">
        <strong>{projectName ?? '未选择项目'}</strong>
        {projectName && <span className={dirty ? 'save-state dirty' : 'save-state'}>{dirty ? '有未保存修改' : '已保存'}</span>}
      </div>
      <div className="header-actions">
        <button className="icon-button" onClick={onUndo} disabled={!canUndo} title="撤销"><Undo2 size={17} /></button>
        <button className="icon-button" onClick={onRedo} disabled={!canRedo} title="重做"><Redo2 size={17} /></button>
        <span className="toolbar-separator" />
        <button className="button secondary" onClick={onSave} disabled={!dirty || saving}><Save size={16} />{saving ? '保存中' : '保存'}</button>
        <button className="button secondary" onClick={onConfirm} disabled={!canConfirm}><Check size={16} />确认数据</button>
        <button className="button secondary" onClick={onExportMeasurement} disabled={!canExportMeasurement} title="下载当前已保存的量房数据"><FileJson size={16} />量房 JSON</button>
        <button className="button primary" onClick={onExport} disabled={!canModel}><Download size={16} />导出 GLB</button>
      </div>
    </header>
  )
}
