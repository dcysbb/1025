import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, Gauge, Home, Power, RefreshCw, SlidersHorizontal, Upload, WandSparkles } from 'lucide-react'
import { Disclosure, Reveal } from './Motion'
import { AXES, type Axis, type DriveParameters, type ParameterState, type StageState } from './stageClient'
import { errorMessage } from './apiClient'
import { makeStageProfile, parseStageProfile } from './stageProfiles'
import StageToolHistory from './StageToolHistory'
import HelpTooltip from './HelpTooltip'

type Props = {
  state: StageState; auth: boolean; online: boolean; busy: boolean; uncertain: boolean
  onAct: (path: string, body?: unknown, message?: string) => Promise<unknown>
  onParameters: (axis: Axis, values?: DriveParameters) => Promise<ParameterState>
  historyVersion: number
  children: (axisTools: (axis: Axis) => ReactNode, utilities: ReactNode) => ReactNode
}
type FIELDS_ITEM = {key: keyof DriveParameters; label: string; unit: string}
const FIELDS: FIELDS_ITEM[] = [
  {key: 'forward_amplitude', label: '正向驱动幅值', unit: '%'},
  {key: 'reverse_amplitude', label: '反向驱动幅值', unit: '%'},
  {key: 'step_rate', label: '步频', unit: '步/秒'},
  {key: 'acceleration', label: '步频加速度', unit: '步/秒²'},
]

