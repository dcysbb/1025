import { useCallback, useEffect, useRef, useState } from 'react'
import { Plug, Square, Unplug } from 'lucide-react'
import StageWorkbench from './StageWorkbench'
import StageAdvanced from './StageAdvanced'
import { AXES, StageRequestError, stageApi, type Axis, type StageConfig, type StageState, type DriveParameters, type ParameterState } from './stageClient'
import { errorMessage } from './apiClient'

function request<T>(path = '', method = 'GET', body?: unknown) {
  return stageApi<T>(`/api/stage${path}`, method, body, path === '/connect' || path === '/recover' ? 45000 : method === 'GET' ? 5000 : 20000)
}

export default function StagePanel({ auth, connected, configuration = false, onDirtyChange }: { auth: boolean; connected: boolean; configuration?: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [state, setState] = useState<StageState | null>(null)
  const [draft, setDraft] = useState<StageConfig | null>(null)
  const [online, setOnline] = useState(false)
  const [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false)
  const [message, setMessage] = useState(''), [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [uncertain, setUncertain] = useState(false), [awaitingRefresh, setAwaitingRefresh] = useState(false)
  const [lastRead, setLastRead] = useState(0), [historyVersion, setHistoryVersion] = useState(0)
  const commandRef = useRef(false), stopRef = useRef(false), generation = useRef(0), actionId = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accept = useCallback((next: StageState) => {
    setState(next)
    setDraft(prior => configuration ? prior ?? structuredClone(next.config) : structuredClone(next.config))
    setOnline(true)
    setReadError('')
    setLastRead(Date.now())
    setAwaitingRefresh(false)
  }, [configuration])
  useEffect(() => {
    if (!lastRead) return
    const timer = setTimeout(() => setOnline(false), Math.max(0, 3500 - (Date.now() - lastRead)))
    return () => clearTimeout(timer)
  }, [lastRead])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      const epoch = generation.current
      try {
        if (commandRef.current || stopRef.current) return
        const next = await request<StageState>()
        if (!cancelled && epoch === generation.current) {
          if (!next.config || !Array.isArray(next.channels)) throw new Error('位移台状态格式无效')
          accept(next)
        }
      } catch (error) {
        if (!cancelled && epoch === generation.current) {
          setOnline(false)
          setReadError(errorMessage(error, '读取 PDXC3 位移台状态失败'))
        }
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 1000)
      }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [accept])

  async function act(path: string, body?: unknown, success = '') {
    const isStop = path === '/stop'
    if (isStop ? stopRef.current : commandRef.current || stopRef.current) return
    if (!auth) return
    if (isStop) stopRef.current = true
    else commandRef.current = true
    const mine = ++actionId.current
    generation.current++
    if (isStop) setStopping(true)
    else setBusy(true)
    setError(''); setMessage('')
    try {
      const next = await request<StageState>(path, path === '/config' ? 'PUT' : 'POST', body ?? {})
      if (mounted.current && mine === actionId.current) {
        accept(next)
        if (path === '/config') setDraft(structuredClone(next.config))
        if (path === '/connect' || path === '/recover' || path === '/disconnect' || isStop && !next.motion_pending) setUncertain(false)
        setMessage(isStop ? next.motion_pending ? '已发送停止，等待空闲确认' : '控制器已报告全部通道空闲' : success)
      }
    } catch (e) {
      if (mounted.current && mine === actionId.current) {
        const ambiguous = (path === '/move' || path === '/action' || isStop) && !(e instanceof StageRequestError)
        if (ambiguous) setUncertain(true)
        setAwaitingRefresh(true)
        const reason = errorMessage(e, '位移台操作失败')
        setError(ambiguous ? `${reason} ${isStop ? '无法确认设备已停止，禁止继续移动；请检查控制器连接和运动状态。' : '请求结果未确认，勿重复移动；请发送停止并检查连接。'}` : reason)
      }
    } finally {
      generation.current++
      if (isStop) stopRef.current = false
      else commandRef.current = false
      if (mounted.current) {
        if (isStop) setStopping(false)
        else setBusy(false)
        setHistoryVersion(version => version + 1)
      }
    }
  }
  async function parameters(axis: Axis, values?: DriveParameters) {
    if (commandRef.current || stopRef.current || !auth || !connected || !online || !state?.connected) throw new Error('当前不能读取或应用驱动参数')
    commandRef.current = true
    const mine = ++actionId.current
    generation.current++; setBusy(true)
    try {
      const result = await stageApi<ParameterState>(`/api/stage/parameters/${axis}`, values ? 'PUT' : 'GET', values, 20000)
      if (!mounted.current || mine !== actionId.current) throw new Error('操作已被停止请求替代，请重新读取参数')
      return result
    } finally {
      generation.current++; commandRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const writable = auth && connected && online
  const dirty = draft && state && JSON.stringify(draft) !== JSON.stringify(state.config)
  useEffect(() => { onDirtyChange?.(!!dirty) }, [dirty, onDirtyChange])
  const validMapping = draft && new Set(Object.values(draft.axes)).size === 3
  function move(axis: Axis, direction: -1 | 1, steps: number) {
    if (!writable || !state?.connected || state.error || uncertain || awaitingRefresh || dirty || state.motion_pending ||
      state.channels.length !== 3 || state.channels.some(row => row.moving !== false) ||
      !state.channels.find(row => row.channel === state.config.axes[axis])?.ready ||
      !Number.isSafeInteger(steps) || steps < 1 || steps > state.config.max_steps) return
    void act('/move', { axis, direction, steps }, `${axis.toUpperCase()} 轴请求已下发，等待状态采样确认空闲`)
  }

  return <div className="page-content stage-panel">
    <section className="content-panel glass-panel stage-header">
      <div><h2>PD1V/M 位移台 <span className="stage-model">PDXC3</span></h2><p>开环步数控制 · 不提供实测位置</p></div>
      <div className="stage-actions">
        <span className="mode-badge" data-mode={state?.config.mode}>{state?.config.mode === 'simulation' ? '模拟设备' : '真实设备'}</span>
        <span className={`stage-state ${state?.connected && online ? 'stage-state--on' : ''}`}>
          {!online ? '状态过期 / 等待更新' : state?.connected ? state.motion_pending ? '等待运动确认' : '已连接' : '未连接'}
        </span>
        {!configuration && <button className="button button--quiet" disabled={!writable || busy || stopping || !!state?.error || !state || state.connected}
          onClick={() => void act('/connect', {}, '位移台已连接')}><Plug size={15}/>连接控制器</button>}
        <button className="button stage-stop" disabled={!auth || stopping || !state?.connected && !state?.error && !uncertain}
          onClick={() => void act('/stop')}><Square size={15}/>{stopping ? '正在停止…' : '全部停止'}</button>
      </div>
    </section>
    {readError && <div className="inline-error" role="alert">{readError} 当前位移台状态已过期，点动暂停；正在自动重试读取，停止入口保留。</div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {state?.error && <div className="inline-error" role="alert">{state.error}</div>}
    {message && <p className="stage-message" role="status">{message}</p>}
    {!auth && <p>登录后可配置和控制位移台。</p>}
    {state?.config.mode === 'simulation' && <div className="stage-simulation">模拟模式：按钮只改变模拟数据。</div>}
    {configuration && <section className="content-panel glass-panel">
      <div className="panel-heading"><h2>连接与轴映射</h2></div>
      {!draft ? <p>{online ? '正在读取配置…' : '等待后台连接…'}</p> : <>
        <fieldset disabled={!writable || busy || !!state?.connected || !!state?.channels.length} className="stage-config">
          <label className="field">连接模式<select value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as StageConfig['mode'] })}>
            <option value="real">真实设备</option><option value="simulation">模拟设备</option>
          </select></label>
          <label className="field">控制器序列号<input placeholder="129…" inputMode="numeric" value={draft.serial_number}
            onChange={e => setDraft({ ...draft, serial_number: e.target.value.trim() })} /></label>
          <label className="field">PDXC3 连接方式<select value={draft.connection ?? 'tcp'} onChange={e => setDraft({ ...draft, connection: e.target.value as 'usb' | 'tcp' })}><option value="tcp">以太网 TCP</option><option value="usb">原生 USB</option></select></label>
          {(draft.connection ?? 'tcp') === 'tcp' && <>
          <label className="field">IPv4 地址（留空自动发现）<input placeholder="自动发现本机网段" value={draft.host}
            onChange={e => setDraft({ ...draft, host: e.target.value.trim() })} /></label>
          <label className="field">网络端口<input type="number" min={1} max={65535} value={draft.port}
            onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
          </>}
          <label className="field">单次步数上限<input type="number" min={1} max={100000} value={draft.max_steps}
            onChange={e => setDraft({ ...draft, max_steps: Number(e.target.value) })} /></label>
          {AXES.map(axis => <div className="stage-mapping" key={axis}>
            <label className="field">{axis.toUpperCase()} 轴<select aria-label={`${axis.toUpperCase()} 轴通道`} value={draft.axes[axis]}
              onChange={e => setDraft({ ...draft, axes: { ...draft.axes, [axis]: Number(e.target.value) } })}>
              {[1, 2, 3].map(ch => <option key={ch} value={ch}>CH{ch}</option>)}
            </select></label>
            <label className="stage-invert"><input type="checkbox" checked={draft.inverted[axis]}
              onChange={e => setDraft({ ...draft, inverted: { ...draft.inverted, [axis]: e.target.checked } })} />反转方向</label>
          </div>)}
        </fieldset>
        {dirty && <p className="subtle-note">有未保存的更改</p>}
        {!validMapping && <p className="inline-error">XYZ 不能使用重复通道。</p>}
        <div className="stage-actions">
          <button className="button button--quiet" disabled={!writable || busy || state?.connected || !dirty || !validMapping}
            onClick={() => void act('/config', draft, '配置已保存')}>保存位移台配置</button>
          <button className="button button--primary" disabled={!writable || busy || state?.connected || !!dirty}
            onClick={() => void act('/connect', undefined, '位移台已连接')}><Plug size={15} />{busy ? '处理中…' : '连接控制器'}</button>
          <button className="button button--quiet" disabled={!writable || busy || !state?.connected && !state?.error}
            onClick={() => void act('/disconnect', undefined, '位移台已断开')}><Unplug size={15} />断开</button>
        </div>
      </>}
    </section>}

    {!configuration && (state ? <StageWorkbench key={[state.config.serial_number, state.config.mode, state.config.max_steps, ...AXES.map(axis => `${state.config.axes[axis]}:${state.config.inverted[axis]}`)].join('|')} state={state} auth={auth} connected={connected} online={online}
      busy={busy} stopping={stopping} uncertain={uncertain} awaitingRefresh={awaitingRefresh} historyVersion={historyVersion}
      onMove={move} onStop={() => { void act('/stop') }} advanced={<StageAdvanced state={state} auth={auth} online={connected && online} busy={busy || stopping} uncertain={uncertain || awaitingRefresh}
        onAct={act} onParameters={parameters}/>}/> : <section className="content-panel glass-panel">正在读取位移台状态…</section>)}
  </div>
}
