import { useEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import { apiRequest, errorMessage } from './apiClient'

type AnalogState = {
  config: {mode: 'real' | 'simulation'; host: string; port: number; unit_id: number; register_base: number | null; current_output_confirmed: boolean; outputs: {label: string; fault_ma: number}[]}
  connected: boolean; enabled: boolean; manual_active?: boolean; unconfirmed: boolean; error: string | null
  outputs: {channel: number; current_ma: number; status: string}[]
}
const request = <T,>(path: string, body?: unknown) => apiRequest<T>(path, {
  method: body === undefined ? 'GET' : 'POST', operation: body === undefined ? '读取模拟量调试状态' : '调节模拟量输出',
  timeoutMs: 15000, body: body === undefined ? undefined : JSON.stringify(body),
})
const validCurrent = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 4 && Number(value) <= 20 && Math.abs(Number(value) * 1000 - Math.round(Number(value) * 1000)) < 1e-6

export default function AnalogManualPanel({auth, connected}: {auth: boolean; connected: boolean}) {
  const [state, setState] = useState<AnalogState | null>(null), [values, setValues] = useState(['4', '4', '4', '4'])
  const [fresh, setFresh] = useState(false), [lastRead, setLastRead] = useState(0), [busy, setBusy] = useState(''), [stopping, setStopping] = useState(false)
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [message, setMessage] = useState('')
  const [commandUnconfirmed, setCommandUnconfirmed] = useState(false)
  const generation = useRef(0), pending = useRef(false), stopPending = useRef(false), identity = useRef('')
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    async function poll() {
      const epoch = generation.current
      try {
        if (pending.current || stopPending.current) return
        const next = await request<AnalogState>('/api/analog-output')
        if (!next.config || !Array.isArray(next.outputs)) throw new Error('模拟量状态格式无效，请检查后台版本')
        if (!cancelled && epoch === generation.current) {
          setState(next); setFresh(true); setLastRead(Date.now()); setReadError('')
          const key = JSON.stringify([next.config.mode, next.config.host, next.config.port, next.config.unit_id, next.config.register_base, next.connected])
          if (key !== identity.current) {
            identity.current = key
            setValues([1, 2, 3, 4].map(channel => {
              const current = next.outputs.find(row => row.channel === channel)?.current_ma
              return current != null && current >= 4 && current <= 20 ? String(current) : '4'
            }))
          }
        }
      } catch (exc) {
        if (!cancelled && epoch === generation.current) {setFresh(false); setReadError(errorMessage(exc, '模拟量状态读取失败'))}
      } finally {if (!cancelled) timer = setTimeout(poll, 1000)}
    }
    void poll()
    return () => {cancelled = true; clearTimeout(timer); generation.current = -1}
  }, [])
  useEffect(() => {
    if (!lastRead) return
    const timer = setTimeout(() => setFresh(false), Math.max(0, 3500 - (Date.now() - lastRead)))
    return () => clearTimeout(timer)
  }, [lastRead])
  const reason = !auth ? '需要操作员权限' : commandUnconfirmed ? '上次操作结果未确认，请检查连接并停止输出' : !connected ? '后台未连接' : !fresh ? '模块状态已过期，等待读取恢复' : !state?.connected ? '请在硬件连接 → 模拟量输出连接模块' : state.unconfirmed ? '输出未确认，请检查连接并停止输出' : state.enabled ? '压力跟随运行中，请先切换为手动调节' : state.config.register_base == null || !state.config.current_output_confirmed ? '请在硬件连接中核对输出寄存器及 4–20mA 型号和接线' : stopping ? '正在停止输出' : busy ? '正在下发，请等待应答' : ''
  async function act(path: string, body: unknown, label: string, stop = false) {
    if (!auth || stopPending.current || !stop && (pending.current || reason)) return
    if (stop) {stopPending.current = true; setStopping(true)} else {pending.current = true; setBusy(label)}
    const epoch = ++generation.current
    setError(''); setMessage('')
    try {
      const next = await request<AnalogState>(path, body)
      if (epoch === generation.current) {setState(next); setCommandUnconfirmed(false); setFresh(true); setLastRead(Date.now()); setMessage(stop ? '已停止输出，并写入所控制通道的故障电流' : `${label}，写入应答已确认`)}
    } catch (exc) {
      if (epoch === generation.current) {setCommandUnconfirmed(true); setFresh(false); setError(errorMessage(exc, '输出结果未确认，请检查连接，勿重复下发'))}
    } finally {
      if (stop) {stopPending.current = false; setStopping(false)} else {pending.current = false; setBusy('')}
      if (epoch === generation.current) generation.current++
    }
  }
  const stopAvailable = auth && (state?.enabled || state?.manual_active || state?.unconfirmed || commandUnconfirmed || !!busy)
  const status = !fresh ? '状态未确认' : state?.unconfirmed ? '输出未确认' : !state?.connected ? '未连接' : state.enabled ? '压力跟随中' : state.manual_active ? '手动输出中' : '已连接 · 待机'
  return <section className="content-panel glass-panel analog-manual">
    <div className="panel-heading"><div><h2>四路模拟量手动调节</h2><p className="stage-note">ZS-AO-4-RJ45 · {state?.config.mode === 'simulation' ? '模拟设备' : '真实设备'} · 4–20mA</p></div><span className={`status-chip ${fresh && state?.connected && !state.unconfirmed ? 'status-chip--ok' : 'status-chip--muted'}`}>{status}</span></div>
    {readError && <p className="inline-error" role="alert">{readError}</p>}{state?.error && <p className="inline-error" role="alert">{state.error}</p>}{error && <p className="inline-error" role="alert">{error}</p>}{message && <p className="stage-message" role="status">{message}</p>}
    {state?.enabled && <div className="analog-manual-switch"><span>停止压力跟随并写入故障电流后，可独立设置各通道。</span><button className="button button--quiet" disabled={!auth || !connected || !fresh || stopping} onClick={() => void act('/api/analog-output/stop', {}, '切换为手动调节', true)}>{stopping ? '切换中…' : '切换为手动调节'}</button></div>}
    <div className="analog-manual-grid">{[1, 2, 3, 4].map((channel, index) => {
      const row = state?.outputs.find(item => item.channel === channel), valid = validCurrent(values[index])
      const update = (value: string) => setValues(prior => prior.map((v, i) => i === index ? value : v))
      return <article className="analog-manual-card" key={channel}>
        <h3>AO{channel}{state?.config.outputs[index]?.label && <small>{state.config.outputs[index].label}</small>}</h3>
        <div className="analog-manual-readout"><strong>{fresh && !state?.unconfirmed && row ? `${row.current_ma.toFixed(3)} mA` : '—'}</strong><small>已确认设定值 · 非实测电流</small></div>
        <label className="field">待下发电流（mA）<input aria-label={`AO${channel} 电流`} type="number" min={4} max={20} step={0.001} disabled={!auth || !!busy || stopping} value={values[index]} onChange={event => update(event.target.value)}/></label>
        <input className="analog-manual-slider" aria-label={`AO${channel} 电流滑块`} type="range" min={4} max={20} step={0.001} value={valid ? Number(values[index]) : 4} disabled={!auth || !!busy || stopping} onChange={event => update(event.target.value)}/>
        <div className="filter-buttons">{[4, 12, 20].map(value => <button className="button button--quiet" disabled={!auth || !!busy || stopping} key={value} onClick={() => update(String(value))}>{value}mA</button>)}</div>
        {!valid && <p className="inline-error">电流须为 4–20mA，最多三位小数</p>}
        <button className="button button--primary" disabled={!!reason || !valid} onClick={() => void act('/api/debug/analog-output', {channel, current_ma: Number(values[index])}, `AO${channel} 设定 ${Number(values[index]).toFixed(3)}mA`)}><Send size={14}/>{busy.startsWith(`AO${channel} `) ? '下发中…' : `下发 AO${channel}`}</button>
      </article>
    })}</div>
    {reason && <p className="subtle-note" role="status">{reason}</p>}
    <div className="stage-actions"><button className="button stage-stop" disabled={!stopAvailable || stopping} onClick={() => void act('/api/analog-output/stop', {}, '停止模拟量输出', true)}><Square size={15}/>{stopping ? '停止中…' : '停止模拟量输出'}</button><span className="stage-note">停止时写入各通道配置的故障电流；不会恢复压力跟随。</span></div>
  </section>
}
