import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Gauge, Home, Power, RefreshCw, SlidersHorizontal, Upload, WandSparkles, X } from 'lucide-react'
import { Disclosure, Presence } from './Motion'
import { AXES, type Axis, type DriveParameters, type ParameterState, type StageState } from './stageClient'
import { errorMessage } from './apiClient'
import { makeStageProfile, parseStageProfile } from './stageProfiles'
import StageToolHistory from './StageToolHistory'

type Props = {
  state: StageState; auth: boolean; online: boolean; busy: boolean; uncertain: boolean
  onAct: (path: string, body?: unknown, message?: string) => Promise<void>
  onParameters: (axis: Axis, values?: DriveParameters) => Promise<ParameterState>
  historyVersion: number
  // Share confirmations while placing channel actions inside the workbench cards.
  children: (axisTools: (axis: Axis) => ReactNode, utilities: ReactNode) => ReactNode
}
const FIELDS: {key: keyof DriveParameters; label: string; unit: string}[] = [
  {key: 'forward_amplitude', label: '正向驱动幅值', unit: '%'},
  {key: 'reverse_amplitude', label: '反向驱动幅值', unit: '%'},
  {key: 'step_rate', label: '步频', unit: '步/秒'},
  {key: 'acceleration', label: '步频加速度', unit: '步/秒²'},
]
type Confirmation = {operation: 'zero' | 'optimize'; axis: Axis; channel: number; identity: string} | {operation: 'recover'; identity: string}

