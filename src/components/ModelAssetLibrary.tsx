import { Box, CheckCircle2, CopyCheck, FileUp, Plus, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { legacyImportSources, modelAssetRegistry } from '../modelAssets'

type FlowStep = 'imported' | 'converted' | 'deduped' | 'room'

const convertedAssets = Object.values(modelAssetRegistry).filter((asset) => asset.tags.includes('converted'))

export function ModelAssetLibrary({ canAddToRoom, onAddToRoom, onOpenRoom }: {
  canAddToRoom: boolean
  onAddToRoom: (assetId: keyof typeof modelAssetRegistry) => void
  onOpenRoom: () => void
}) {
  const [step, setStep] = useState<FlowStep>('imported')
  const convertedIds = new Set(convertedAssets.map((asset) => asset.id))
  const conversionCount = legacyImportSources.filter((source) => convertedIds.has(source.converted_asset_id as keyof typeof modelAssetRegistry)).length
  const dedupeResult = useMemo(() => {
    const bySource = new Map<string, string>()
    const duplicates: string[] = []
    for (const source of legacyImportSources) {
      const key = `${source.source_asset_id}:${source.sha256}`
      const existing = bySource.get(key)
      if (existing) duplicates.push(`${source.id} -> ${existing}`)
      else bySource.set(key, source.converted_asset_id)
    }
    return { unique: bySource.size, duplicates }
  }, [])

  return (
    <div className="model-library">
      <div className="library-toolbar">
        <div>
          <strong>模型库</strong>
          <span>{legacyImportSources.length} 个导入源 · {conversionCount} 个 GLB 运行时资产</span>
        </div>
        <button className="button secondary" onClick={onOpenRoom}><Box size={16} />三维房间</button>
      </div>

      <div className="library-flow" aria-label="模型资产全流程">
        <button className={step === 'imported' ? 'active' : ''} onClick={() => setStep('imported')}><FileUp size={16} />放入</button>
        <button className={step === 'converted' ? 'active' : ''} onClick={() => setStep('converted')}><RefreshCw size={16} />转换</button>
        <button className={step === 'deduped' ? 'active' : ''} onClick={() => setStep('deduped')}><CopyCheck size={16} />去重</button>
        <button className={step === 'room' ? 'active' : ''} onClick={() => setStep('room')}><Plus size={16} />加入房间</button>
      </div>

      {step === 'deduped' && (
        <section className="dedupe-panel">
          <CheckCircle2 size={18} />
          <div>
            <strong>按 source_asset_id + SHA-256 去重完成</strong>
            <span>唯一导入源 {dedupeResult.unique} 个；重复导入会回用既有 converted_asset_id，不生成第二份运行时资产。</span>
          </div>
        </section>
      )}

      <div className="library-grid">
        {legacyImportSources.map((source) => {
          const asset = modelAssetRegistry[source.converted_asset_id as keyof typeof modelAssetRegistry]
          return (
            <article className="library-card" key={source.id}>
              <div className="library-preview">
                {asset?.thumbnail ? <img src={asset.thumbnail} alt={asset.label} /> : <FileUp size={32} />}
              </div>
              <div className="library-card-body">
                <strong>{source.label}</strong>
                <span>{source.original_filename} · {source.bytes.toLocaleString()} bytes</span>
                <code>{source.sha256.slice(0, 16)}</code>
                <div className="library-status">
                  <span className="done">导入</span>
                  <span className={asset ? 'done' : ''}>转换</span>
                  <span className="done">去重</span>
                  <span className={step === 'room' ? 'done' : ''}>房间</span>
                </div>
              </div>
              <div className="library-card-actions">
                <button className="button secondary compact" onClick={() => setStep('converted')} disabled={!asset}><RefreshCw size={14} />查看 GLB</button>
                <button className="button primary compact" onClick={() => { onAddToRoom(asset.id as keyof typeof modelAssetRegistry); setStep('room') }} disabled={!asset || !canAddToRoom}><Plus size={14} />加入房间</button>
              </div>
            </article>
          )
        })}
      </div>

      <div className="runtime-table">
        {convertedAssets.map((asset) => (
          <div key={asset.id}>
            <strong>{asset.label}</strong>
            <span>{asset.format.toUpperCase()} · {asset.bytes.toLocaleString()} bytes · {asset.legacy_source_ids?.join(', ')}</span>
            <code>{asset.sha256.slice(0, 20)}</code>
          </div>
        ))}
      </div>
    </div>
  )
}
