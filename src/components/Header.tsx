import { Box, Check, Download, FileJson, Monitor, Moon, Redo2, Save, Sun, Undo2 } from 'lucide-react'
import { appearance, useSkin, useThemeSetting, type Skin, type ThemeSetting } from '../appearance'

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

const themeOptions: Array<{ value: ThemeSetting; label: string; hint: string; icon: typeof Sun }> = [
  { value: 'light', label: '浅色', hint: '浅色模式', icon: Sun },
  { value: 'dark', label: '深色', hint: '深色模式', icon: Moon },
  { value: 'system', label: '系统', hint: '跟随系统外观设置', icon: Monitor },
]

const skinOptions: Array<{ value: Skin; label: string; hint: string }> = [
  { value: 'magazine', label: '杂志', hint: '杂志版式 · 高端排版' },
  { value: 'toolkit', label: '工具', hint: '工具版式 · 现代效率' },
]

function ThemeSwitcher() {
  const setting = useThemeSetting()
  return (
    <div className="segmented" role="group" aria-label="外观模式">
      {themeOptions.map(({ value, label, hint, icon: Icon }) => (
        <button
          key={value}
          className={setting === value ? 'segment active' : 'segment'}
          title={hint}
          aria-pressed={setting === value}
          onClick={() => appearance.setThemeSetting(value)}
        >
          <Icon size={15} /><span className="segment-label">{label}</span>
        </button>
      ))}
    </div>
  )
}

function SkinSwitcher() {
  const skin = useSkin()
  return (
    <div className="segmented" role="group" aria-label="界面版式">
      {skinOptions.map(({ value, label, hint }) => (
        <button
          key={value}
          className={skin === value ? 'segment active' : 'segment'}
          title={hint}
          aria-pressed={skin === value}
          onClick={() => appearance.setSkin(value)}
        >
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
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
        <span className="toolbar-separator" />
        <div className="header-switchers">
          <ThemeSwitcher />
          <SkinSwitcher />
        </div>
      </div>
    </header>
  )
}
