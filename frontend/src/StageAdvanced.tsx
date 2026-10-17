import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Gauge, Home, Power, RefreshCw, SlidersHorizontal, WandSparkles, X } from 'lucide-react'
import { Disclosure, Presence } from './Motion'
import { AXES, type Axis, type DriveParameters, type ParameterState, type StageState } from './stageClient'
import { errorMessage } from './apiClient'

type Props = {
  state: StageState; auth: boolean; online: boolean; busy: boolean; uncertain: boolean
  onAct: (path: string, body?: unknown, message?: string) => Promise<void>
  onParameters: (axis: Axis, values?: DriveParameters) => Promise<ParameterState>
}
const FIELDS: {key: keyof DriveParameters; label: string; unit: string}[] = [
  {key: 'forward_amplitude', label: '正向驱动幅值', unit: '%'},
  {key: 'reverse_amplitude', label: '反向驱动幅值', unit: '%'},
  {key: 'step_rate', label: '步频', unit: '步/秒'},
  {key: 'acceleration', label: '步频加速度', unit: '步/秒²'},
]

export default function StageAdvanced({state, auth, online, busy, uncertain, onAct, onParameters}: Props) {
  const [axis, setAxis] = useState<Axis>('x')
  const [parameters, setParameters] = useState<ParameterState | null>(null)
  const [draft, setDraft] = useState<Record<keyof DriveParameters, string> | null>(null)
  const [error, setError] = useState(''), [feedback, setFeedback] = useState('')
  const [confirm, setConfirm] = useState<'zero' | 'optimize' | 'recover' | null>(null)
  const [stationary, setStationary] = useState(false)
  const epoch = useRef(0), parameterRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)
  const identity = JSON.stringify([axis, state.config.mode, state.config.serial_number, state.config.axes, state.config.inverted, state.connected])
  useEffect(() => {
    epoch.current++
    // eslint-disable-next-line react/set-state-in-effect -- Device/axis changes revoke parameter drafts and confirmations.
    setParameters(null); setDraft(null); setError(''); setFeedback(''); setConfirm(null); setStationary(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- This is a request generation, not a DOM ref.
    return () => { epoch.current++ }
  }, [identity])
  useEffect(() => {
    if (!confirm) return
    const previous = document.activeElement
    const buttons = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
    buttons()[0]?.focus()
    function modalKeys(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); setConfirm(null); return }
      if (event.key !== 'Tab') return
      const items = buttons(), first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', modalKeys)
    return () => { document.removeEventListener('keydown', modalKeys); if (previous instanceof window.HTMLElement && previous.isConnected) previous.focus() }
  }, [confirm])
  const row = state.channels.find(item => item.channel === state.config.axes[axis])
  const idle = state.channels.length === 3 && state.channels.every(item => item.moving === false && !item.optimizing)
  const available = auth && online && state.connected && !busy && !uncertain && !state.error && idle && !state.motion_pending && !!row?.ready
  const canReadParameters = auth && online && state.connected && !busy && !uncertain && idle && !state.motion_pending && !!row?.ready
  const blocked = !auth ? '登录后可操作' : !online ? '后台状态已过期' : busy ? '请求处理中' : !state.connected ? '控制器未连接' : uncertain ? '操作结果未确认，请先停止' : state.error || (state.motion_pending || !idle ? '运动或优化尚未结束，可使用全部停止' : !row?.ready ? row?.error || '此轴未就绪' : '')
  const dirty = draft && parameters && FIELDS.some(({key}) => draft[key] !== String(parameters.values[key]))
  const invalid = !draft || !parameters || FIELDS.some(({key}) => {
    const value = Number(draft[key]), bounds = parameters.limits[key]
    return !draft[key].trim() || !Number.isSafeInteger(value) || bounds.min != null && value < bounds.min || bounds.max != null && value > bounds.max
  })
  async function readOrApply(apply = false) {
    if (!(apply ? available : canReadParameters) || parameterRef.current || apply && (!draft || invalid || !dirty)) return
    parameterRef.current = true
    const mine = epoch.current
    setError(''); setFeedback('')
    try {
      const next = await onParameters(axis, apply ? Object.fromEntries(FIELDS.map(({key}) => [key, Number(draft![key])])) as DriveParameters : undefined)
      if (mine === epoch.current) {
        setParameters(next); setDraft(Object.fromEntries(FIELDS.map(({key}) => [key, String(next.values[key])])) as Record<keyof DriveParameters, string>)
        setFeedback(apply ? '参数已应用并读回；未自动运动，也未写入闪存。' : '已读取当前控制器参数。')
      }
    } catch (e) { if (mine === epoch.current) setError(errorMessage(e, apply ? '参数应用未确认，请重新读取核对' : '读取驱动参数失败')) }
    finally { parameterRef.current = false }
  }
  async function confirmedAction() {
    if (!confirm || busy) return
    const operation = confirm
    if (operation === 'recover' ? !auth || !online || !stationary : !available) return
    setConfirm(null)
    await onAct(operation === 'recover' ? '/recover' : '/action', operation === 'recover' ? {confirmed_stationary: true} : {axis, operation, confirmed: true},
      operation === 'zero' ? '开环计数清零请求已下发；未寻找机械原点。' : operation === 'optimize' ? '性能优化请求已下发，等待控制器状态；可随时全部停止。' : '连接已恢复，请核对通道状态。')
  }
  return <section className="content-panel glass-panel stage-advanced">
    <div className="panel-heading"><div><h2><SlidersHorizontal size={17}/>控制器工具</h2><p className="stage-note">输出使能 · Home / Zero · Optimize · 驱动参数</p></div>
      <label className="field stage-tool-axis">操作轴<select aria-label="控制器工具操作轴" value={axis} disabled={busy} onChange={event => setAxis(event.target.value as Axis)}>{AXES.map(value => <option key={value} value={value}>{value.toUpperCase()} / CH{state.config.axes[value]}</option>)}</select></label>
    </div>
    <div className="stage-tool-status"><span>{row?.stage || '未识别'}</span><span>输出：{state.connected && online ? row?.enabled ? '已使能' : '未使能' : '未知'}</span><span>优化：{row?.optimizing || state.operation?.axis === axis ? '进行中 / 等待确认' : row?.optimized ? '控制器已返回优化标志' : '未返回优化标志'}</span>
      <span>开环命令计数：<b>{state.connected && online && row?.command_count != null ? row.command_count : '—'}</b>（非实测位置）</span>
    </div>
    <div className="stage-tool-actions">
      <button className="button button--quiet" aria-label={`${axis.toUpperCase()} 轴启用输出`} disabled={!available || row?.enabled} onClick={() => void onAct('/action', {axis, operation:'enable'}, '输出启用请求已下发。')}><Power size={15}/>启用输出</button>
      <button className="button button--quiet" aria-label={`${axis.toUpperCase()} 轴禁用输出`} disabled={!available || !row?.enabled} onClick={() => void onAct('/action', {axis, operation:'disable'}, '输出禁用请求已下发。')}><Power size={15}/>禁用输出</button>
      <button className="button button--quiet" disabled={!available || row?.open_loop === false} onClick={() => setConfirm('zero')}><Home size={15}/>Home / Zero · 计数清零</button>
      <button className="button button--quiet" disabled={!available || !row?.enabled || row?.open_loop === false} onClick={() => setConfirm('optimize')}><WandSparkles size={15}/>Optimize · 性能优化</button>
    </div>
    {blocked && <p className="stage-note">{blocked}</p>}
    <p className="stage-tool-explanation">PD1V/M 使用开环控制：Home / Zero 只清零计数。性能优化会驱动位移台自动运动，不受单次点动步数上限限制。</p>
    <Disclosure title="驱动参数 · 幅值、步频与加速度" className="stage-parameter-disclosure">
      <div className="stage-parameter-actions"><button className="button button--quiet" disabled={!canReadParameters} onClick={() => void readOrApply()}><RefreshCw size={14}/>读取当前参数</button>{dirty && <span className="subtle-note">有未应用的参数</span>}</div>
      {draft && parameters ? <div className="stage-parameter-grid">{FIELDS.map(({key,label,unit}) => <label className="field" key={key}>{label}（{unit}）<input type="number" aria-label={label} value={draft[key]} disabled={!available} min={parameters.limits[key].min ?? undefined} max={parameters.limits[key].max ?? undefined} step={1} onChange={event => setDraft({...draft,[key]:event.target.value})}/><small>控制器范围：{parameters.limits[key].min ?? '—'}–{parameters.limits[key].max ?? '—'}</small></label>)}</div> : <p className="stage-note">先读取当前轴参数，再调整。切换轴或重新连接后需要重新读取。</p>}
      {draft && <div className="stage-parameter-actions"><button className="button button--primary" disabled={!available || invalid || !dirty} onClick={() => void readOrApply(true)}>应用驱动参数</button>{invalid && <span className="inline-error">参数必须为控制器范围内的整数。</span>}</div>}
      <p className="stage-note">参数只应用于当前控制器，不改现场连接配置，不自动执行点动或优化。应用失败时请重新读取，确认是否部分生效。</p>
      {error && <p className="inline-error" role="alert">{error}</p>}{feedback && <p className="stage-message" role="status">{feedback}</p>}
    </Disclosure>
    <Disclosure title="连接诊断与恢复" className="stage-diagnostics">
      <div className="stage-diagnostic-grid"><span>通道：{state.diagnostics?.transport || state.config.connection?.toUpperCase() || 'TCP'}</span><span>采样耗时：{state.diagnostics?.latency_ms ?? '—'} ms</span><span>连续读取失败：{state.diagnostics?.read_failures ?? 0}</span><span>有效采样：{state.diagnostics?.sample_count ?? 0}</span></div>
      <p className="stage-note">XA 与控制台应轮流连接。关闭 XA 窗口后若仍有残留进程，也可能占用连接。读取异常暂停操作；控制动作不会自动重发。</p>
      <div className="stage-tool-actions"><button className="button button--quiet" disabled={!auth || !online || busy || !state.connected} onClick={() => void onAct('/disconnect', {}, '位移台已断开。')}><Gauge size={14}/>断开控制器</button>
      <button className="button button--quiet" disabled={!auth || !online || busy || state.connected || !state.error && !state.diagnostics?.recovery_required} onClick={() => {setStationary(false);setConfirm('recover')}}>恢复失效连接</button></div>
    </Disclosure>
    {createPortal(<Presence show={!!confirm}>{confirm && <div className="modal-backdrop stage-tool-modal"><section ref={dialogRef} className="login-card glass-panel" role="dialog" aria-modal="true" aria-label={confirm === 'zero' ? '确认开环计数清零' : confirm === 'optimize' ? '确认性能优化' : '确认恢复连接'}>
      <button className="icon-button modal-close" aria-label="取消控制器操作" onClick={() => setConfirm(null)}><X size={17}/></button>
      <h2>{confirm === 'zero' ? `${axis.toUpperCase()} / CH${state.config.axes[axis]} 开环计数清零` : confirm === 'optimize' ? `${axis.toUpperCase()} / CH${state.config.axes[axis]} 性能优化` : '恢复失效连接'}</h2>
      <p>{confirm === 'zero' ? '这会把控制器的开环命令计数设为零，不会寻找机械原点，也不会测量当前位置。' : confirm === 'optimize' ? '控制器会自动驱动此轴，通常约 1–2 分钟；实际行程由控制器算法决定，不受点动步数上限限制。请确认负载、行程空间和接线，可随时使用全部停止。' : '仅在现场确认位移台已经静止后释放失效会话并重新连接。必要时先断电重启控制器；恢复不会启用输出或重发之前的动作。'}</p>
      {confirm === 'recover' && <label className="check-row"><input type="checkbox" checked={stationary} onChange={event => setStationary(event.target.checked)}/>我已现场确认位移台静止</label>}
      <div className="stage-tool-actions"><button className="button button--quiet" onClick={() => setConfirm(null)}>取消</button><button className="button button--primary" disabled={busy || (confirm === 'recover' ? !auth || !online || !stationary : !available)} onClick={() => void confirmedAction()}>{confirm === 'zero' ? '确认清零' : confirm === 'optimize' ? '确认开始优化' : '确认恢复连接'}</button></div>
    </section></div>}</Presence>, document.body)}
  </section>
}
