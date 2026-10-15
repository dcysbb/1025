import { useEffect, useState } from 'react'
import { ArrowLeftRight, Plug, Square, Unplug } from 'lucide-react'

type Axis = 'x' | 'y' | 'z'
type StageConfig = {
  mode: 'real' | 'simulation'
  connection: 'usb' | 'tcp'
  serial_number: string
  host: string
  port: number
  axes: Record<Axis, number>
  inverted: Record<Axis, boolean>
  max_steps: number
}
type StageState = {
  config: StageConfig
  connected: boolean
  error: string | null
  channels: { channel: number; moving: boolean | null; enabled: boolean; stage: string; ready: boolean; error: string | null; commanded_steps?: number }[]
}
const AXES: Axis[] = ['x', 'y', 'z']

async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/stage${path}`, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('auth-needed'))
    throw new Error(typeof result.detail === 'string' ? result.detail : '请检查配置或输入范围')
  }
  return result
}

export default function StagePanel({ auth, connected, configuration = false, onDirtyChange }: { auth: boolean; connected: boolean; configuration?: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [state, setState] = useState<StageState | null>(null)
  const [draft, setDraft] = useState<StageConfig | null>(null)
  const [steps, setSteps] = useState(10)
  const [online, setOnline] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await request<StageState>()
        if (!cancelled) {
          setState(next)
          setDraft(prior => configuration ? prior ?? structuredClone(next.config) : structuredClone(next.config))
          setOnline(true)
        }
      } catch {
        if (!cancelled) setOnline(false)
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 1000)
      }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [configuration])

  async function act(path: string, body?: unknown, success = '') {
    const isStop = path === '/stop'
    if (isStop) setStopping(true)
    else setBusy(true)
    setError('')
    setMessage('')
    try {
      const next = await request<StageState>(path, path === '/config' ? 'PUT' : 'POST', body ?? {})
      setState(next)
      if (path === '/config') setDraft(structuredClone(next.config))
      setOnline(true)
      setMessage(success)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      if (isStop) setStopping(false)
      else setBusy(false)
    }
  }

  const writable = auth && connected && online
  const dirty = draft && state && JSON.stringify(draft) !== JSON.stringify(state.config)
  useEffect(() => { onDirtyChange?.(!!dirty) }, [dirty, onDirtyChange])
  const validMapping = draft && new Set(Object.values(draft.axes)).size === 3
  const validSteps = Number.isSafeInteger(steps) && steps >= 1 && steps <= (state?.config.max_steps ?? 1000)
  const moving = state?.channels.some(c => c.moving !== false)
  const canMove = writable && state?.connected && !busy && !stopping && !moving && !dirty && validSteps

  return <div className="page-content stage-panel">
    <section className="content-panel glass-panel stage-header">
      <div>
        <h2>PD1V/M 位移台 <span className="stage-model">PDXC3</span></h2>
        <p>开环步数控制 · 不提供实测位置</p>
      </div>
      <div className="stage-actions">
        <span className={`stage-state ${state?.connected && online ? 'stage-state--on' : ''}`}>
          {state?.config.mode === 'simulation' ? '模拟 · ' : '实机 · '}
          {!online ? '后台未连接' : state?.connected ? '已连接' : '未连接'}
        </span>
        <button className="button stage-stop" disabled={!writable || stopping || !state?.connected && !state?.error}
          onClick={() => void act('/stop', undefined, '已发送全部通道停止指令')}>
          <Square size={15} />{stopping ? '正在停止…' : '全部停止'}
        </button>
      </div>
    </section>

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

    {!configuration && <section className="content-panel glass-panel">
      <div className="panel-heading stage-move-heading"><h2>轴运动</h2>
        <label className="field">每次移动（步）<input aria-label="每次移动步数" type="number" min={1}
          max={state?.config.max_steps ?? 1000} value={steps} onChange={e => setSteps(Number(e.target.value))} /></label>
      </div>
      {!validSteps && <p className="inline-error">步数必须为 1–{state?.config.max_steps ?? 1000} 的整数。</p>}
      {dirty && <p className="stage-note">请先保存轴映射。</p>}
      <div className="stage-axis-grid">{AXES.map(axis => {
        const channel = state?.config.axes[axis] ?? AXES.indexOf(axis) + 1
        const row = state?.channels.find(c => c.channel === channel)
        return <article className={`stage-axis stage-axis--${axis}`} key={axis}>
          <div className="stage-axis-title"><strong>{axis.toUpperCase()}</strong><span>CH{channel}{state?.config.inverted[axis] ? ' · 反向' : ''}</span></div>
          <p>{!state?.connected || !online ? '未连接' : row?.moving === true ? '运动中' : !row?.ready ? '未就绪' : row?.moving === false ? '空闲' : '状态未知'}</p>
          <div className="stage-axis-buttons">
            {([-1, 1] as const).map(direction => <button key={direction} className="button button--quiet"
              aria-label={`${axis.toUpperCase()} 轴${direction === 1 ? '正向' : '反向'}移动`} disabled={!canMove || !row?.ready}
              onClick={() => void act('/move', { axis, direction, steps }, '移动请求已发送')}>
              {direction === -1 ? '−' : '+'} {axis.toUpperCase()}
            </button>)}
          </div>
          {row?.error && <p className="inline-error" role="alert">{row.error}</p>}
          {row?.commanded_steps !== undefined && <small>模拟累计：{row.commanded_steps} 步</small>}
        </article>
      })}</div>
      <p className="stage-note"><ArrowLeftRight size={14} />实际位移随负载和驱动设置变化；每次点击只发送一次有限步数移动。</p>
    </section>}
  </div>
}
