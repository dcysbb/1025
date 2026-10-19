import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Power, RefreshCw, Square } from 'lucide-react'
import type { HardwareConfig } from './HardwarePanel'
import { ApiError, apiRequest, errorMessage } from './apiClient'
import { outputTerminals } from './terminalDefinitions'
import { Disclosure } from './Motion'

export type TerminalSystemState = {
  mode: 'real' | 'simulation'; interlock: string; valve: string; pressure_ok: boolean
  adam_connected: boolean; history_recording: boolean
}
type Relays = { mode: string; outputs: boolean[]; valve_output: number; valve_open_on_energized?: boolean; interlock: string; remaining_s: Record<string, number> }
type Props = {
  draft: HardwareConfig; saved: HardwareConfig; active: boolean; auth: boolean; connected: boolean; online: boolean
  io: { connected: boolean; inputs: boolean[] | null; outputs: boolean[] | null }
  systemState?: TerminalSystemState | null; configurationBusy: boolean; routingDirty: boolean
  onPatch: (changes: Partial<HardwareConfig>) => void; onBusyChange: (busy: boolean) => void
  mappingActions: ReactNode; textActions: ReactNode
}

export default function TerminalWorkbench({ draft, saved, active, auth, connected, online, io, systemState, configurationBusy, routingDirty, onPatch, onBusyChange, mappingActions, textActions }: Props) {
  const [relays, setRelays] = useState<Relays | null>(null), [readError, setReadError] = useState('')
  const [lastRead, setLastRead] = useState(0), [fresh, setFresh] = useState(false)
  const identity = JSON.stringify([saved.mode, saved.io_device, saved.dam_serial_port, saved.dam_baudrate, saved.dam_unit_id, saved.open_output, saved.valve_open_on_energized])
  const [readIdentity, setReadIdentity] = useState('')
  const [awaitingRead, setAwaitingRead] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false), [timed, setTimed] = useState(false), [duration, setDuration] = useState('10')
  const [starting, setStarting] = useState<number | null>(null), [releasing, setReleasing] = useState<number | null>(null)
  const [uncertain, setUncertain] = useState<number[]>([]), [feedback, setFeedback] = useState<Record<number, { error?: string; message?: string }>>({})
  const [reload, setReload] = useState(0)
  const generation = useRef(0), action = useRef(0), startRef = useRef<number | null>(null), releaseRef = useRef<number | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange(false) } }, [onBusyChange])
  const usable = active && auth && connected && saved.io_device === 'dam0808d'
  const revoke = useCallback(() => setAcknowledged(false), [])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Revoke manual authority when the device, routing or freshness changes.
    revoke()
    const hide = () => { if (document.visibilityState !== 'visible') revoke() }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [active, auth, connected, online, fresh, routingDirty, saved.mode, saved.open_output, saved.valve_open_on_energized, saved.dam_serial_port, systemState?.interlock, revoke])
  useEffect(() => {
    if (!lastRead) return
    const timer = setTimeout(() => setFresh(false), Math.max(0, 3500 - (Date.now() - lastRead)))
    return () => clearTimeout(timer)
  }, [lastRead])
  useEffect(() => {
    if (!usable) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const epoch = generation.current
      try {
        if (startRef.current !== null || releaseRef.current !== null) return
        const next = await apiRequest<Relays>('/api/debug/relays')
        if (!Array.isArray(next.outputs) || next.outputs.length !== 8) throw new Error('读取 DAM 输出状态失败：后台返回的八路继电器数据格式异常。')
        if (!cancelled && epoch === generation.current) { setRelays(next); setReadIdentity(identity); setReadError(''); setFresh(true); setAwaitingRead(false); setLastRead(Date.now()) }
      } catch (error) {
        if (!cancelled && epoch === generation.current) { setFresh(false); setReadError(errorMessage(error, '读取 DAM 输出状态失败')) }
      } finally { if (!cancelled) timer = setTimeout(poll, 2000) }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [usable, identity, reload])

  const sameMapping = readIdentity === identity && relays?.valve_output === saved.open_output && (relays?.valve_open_on_energized ?? true) === saved.valve_open_on_energized && relays?.mode === saved.mode && systemState?.mode === saved.mode
  function positiveReason(valve: boolean) {
    if (!active || !auth) return '登录后可操作输出'
    if (saved.io_device !== 'dam0808d') return '当前生效的 I/O 不是 DAM0808D'
    if (!connected || !online || !fresh || !io.connected || !systemState?.adam_connected) return 'DAM 状态未知或已过期，等待重新读取'
    if (awaitingRead) return '等待操作后的输出状态读回'
    if (!sameMapping) return '运行模式或阀控映射已变化，请重新读取硬件配置'
    if (configurationBusy || routingDirty) return '请先保存或放弃连接与功能分配的更改'
    if (uncertain.length) return '有输出结果未确认，请先释放对应输出或关闭插板阀'
    if (starting !== null || releasing !== null) return '输出请求处理中，请等待读回'
    if (valve) {
      if (systemState.interlock !== 'armed') return '请先在“联锁控制”启用联锁，再请求开阀'
      if (!systemState.pressure_ok) return '压力条件未满足，禁止开阀'
    } else {
      if (systemState.interlock !== 'disarmed' || relays?.interlock !== 'disarmed') return '普通输出仅在联锁未启用时允许手动吸合'
      if (!systemState.history_recording) return '审计记录不可用，禁止手动吸合'
      if (!acknowledged) return '请先勾选普通输出手动控制确认'
      if (timed && (!Number.isFinite(Number(duration)) || Number(duration) < 1 || Number(duration) > 60)) return '自动释放时间必须为 1–60 秒'
    }
    return ''
  }
  const canRelease = active && auth && saved.io_device === 'dam0808d' && !configurationBusy && releasing === null
  async function operate(channel: number, enabled: boolean) {
    const valve = channel === saved.open_output
    if (enabled ? positiveReason(valve) || startRef.current !== null || releaseRef.current !== null : !canRelease || releaseRef.current !== null) return
    if (enabled) { startRef.current = channel; setStarting(channel) }
    else { releaseRef.current = channel; setReleasing(channel) }
    const mine = ++action.current
    generation.current++; onBusyChange(true)
    setFeedback(prior => ({ ...prior, [channel]: {} }))
    try {
      if (valve) {
        await apiRequest(`/api/valve/${enabled ? 'open' : 'close'}`, { method: 'POST', body: '{}' })
      } else {
        const next = await apiRequest<Relays>(`/api/debug/relays/${channel}`, {
          method: 'POST', body: JSON.stringify({ enabled, duration_s: enabled && timed ? Number(duration) : 0 }),
          operation: `${enabled ? '吸合' : '释放'} DAM OUT${channel + 1}（DO${channel}）`,
        })
        if (!Array.isArray(next.outputs) || next.outputs.length !== 8) throw new Error('继电器请求已发送，但返回的输出状态格式异常，执行结果未确认。')
        if (mounted.current && mine === action.current) { setRelays(next); setReadIdentity(identity); setFresh(true); setLastRead(Date.now()) }
      }
      if (mounted.current) {
        if (!enabled) setUncertain(prior => valve ? [] : prior.filter(value => value !== channel))
        if (mine === action.current) setFeedback(prior => ({ ...prior, [channel]: { message: valve ? `${enabled ? '开阀' : '关阀'}请求已下发，实际位置以到位反馈为准。${enabled ? '' : '同时清除普通手动输出。'}` : `OUT${channel + 1} 已读回${enabled ? '吸合' : '释放'}；此读回不代表外接设备已完成动作。` } }))
      }
    } catch (error) {
      if (mounted.current && mine === action.current) {
        const ambiguous = !(error instanceof ApiError) || error.kind !== 'http' || (error.status ?? 500) >= 500
        if (ambiguous) setUncertain(prior => [...new Set([...prior, channel])])
        setFeedback(prior => ({ ...prior, [channel]: { error: `${errorMessage(error, '输出控制失败')}${ambiguous ? ' 请勿重复吸合；先释放此输出或关闭插板阀，并核对接线与反馈。' : ''}` } }))
        revoke()
      }
    } finally {
      generation.current++
      if (enabled) { startRef.current = null; if (mounted.current) setStarting(null) }
      else { releaseRef.current = null; if (mounted.current) setReleasing(null) }
      if (mounted.current) { setAwaitingRead(true); onBusyChange(startRef.current !== null || releaseRef.current !== null); setReload(value => value + 1) }
    }
  }
  const editText = (key: 'dam_input_labels' | 'dam_output_labels' | 'dam_input_notes' | 'dam_output_notes', index: number, value: string) => {
    const items = [...draft[key]]; items[index] = value; onPatch({ [key]: items })
  }
  const editable = auth && connected && online && !configurationBusy && starting === null && releasing === null
  return <div className="terminal-workbench">
    <div className="panel-heading"><div><h2>DAM0808D 端子工作台</h2><p>功能分配直接应用于现有阀门映射；普通输出接入实际继电器控制。</p></div><span className="mode-badge" data-mode={saved.mode}>{saved.mode === 'simulation' ? '模拟 I/O' : '真实 DAM'}</span></div>
    <nav className="terminal-section-links" aria-label="端子工作台区域"><a href="#dam-output-controls">输出控制 · 8 路</a><a href="#dam-input-assignments">输入分配 · 8 路</a><a href="#dam-physical-wiring">物理接线图</a></nav>
    {saved.io_device !== 'dam0808d' && <p className="inline-error">当前生效的 I/O 为 ADAM6050；DAM 操作已禁用。请到“设备连接”选择并保存 DAM0808D。</p>}
    <div className="terminal-assignment-notice"><b>{routingDirty ? '功能或连接更改尚未生效' : `当前阀控：OUT${saved.open_output + 1} / DO${saved.open_output} · 关闭反馈 IN${saved.valve_closed_di + 1}${saved.valve_open_di === null ? ' · 未安装打开反馈' : ` · 打开反馈 IN${saved.valve_open_di + 1}`}`}</b><p>选择功能后须保存才生效。保存功能分配会关阀、清除手动输出并撤销受影响的现场验证；已启用联锁将锁存。</p>{mappingActions}</div>
    <div className="terminal-manual-toolbar">
      <label><input type="checkbox" checked={acknowledged} disabled={!usable || !online || configurationBusy || routingDirty || systemState?.interlock !== 'disarmed'} onChange={event => setAcknowledged(event.target.checked)}/>启用普通输出手动控制：已核对接线、负载和线圈电压</label>
      <p>普通继电器手动吸合绕过压力保护，仅在联锁未启用时可用。阀控通道使用正常联锁开/关阀接口。</p>
      <div><label><input type="checkbox" checked={timed} onChange={event => setTimed(event.target.checked)}/>普通输出定时释放</label>{timed && <label className="field">自动释放时间（秒）<input type="number" aria-label="普通输出自动释放秒数" min={1} max={60} value={duration} onChange={event => setDuration(event.target.value)}/></label>}<button className="button button--quiet" onClick={() => setReload(value => value + 1)} disabled={!usable}><RefreshCw size={14}/>刷新输出状态</button></div>
    </div>
    {usable && readError && <p className="inline-error" role="alert">{readError} 输出显示可能已过期，吸合暂停；可尝试释放当前输出。</p>}
    <h3 id="dam-output-controls">输出控制与分配 · OUT1–OUT8</h3>
    <div className="terminal-output-grid">{Array.from({ length: 8 }, (_, index) => {
      const currentValve = saved.open_output === index, futureValve = draft.open_output === index
      const known = usable && online && fresh && readIdentity === identity && io.connected
      const value = known ? currentValve ? io.outputs?.[index] : relays?.outputs[index] : undefined
      const reason = positiveReason(currentValve)
      const position = ({ open: '已打开', closed: '已关闭', opening: '正在打开', closing: '正在关闭', fault: '反馈冲突', unknown: '未确认' } as Record<string, string>)[systemState?.valve ?? 'unknown']
      return <article className={`terminal-output-card ${currentValve ? 'terminal-output-card--valve' : ''}`} key={index}>
        <header><h4>OUT{index + 1} <small>DO{index}</small></h4><span className={`terminal-level ${value === true ? 'terminal-level--on' : ''}`}>{value === undefined ? '状态未知' : value ? '吸合' : '释放'}</span></header>
        <p className="terminal-contact">{outputTerminals(index)}</p>
        <div className="terminal-output-actions"><button className="button button--primary" aria-label={currentValve ? '端子页打开插板阀' : `吸合 OUT${index + 1}`} disabled={!!reason} onClick={() => void operate(index, true)}><Power size={14}/>{starting === index ? '发送中…' : currentValve ? '请求开阀' : '吸合'}</button><button className="button button--danger-soft" aria-label={currentValve ? '端子页关闭插板阀' : `释放 OUT${index + 1}`} disabled={!canRelease} onClick={() => void operate(index, false)}><Square size={14}/>{releasing === index ? '发送中…' : currentValve ? '请求关阀' : '释放'}</button></div>
        <p className="terminal-disabled-reason">{reason || (currentValve ? '开阀受压力和阀位联锁保护' : timed ? `吸合后 ${duration} 秒自动释放` : '吸合后保持，需手动释放')}</p>
        <label className="field">控制功能<select aria-label={`OUT${index + 1} 控制功能`} value={futureValve ? 'valve' : 'manual'} disabled={!editable || draft.io_device !== 'dam0808d'} onChange={event => { if (event.target.value === 'valve') onPatch({ open_output: index }) }}><option value="manual" disabled={futureValve}>普通继电器手动输出</option><option value="valve">插板阀电磁阀</option></select></label>
        {futureValve && <label className="field">开关映射<select aria-label={`OUT${index + 1} 开关映射`} value={String(draft.valve_open_on_energized)} disabled={!editable} onChange={event => onPatch({ valve_open_on_energized: event.target.value === 'true' })}><option value="true">吸合开阀 / 释放关阀</option><option value="false">吸合关阀 / 释放开阀</option></select></label>}
        {currentValve !== futureValve && <p className="terminal-draft-note">待保存：{futureValve ? '分配为阀控输出' : '改为普通手动输出'}；当前仍按已保存功能运行。</p>}
        {currentValve && <p className="terminal-valve-position">阀位反馈：{connected && online ? position : '未知'}<small>{saved.valve_open_on_energized ? '吸合 → 开阀请求；释放 → 关阀请求' : '吸合 → 关阀请求；释放 → 开阀请求'}</small></p>}
        {!currentValve && relays?.remaining_s?.[String(index)] != null && value && <p>约 {Math.ceil(relays.remaining_s[String(index)])} 秒后自动释放</p>}
        <Disclosure title="名称与用途备注" className="terminal-output-details">
        <label className="field">名称<input aria-label={`OUT${index + 1} 名称`} maxLength={32} value={draft.dam_output_labels[index]} disabled={!editable} onChange={event => editText('dam_output_labels', index, event.target.value)}/></label>
        <label className="field">用途备注<input aria-label={`OUT${index + 1} 备注`} maxLength={160} value={draft.dam_output_notes[index]} disabled={!editable} onChange={event => editText('dam_output_notes', index, event.target.value)}/></label>
        </Disclosure>
        {feedback[index]?.error && <p className="inline-error" role="alert">{feedback[index].error}</p>}{feedback[index]?.message && <p className="hardware-message" role="status">{feedback[index].message}</p>}
      </article>
    })}</div>
    <h3 id="dam-input-assignments">输入监测与分配 · IN1–IN8</h3><p className="terminal-help">输入端读取外部电平，不能像继电器一样输出。选择功能会把对应反馈从原输入移到当前输入；关闭到位为必需项，请先分配到其他输入再取消原分配。</p>
    <div className="hardware-table-wrap"><table className="hardware-table terminal-input-table"><thead><tr><th>输入 / 端子</th><th>实际电平</th><th>控制功能</th><th>有效电平 / 反馈</th><th>名称</th><th>用途备注</th></tr></thead><tbody>{Array.from({ length: 8 }, (_, index) => {
      const role = draft.valve_closed_di === index ? 'closed' : draft.valve_open_di === index ? 'open' : 'monitor'
      const polarity = role === 'closed' ? draft.valve_closed_active_high : draft.valve_open_active_high
      const value = saved.io_device === 'dam0808d' && connected && online && io.connected ? io.inputs?.[index] : undefined
      const changed = draft.valve_closed_di !== saved.valve_closed_di || draft.valve_open_di !== saved.valve_open_di || draft.valve_closed_active_high !== saved.valve_closed_active_high || draft.valve_open_active_high !== saved.valve_open_active_high
      return <tr key={index} className={role === 'monitor' ? '' : 'terminal-row--valve'}><td>IN{index + 1} / DI{index}<small>物理端子 {index + 10}</small></td><td>{value === undefined ? '未知' : value ? '高电平' : '低电平'}</td><td><select aria-label={`IN${index + 1} 控制功能`} value={role} disabled={!editable || draft.io_device !== 'dam0808d'} onChange={event => {
        const next = event.target.value
        if (next === 'closed' && draft.valve_open_di !== index) onPatch({ valve_closed_di: index })
        else if (next === 'open' && draft.valve_closed_di !== index) onPatch({ valve_open_di: index })
        else if (next === 'monitor' && draft.valve_closed_di !== index && draft.valve_open_di === index) onPatch({ valve_open_di: null })
      }}><option value="monitor" disabled={role === 'closed'}>仅监测输入</option><option value="closed" disabled={role === 'open'}>插板阀关闭到位</option><option value="open" disabled={role === 'closed'}>插板阀打开到位</option></select></td><td>{role !== 'monitor' ? <><select aria-label={`IN${index + 1} 反馈有效电平`} value={String(polarity)} disabled={!editable || draft.io_device !== 'dam0808d'} onChange={event => onPatch({ [role === 'closed' ? 'valve_closed_active_high' : 'valve_open_active_high']: event.target.value === 'true' })}><option value="true">高电平有效</option><option value="false">低电平有效</option></select><small>{changed ? '待保存，当前反馈按原映射判定' : value === undefined ? '反馈未知' : value === polarity ? '到位信号有效' : '到位信号未触发'}</small></> : '未用于阀门反馈'}</td><td><input aria-label={`IN${index + 1} 名称`} maxLength={32} value={draft.dam_input_labels[index]} disabled={!editable} onChange={event => editText('dam_input_labels', index, event.target.value)}/></td><td><input aria-label={`IN${index + 1} 备注`} maxLength={160} value={draft.dam_input_notes[index]} disabled={!editable} onChange={event => editText('dam_input_notes', index, event.target.value)}/></td></tr>
    })}</tbody></table></div>
    {textActions}
  </div>
}
