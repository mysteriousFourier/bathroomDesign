import { Check, ExternalLink, FileDown, X } from 'lucide-react'
import { useEffect } from 'react'

const rules = [
  ['用笔', '全图只用一支黑色或深蓝色笔；墙体画连续实线，尺寸放在轮廓外侧并带尺寸线。'],
  ['基准', '尺寸基准未勾选时默认按完成面；只有实测毛坯面时才勾选毛坯面。'],
  ['墙体', '沿房间内侧完成面画连续闭合轮廓，墙垛、包管和门框短回折都要画出；线条长短无需按比例。'],
  ['尺寸', '实际墙长只以标注整数毫米为准，绝不按草图线条比例换算；数字横向正写。'],
  ['校验', '横向、纵向都保留分段尺寸链和总尺寸；小范围现场误差按尺寸链比例自动闭合，并保留原值和调整量。'],
  ['门窗', '固定填写 D1、W1、W2；CG 是洞口距地，CK 是洞口内宽，CH 是洞口内高。'],
  ['点位', '不填写 X/Y 表；在草图实际相对位置画符号并写地漏、排水、给水或电点简称。'],
  ['高度', '填写室内净高；整体吊顶高度可直接写在房间中央，如“吊顶 2100”。'],
  ['改错', '错误数字划一条线作废后在旁边重写，不覆盖、涂黑或反复描粗。'],
  ['拍照', '完整拍到纸张四边，镜头垂直、光线均匀，使用长边至少 2000 像素的原图。'],
] as const

export function CaptureGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null
  return (
    <div className="guide-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="capture-guide" role="dialog" aria-modal="true" aria-labelledby="capture-guide-title">
        <header className="capture-guide-header">
          <div>
            <span className="guide-kicker">采集规范 1.0</span>
            <h2 id="capture-guide-title">让量房数据一次可识别</h2>
          </div>
          <button className="icon-button" title="关闭" aria-label="关闭量房规则" onClick={onClose}><X size={18} /></button>
        </header>
        <p className="capture-guide-summary">墙体图形表达拓扑，最终尺寸以标注毫米数为准；点位按符号中心在草图中的相对位置换算。旧草图仍可上传，信息不足时系统会定位到原图请你确认。</p>
        <div className="capture-rule-list">
          {rules.map(([name, detail]) => (
            <div className="capture-rule" key={name}>
              <span className="capture-rule-check"><Check size={14} /></span>
              <strong>{name}</strong>
              <p>{detail}</p>
            </div>
          ))}
        </div>
        <div className="capture-guide-actions">
          <a className="button secondary" href="/measurement-template.html" target="_blank" rel="noreferrer"><ExternalLink size={15} />预览模板</a>
          <a className="button primary" href="/measurement-template.html" target="_blank" rel="noreferrer"><FileDown size={15} />打印量房纸</a>
        </div>
      </section>
    </div>
  )
}
