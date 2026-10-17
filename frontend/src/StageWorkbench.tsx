import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeftRight, Keyboard, RefreshCw } from 'lucide-react'
import { AXES, stageApi, type Axis, type StageState } from './stageClient'
import { errorMessage } from './apiClient'

type Props = {
  state: StageState; auth: boolean; connected: boolean; online: boolean; busy: boolean; stopping: boolean
  uncertain: boolean; awaitingRefresh: boolean; historyVersion: number
  onMove: (axis: Axis, direction: -1 | 1, steps: number) => void
  onStop: () => void
  advanced?: ReactNode
}
type Movement = { id: number; timestamp: string; message: string; details: { axis?: Axis; channel?: number; direction?: number; hardware_direction?: number; steps?: number; mode?: string; result?: string; reason?: string } }
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const PRESETS = [1, 10, 100, 1000]
const KEYS: Record<string, [Axis, -1 | 1]> = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1], ArrowDown: ['y', -1], ArrowUp: ['y', 1], PageDown: ['z', -1], PageUp: ['z', 1] }
const editable = (target: EventTarget | null) => target instanceof window.Element && !!target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')
const hasDialog = () => !!document.querySelector('[role="dialog"], [aria-modal="true"]')

export default function StageWorkbench({ state, auth, connected, online, busy, stopping, uncertain, awaitingRefresh, historyVersion, onMove, onStop, advanced }: Props) {
  const { config } = state
  const identity = JSON.stringify([config.serial_number, config.mode, ...AXES.map(axis => [config.axes[axis], config.inverted[axis]])])
  const key = `vacuum-stage-steps:v1:${identity}`
  const [steps, setSteps] = useState<Record<Axis, string>>(() => {
    const values = Object.fromEntries(AXES.map(axis => [axis, String(Math.min(10, config.max_steps))])) as Record<Axis, string>
    try {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null')
      if (saved && typeof saved === 'object') for (const axis of AXES) {
        if (typeof saved[axis] === 'string' || typeof saved[axis] === 'number') values[axis] = String(saved[axis]).slice(0, 32)
      }
    } catch { /* Preferences are optional; no hardware configuration is changed. */ }
    return values
  })
  const step = (axis: Axis) => steps[axis]
  function setStep(axis: Axis, value: string) {
    const values = { ...steps, [axis]: value }
    setSteps(values)
    try { window.localStorage.setItem(key, JSON.stringify(values)) } catch { /* Keep working in memory. */ }
  }
  const [keyboard, setKeyboard] = useState(false)
  const armed = useRef(false)
  const area = useRef<HTMLDivElement>(null)
  const disableKeys = useCallback(() => { armed.current = false; setKeyboard(false) }, [])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Revoke keyboard authority whenever device/auth/freshness changes.
    disableKeys()
    const hide = () => { if (document.visibilityState !== 'visible') disableKeys() }
    window.addEventListener('blur', disableKeys)
    document.addEventListener('visibilitychange', hide)
    return () => { window.removeEventListener('blur', disableKeys); document.removeEventListener('visibilitychange', hide) }
  }, [identity, auth, connected, online, state.connected, uncertain, disableKeys])
  useEffect(() => {
    if (!keyboard) return
    const check = () => { if (hasDialog()) disableKeys() }
    const observer = new window.MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal'] })
    check()
    return () => observer.disconnect()
  }, [keyboard, disableKeys])

  const enabled = auth && connected && online && state.connected && !uncertain && !awaitingRefresh && !state.error
  function reason(axis: Axis) {
    const row = state.channels.find(channel => channel.channel === config.axes[axis])
    const count = Number(step(axis))
    if (!auth) return '登录后可点动'
    if (!connected || !online) return '状态过期，等待后台更新'
    if (uncertain) return '请求结果未确认，请先停止并检查连接'
    if (awaitingRefresh) return '等待重新读取控制器状态'
    if (state.error) return state.error
    if (!state.connected) return '控制器未连接，请到“硬件连接”连接设备'
    if (stopping) return '正在发送停止请求'
    if (busy) return '请求发送中，请勿重复操作'
    if (state.motion_pending) return '等待后续状态采样确认空闲'
    if (state.channels.length !== 3 || state.channels.some(channel => channel.moving === null || channel.moving === undefined)) return '通道运动状态未知'
    if (state.channels.some(channel => channel.moving)) return '有通道正在运动，请等待空闲'
    if (!row?.ready) return row?.error || '通道未就绪，请核对识别型号及连接'
    if (!Number.isSafeInteger(count) || count < 1 || count > config.max_steps) return `步数必须为 1–${config.max_steps} 的整数`
    return ''
  }
  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!armed.current) return
    if (editable(event.target) || hasDialog()) { disableKeys(); return }
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) { if (event.repeat && (KEYS[event.key] || event.key === 'Escape')) event.preventDefault(); return }
    if (event.key === 'Escape') { event.preventDefault(); if (auth) onStop(); return }
    const command = KEYS[event.key]
    if (!command) return
    event.preventDefault()
    if (!reason(command[0])) onMove(command[0], command[1], Number(step(command[0])))
  }

  const [events, setEvents] = useState<Movement[]>([])
  const [historyError, setHistoryError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data = await stageApi<{ events: Movement[] }>('/api/events?kind=stage_move&limit=20')
        if (!cancelled) { setEvents(Array.isArray(data.events) ? data.events.slice(0, 20) : []); setHistoryError('') }
      } catch (error) { if (!cancelled) setHistoryError(`运动记录读取失败，当前列表可能已过期。${errorMessage(error, '请稍后重试。')} 此提示只涉及记录读取，运动状态和停止入口单独更新。`) }
      finally { if (!cancelled) timer = setTimeout(refresh, 2000) }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [identity, historyVersion, reload])

  return <>
    <section id="stage-manual" tabIndex={-1} className="content-panel glass-panel stage-workbench">
      <div className="panel-heading"><div><h2>精细手动调节</h2><p className="stage-note">每轴独立步长 · 单次点动 · 上限 {config.max_steps} 步</p></div><span className="stage-open-loop">OPEN LOOP</span></div>
      <div ref={area} tabIndex={0} className={`stage-keyboard-area ${keyboard ? 'stage-keyboard-area--armed' : ''}`} aria-label="键盘点动控制区域"
        onKeyDown={handleKey} onFocusCapture={event => { if (editable(event.target)) disableKeys() }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) disableKeys() }}>
        <div className="stage-keyboard-toolbar"><div><Keyboard size={17}/><span>{keyboard ? '键盘点动已启用' : '键盘点动未启用'}</span></div>
          <button className="button button--quiet" aria-pressed={keyboard} disabled={!enabled} onClick={() => {
            if (armed.current) disableKeys()
            else if (enabled && !hasDialog()) { armed.current = true; setKeyboard(true); area.current?.focus() }
          }}>{keyboard ? '停用键盘' : '启用键盘'}</button>
          <p>← / → X · ↓ / ↑ Y · PageDown / PageUp Z · Esc 停止</p>
        </div>
        <div className="stage-axis-grid">{AXES.map(axis => {
          const row = state.channels.find(channel => channel.channel === config.axes[axis])
          const blocked = reason(axis)
          const known = state.connected && online && connected
          const status = !known ? '状态未知' : row?.moving ? '运动中' : state.motion_pending ? '等待确认' : row?.moving !== false ? '状态未知' : !row.ready ? '未就绪' : '空闲'
          return <article className={`stage-axis stage-axis--${axis}`} key={axis}>
            <div className="stage-axis-title"><strong>{axis.toUpperCase()}</strong><span className="stage-axis-channel">CH{config.axes[axis]} · {config.inverted[axis] ? '方向反转' : '标准方向'}</span><span className={`stage-axis-status ${known && row?.ready && !row.moving && !state.motion_pending ? 'stage-axis-status--ready' : ''}`}>{status}</span></div>
            <dl className="stage-axis-details"><div><dt>识别型号</dt><dd>{row?.stage || '未识别'}</dd></div><div><dt>输出使能</dt><dd>{!known || !row ? '未知' : row.enabled ? '已使能' : '未使能'}</dd></div></dl>
            <label className="field stage-step-field">单次步数<input aria-label={`${axis.toUpperCase()} 轴点动步数`} type="number" inputMode="numeric" min={1} max={config.max_steps} step={1} value={step(axis)} onChange={event => setStep(axis, event.target.value)}/></label>
            <div className="stage-step-presets" aria-label={`${axis.toUpperCase()} 轴快捷步长`}>{PRESETS.map(value => <button key={value} type="button" aria-label={`${axis.toUpperCase()} 轴 ${value} 步`} aria-pressed={step(axis) === String(value)} disabled={value > config.max_steps} onClick={() => setStep(axis, String(value))}>{value}</button>)}</div>
            <div className="stage-axis-buttons">{([-1, 1] as const).map(direction => <button key={direction} className="button button--quiet" aria-describedby={`stage-reason-${axis}`}
              aria-label={`${axis.toUpperCase()} 轴${direction === 1 ? '正向' : '反向'}移动`} disabled={!!blocked}
              onKeyDown={event => { if (event.repeat) event.preventDefault() }}
              onClick={() => { if (!reason(axis)) onMove(axis, direction, Number(step(axis))) }}>
              <span>{direction === -1 ? '−' : '+'}</span>{axis.toUpperCase()}
            </button>)}</div>
            <p className={`stage-axis-reason ${blocked ? '' : 'stage-axis-reason--ready'}`} id={`stage-reason-${axis}`}>{blocked || `点击一次下发 ${step(axis)} 步`}</p>
          </article>
        })}</div>
      </div>
      <p className="stage-note stage-workbench-note"><ArrowLeftRight size={15}/>PD1V/M 无位置反馈；实际位移随负载和驱动设置变化。“已下发”不代表实测到位。</p>
    </section>
    {advanced}
    <section id="stage-movement-history" tabIndex={-1} className="content-panel glass-panel stage-movement-history">
      <div className="panel-heading"><h2>运动记录</h2><div><span className="subtle-note">最近 20 条移动请求</span><button className="icon-button" aria-label="刷新运动记录" onClick={() => setReload(value => value + 1)}><RefreshCw size={15}/></button></div></div>
      {historyError && <p className="inline-error" role="alert">{historyError}</p>}
      {!events.length ? <div className="stage-history-empty">暂无移动请求记录</div> : <div className="stage-history-scroll"><table><thead><tr><th>北京时间</th><th>轴 / 通道</th><th>方向 / 硬件</th><th>步数</th><th>模式</th><th>请求结果</th><th>说明</th></tr></thead><tbody>{events.map(event => {
        const detail = event.details ?? {}, result = detail.result ?? 'submitted'
        const label = result === 'submitted' ? '请求已下发' : result === 'rejected' ? '未下发' : '结果未确认'
        const stamp = Date.parse(event.timestamp)
        return <tr key={event.id}><td>{Number.isFinite(stamp) ? clock.format(new Date(stamp)) : '—'}</td><td>{detail.axis?.toUpperCase() ?? '—'} / {detail.channel ? `CH${detail.channel}` : '—'}</td><td>{detail.direction === 1 ? '正向 +' : detail.direction === -1 ? '反向 −' : '—'} / {detail.hardware_direction === 1 ? '+' : detail.hardware_direction === -1 ? '−' : '—'}</td><td>{detail.steps ?? '—'}</td><td>{detail.mode === 'simulation' ? '模拟' : detail.mode === 'real' ? '实机' : '—'}</td><td><span className={`stage-result stage-result--${result === 'submitted' ? 'submitted' : result === 'rejected' ? 'rejected' : 'unconfirmed'}`}>{label}</span></td><td>{detail.reason || event.message}</td></tr>
      })}</tbody></table></div>}
    </section>
  </>
}