export default function StageAdvanced({state, auth, online, busy, uncertain, onAct, onParameters, historyVersion, children}: Props) {
  const [axis, setAxis] = useState<Axis>('x')
  const [parameters, setParameters] = useState<ParameterState | null>(null)
  const [draft, setDraft] = useState<Record<keyof DriveParameters, string> | null>(null)
  const [error, setError] = useState(''), [feedback, setFeedback] = useState('')
  const [paramOpen, setParamOpen] = useState(false)
  const [homeDirections, setHomeDirections] = useState<Partial<Record<Axis, -1 | 1>>>({})
  const epoch = useRef(0), parameterRef = useRef(false)
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
    // eslint-disable-next-line react/set-state-in-effect -- Device/mapping changes revoke local operation state.
    setHomeDirections({})
  }, [deviceIdentity])
  const row = state.channels.find(item => item.channel === state.config.axes[axis])
  const idle = state.channels.length === 3 && state.channels.every(item => item.moving === false && !item.optimizing)
  function blockedFor(targetAxis: Axis) {
    const target = state.channels.find(item => item.channel === state.config.axes[targetAxis])
    return !auth ? '登录后可操作' : !online ? '后台状态已过期' : busy ? '请求处理中' : !state.connected ? '控制器未连接' : uncertain ? '操作结果未确认，请先停止' : state.error || (state.motion_pending || !idle ? '运动或优化尚未结束，可使用全部停止' : !target?.ready ? target?.error || '此通道未就绪' : '')
  }
  const available = auth && online && state.connected && !busy && !uncertain && !state.error && idle && !state.motion_pending && !!row?.ready
  const canReadParameters = available
  // Opening the parameter panel reads the current axis automatically; the old
  // manual "read first" step is gone.
  useEffect(() => {
    if (!paramOpen || !canReadParameters || parameters || parameterRef.current || error) return
    void readOrApply(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Auto-read on open/axis change only.
  }, [paramOpen, identity, canReadParameters, error])
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
        setFeedback(apply ? '参数已应用并读回，并保存到现场配置；重连后自动恢复。' : '已读取当前控制器参数。')
      }
    } catch (e) { if (mine === epoch.current) setError(errorMessage(e, apply ? '参数应用未确认，请重新读取核对' : '读取驱动参数失败')) }
    finally { parameterRef.current = false }
  }
  async function tool(targetAxis: Axis, operation: 'home' | 'optimize') {
    const channel = state.config.axes[targetAxis], target = state.channels.find(item => item.channel === channel)
    if (blockedFor(targetAxis) || !target?.enabled || target.open_loop === false) return
    const body = {axis: targetAxis, operation,
      ...(operation === 'home' ? {home_direction: homeDirections[targetAxis] ?? state.config.home_direction?.[targetAxis] ?? -1} : {})}
    await onAct('/action', body, `${targetAxis.toUpperCase()} / CH${channel} ${operation === 'home' ? '回零' : '性能优化'}请求已下发，可随时全部停止。`)
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
        {operation && <div className="stage-optimization-progress" role="status"><WandSparkles size={19}/><div><strong>{targetAxis.toUpperCase()} / CH{operation.channel} · 性能优化{!online || !state.connected || state.error ? '结果未确认' : operation.phase === 'running' ? '进行中' : '等待控制器开始'}</strong><p>{!online || !state.connected || state.error ? '通信或状态读取异常，不能确认优化进度或停止结果。禁止继续移动或重复优化，请检查控制器状态。' : <>已等待 {Math.floor(operation.elapsed_s ?? 0)} 秒 · 通常约 1–2 分钟。请保持连接，可随时使用顶部“全部停止”。</>}</p><HelpTooltip label="优化进度说明">仅显示控制器状态与等待时间，不推算完成百分比。</HelpTooltip></div></div>}
        <label className="field stage-home-direction">回零方向<select aria-label={`${targetAxis.toUpperCase()} 轴回零方向`} disabled={!channelAvailable} value={homeDirections[targetAxis] ?? state.config.home_direction?.[targetAxis] ?? -1} onChange={event => setHomeDirections(prior => ({...prior, [targetAxis]: Number(event.target.value) as -1 | 1}))}><option value={-1}>负向（−）</option><option value={1}>正向（+）</option></select></label>
        <div className="stage-tool-actions">
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴启用输出`} disabled={!channelAvailable || target?.enabled} onClick={() => void onAct('/action', {axis: targetAxis, operation:'enable'}, `${targetAxis.toUpperCase()} / CH${channel} 输出启用请求已下发。`)}><Power size={15}/>启用输出</button>
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴禁用输出`} disabled={!channelAvailable || !target?.enabled} onClick={() => void onAct('/action', {axis: targetAxis, operation:'disable'}, `${targetAxis.toUpperCase()} / CH${channel} 输出禁用请求已下发。`)}><Power size={15}/>禁用输出</button>
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴 Home · 回零`} disabled={!channelAvailable || target?.open_loop === false || !target?.enabled} onClick={() => void tool(targetAxis, 'home')}><Home size={15}/>Home · 回零</button>
          <button className="button button--quiet" aria-label={`${targetAxis.toUpperCase()} 轴 Optimize · 性能优化`} disabled={!channelAvailable || !target?.enabled || target?.open_loop === false} onClick={() => void tool(targetAxis, 'optimize')}><WandSparkles size={15}/>Optimize · 性能优化</button>
        </div>
        {!blocked && !target?.enabled && <p className="stage-note">回零与性能优化不可用：请先启用此通道输出。</p>}
        {!blocked && target?.open_loop === false && <p className="stage-note">回零和 Optimize 不可用：此通道不是开环模式。</p>}
        <QuickParams axis={targetAxis} state={state} auth={auth} online={online} busy={busy} uncertain={uncertain} onParameters={onParameters}/>
    </>
  }
  return <>{children(renderAxisTools, <div id="stage-controller-tools" tabIndex={-1} className="stage-advanced">
    <h3 className="stage-utilities-heading"><SlidersHorizontal size={16}/>参数与诊断</h3>
    <div className={`disclosure stage-parameter-disclosure`}>
      <button type="button" className="disclosure__toggle" aria-expanded={paramOpen} aria-controls="stage-parameter-panel" onClick={() => setParamOpen(value => !value)}>
        驱动参数 · 幅值、步频与加速度（全部轴逐轴编辑）
      </button>
      <Reveal open={paramOpen} id="stage-parameter-panel">
      <label className="field stage-tool-axis">参数通道<select aria-label="驱动参数通道" value={axis} disabled={busy} onChange={event => setAxis(event.target.value as Axis)}>{AXES.map(value => <option key={value} value={value}>{value.toUpperCase()} / CH{state.config.axes[value]}</option>)}</select></label>
      <div className="stage-parameter-actions"><button className="button button--quiet" disabled={!canReadParameters} onClick={() => void readOrApply()}><RefreshCw size={14}/>重新读取</button>{dirty && <span className="subtle-note">有未应用的参数</span>}</div>
      <div className="stage-parameter-actions"><button className="button button--quiet" disabled={!parameters || !available} onClick={exportProfile}><Download size={14}/>导出已读参数</button><button className="button button--quiet" disabled={!parameters || !available} onClick={() => profileInput.current?.click()}><Upload size={14}/>导入参数预览</button><input ref={profileInput} aria-label="导入 PDXC3 驱动参数文件" type="file" accept=".json,application/json" hidden onChange={event => { void importProfile(event.target.files?.[0]); event.target.value = '' }}/></div>
      {draft && parameters ? <div className="stage-parameter-grid">{FIELDS.map(({key,label,unit}) => <label className="field" key={key}>{label}（{unit}）<input type="number" aria-label={label} value={draft[key]} disabled={!available} min={parameters.limits[key].min ?? undefined} max={parameters.limits[key].max ?? undefined} step={1} onChange={event => setDraft({...draft,[key]:event.target.value})}/><HelpTooltip label={`${label}范围`}>控制器范围：{parameters.limits[key].min ?? '—'}–{parameters.limits[key].max ?? '—'}</HelpTooltip></label>)}</div> : <p className="stage-note">{canReadParameters ? '正在读取当前轴参数…' : '通道就绪且空闲后自动读取；也可点击“重新读取”。'}</p>}
      {draft && <div className="stage-parameter-actions"><button className="button button--primary" disabled={!available || invalid || !dirty} onClick={() => void readOrApply(true)}>应用驱动参数</button>{invalid && <span className="inline-error">参数必须为控制器范围内的整数。</span>}</div>}
      <HelpTooltip label="控制器操作说明">参数应用于当前轴并保存到现场配置，重连后自动恢复。导入只填入预览，核对后再应用。不会自动点动或优化。应用失败时请重新读取，确认是否部分生效。</HelpTooltip>
      {error && <p className="inline-error" role="alert">{error}</p>}{feedback && <p className="stage-message" role="status">{feedback}</p>}
      </Reveal>
    </div>
    <Disclosure title="连接诊断与恢复" className="stage-diagnostics">
      <div className="stage-diagnostic-grid"><span>通道：{state.diagnostics?.transport || state.config.connection?.toUpperCase() || 'TCP'}</span><span>采样耗时：{state.diagnostics?.latency_ms ?? '—'} ms</span><span>连续读取失败：{state.diagnostics?.read_failures ?? 0}</span><span>有效采样：{state.diagnostics?.sample_count ?? 0}</span></div>
      <HelpTooltip label="控制器操作说明">XA 与控制台应轮流连接。关闭 XA 窗口后若仍有残留进程，也可能占用连接。读取异常暂停操作；控制动作不会自动重发。</HelpTooltip>
      <div className="stage-tool-actions"><button className="button button--quiet" disabled={!auth || !online || busy || !state.connected} onClick={() => void onAct('/disconnect', {}, '位移台已断开。')}><Gauge size={14}/>断开控制器</button>
      <button className="button button--quiet" disabled={!auth || !online || busy || !state.motion_pending && !state.diagnostics?.motion_locked} onClick={() => {void onAct('/recover', {}, '已停止并恢复控制。')}}>停止并恢复</button></div>
    </Disclosure>
    <StageToolHistory version={historyVersion}/>
    </div>)}

  </>
}

/** Per-axis quick speed/acceleration panel embedded in each workbench card. */
export function QuickParams({axis, state, auth, online, busy, uncertain, onParameters}: {
  axis: Axis; state: StageState; auth: boolean; online: boolean; busy: boolean; uncertain: boolean
  onParameters: (axis: Axis, values?: DriveParameters) => Promise<ParameterState>
}) {
  const channel = state.config.axes[axis]
  const [open, setOpen] = useState(false)
  const [params, setParams] = useState<ParameterState | null>(null)
  const [draft, setDraft] = useState<{step_rate: string; acceleration: string} | null>(null)
  const [error, setError] = useState(''), [feedback, setFeedback] = useState('')
  const [working, setWorking] = useState(false)
  const epoch = useRef(0), requestRef = useRef(false)
  const identity = JSON.stringify([axis, state.config.serial_number, state.config.mode, state.config.connection, state.config.host, state.config.port, state.connected, state.config.axes, state.config.inverted])
  useEffect(() => {
    epoch.current++; requestRef.current = false
    // eslint-disable-next-line react/set-state-in-effect -- Device/axis changes revoke the quick draft.
    setParams(null); setDraft(null); setError(''); setFeedback(''); setWorking(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- This ref tracks request generations, not a DOM node.
    return () => { epoch.current++ }
  }, [identity])
  const row = state.channels.find(item => item.channel === channel)
  const idle = state.channels.length === 3 && state.channels.every(item => item.moving === false && !item.optimizing)
  const blocked = !auth ? '登录后可读取和修改参数。' : !online ? '后台状态已过期，请等待连接恢复。' : !state.connected ? '控制器未连接。' : uncertain ? '操作结果未确认，请先停止并核对状态。' : state.error || (state.motion_pending || !idle ? '运动或优化进行中，停止并确认空闲后可读取和修改参数。' : !row?.ready ? row?.error || '此通道未就绪。' : busy && !working ? '其他请求处理中，请稍候。' : '')
  const canUse = !blocked && !busy
  useEffect(() => {
    if (open && canUse && !params && !working && !error) void readOrApply()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Busy changes must not cancel the request they started.
  }, [open, canUse, identity, params, working, error])
  const dirty = params && draft && (String(params.values.step_rate) !== draft.step_rate || String(params.values.acceleration) !== draft.acceleration)
  const invalid = !params || !draft || (['step_rate', 'acceleration'] as const).some(key => {
    const value = draft[key], n = Number(value), bounds = params.limits[key]
    return !value.trim() || !Number.isSafeInteger(n) || bounds.min != null && n < bounds.min || bounds.max != null && n > bounds.max
  })
  async function readOrApply(apply = false) {
    if (!canUse || requestRef.current || apply && (!params || !draft || invalid || !dirty)) return
    requestRef.current = true
    const mine = epoch.current
    setWorking(true); setError(''); setFeedback('')
    try {
      const next = await onParameters(axis, apply ? {...params!.values, step_rate: Number(draft!.step_rate), acceleration: Number(draft!.acceleration)} : undefined)
      if (mine === epoch.current) {
        setParams(next); setDraft({step_rate: String(next.values.step_rate), acceleration: String(next.values.acceleration)})
        if (apply) setFeedback('已应用并保存；重连后自动恢复。')
      }
    } catch (e) { if (mine === epoch.current) setError(errorMessage(e, apply ? '参数应用未确认，请重新读取核对' : '读取驱动参数失败')) }
    finally { if (mine === epoch.current) { requestRef.current = false; setWorking(false) } }
  }
  return <div className="stage-quick-params">
    <button type="button" className="disclosure__toggle" aria-expanded={open} aria-controls={`stage-quick-${axis}`} onClick={() => setOpen(value => !value)}>
      速度 / 加速度{params ? `：${params.values.step_rate} 步/秒 · ${params.values.acceleration} 步/秒²` : ''}
    </button>
    <Reveal open={open} id={`stage-quick-${axis}`}>
      <div className="stage-parameter-actions"><button className="button button--quiet" disabled={!canUse || working} onClick={() => void readOrApply()}><RefreshCw size={14}/>{working ? '处理中…' : '重新读取'}</button>{dirty && <span className="subtle-note">有未应用的参数</span>}</div>
      {draft && params ? <div className="stage-quick-grid">
        <label className="field">步频（步/秒）<input type="number" aria-label={`${axis.toUpperCase()} 轴步频`} value={draft.step_rate} disabled={!canUse || working}
          min={params.limits.step_rate.min ?? undefined} max={params.limits.step_rate.max ?? undefined} step={1}
          onChange={event => setDraft({...draft, step_rate: event.target.value})}/></label>
        <label className="field">加速度（步/秒²）<input type="number" aria-label={`${axis.toUpperCase()} 轴加速度`} value={draft.acceleration} disabled={!canUse || working}
          min={params.limits.acceleration.min ?? undefined} max={params.limits.acceleration.max ?? undefined} step={1}
          onChange={event => setDraft({...draft, acceleration: event.target.value})}/></label>
        <button className="button button--primary" disabled={!canUse || working || invalid || !dirty} onClick={() => void readOrApply(true)}>应用</button>
      </div> : !blocked && <p className="stage-note">{working ? '正在读取…' : error ? '读取失败，请重试。' : '等待读取当前参数。'}</p>}
      {blocked && <p className="stage-note">{blocked}</p>}
      {params && draft && invalid && <p className="inline-error">请输入范围内的整数：步频 {params.limits.step_rate.min ?? '—'}–{params.limits.step_rate.max ?? '—'}，加速度 {params.limits.acceleration.min ?? '—'}–{params.limits.acceleration.max ?? '—'}。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {feedback && <p className="stage-message" role="status">{feedback}</p>}
    </Reveal>
  </div>
}
