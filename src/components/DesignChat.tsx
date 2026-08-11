import { CheckCircle2, MessageCircle, Plus, ReceiptText, Send, X } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { studioApi } from '../api'
import { polygonSignedArea } from '../spec'
import type { ChatSession, ChatSessionSummary, DesignChatResponse, RoomSpec } from '../types'

type DesignChatProps = {
  open: boolean
  projectId: string | null
  room: RoomSpec | null
  onClose: () => void
  onQuote?: (quote: DesignChatResponse | null, notify?: boolean) => void
}

function shortTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function quoteLineLabel(line: DesignChatResponse['material_quotes'][number]) {
  const name = line.材料名称 ?? line.家具名称 ?? line.材料编号
  const quantity = line.采购量 ?? line.数量 ?? 0
  const subtotal = line.材料小计 ?? line.家具小计 ?? 0
  return { name, quantity, unit: line.单位, price: line.单价, subtotal }
}

function QuoteDetails({ quote }: { quote: DesignChatResponse }) {
  const materials = quote.material_quotes.map(quoteLineLabel)
  const furniture = quote.furniture_quotes.map(quoteLineLabel)
  return <div className="quote-detail" data-testid="quote-summary">
    <div className="quote-detail-heading"><ReceiptText size={14} /><strong>结构化报价明细</strong><span>{quote.pricing_status === 'final' ? '需求确认版' : '候选区间'}</span></div>
    <div className="quote-detail-lines">
      {materials.map((line, index) => <div className="quote-detail-row" key={`material-${index}`}><span>{line.name}</span><small>{line.quantity} {line.unit} × ¥{line.price.toLocaleString('zh-CN')}</small><b>¥{line.subtotal.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b></div>)}
      {furniture.map((line, index) => <div className="quote-detail-row" key={`furniture-${index}`}><span>{line.name}</span><small>{line.quantity} {line.unit} × ¥{line.price.toLocaleString('zh-CN')}</small><b>¥{line.subtotal.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b></div>)}
      {!materials.length && !furniture.length && <div className="quote-detail-empty">暂未匹配到有价格的目录产品</div>}
    </div>
    <div className="quote-detail-totals">
      <span>材料合计 <b>¥{quote.material_total.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b></span>
      <span>家具合计 <b>¥{(quote.furniture_total ?? quote.furniture_price_range.min).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b></span>
      <strong>报价合计 ¥{(quote.quote_total ?? quote.total_price_range.min).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</strong>
    </div>
    <div className="quote-detail-note"><CheckCircle2 size={12} />{quote.pricing_status === 'final' ? '金额由服务端目录、量房采购量和已选品类确定性计算' : `家具候选区间 ¥${quote.furniture_price_range.min.toFixed(2)}–¥${quote.furniture_price_range.max.toFixed(2)}`}</div>
  </div>
}

export function DesignChat({ open, projectId, room, onClose, onQuote }: DesignChatProps) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const roomArea = useMemo(() => room && room.boundary.length > 2 ? Math.abs(polygonSignedArea(room.boundary)) / 1_000_000 : null, [room])

  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setActiveSession(null)
    void studioApi.chatSessions(projectId).then(async (items) => {
      if (cancelled) return
      let summaries = items
      let session: ChatSession
      if (items.length) session = await studioApi.chatSession(projectId, items[0].id)
      else {
        session = await studioApi.createChatSession(projectId)
        summaries = [{ id: session.id, project_id: session.project_id, title: session.title, message_count: session.message_count, last_message: session.last_message, created_at: session.created_at, updated_at: session.updated_at }]
      }
      if (cancelled) return
      setSessions(summaries)
      setActiveSession(session)
      const latestQuote = [...session.messages].reverse().find((message) => message.quote)?.quote ?? null
      onQuote?.(latestQuote, false)
    }).catch((reason: Error) => {
      if (!cancelled) setError(reason.message)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, projectId, onQuote])

  useEffect(() => {
    const node = messagesRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [activeSession?.messages.length, sending])

  if (!open) return null

  async function createSession() {
    if (!projectId || loading || sending) return
    setLoading(true); setError(null)
    try {
      const session = await studioApi.createChatSession(projectId)
      setSessions((current) => [{ id: session.id, project_id: session.project_id, title: session.title, message_count: session.message_count, last_message: session.last_message, created_at: session.created_at, updated_at: session.updated_at }, ...current])
      setActiveSession(session)
      onQuote?.(null, false)
    } catch (reason) {
      setError((reason as Error).message)
    } finally { setLoading(false) }
  }

  async function selectSession(sessionId: string) {
    if (!projectId || loading || sending || sessionId === activeSession?.id) return
    setLoading(true); setError(null)
    try {
      const session = await studioApi.chatSession(projectId, sessionId)
      setActiveSession(session)
      const latestQuote = [...session.messages].reverse().find((message) => message.quote)?.quote ?? null
      onQuote?.(latestQuote, false)
    } catch (reason) {
      setError((reason as Error).message)
    } finally { setLoading(false) }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const content = input.trim()
    if (!content || !projectId || !activeSession || sending || !room) return
    setInput(''); setSending(true); setError(null)
    try {
      const session = await studioApi.sendChatMessage(projectId, activeSession.id, content, room)
      setActiveSession(session)
      setSessions((current) => current.map((item) => item.id === session.id ? { id: session.id, project_id: session.project_id, title: session.title, message_count: session.message_count, last_message: session.last_message, created_at: session.created_at, updated_at: session.updated_at } : item).sort((a, b) => b.updated_at.localeCompare(a.updated_at)))
      const latestQuote = [...session.messages].reverse().find((message) => message.quote)?.quote
      if (latestQuote) onQuote?.(latestQuote, true)
    } catch (reason) {
      setInput(content); setError((reason as Error).message)
    } finally { setSending(false) }
  }

  const currentQuote = [...(activeSession?.messages ?? [])].reverse().find((message) => message.quote)?.quote ?? null

  return <aside className="design-chat" aria-label="小和需求助手">
    <header><span><MessageCircle size={17} />小和需求助手</span><div className="chat-header-session">{activeSession?.title ?? '项目对话'}</div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
    <div className="chat-workspace">
      <nav className="chat-history" aria-label="历史对话">
        <button className="button primary chat-new" onClick={() => void createSession()} disabled={loading || sending || !projectId}><Plus size={14} />新建对话</button>
        <div className="chat-history-list">
          {sessions.map((session) => <button key={session.id} className={session.id === activeSession?.id ? 'chat-history-item active' : 'chat-history-item'} onClick={() => void selectSession(session.id)} disabled={loading || sending} aria-current={session.id === activeSession?.id ? 'page' : undefined}><strong>{session.title}</strong><small>{session.last_message || '尚未开始'}</small><time>{shortTime(session.updated_at)}</time></button>)}
          {!sessions.length && !loading && <span className="chat-history-empty">还没有历史对话</span>}
        </div>
      </nav>
      <section className="chat-thread">
        <div className="chat-thread-context">
          <div>{roomArea === null ? '尚无可用量房轮廓，请先在主界面完成量房。' : `已读取主界面量房：地面 ${roomArea.toFixed(2)}㎡ · 层高 ${room?.height_mm ? `${(room.height_mm / 1000).toFixed(2)}m` : '待确认'} · ${room?.openings.length ?? 0} 个门窗洞口`}</div>
          {currentQuote && <>
            <div>量房面积：墙面 {currentQuote.surfaces.wall_net_area_sqm?.toFixed(2) ?? '待确认'}㎡ · 吊顶 {currentQuote.surfaces.ceiling_area_sqm.toFixed(2)}㎡ · 地面 {currentQuote.surfaces.floor_area_sqm.toFixed(2)}㎡</div>
            <div>需求采集：{currentQuote.requirements.complete ? '已完整，已生成报价' : `还需确认 ${currentQuote.requirements.missing_fields.join('、')}`}</div>
            {currentQuote.style_match.catalog_style && <div>风格归一：{currentQuote.style_match.user_terms.join('、')} → {currentQuote.style_match.catalog_style}</div>}
          </>}
          {error && <div className="chat-error">{error}</div>}
        </div>
        <div className="chat-messages" ref={messagesRef} aria-live="polite">
          {activeSession?.messages.map((message) => <div key={message.id} className={`chat-message ${message.role}`}><div>{message.content}</div>{message.quote?.requirements.complete && <QuoteDetails quote={message.quote} />}</div>)}
          {loading && !activeSession && <div className="chat-message assistant">正在打开项目对话…</div>}
          {sending && <div className="chat-message assistant">正在核对需求与知识图谱约束…</div>}
        </div>
        <form onSubmit={submit}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="描述家庭成员、功能、风格和预算…" rows={3} disabled={loading || sending || !activeSession} /><button className="button primary" disabled={sending || loading || !input.trim() || !room || !activeSession}><Send size={15} />发送</button></form>
        <small className="chat-footnote">完整需求会生成服务端确定的材料与家具结构化报价；后续布局可继续调整空间方案。</small>
      </section>
    </div>
  </aside>
}
