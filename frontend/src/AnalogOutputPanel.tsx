import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import HelpTooltip from './HelpTooltip'
import { Disclosure } from './Motion'
import { applyConnection, changedFields, connectionMessage } from './deviceConnections'
import { Check, Plug, Square, Unplug } from 'lucide-react'
import { apiRequest, errorMessage } from './apiClient'
import { validOffset } from './analogCalibration'

type Mapping = {enabled: boolean; label: string; source_channel: number; pressure_4ma_pa: number | string | null; pressure_20ma_pa: number | string | null; scale: 'linear' | 'log'; fault_ma: number; offset_ma?: number | string}
type Config = {mode: 'real' | 'simulation'; host: string; port: number; unit_id: number; register_base: 0 | 10 | null; current_output_confirmed: boolean; update_interval_s: number; outputs: Mapping[]}
type State = {config: Config; connected: boolean; enabled: boolean; manual_active?: boolean; unconfirmed: boolean; error: string | null; outputs: {channel: number; current_ma: number; target_ma?: number; offset_ma?: number; pressure_pa?: number | null; status: string}[]}
const request = <T,>(path = '', method = 'GET', body?: unknown) => apiRequest<T>(`/api/analog-output${path}`, {method, operation: method === 'GET' ? '读取模拟量模块状态' : '模拟量模块操作', timeoutMs: 15000, body: body === undefined ? undefined : JSON.stringify(body)})

