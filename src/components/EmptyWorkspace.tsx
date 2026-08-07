import { ArrowRight, Ruler, ScanLine } from 'lucide-react'
import { useState } from 'react'

export function EmptyWorkspace({ hasPlan, analysisFailed, canAnalyze, onAnalyze, onManual }: {
  hasPlan: boolean
  analysisFailed?: boolean
  canAnalyze: boolean
  onAnalyze: () => void
  onManual: (width: number, depth: number, height: number) => void
}) {
  const [width, setWidth] = useState(1800)
  const [depth, setDepth] = useState(2600)
  const [height, setHeight] = useState(2600)
  return (
    <div className="empty-workspace">
      <div className="empty-symbol"><Ruler size={34} strokeWidth={1.25} /></div>
      <h1>{analysisFailed ? '上次拓扑识别未通过' : hasPlan ? '测量图已经就位' : '从测量图开始建立空间'}</h1>
      <p>{analysisFailed ? '原图与上一轮结果均已保留，可直接重新解析。' : hasPlan ? '解析后先核对尺寸和空间边界；生成草稿只有保存后才会替换当前结果。' : '上传带尺寸的平面图；图纸信息足够时，现场照片可以省略。'}</p>
      {hasPlan && <button className="button primary" onClick={onAnalyze} disabled={!canAnalyze}><ScanLine size={17} />解析测量图</button>}
      <div className="manual-divider"><span>或手动建立矩形空间</span></div>
      <div className="manual-dimensions">
        <label>宽度 <span><input type="number" min="500" value={width} onChange={(e) => setWidth(Number(e.target.value))} /> mm</span></label>
        <label>深度 <span><input type="number" min="500" value={depth} onChange={(e) => setDepth(Number(e.target.value))} /> mm</span></label>
        <label>净高 <span><input type="number" min="1000" value={height} onChange={(e) => setHeight(Number(e.target.value))} /> mm</span></label>
        <button className="icon-button strong" title="建立空间" onClick={() => onManual(width, depth, height)} disabled={width < 500 || depth < 500 || height < 1000}><ArrowRight size={18} /></button>
      </div>
    </div>
  )
}
