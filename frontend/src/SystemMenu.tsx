import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronUp, Power, RefreshCw, RotateCcw, X } from 'lucide-react'
import { apiRequest, errorMessage } from './apiClient'
import { Presence, Reveal } from './Motion'

type Info = {version: string; revision: string; built_at: string | null; instance_id: string; can_manage: boolean; unavailable_reason: string; pending: string | null}
type Action = 'exit' | 'restart'
function date(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '源码运行 · 尚未打包'
  return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(value))
}

export default function SystemMenu({auth, local, connected, dirty, onStateChange}: {auth: boolean; local: boolean; connected: boolean; dirty: boolean; onStateChange: (state: 'running' | 'exit' | 'restart') => void}) {
  const [info, setInfo] = useState<Info | null>(null), [readError, setReadError] = useState('')
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Action | null>(null)
  const [error, setError] = useState(''), [progress, setProgress] = useState('')
  const root = useRef<HTMLDivElement>(null), dialog = useRef<HTMLElement>(null), request = useRef(false)
  const original = useRef(''), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => {mounted.current = false} }, [])
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const next = await apiRequest<Info>('/api/system', {operation: '读取控制台版本', timeoutMs: 3000})
        if (typeof next.version !== 'string' || typeof next.instance_id !== 'string') throw new Error('后台尚不支持版本与退出菜单，请更新后台程序。')
        if (!cancelled) {
          setInfo(next); setReadError('')
          if (pending === 'restart' && original.current && next.instance_id !== original.current) {
            setPending(null); setProgress(''); setConfirm(null); onStateChange('running')
          }
        }
      } catch (error) { if (!cancelled && !pending) setReadError(errorMessage(error, '读取控制台版本失败')) }
      finally { if (!cancelled) timer = setTimeout(read, pending ? 1000 : 10000) }
    }
    void read()
    return () => {cancelled = true; clearTimeout(timer)}
  }, [pending, onStateChange])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {if (!root.current?.contains(event.target as Node)) setOpen(false)}
    const key = (event: KeyboardEvent) => {if (event.key === 'Escape') setOpen(false)}
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => {
    if (!confirm || busy || pending) return
    const previous = document.activeElement
    const buttons = () => [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    buttons()[0]?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {setConfirm(null); return}
      if (event.key === 'Tab') {
        const items = buttons(), first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus()}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus()}
      }
    }
    document.addEventListener('keydown', key)
    return () => {document.removeEventListener('keydown', key); if (previous instanceof window.HTMLElement && previous.isConnected) previous.focus()}
  }, [confirm, busy, pending])
  const reason = !local ? '仅运行控制台的本机可操作' : !auth ? '需要操作员权限' : !connected || readError ? '后台状态未确认' : !info?.can_manage ? info?.unavailable_reason || '正在读取后台能力' : ''
  async function control() {
    if (!confirm || reason || request.current) return
    request.current = true; setBusy(true); setError('')
    const action = confirm
    try {
      original.current = info?.instance_id ?? ''
      await apiRequest('/api/system/control', {method: 'POST', body: JSON.stringify({action}), operation: action === 'exit' ? '退出控制台' : '重启控制台', timeoutMs: 30000})
      if (mounted.current) {
        setPending(action); onStateChange(action)
        setProgress(action === 'exit' ? '退出请求已接受。后台停止后，本页可以关闭；下次从桌面入口启动。' : '正在重启后台，页面会在新进程就绪后自动恢复。')
      }
    } catch (error) { if (mounted.current) setError(errorMessage(error, '退出或重启未确认，请检查后台状态；不要重复提交。')) }
    finally {request.current = false; if (mounted.current) setBusy(false)}
  }
  return <div className="system-menu" ref={root}>
    <Reveal open={open} id="console-system-menu" className="system-menu-reveal"><div className="system-menu-options">
      <button disabled={!!reason || busy || !!pending} onClick={() => {setOpen(false); setConfirm('restart'); setError('')}}><RotateCcw size={16}/>重启控制台</button>
      <button className="system-menu-exit" disabled={!!reason || busy || !!pending} onClick={() => {setOpen(false); setConfirm('exit'); setError('')}}><Power size={16}/>退出控制台</button>
      {reason && <p>{reason}</p>}{readError && <p role="alert">{readError}</p>}
    </div></Reveal>
    <button className="system-menu-trigger" aria-label="控制台退出与重启菜单" aria-expanded={open} aria-controls="console-system-menu" onClick={() => setOpen(value => !value)} title={info ? `v${info.version} · ${info.revision}\n构建于 ${date(info.built_at)}（北京时间）` : '正在读取版本'}><Power size={17}/><span>控制台</span><ChevronUp size={15}/></button>
    <div className="system-build" title={info ? `${info.revision} · 北京时间` : readError}><b>{info ? `v${info.version}` : '版本未读取'}</b><span>{info ? date(info.built_at) : '等待后台'}</span></div>
    {createPortal(<Presence show={!!confirm}><div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={confirm === 'exit' ? '退出控制台确认' : '重启控制台确认'}><section ref={dialog} className="login-card glass-panel system-confirm">
      {!busy && !pending && <button className="icon-button modal-close" aria-label="取消退出或重启" onClick={() => setConfirm(null)}><X size={17}/></button>}
      <div className="brand-mark brand-mark--large">{confirm === 'restart' ? <RotateCcw size={24}/> : <Power size={24}/>}</div><h2>{pending ? confirm === 'restart' ? '正在重启控制台' : '退出请求已接受' : confirm === 'restart' ? '重启控制台？' : '退出控制台？'}</h2>
      <p>{pending ? progress : '将停止位移台、请求关闭阀门与调试输出，并停止后台监测。重启后需要重新启用联锁和连接位移台。'}</p>
      {!pending && dirty && <p className="inline-error">有未保存的设置，退出或重启会丢弃这些更改。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {pending === 'restart' && <p className="system-restarting" role="status"><RefreshCw size={16}/>等待新后台就绪；若一直未恢复，请从桌面入口检查启动错误。</p>}
      {!pending && <div className="system-confirm-actions"><button className="button button--quiet" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className={`button ${confirm === 'exit' ? 'button--danger-soft' : 'button--primary'}`} disabled={!!reason || busy} onClick={() => void control()}>{busy ? '正在停止设备…' : confirm === 'restart' ? '确认重启' : '确认退出'}</button></div>}
      {pending === 'exit' && <button className="button button--quiet" onClick={() => setConfirm(null)}>关闭提示</button>}
    </section></div></Presence>, document.body)}
  </div>
}
