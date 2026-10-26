import { useEffect, useRef, useState } from 'react'
import { Check, Plug, Square, Unplug } from 'lucide-react'
import { apiRequest, errorMessage } from './apiClient'
import { validOffset } from './analogCalibration'

type Mapping = {enabled: boolean; label: string; source_channel: number; pressure_4ma_pa: number | string | null; pressure_20ma_pa: number | string | null; scale: 'linear' | 'log'; fault_ma: number; offset_ma?: number | string}
type Config = {mode: 'real' | 'simulation'; host: string; port: number; unit_id: number; register_base: 0 | 10 | null; current_output_confirmed: boolean; update_interval_s: number; outputs: Mapping[]}
type State = {config: Config; connected: boolean; enabled: boolean; manual_active?: boolean; unconfirmed: boolean; error: string | null; outputs: {channel: number; current_ma: number; target_ma?: number; offset_ma?: number; pressure_pa?: number | null; status: string}[]}
const request = <T,>(path = '', method = 'GET', body?: unknown) => apiRequest<T>(`/api/analog-output${path}`, {method, operation: method === 'GET' ? '读取模拟量模块状态' : '模拟量模块操作', timeoutMs: 15000, body: body === undefined ? undefined : JSON.stringify(body)})

export default function AnalogOutputPanel({auth, connected, onDirtyChange}: {auth: boolean; connected: boolean; onDirtyChange: (dirty: boolean) => void}) {
  const [state, setState] = useState<State | null>(null), [draft, setDraft] = useState<Config | null>(null)
  const [saved, setSaved] = useState<Config | null>(null), [busy, setBusy] = useState('')
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [message, setMessage] = useState('')
  const [lastRead, setLastRead] = useState(0), [fresh, setFresh] = useState(false)
  const inFlight = useRef(false), generation = useRef(0)
  const dirty = !!draft && JSON.stringify(saved) !== JSON.stringify(draft)
  useEffect(() => {onDirtyChange(dirty)}, [dirty, onDirtyChange])
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    async function read() {
      const epoch = generation.current
      try {
        if (inFlight.current) return
        const next = await request<State>()
        if (!next.config || !Array.isArray(next.outputs)) throw new Error('模拟量状态格式无效，请检查后台版本')
        if (!cancelled && epoch === generation.current) {
          setState(next); setSaved(next.config); setDraft(prior => prior ?? structuredClone(next.config)); setReadError(''); setFresh(true); setLastRead(Date.now())
        }
      } catch (error) {if (!cancelled && epoch === generation.current) {setFresh(false); setReadError(errorMessage(error, '模拟量状态读取失败'))}}
      finally {if (!cancelled) timer = setTimeout(read, 1000)}
    }
    void read()
    return () => {cancelled = true; clearTimeout(timer)}
  }, [])
  useEffect(() => {
    if (!lastRead) return
    const timer = setTimeout(() => setFresh(false), Math.max(0, 3500 - (Date.now() - lastRead)))
    return () => clearTimeout(timer)
  }, [lastRead])
  const editable = auth && !!draft && !busy && !state?.enabled && !state?.manual_active && !state?.unconfirmed
  const writable = auth && connected && fresh && !busy
  const patch = <K extends keyof Config>(key: K, value: Config[K]) => setDraft(prior => prior ? {...prior, [key]: value} : prior)
  function mapping(index: number, key: keyof Mapping, value: unknown) {
    if (draft) patch('outputs', draft.outputs.map((row, i) => i === index ? {...row, [key]: value} : row))
  }
  async function act(path: string, success: string) {
    if (!auth || inFlight.current) return
    inFlight.current = true; generation.current++; setBusy(path); setError(''); setMessage('')
    try {
      const next = await request<State>(path, path === '/config' ? 'PUT' : 'POST', path === '/config' ? draft : {})
      setState(next); setSaved(next.config); if (path === '/config') setDraft(structuredClone(next.config))
      setFresh(true); setLastRead(Date.now()); setMessage(success)
    } catch (error) {setError(errorMessage(error, '模拟量操作未确认，请检查状态，勿重复发送输出请求。'))}
    finally {generation.current++; inFlight.current = false; setBusy('')}
  }
  return <section className="content-panel glass-panel analog-panel">
    <div className="panel-heading"><div><h2>ZS-AO-4-RJ45</h2><p className="stage-note">中盛科技 · 实时压力 → 4–20mA</p></div><span className={`status-chip ${fresh && state?.connected ? 'status-chip--ok' : 'status-chip--muted'}`}>{!fresh ? '状态未确认' : state?.enabled ? '实时输出中' : state?.manual_active ? '手动输出中' : state?.connected ? '已连接 · 输出未启用' : '未连接'}</span></div>
    {readError && <p className="inline-error" role="alert">{readError}</p>}{state?.error && <p className="inline-error" role="alert">{state.error}</p>}{error && <p className="inline-error" role="alert">{error}</p>}{message && <p className="stage-message" role="status">{message}</p>}
    {draft ? <>
      <fieldset disabled={!editable}><div className="settings-grid">
        <label className="field">模拟量运行模式<select value={draft.mode} disabled={!!state?.connected} onChange={event => patch('mode', event.target.value as Config['mode'])}><option value="real">真实设备</option><option value="simulation">模拟设备</option></select></label>
        <div className="field">连接方式<span className="hardware-interface">以太网 · Modbus TCP</span></div>
        <label className="field">模拟量模块 IP 地址<input value={draft.host} disabled={!!state?.connected} placeholder="192.168.0.7" onChange={event => patch('host', event.target.value.trim())}/></label>
        <label className="field">模拟量 TCP 端口<input type="number" min={1} max={65535} value={draft.port} disabled={!!state?.connected} onChange={event => patch('port', Number(event.target.value))}/></label>
        <label className="field">模拟量站号<input type="number" min={1} max={255} value={draft.unit_id} disabled={!!state?.connected} onChange={event => patch('unit_id', Number(event.target.value))}/></label>
        <label className="field">AO1 起始寄存器<select value={draft.register_base ?? ''} disabled={!!state?.connected} onChange={event => patch('register_base', event.target.value === '' ? null : Number(event.target.value) as 0 | 10)}><option value="">待核对</option><option value="10">0x000A（厂家寄存器表）</option><option value="0">0x0000（厂家指令示例）</option></select></label>
        <label className="field">输出更新周期（秒）<input type="number" min={0.2} max={10} step={0.1} value={draft.update_interval_s} onChange={event => patch('update_interval_s', Number(event.target.value))}/></label>
      </div><label className="stage-invert analog-confirm"><input type="checkbox" checked={draft.current_output_confirmed} onChange={event => patch('current_output_confirmed', event.target.checked)}/>已核对模块为 4–20mA 电流输出型号及接线</label></fieldset>
      {draft.register_base == null && <p className="request-notice">厂家手册寄存器表与示例的起始地址不一致。请核对现场版本；地址未确认前禁止开启输出。</p>}
      <div className="analog-mapping-grid">{draft.outputs.map((row, i) => {
        const current = state?.outputs.find(value => value.channel === i + 1)
        return <fieldset className="analog-mapping" key={i} disabled={!editable}>
          <div className="analog-mapping-heading"><b>AO{i + 1}</b><label><input type="checkbox" checked={row.enabled} onChange={event => mapping(i, 'enabled', event.target.checked)}/>启用映射</label></div>
          <label className="field">AO{i + 1} 名称<input maxLength={32} value={row.label} onChange={event => mapping(i, 'label', event.target.value)}/></label>
          <label className="field">AO{i + 1} 压力来源<select value={row.source_channel} onChange={event => mapping(i, 'source_channel', Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map(ch => <option key={ch} value={ch}>真空规 CH{ch}</option>)}</select></label>
          <div className="analog-endpoints">{(['pressure_4ma_pa', 'pressure_20ma_pa'] as const).map((key, k) => <label className="field" key={key}>{k ? '20mA' : '4mA'} 对应压力（Pa）<input aria-label={`AO${i + 1} ${k ? '20mA' : '4mA'} 对应压力`} type="text" inputMode="decimal" placeholder="例如 1e-6" value={row[key] ?? ''} onChange={event => mapping(i, key, event.target.value === '' ? null : event.target.value)}/></label>)}</div>
          <label className="field">AO{i + 1} 转换方式<select value={row.scale} onChange={event => mapping(i, 'scale', event.target.value)}><option value="log">对数</option><option value="linear">线性</option></select></label>
          <label className="field">AO{i + 1} 压力失效 / 停止时电流（mA）<input type="number" min={4} max={20} step={0.001} value={row.fault_ma} onChange={event => mapping(i, 'fault_ma', Number(event.target.value))}/></label>
          <label className="field">AO{i + 1} 校准偏移（mA）<input aria-label={`AO${i + 1} 校准偏移`} type="text" inputMode="decimal" value={row.offset_ma ?? 0} onChange={event => mapping(i, 'offset_ma', event.target.value)}/></label>
          {!validOffset(row.offset_ma) && <p className="inline-error">偏移须为 −16 至 +16mA，最多三位小数</p>}
          <div className="analog-current"><strong>{fresh && current && !state?.unconfirmed ? `${current.current_ma.toFixed(3)} mA` : '—'}</strong>{fresh && current?.target_ma != null && !state?.unconfirmed && <small>目标 {current.target_ma.toFixed(3)}mA · 已用偏移 {(current.offset_ma ?? 0) >= 0 ? '+' : ''}{(current.offset_ma ?? 0).toFixed(3)}mA</small>}<small>{state?.unconfirmed ? '输出未确认，请检查模块连接' : fresh && current ? current.status : '暂无已确认的设定值'}</small><small>寄存器设定值，非实测电流</small></div>
        </fieldset>
      })}</div>
      {dirty && <p className="subtle-note">有未保存的模拟量设置</p>}
      <div className="stage-actions">
        <button className="button button--primary" disabled={!writable || !editable || !dirty || draft.outputs.some(row => !validOffset(row.offset_ma))} onClick={() => void act('/config', '模拟量配置已保存，未启用输出')}><Check size={15}/>{busy === '/config' ? '保存中…' : '保存模拟量设置'}</button>
        <button className="button button--quiet" disabled={!writable || dirty || state?.connected} onClick={() => void act('/connect', '模拟量模块已连接；连接过程未写入电流')}><Plug size={15}/>连接模拟量模块</button>
        <button className="button button--quiet" disabled={!writable || dirty || !state?.connected || state.enabled || state.manual_active || state.unconfirmed || draft.register_base == null || !draft.current_output_confirmed || !draft.outputs.some(row => row.enabled)} onClick={() => void act('/enable', '实时压力电流输出已启用')}>开始实时输出</button>
        <button className="button stage-stop" disabled={!auth || !!busy || !state?.enabled && !state?.manual_active && !state?.unconfirmed} onClick={() => void act('/stop', '实时输出已停止，已写入各通道故障电流')}><Square size={15}/>停止实时输出</button>
        <button className="button button--quiet" disabled={!writable || !state?.connected} onClick={() => void act('/disconnect', '模拟量模块已断开')}><Unplug size={15}/>断开模拟量模块</button>
      </div>
      <p className="stage-note">压力过期、无效或真空规断连时使用故障电流；超量程限幅到 4–20mA。通信中断或程序异常退出后，模块可能保持最后电流，不能据此判断压力有效。</p>
      <p className="stage-note">下发电流＝目标电流＋校准偏移，最终限于 4–20mA；偏移也作用于故障电流和 Debug 手动调节。</p>
    </> : <p>正在读取模拟量设置…</p>}
  </section>
}
