import { useEffect, useState } from 'react'
import { Check, Plug, RefreshCw } from 'lucide-react'
import StagePanel from './StagePanel'
import { Disclosure } from './Motion'
import { apiRequest, errorMessage } from './apiClient'
import TerminalWorkbench, { type TerminalSystemState } from './TerminalWorkbench'
import { outputTerminals } from './terminalDefinitions'

type TerminalText = 'dam_input_labels' | 'dam_output_labels' | 'dam_input_notes' | 'dam_output_notes'
export type HardwareConfig = {
  mode: 'real' | 'simulation'; tpg_connection: 'tcp' | 'usb'; tpg_serial_port: string; tpg_baudrate: number; tpg_host: string; tpg_port: number
  io_device: 'dam0808d' | 'adam6050'; dam_serial_port: string; dam_baudrate: number; dam_unit_id: number
  adam_host: string; adam_port: number; adam_unit_id: number
  valve_closed_di: number; valve_open_di: number | null; open_output: number
  valve_closed_active_high: boolean; valve_open_active_high: boolean
  valve_open_on_energized: boolean
} & Record<TerminalText, string[]>
type HardwareStatus = { tpg: { connected: boolean; error: string | null }; io: { connected: boolean; error: string | null; inputs: boolean[] | null; outputs: boolean[] | null; manual_reset_required: boolean } }
const TPG: (keyof HardwareConfig)[] = ['tpg_connection', 'tpg_serial_port', 'tpg_baudrate', 'tpg_host', 'tpg_port']
const IO: (keyof HardwareConfig)[] = ['io_device', 'dam_serial_port', 'dam_baudrate', 'dam_unit_id', 'adam_host', 'adam_port', 'adam_unit_id']
const MAPPING: (keyof HardwareConfig)[] = ['valve_closed_di', 'valve_open_di', 'open_output', 'valve_closed_active_high', 'valve_open_active_high', 'valve_open_on_energized']
const TEXT: TerminalText[] = ['dam_input_labels', 'dam_output_labels', 'dam_input_notes', 'dam_output_notes']
const FIXED = [
  [1, '电源 +', 'DC 7–30 V'], [2, '电源 −', '电源负极'], [3, 'A+', 'RS485 A'], [4, 'B−', 'RS485 B'],
  [5, 'PB', '厂家标识；软件未使用'], [6, 'TX', 'RS232 发送'], [7, 'RX', 'RS232 接收'], [8, 'GND', '通信地'],
  [9, 'COM+', '输入公共正端'], [18, 'COM−', '输入公共负端'],
] as const
function request<T>(path: string, method = 'GET', body?: unknown, operation?: string): Promise<T> {
  return apiRequest<T>(`/api${path}`, { method, operation, body: body === undefined ? undefined : JSON.stringify(body) })
}

function normalize(config: HardwareConfig) {
  return { ...config, valve_open_on_energized: config.valve_open_on_energized ?? true, ...Object.fromEntries(TEXT.map(key => [key, config[key] ?? Array(8).fill('')])) } as HardwareConfig
}