export default function StageAdvanced({state, auth, online, busy, uncertain, onAct, onParameters, historyVersion, children}: Props) {
  const [axis, setAxis] = useState<Axis>('x')
  const [parameters, setParameters] = useState<ParameterState | null>(null)
  const [draft, setDraft] = useState<Record<keyof DriveParameters, string> | null>(null)
  const [error, setError] = useState(''), [feedback, setFeedback] = useState('')
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [stationary, setStationary] = useState(false)
  const epoch = useRef(0), parameterRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)
  const profileInput = useRef<HTMLInputElement>(null)
  const deviceIdentity = JSON.stringify([state.config.mode, state.config.serial_number, state.config.connection, state.config.host, state.config.port, state.config.axes, state.config.inverted, state.connected])
  const identity = JSON.stringify([axis, deviceIdentity])
  useEffect(() => {
    epoch.current++
    // eslint-disable-next-line react/set-state-in-effect -- Device/axis changes revoke parameter drafts.
    setParameters(null); setDraft(null); setError(''); setFeedback('')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- This is a request generation, not a DOM ref.
    return () => { epoch.current++ }
  }, [identity])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Device/mapping changes revoke hardware confirmations.
    setConfirm(null); setStationary(false)
  }, [deviceIdentity])
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
  function blockedFor(targetAxis: Axis) {
    const target = state.channels.find(item => item.channel === state.config.axes[targetAxis])
    return !auth ? '登录后可操作' : !online ? '后台状态已过期' : busy ? '请求处理中' : !state.connected ? '控制器未连接' : uncertain ? '操作结果未确认，请先停止' : state.error || (state.motion_pending || !idle ? '运动或优化尚未结束，可使用全部停止' : !target?.ready ? target?.error || '此通道未就绪' : '')
  }
  const available = auth && online && state.connected && !busy && !uncertain && !state.error && idle && !state.motion_pending && !!row?.ready
  const canReadParameters = auth && online && state.connected && !busy && !uncertain && idle && !state.motion_pending && !!row?.ready
  const confirmRow = confirm && confirm.operation !== 'recover' ? state.channels.find(item => item.channel === confirm.channel) : null
  const canConfirm = confirm?.identity === deviceIdentity && (confirm.operation === 'recover' ? auth && online && !busy && stationary && (state.motion_pending || state.diagnostics?.motion_locked) :
    !blockedFor(confirm.axis) && confirm.channel === state.config.axes[confirm.axis] && confirmRow?.open_loop !== false && (confirm.operation !== 'optimize' || !!confirmRow?.enabled))
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
        setFeedback(apply ? '参数已应用并读回；未自动运动，未调用额外保存到设备命令。' : '已读取当前控制器参数。')
      }
    } catch (e) { if (mine === epoch.current) setError(errorMessage(e, apply ? '参数应用未确认，请重新读取核对' : '读取驱动参数失败')) }
    finally { parameterRef.current = false }
  }
  async function confirmedAction() {
    if (!confirm || !canConfirm) return
    const {operation} = confirm
    const channelLabel = confirm.operation === 'recover' ? '' : `${confirm.axis.toUpperCase()} / CH${confirm.channel} `
    setConfirm(null)
    await onAct(operation === 'recover' ? '/recover' : '/action', confirm.operation === 'recover' ? {confirmed_stationary: true} : {axis: confirm.axis, operation, confirmed: true},
      operation === 'zero' ? `${channelLabel}开环命令计数已读回零；未寻找机械原点。` : operation === 'optimize' ? `${channelLabel}性能优化请求已下发，等待控制器状态；可随时全部停止。` : '运动锁定已解除。')
  }
  async function importProfile(file?: File) {
    if (!file || !parameters || !available) return
    const mine = epoch.current
    try {
      if (file.size > 16384) throw new Error('参数文件过大，最大 16 KB。')
      const values = parseStageProfile(await file.text(), parameters)
      if (mine !== epoch.current) return
      setDraft(Object.fromEntries(FIELDS.map(({key}) => [key, String(values[key])])) as Record<keyof DriveParameters, string>)
      setError(''); setFeedback('已载入参数预览，请核对当前轴和各项数值，再点击“应用驱动参数”；尚未发送给控制器。')
    } catch (e) { if (mine === epoch.current) { setFeedback(''); setError(errorMessage(e, '读取参数文件失败')) } }
  }
  function exportProfile() {
    if (!parameters) return
    const blob = new Blob([makeStageProfile(parameters.values, {serial_number: state.config.serial_number, channel: state.config.axes[axis], stage: row?.stage ?? ''})], {type: 'application/json'})
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = `PDXC3-${state.config.serial_number || 'simulation'}-CH${state.config.axes[axis]}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setFeedback('已导出最近读回的控制器参数；未导出未应用的修改。')
  }
  function renderAxisTools(targetAxis: Axis) {
    const channel = state.config.axes[targetAxis], target = state.channels.find(item => item.channel === channel)
    const blocked = blockedFor(targetAxis), channelAvailable = !blocked
    const operation = state.operation?.kind === 'optimize' && state.operation.axis === targetAxis ? state.operation : null
    return <>
        {operation && <div className="stage-optimization-progress" role="status"><WandSparkles size={19}/><div><strong>{targetAxis.toUpperCase()} / CH{operation.channel} · 性能优化{!online || !state.connected || state.error ? '结果未确认' : operation.phase === 'running' ? '进行中' : '等待控制器开始'}</strong><p>{!online || !state.connected || state.error ? '通信或状态读取异常，不能确认优化进度或停止结果。禁止继续移动或重复优化，请检查控制器状态。' : <>已等待 {Math.floor(operation.elapsed_s ?? 0)} 秒 · 通常约 1–2 分钟。请保持连接，可随时使用顶部“全部停止”。</>}</p><small>仅显示控制器状态与等待时间，不推算完成百分比。</small></div></div>}
        <div className="stage-tool-actions">
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴启用输出`} disabled={!channelAvailable || target?.enabled} onClick={() => void onAct('/action', {axis: targetAxis, operation:'enable'}, `${targetAxis.toUpperCase()} / CH${channel} 输出启用请求已下发。`)}><Power size={15}/>启用输出</button>
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴禁用输出`} disabled={!channelAvailable || !target?.enabled} onClick={() => void onAct('/action', {axis: targetAxis, operation:'disable'}, `${targetAxis.toUpperCase()} / CH${channel} 输出禁用请求已下发。`)}><Power size={15}/>禁用输出</button>
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴 Home / Zero · 计数清零`} disabled={!channelAvailable || target?.open_loop === false} onClick={() => setConfirm({operation: 'zero', axis: targetAxis, channel, identity: deviceIdentity})}><Home size={15}/>Home / Zero · 计数清零</button>
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴 Optimize · 性能优化`} disabled={!channelAvailable || !target?.enabled || target?.open_loop === false} onClick={() => setConfirm({operation: 'optimize', axis: targetAxis, channel, identity: deviceIdentity})}><WandSparkles size={15}/>Optimize · 性能优化</button>
        </div>
        {!blocked && !target?.enabled && <p className="stage-note">性能优化不可用：请先启用此通道输出。</p>}
        {!blocked && target?.open_loop === false && <p className="stage-note">Home / Zero 和 Optimize 不可用：此通道不是开环模式。</p>}
    </>
  }
  return <>{children(renderAxisTools, <div id="stage-controller-tools" tabIndex={-1} className="stage-advanced">
    <h3 className="stage-utilities-heading"><SlidersHorizontal size={16}/>参数与诊断</h3>
    <Disclosure title="驱动参数 · 幅值、步频与加速度" className="stage-parameter-disclosure">
      <label className="field stage-tool-axis">参数通道<select aria-label="驱动参数通道" value={axis} disabled={busy} onChange={event => setAxis(event.target.value as Axis)}>{AXES.map(value => <option key={value} value={value}>{value.toUpperCase()} / CH{state.config.axes[value]}</option>)}</select></label>
      <div className="stage-parameter-actions"><button className="button button--quiet" disabled={!canReadParameters} onClick={() => void readOrApply()}><RefreshCw size={14}/>读取当前参数</button>{dirty && <span className="subtle-note">有未应用的参数</span>}</div>
      <div className="stage-parameter-actions"><button className="button button--quiet" disabled={!parameters || !available} onClick={exportProfile}><Download size={14}/>导出已读参数</button><button className="button button--quiet" disabled={!parameters || !available} onClick={() => profileInput.current?.click()}><Upload size={14}/>导入参数预览</button><input ref={profileInput} aria-label="导入 PDXC3 驱动参数文件" type="file" accept=".json,application/json" hidden onChange={event => { void importProfile(event.target.files?.[0]); event.target.value = '' }}/></div>
      {draft && parameters ? <div className="stage-parameter-grid">{FIELDS.map(({key,label,unit}) => <label className="field" key={key}>{label}（{unit}）<input type="number" aria-label={label} value={draft[key]} disabled={!available} min={parameters.limits[key].min ?? undefined} max={parameters.limits[key].max ?? undefined} step={1} onChange={event => setDraft({...draft,[key]:event.target.value})}/><small>控制器范围：{parameters.limits[key].min ?? '—'}–{parameters.limits[key].max ?? '—'}</small></label>)}</div> : <p className="stage-note">先读取当前轴参数，再调整。切换轴或重新连接后需要重新读取。</p>}
      {draft && <div className="stage-parameter-actions"><button className="button button--primary" disabled={!available || invalid || !dirty} onClick={() => void readOrApply(true)}>应用驱动参数</button>{invalid && <span className="inline-error">参数必须为控制器范围内的整数。</span>}</div>}
      <p className="stage-note">参数应用于当前轴；导入只填入预览，核对后再应用。不会自动点动或优化，不额外调用设备保存命令；断电保持行为由固件决定。应用失败时请重新读取，确认是否部分生效。</p>
      {error && <p className="inline-error" role="alert">{error}</p>}{feedback && <p className="stage-message" role="status">{feedback}</p>}
    </Disclosure>
    <Disclosure title="连接诊断与恢复" className="stage-diagnostics">
      <div className="stage-diagnostic-grid"><span>通道：{state.diagnostics?.transport || state.config.connection?.toUpperCase() || 'TCP'}</span><span>采样耗时：{state.diagnostics?.latency_ms ?? '—'} ms</span><span>连续读取失败：{state.diagnostics?.read_failures ?? 0}</span><span>有效采样：{state.diagnostics?.sample_count ?? 0}</span></div>
      <p className="stage-note">XA 与控制台应轮流连接。关闭 XA 窗口后若仍有残留进程，也可能占用连接。读取异常暂停操作；控制动作不会自动重发。</p>
      <div className="stage-tool-actions"><button className="button button--quiet" disabled={!auth || !online || busy || !state.connected} onClick={() => void onAct('/disconnect', {}, '位移台已断开。')}><Gauge size={14}/>断开控制器</button>
      <button className="button button--quiet" disabled={!auth || !online || busy || !state.motion_pending && !state.diagnostics?.motion_locked} onClick={() => {setStationary(false);setConfirm({operation: 'recover', identity: deviceIdentity})}}>解除运动锁定</button></div>
    </Disclosure>
    <StageToolHistory version={historyVersion}/>
    </div>)}
    {createPortal(<Presence show={!!confirm}>{confirm && <div className="modal-backdrop stage-tool-modal"><section ref={dialogRef} className="login-card glass-panel" role="dialog" aria-modal="true" aria-label={confirm.operation === 'zero' ? '确认开环计数清零' : confirm.operation === 'optimize' ? '确认性能优化' : '确认解除运动锁定'}>
      <button className="icon-button modal-close" aria-label="取消控制器操作" onClick={() => setConfirm(null)}><X size={17}/></button>
      <h2>{confirm.operation === 'recover' ? '解除运动锁定' : `${confirm.axis.toUpperCase()} / CH${confirm.channel} ${confirm.operation === 'zero' ? '开环计数清零' : '性能优化'}`}</h2>
      <p>{confirm.operation === 'zero' ? '这只会把此通道的开环命令计数设为零，不会寻找机械原点，也不会测量当前位置。' : confirm.operation === 'optimize' ? '控制器会自动驱动此通道，通常约 1–2 分钟；实际行程由控制器算法决定，不受点动步数上限限制。请确认负载、行程空间和接线，可随时使用全部停止。' : '确认位移台静止后，后台读取全部通道并确认空闲，再解除历史运动锁定；不会启用输出或重发动作。'}</p>
      {confirm.operation === 'recover' && <label className="check-row"><input type="checkbox" checked={stationary} onChange={event => setStationary(event.target.checked)}/>我已现场确认位移台静止</label>}
      <div className="stage-tool-actions"><button className="button button--quiet" onClick={() => setConfirm(null)}>取消</button><button className="button button--primary" disabled={!canConfirm} onClick={() => void confirmedAction()}>{confirm.operation === 'zero' ? '确认清零' : confirm.operation === 'optimize' ? '确认开始优化' : '确认解除运动锁定'}</button></div>
    </section></div>}</Presence>, document.body)}
  </>
}
