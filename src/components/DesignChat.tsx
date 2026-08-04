import { FormEvent, useState } from 'react'
import { MessageCircle, Send, X } from 'lucide-react'
import { studioApi } from '../api'
import type { ChatMessage, RoomSpec } from '../types'
function area(points:RoomSpec['boundary']){return Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x_mm*q.z_mm-q.x_mm*p.z_mm},0))/2/1e6}
export function DesignChat({open,room,onClose}:{open:boolean;room:RoomSpec|null;onClose:()=>void}){
 const roomArea=room&&room.boundary.length>2?area(room.boundary):null
 const [messages,setMessages]=useState<ChatMessage[]>([{role:'assistant',content:'您好，我是小和。我会直接读取主界面量房数据计算地面、墙面用量；您只需告诉我使用人群、功能、风格和预算。'}]);const [input,setInput]=useState('');const [sending,setSending]=useState(false)
 if(!open)return null
 async function submit(e:FormEvent){e.preventDefault();const content=input.trim();if(!content||sending)return;const next=[...messages,{role:'user' as const,content}];setMessages(next);setInput('');setSending(true);try{const result=await studioApi.designChat(next,room);setMessages([...next,{role:'assistant',content:result.message}])}catch(error){setMessages([...next,{role:'assistant',content:`暂时无法连接设计助手：${(error as Error).message}`}])}finally{setSending(false)}}
 return <aside className="design-chat" aria-label="小和需求助手"><header><span><MessageCircle size={17}/>小和需求助手</span><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17}/></button></header><div className="chat-room-source" data-testid="chat-room-source">{roomArea===null?'尚无可用量房轮廓，请先在主界面完成量房。':`已读取主界面量房：地面 ${roomArea.toFixed(2)}㎡ · 层高 ${room?.height_mm?`${(room.height_mm/1000).toFixed(2)}m`:'待确认'} · ${room?.openings.length??0} 个门窗洞口`}</div><div className="chat-messages" aria-live="polite">{messages.map((m,i)=><div key={i} className={`chat-message ${m.role}`}>{m.content}</div>)}{sending&&<div className="chat-message assistant">正在计算排布、用量与报价…</div>}</div><form onSubmit={submit}><textarea value={input} onChange={e=>setInput(e.target.value)} placeholder="描述家庭成员、功能、风格和预算…" rows={3}/><button className="button primary" disabled={sending||!input.trim()||!room}><Send size={15}/>发送</button></form><small>面积来自当前量房数据；用量含默认 10% 直铺损耗，成交前请复尺并核对包装规格。</small></aside>
}