export default function HardwarePanel({ auth, connected, systemState, onDirtyChange }: { auth: boolean; connected: boolean; systemState?: TerminalSystemState | null; onDirtyChange?: (dirty: boolean) => void }) {
  const [tab, setTab] = useState<'devices' | 'terminals' | 'valve'>('devices')
  const [saved, setSaved] = useState<HardwareConfig | null>(null)
  const [draft, setDraft] = useState<HardwareConfig | null>(null)
  const [state, setState] = useState<HardwareStatus | null>(null)
  const [online, setOnline] = useState(false)
  const [ports, setPorts] = useState<{ device: string; description: string }[]>([])
  const [portsLoading, setPortsLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [terminalBusy, setTerminalBusy] = useState(false), [lastRead, setLastRead] = useState(0)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [loadVersion, setLoadVersion] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [stageDirty, setStageDirty] = useState(false)
  const writable = auth && connected && online && !busy && !terminalBusy && !errors.load
  const editable = auth && !busy && !terminalBusy && !errors.load
  const editReason = !auth ? '需要操作员权限才能修改；本机访问会自动取得本机操作权限。'
    : errors.load ? '硬件配置尚未读取成功，请先重新读取配置。'
    : busy ? '正在保存或连接设备，请等待本次请求结束。'
    : terminalBusy ? '正在操作 DAM 端子，请等待本次请求结束。' : ''
  const dirty = (keys: (keyof HardwareConfig)[]) => !!draft && !!saved && keys.some(key => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]))
  const anyDirty = dirty([...TPG, ...IO, ...MAPPING, ...TEXT]) || stageDirty
  useEffect(() => { onDirtyChange?.(anyDirty) }, [anyDirty, onDirtyChange])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (anyDirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])
  useEffect(() => {
    if (!lastRead) return
    const timer = setTimeout(() => setOnline(false), Math.max(0, 3500 - (Date.now() - lastRead)))
    return () => clearTimeout(timer)
  }, [lastRead])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    void request<{ config: HardwareConfig }>('/config', 'GET', undefined, '读取硬件连接配置').then(data => {
      if (!cancelled) { setSaved(normalize(data.config)); setDraft(normalize(data.config)); setErrors(prior => ({ ...prior, load: '' })) }
    }).catch(error => { if (!cancelled) setErrors(prior => ({ ...prior, load: errorMessage(error, '读取硬件连接配置失败') })) })
    async function poll() {
      try { const next = await request<HardwareStatus>('/hardware/status'); if (!cancelled) { setState(next); setOnline(true); setLastRead(Date.now()); setErrors(prior => ({ ...prior, status: '' })) } }
      catch (error) { if (!cancelled) { setOnline(false); setErrors(prior => ({ ...prior, status: errorMessage(error, '读取真空规与 I/O 控制器状态失败') })) } }
      finally { if (!cancelled) timer = setTimeout(poll, 2000) }
    }
    void poll()
    void refreshPorts()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [loadVersion])
  async function refreshPorts() {
    setPortsLoading(true)
    try {
      const next = await request<{ ports: typeof ports }>('/hardware/ports')
      if (!Array.isArray(next.ports) || next.ports.some(port => typeof port.device !== 'string' || typeof port.description !== 'string')) throw new Error('读取串口列表失败：后台返回的列表格式异常，请刷新列表并检查后台版本。')
      setPorts(next.ports); setErrors(prior => ({ ...prior, ports: '' }))
    }
    catch (error) { setErrors(prior => ({ ...prior, ports: error instanceof Error ? error.message : '串口列表读取失败' })) }
    finally { setPortsLoading(false) }
  }
  const patch = <K extends keyof HardwareConfig>(key: K, value: HardwareConfig[K]) => setDraft(prior => prior && ({ ...prior, [key]: value }))
  async function run(section: string, action: () => Promise<void>, message: string) {
    setBusy(section); setErrors(prior => ({ ...prior, [section]: '' })); setMessages(prior => ({ ...prior, [section]: '' }))
    try { await action(); setMessages(prior => ({ ...prior, [section]: message })) }
    catch (error) { setErrors(prior => ({ ...prior, [section]: error instanceof Error ? error.message : '操作失败' })) }
    finally { setBusy('') }
  }
  function save(section: string, keys: (keyof HardwareConfig)[]) {
    if (!draft) return
    const values = Object.fromEntries(keys.map(key => [key, draft[key]]))
    void run(section, async () => {
      const next = await request<{ config: HardwareConfig; warning?: string | null }>('/config', 'PATCH', { config: values }, `保存${section === 'tpg' ? 'TPG366 真空规连接配置' : section === 'io' ? 'I/O 控制器连接配置' : section === 'valve' ? '插板阀映射' : 'DAM 端子名称与备注'}`)
      const normalized = normalize(next.config)
      setSaved(normalized)
      setDraft(prior => prior && ({ ...prior, ...Object.fromEntries(keys.map(key => [key, normalized[key]])) }))
      if (next.warning) setErrors(prior => ({ ...prior, [section]: next.warning! }))
    }, '已保存')
  }
  const notice = (id: string) => <>{errors[id] && <p className="inline-error" role="alert">{errors[id]}</p>}{messages[id] && <p role="status" className="hardware-message">{messages[id]}</p>}</>
  const actions = (id: string, keys: (keyof HardwareConfig)[], path?: string, saveLabel?: string) => <div className="hardware-actions">
    <span className="subtle-note">{dirty(keys) ? '有未保存的更改' : '已保存'}{id !== 'terminals' && dirty(keys) ? ' · 应用配置将关阀并撤销现场验证' : ''}</span>
    <button className="button button--quiet" disabled={!dirty(keys) || !!busy || terminalBusy} onClick={() => setDraft(prior => prior && saved && ({ ...prior, ...Object.fromEntries(keys.map(key => [key, saved[key]])) }))}>放弃更改</button>
    <button className="button button--primary" aria-label={saveLabel ?? `保存${id === 'tpg' ? '真空规' : id === 'io' ? 'I/O' : id === 'valve' ? '阀门映射' : '端子定义'}`} disabled={!writable || !dirty(keys) || id === 'valve' && (dirty(IO) || draft?.valve_closed_di === draft?.valve_open_di)} onClick={() => save(id, keys)}><Check size={15} />{saveLabel ?? '保存'}</button>
    {path && <button className="button" disabled={!writable || dirty(keys) || (id === 'io' && state?.io.manual_reset_required)} onClick={() => void run(id, async () => { await request(path, 'POST', {}); setState(await request('/hardware/status')) }, '设备连接成功')}><Plug size={15} />连接{id === 'tpg' ? '真空规' : 'I/O'}</button>}
  </div>
  const status = (id: 'tpg' | 'io') => <><span className={`status-chip ${online && state?.[id].connected ? 'status-chip--ok' : 'status-chip--muted'}`}>{online ? state?.[id].connected ? '在线' : '未连接' : '状态未知'}</span>{state?.[id].error && <p className="inline-error">{state[id].error}</p>}</>
  const serialField = (key: 'tpg_serial_port' | 'dam_serial_port', label: string) => <label className="field">{label}<input list="hardware-com-ports" value={draft?.[key] ?? ''} placeholder="输入 COM 口，或从列表选择" onChange={event => patch(key, event.target.value.trim().toUpperCase())} /></label>
  const baudField = (key: 'tpg_baudrate' | 'dam_baudrate', label: string) => <label className="field">{label}<select value={draft?.[key]} onChange={event => patch(key, Number(event.target.value))}>{(key === 'tpg_baudrate' ? [9600, 19200, 38400, 57600, 115200] : [2400, 4800, 9600, 19200, 38400]).map(rate => <option key={rate} value={rate}>{rate}</option>)}</select></label>
  const numberField = (key: 'tpg_port' | 'dam_unit_id' | 'adam_port' | 'adam_unit_id', label: string, max = 65535) => <label className="field">{label}<input type="number" min={key === 'adam_unit_id' ? 0 : 1} max={max} value={draft?.[key] ?? 0} onChange={event => patch(key, Number(event.target.value))} /></label>


  return <div className="page-content hardware-panel">
    <div className="hardware-tabs" role="tablist" aria-label="硬件配置">
      {([['devices', '设备连接'], ['terminals', 'DAM 端子'], ['valve', '插板阀映射']] as const).map(([id, title]) => <button role="tab" aria-selected={tab === id} aria-controls={`hardware-${id}`} id={`hardware-tab-${id}`} key={id} className={`button ${tab === id ? 'button--primary' : 'button--quiet'}`} onClick={() => setTab(id)}>{title}</button>)}
    </div>
    {notice('load')}{errors.load && <button className="button button--quiet" onClick={() => setLoadVersion(value => value + 1)}>重新读取硬件配置</button>}{(!connected || !online) && <p className="inline-error" role="alert">{errors.status || '正在读取后台与硬件状态…'} 保存和连接已暂停；设备是否在线尚未确认，正在自动重试读取。</p>}
    {!draft ? <p>正在读取硬件配置…</p> : <>
      <datalist id="hardware-com-ports">{ports.map(port => <option key={port.device} value={port.device}>{port.description}</option>)}</datalist>
      <div role="tabpanel" aria-labelledby="hardware-tab-devices" id="hardware-devices" hidden={tab !== 'devices'}>
        {editReason && <p className="inline-error" role="status">{editReason}</p>}
        <div className="hardware-tools"><span>{portsLoading ? '正在枚举系统串口…' : ports.length ? `系统识别到：${ports.map(port => `${port.device} · ${port.description}`).join('；')}` : '未识别到串口'}</span><button className="button button--quiet" onClick={() => void refreshPorts()} disabled={!auth || !connected || portsLoading}><RefreshCw size={15} />{portsLoading ? '正在刷新…' : '刷新串口列表'}</button></div>{notice('ports')}
        <section className="content-panel glass-panel hardware-card"><div className="panel-heading"><h2>TPG366 真空规</h2>{status('tpg')}</div>
          <fieldset disabled={!editable}><div className="settings-grid">
            <label className="field">真空规连接方式<select value={draft.tpg_connection} onChange={event => patch('tpg_connection', event.target.value as 'usb' | 'tcp')}><option value="usb">USB 串口</option><option value="tcp">以太网 TCP</option></select></label>
            {draft.tpg_connection === 'usb' ? <>{serialField('tpg_serial_port', '真空规串口')}{baudField('tpg_baudrate', '真空规波特率')}</> : <><label className="field">真空规 IP 地址<input value={draft.tpg_host} onChange={event => patch('tpg_host', event.target.value.trim())} /></label>{numberField('tpg_port', '真空规 TCP 端口')}</>}
          </div></fieldset>{actions('tpg', TPG, '/devices/connect-gauge')}{notice('tpg')}
        </section>
        <section className="content-panel glass-panel hardware-card"><div className="panel-heading"><h2>I/O 控制器</h2>{status('io')}</div>
          <fieldset disabled={!editable}><div className="settings-grid"><label className="field">I/O 型号<select value={draft.io_device} onChange={event => patch('io_device', event.target.value as HardwareConfig['io_device'])}><option value="dam0808d">DAM0808D</option><option value="adam6050">ADAM6050</option></select></label>
            {draft.io_device === 'dam0808d' ? <><div className="field">支持的接口<span className="hardware-interface">USB 转 RS485 · Modbus RTU</span></div>{serialField('dam_serial_port', 'DAM 串口')}{baudField('dam_baudrate', 'DAM 波特率')}{numberField('dam_unit_id', 'DAM 设备地址', 255)}</> : <><div className="field">支持的接口<span className="hardware-interface">以太网 TCP · Modbus TCP</span></div><label className="field">ADAM IP 地址<input value={draft.adam_host} onChange={event => patch('adam_host', event.target.value.trim())} /></label>{numberField('adam_port', 'ADAM TCP 端口')}{numberField('adam_unit_id', 'ADAM 设备地址', 255)}</>}
          </div></fieldset>{actions('io', IO, '/devices/connect-io')}{notice('io')}
          {state?.io.manual_reset_required && <p className="inline-error">I/O 重连已锁存，请在联锁控制中人工复位。</p>}
        </section>
        <StagePanel auth={auth} connected={connected} configuration onDirtyChange={setStageDirty} />
      </div>
      <div role="tabpanel" aria-labelledby="hardware-tab-terminals" id="hardware-terminals" hidden={tab !== 'terminals'}>
        <section className="content-panel glass-panel">
          {saved && state && <TerminalWorkbench draft={draft} saved={saved} active={tab === 'terminals'} auth={auth} connected={connected} online={online} io={state.io} systemState={systemState}
            configurationBusy={!!busy} routingDirty={dirty([...IO, ...MAPPING])} onPatch={changes => setDraft(prior => prior && ({ ...prior, ...changes }))} onBusyChange={setTerminalBusy}
            mappingActions={<>{actions('valve', MAPPING, undefined, '保存功能分配')}{notice('valve')}{dirty(IO) && <p className="inline-error">请先保存或放弃 I/O 连接更改，再保存功能分配。</p>}{draft.valve_closed_di === draft.valve_open_di && <p className="inline-error">打开与关闭到位必须使用不同输入。</p>}</>}
            textActions={<>{actions('terminals', TEXT)}{notice('terminals')}</>}/>}
          <div id="dam-physical-wiring"><Disclosure className="terminal-wiring" title="查看物理端子与接线图">
          <div className="terminal-diagram" aria-label="DAM0808D 端子示意图">
            <div className="terminal-strip">{Array.from({ length: 8 }, (_, i) => <div className={draft.io_device === 'dam0808d' && draft.open_output === i ? 'terminal-chip terminal-chip--valve' : 'terminal-chip'} key={i}><b>OUT{i + 1} / DO{i}</b><small>{outputTerminals(i)}</small></div>)}</div>
            <div className="terminal-board">DAM0808D <span>OUT1–OUT4：COM / NO / NC · OUT5–OUT8：两端常开触点</span></div>
            <div className="terminal-strip terminal-strip--inputs">{Array.from({ length: 18 }, (_, i) => <div className="terminal-chip" key={i}><b>{i + 1}</b><small>{i >= 9 && i <= 16 ? `IN${i - 8} (DI${i - 9})` : FIXED.find(row => row[0] === i + 1)?.[1]}</small></div>)}</div>
          </div>
          <Disclosure className="terminal-fixed" title="电源与通信端子（固定定义）"><table className="hardware-table"><thead><tr><th>物理端子</th><th>标识</th><th>功能</th></tr></thead><tbody>{FIXED.map(([pin, label, description]) => <tr key={pin}><td>{pin}</td><td>{label}</td><td>{description}</td></tr>)}</tbody></table></Disclosure>
          <p className="terminal-help">IN1 对应机身 DI1、软件 DI0。固定电气定义不可修改；功能分配、名称和备注在上方工作台编辑。</p>
          </Disclosure></div>
        </section>
      </div>
      <div role="tabpanel" aria-labelledby="hardware-tab-valve" id="hardware-valve" hidden={tab !== 'valve'}>
        <section className="content-panel glass-panel"><div className="panel-heading"><h2>插板阀映射</h2><span>{draft.io_device.toUpperCase()}</span></div>
          <fieldset disabled={!writable}><div className="settings-grid">
            {(['valve_closed_di', 'valve_open_di', 'open_output'] as const).map(key => <label className="field" key={key}>{key === 'valve_closed_di' ? '关闭到位输入' : key === 'valve_open_di' ? '打开到位输入' : '电磁阀控制输出'}<select value={draft[key] ?? ''} onChange={event => patch(key, event.target.value === '' ? null as never : Number(event.target.value))}>
              {key === 'valve_open_di' && <option value="">未安装</option>}{Array.from({ length: draft.io_device === 'dam0808d' ? 8 : key === 'open_output' ? 6 : 12 }, (_, i) => <option value={i} key={i}>{draft.io_device === 'dam0808d' ? `${key === 'open_output' ? 'OUT' : 'IN'}${i + 1} / ` : ''}{key === 'open_output' ? 'DO' : 'DI'}{i}{draft.io_device === 'dam0808d' && draft[key === 'open_output' ? 'dam_output_labels' : 'dam_input_labels'][i] ? ` · ${draft[key === 'open_output' ? 'dam_output_labels' : 'dam_input_labels'][i]}` : ''}</option>)}</select></label>)}
            {(['valve_closed_active_high', 'valve_open_active_high'] as const).filter(key => key === 'valve_closed_active_high' || draft.valve_open_di !== null).map(key => <label className="field" key={key}>{key === 'valve_closed_active_high' ? '关闭到位有效电平' : '打开到位有效电平'}<select value={String(draft[key])} onChange={event => patch(key, event.target.value === 'true')}><option value="true">高电平有效</option><option value="false">低电平有效</option></select></label>)}
            <label className="field">开关映射<select value={String(draft.valve_open_on_energized)} onChange={event => patch('valve_open_on_energized', event.target.value === 'true')}><option value="true">吸合开阀 / 释放关阀</option><option value="false">吸合关阀 / 释放开阀</option></select></label>
          </div></fieldset>
          <div className="valve-truth"><div><b>继电器吸合</b><span>{draft.valve_open_on_energized ? '开阀请求' : '关阀请求'}</span></div><div><b>继电器释放</b><span>{draft.valve_open_on_energized ? '关阀请求' : '开阀请求'}</span></div></div>
          <p>单路输出控制电磁阀；实际阀门位置以到位反馈为准。</p>
          {draft.valve_closed_di === draft.valve_open_di && <p className="inline-error">打开与关闭到位必须使用不同输入。</p>}
          {actions('valve', MAPPING)}{notice('valve')}
        </section>
      </div>
    </>}
  </div>
}