const CONNECTION = ['mode', 'host', 'port', 'unit_id', 'register_base'] as const
function rebase(draft: Config, saved: Config, next: Config): Config {
  const outputs = draft.outputs.map((row, index) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === saved.outputs[index][key as keyof Mapping] ? next.outputs[index][key as keyof Mapping] : value])) as Mapping)
  return {...draft, ...Object.fromEntries(Object.keys(draft).filter(key => key !== 'outputs' && draft[key as keyof Config] === saved[key as keyof Config]).map(key => [key, next[key as keyof Config]])), outputs}
}
export default function AnalogOutputPanel({auth, connected, onDirtyChange, connectionHost, onOpenConnection}: {auth: boolean; connected: boolean; onDirtyChange: (dirty: boolean) => void; connectionHost?: HTMLElement | null; onOpenConnection?: () => void}) {
  const [state, setState] = useState<State | null>(null), [draft, setDraft] = useState<Config | null>(null)
  const [saved, setSaved] = useState<Config | null>(null), [busy, setBusy] = useState('')
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [message, setMessage] = useState('')
  const [lastRead, setLastRead] = useState(0), [fresh, setFresh] = useState(false)
  const inFlight = useRef(false), stopPending = useRef(false), generation = useRef(0)
  const savedRef = useRef<Config | null>(null)
  const connectionDirty = !!draft && CONNECTION.some(key => saved?.[key] !== draft[key])
  const mappingDirty = !!draft && (JSON.stringify(saved?.outputs) !== JSON.stringify(draft.outputs) || saved?.update_interval_s !== draft.update_interval_s)
  const dirty = connectionDirty || mappingDirty
  function accept(next: State) {
    const baseline = savedRef.current
    setDraft(prior => prior && baseline ? rebase(prior, baseline, next.config) : structuredClone(next.config))
    savedRef.current = next.config
    setState(next); setSaved(next.config); setFresh(true); setLastRead(Date.now())
  }
  function mappingChanges() {
    if (!draft) return {}
    const outputs = draft.outputs.map((row, index) => ({channel:index+1, ...changedFields(saved?.outputs[index] ?? null, row, Object.keys(row) as (keyof Mapping)[])})).filter(row => Object.keys(row).length > 1)
    return {...(draft.update_interval_s !== saved?.update_interval_s ? {update_interval_s:draft.update_interval_s} : {}), ...(outputs.length ? {outputs} : {})}
  }
  useEffect(() => {onDirtyChange(dirty)}, [dirty, onDirtyChange])
  useEffect(() => {
    const sequence = generation
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    async function read() {
      const epoch = generation.current
      try {
        if (inFlight.current || stopPending.current) return
        const next = await request<State>()
        if (!next.config || !Array.isArray(next.outputs)) throw new Error('模拟量状态格式无效，请检查后台版本')
        if (!cancelled && epoch === generation.current) {
          accept(next); setReadError('')
        }
      } catch (error) {if (!cancelled && epoch === generation.current) {setFresh(false); setReadError(errorMessage(error, '模拟量状态读取失败'))}}
      finally {if (!cancelled) timer = setTimeout(read, 1000)}
    }
    void read()
    return () => {cancelled = true; clearTimeout(timer); sequence.current++}
  }, [])
  useEffect(() => {
    if (!lastRead) return
    const timer = setTimeout(() => setFresh(false), Math.max(0, 3500 - (Date.now() - lastRead)))
    return () => clearTimeout(timer)
  }, [lastRead])
  const editable = auth && !!draft && !busy && !stopping && !state?.enabled && !state?.manual_active && !state?.unconfirmed
  const writable = auth && connected && fresh && !busy && !stopping
  const patch = <K extends keyof Config>(key: K, value: Config[K]) => setDraft(prior => prior ? {...prior, [key]: value} : prior)
  function mapping(index: number, key: keyof Mapping, value: unknown) {
    if (draft) patch('outputs', draft.outputs.map((row, i) => i === index ? {...row, [key]: value} : row))
  }
  async function act(path: string, success: string) {
    const stop = path === '/stop'
    if (!auth || stopPending.current || !stop && inFlight.current) return
    if (stop) {stopPending.current = true; setStopping(true)} else {inFlight.current = true; setBusy(path)}
    const epoch = ++generation.current
    setError(''); setMessage('')
    try {
      if (path === '/enable' && mappingDirty) {
        const savedState = await request<State>('/config', 'PATCH', mappingChanges())
        if (epoch !== generation.current) return
        accept(savedState); setDraft(prior => prior ? {...prior, outputs:structuredClone(savedState.config.outputs), update_interval_s:savedState.config.update_interval_s} : prior)
      }
      if (epoch !== generation.current) return
      let next: State
      if (path === '/apply-connect' && draft) {
        const result = await applyConnection<State>('analog', changedFields(saved, draft, [...CONNECTION]))
        if (epoch !== generation.current) return
        accept(result.state)
        if (result.config_saved) setDraft(prior => prior ? {...prior, ...Object.fromEntries(CONNECTION.map(key => [key,result.state.config[key]]))} : prior)
        if (!result.ok) throw new Error(connectionMessage(result))
        next = result.state
      } else next = await request<State>(path, path === '/config' ? 'PATCH' : 'POST', path === '/config' ? mappingChanges() : {})
      if (epoch !== generation.current) return
      accept(next); if (path === '/config') setDraft(prior => prior ? {...prior, outputs:structuredClone(next.config.outputs), update_interval_s:next.config.update_interval_s} : prior)
      setFresh(true); setLastRead(Date.now()); setMessage(success)
    } catch (error) {if (epoch === generation.current) {setFresh(false); setError(errorMessage(error, '模拟量操作未确认，请检查状态，勿重复发送输出请求。'))}}
    finally {
      if (epoch === generation.current) generation.current++
      if (stop) {stopPending.current = false; setStopping(false)} else {inFlight.current = false; setBusy('')}
    }
  }
  const connectionCard = <section className="content-panel glass-panel hardware-card" id="analog-connection-card">
    <div className="panel-heading"><h2>ZS-AO-4-RJ45 <HelpTooltip label="模拟量连接说明">中盛科技，4–20mA 模拟量输出。填写模块的目标连接地址；应用时停止输出并重新连接，重连后输出保持停止。</HelpTooltip></h2><span className="status-chip">{!fresh ? '状态未确认' : state?.connected ? '已连接' : '未连接'}</span></div>
    {readError && <p className="inline-error">{readError}</p>}{error && <p className="inline-error" role="alert">{error}</p>}{message && <p className="hardware-message" role="status">{message}</p>}
    {draft ? <><fieldset disabled={!auth || !!busy || stopping}><div className="settings-grid">
      <label className="field">模拟量运行模式<select value={draft.mode} onChange={event => patch('mode',event.target.value as Config['mode'])}><option value="real">真实设备</option><option value="simulation">模拟设备</option></select></label>
      <div className="field">连接方式<span className="hardware-interface">以太网 · Modbus TCP</span></div>
      <label className="field">模拟量模块 IP 地址<input value={draft.host} placeholder="192.168.0.7" onChange={event => patch('host',event.target.value.trim())}/></label>
      <label className="field">模拟量 TCP 端口<input type="number" min={1} max={65535} value={draft.port} onChange={event => patch('port',Number(event.target.value))}/></label>
      <label className="field">模拟量站号<input type="number" min={1} max={255} value={draft.unit_id} onChange={event => patch('unit_id',Number(event.target.value))}/></label>
    </div><Disclosure title="高级参数"><label className="field">AO1 起始寄存器 <HelpTooltip label="寄存器地址说明">已核查厂家测试软件使用 0x000A–0x000D。旧配置保留原地址，不通过试写寻找地址。</HelpTooltip><select value={draft.register_base ?? ''} onChange={event => patch('register_base',event.target.value === '' ? null : Number(event.target.value) as 0 | 10)}><option value="">未设置</option><option value="10">0x000A</option><option value="0">0x0000</option></select></label></Disclosure></fieldset>
    {connectionDirty && <p className="subtle-note">有未保存的连接参数</p>}
    <div className="hardware-actions"><button className="button button--quiet" disabled={!auth || !!busy || stopping || !connectionDirty} onClick={() => setDraft(prior => prior && saved ? {...prior, ...Object.fromEntries(CONNECTION.map(key => [key,saved[key]]))} : prior)}>放弃连接更改</button>
    <button className="button button--primary" disabled={!writable} onClick={() => void act('/apply-connect','参数已应用，模拟量模块已连接')}><Plug size={15}/>{busy === '/apply-connect' ? '应用中…' : state?.connected ? '应用并重新连接模拟量模块' : '应用并连接模拟量模块'}</button>
    <button className="button button--quiet" disabled={!writable || !state?.connected} onClick={() => void act('/disconnect','模拟量模块已断开')}><Unplug size={15}/>断开模拟量模块</button>
    <button className="button stage-stop" disabled={!auth || stopping || !busy && !state?.enabled && !state?.manual_active && !state?.unconfirmed} onClick={() => void act('/stop','输出已停止，后续连接已取消')}><Square size={15}/>{stopping ? '停止中…' : '停止模拟量输出'}</button></div></> : <p>正在读取模拟量连接…</p>}
  </section>
  return <>{connectionHost === undefined ? connectionCard : connectionHost && createPortal(connectionCard,connectionHost)}<section className="content-panel glass-panel analog-panel">
    <div className="panel-heading"><div><h2>模拟量输出 <HelpTooltip label="模拟量输出说明">目标电流加校准偏移后限幅至 4–20mA。压力失效或停止时写入故障电流；断线时模块可能保持最后电流。设定值不代表实测电流。</HelpTooltip></h2></div><span className={`status-chip ${fresh && state?.connected ? 'status-chip--ok' : 'status-chip--muted'}`}>{!fresh ? '状态未确认' : state?.enabled ? '实时输出中' : state?.manual_active ? '手动输出中' : state?.connected ? '已连接 · 输出未启用' : '未连接'}</span></div>
    {readError && <p className="inline-error" role="alert">{readError}</p>}{state?.error && <p className="inline-error" role="alert">{state.error}</p>}{error && <p className="inline-error" role="alert">{error}</p>}{message && <p className="stage-message" role="status">{message}</p>}
    {draft ? <>
      <div className="hardware-actions"><button className="button button--quiet" onClick={onOpenConnection}>设备连接设置</button></div>
      {saved?.register_base == null && <p className="inline-error">输出寄存器尚未设置，请在设备连接的高级参数中填写。</p>}
      <label className="field">输出更新周期（秒）<input type="number" min={0.2} max={10} step={0.1} disabled={!editable} value={draft.update_interval_s} onChange={event => patch('update_interval_s',Number(event.target.value))}/></label>
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
          <div className="analog-current"><strong>{fresh && current && !state?.unconfirmed ? `${current.current_ma.toFixed(3)} mA` : '—'}</strong>{fresh && current?.target_ma != null && !state?.unconfirmed && <small>目标 {current.target_ma.toFixed(3)}mA · 已用偏移 {(current.offset_ma ?? 0) >= 0 ? '+' : ''}{(current.offset_ma ?? 0).toFixed(3)}mA</small>}<small>{state?.unconfirmed ? '输出未确认，请检查模块连接' : fresh && current ? current.status : '暂无已确认的设定值'}</small><small>设定电流</small></div>
        </fieldset>
      })}</div>
      {mappingDirty && <p className="subtle-note">有未保存的模拟量映射</p>}
      <div className="stage-actions">
        <button className="button button--primary" disabled={!writable || !editable || !mappingDirty || draft.outputs.some(row => !validOffset(row.offset_ma))} onClick={() => void act('/config', '模拟量配置已保存，未启用输出')}><Check size={15}/>{busy === '/config' ? '保存中…' : '保存模拟量设置'}</button>
        <button className="button button--quiet" disabled={!writable || !state?.connected || state.enabled || state.manual_active || state.unconfirmed || saved?.register_base == null || !draft.outputs.some(row => row.enabled) || draft.outputs.some(row => !validOffset(row.offset_ma))} onClick={() => void act('/enable', '当前参数已保存，实时压力电流输出已启用')}>{busy === '/enable' ? '保存并启用中…' : '开始实时输出'}</button>
        <button className="button stage-stop" disabled={!auth || stopping || !busy && !state?.enabled && !state?.manual_active && !state?.unconfirmed} onClick={() => void act('/stop', '实时输出已停止，已写入各通道故障电流')}><Square size={15}/>{stopping ? '停止中…' : '停止实时输出'}</button>
      </div>
    </> : <p>正在读取模拟量设置…</p>}
  </section></>
}
