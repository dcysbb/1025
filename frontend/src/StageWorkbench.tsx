import HelpTooltip from './HelpTooltip'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Check, GripVertical, Keyboard, Pencil, RefreshCw, X } from 'lucide-react'
import { AXES, channelName, orderedAxes, stageApi, type Axis, type StagePresentation, type StageState } from './stageClient'
import { errorMessage } from './apiClient'

type Props = {
  state: StageState; auth: boolean; connected: boolean; online: boolean; busy: boolean; stopping: boolean
  uncertain: boolean; awaitingRefresh: boolean; historyVersion: number
  onMove: (axis: Axis, direction: -1 | 1, steps: number) => void
  onJog: (axis: Axis, direction: -1 | 1) => void
  onPresets: (presets: number[]) => Promise<StageState>
  onPresentation: (presentation: StagePresentation) => Promise<StageState>
  onStop: () => void
  axisTools: (axis: Axis) => ReactNode
  advanced?: ReactNode
}
type Movement = { id: number; timestamp: string; message: string; details: { axis?: Axis; channel?: number; direction?: number; hardware_direction?: number; steps?: number; mode?: string; result?: string; reason?: string; continuous?: boolean } }
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const DEFAULT_PRESETS = [1, 10, 100, 1000]
const HOLD_MS = 180
const KEYS: Record<string, [Axis, -1 | 1]> = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1], ArrowDown: ['y', -1], ArrowUp: ['y', 1], PageDown: ['z', -1], PageUp: ['z', 1] }
const editable = (target: EventTarget | null) => target instanceof window.Element && !!target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')
const hasDialog = () => !!document.querySelector('[role="dialog"], [aria-modal="true"]')

export default function StageWorkbench({ state, auth, connected, online, busy, stopping, uncertain, awaitingRefresh, historyVersion, onMove, onJog, onPresets, onPresentation, onStop, axisTools, advanced }: Props) {
  const { config } = state
  const presets = config.step_presets?.length ? config.step_presets : DEFAULT_PRESETS
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

  const [arranging, setArranging] = useState(false)
  const [naming, setNaming] = useState<number | null>(null), [nameDraft, setNameDraft] = useState('')
  const [presentationBusy, setPresentationBusy] = useState(false), [presentationError, setPresentationError] = useState('')
  const [dragTarget, setDragTarget] = useState<number | null>(null)
  const drag = useRef<{channel: number; target: number} | null>(null)
  const order = orderedAxes(config).map(axis => config.axes[axis])
  const canArrange = auth && connected && online && !busy && !stopping && !state.motion_pending && !presentationBusy && !state.channels.some(row => row.moving || row.optimizing)
  const enabled = !arranging && auth && connected && online && state.connected && !uncertain && !awaitingRefresh && !state.error
  async function savePresentation(values: StagePresentation) {
    if (!canArrange) return
    setPresentationBusy(true); setPresentationError('')
    try { await onPresentation(values); setNaming(null) }
    catch (error) { setPresentationError(errorMessage(error, '保存面板设置失败')) }
    finally { setPresentationBusy(false) }
  }
  function reorder(channel: number, target: number) {
    if (channel === target) return
    const next = order.filter(value => value !== channel)
    next.splice(order.indexOf(target), 0, channel)
    void savePresentation({card_order: next})
  }
  function dragHandlers(channel: number) {
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || !canArrange) return
        event.preventDefault(); disableKeys()
        drag.current = {channel, target: channel}; setDragTarget(channel)
        event.currentTarget.setPointerCapture?.(event.pointerId)
      },
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (!drag.current) return
        const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>('[data-stage-channel]')
        if (target) { drag.current.target = Number(target.dataset.stageChannel); setDragTarget(drag.current.target) }
      },
      onPointerUp: () => {
        const current = drag.current; drag.current = null; setDragTarget(null)
        if (current && canArrange) reorder(current.channel, current.target)
      },
      onPointerCancel: () => { drag.current = null; setDragTarget(null) },
      onLostPointerCapture: () => { drag.current = null; setDragTarget(null) },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const next = order.indexOf(channel) + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)
        if (canArrange && order[next]) reorder(channel, order[next])
      },
    }
  }
  function reason(axis: Axis) {
    const row = state.channels.find(channel => channel.channel === config.axes[axis])
    const count = Number(step(axis))
    if (!auth) return '登录后可点动'
    if (arranging) return '正在整理面板，完成后可移动'
    if (!connected || !online) return '状态过期，等待后台更新'
    if (uncertain) return '请求结果未确认，请先停止并检查连接'
    if (awaitingRefresh) return '等待重新读取控制器状态'
    if (state.error) return state.error
    if (!state.connected) return '控制器未连接，请到“硬件连接”连接设备'
    if (stopping) return '正在发送停止请求'
    if (state.jogging && state.jogging.axis === axis) return `连续点动中，松开或按 Esc 停止`
    if (state.motion_pending) return '等待后续状态采样确认空闲'
    if (state.channels.length !== 3 || state.channels.some(channel => channel.moving === null || channel.moving === undefined)) return '通道运动状态未知'
    if (state.channels.some(channel => channel.moving || channel.optimizing)) return '有通道正在运动或优化，请等待空闲'
    if (!row?.ready) return row?.error || '通道未就绪，请核对识别型号及连接'
    if (!Number.isSafeInteger(count) || count < 1 || count > config.max_steps) return `步数必须为 1–${config.max_steps} 的整数`
    return ''
  }
  // Press-and-hold state shared by pointer buttons and keyboard keys: a short
  // tap stays a bounded single step; holding past HOLD_MS starts continuous jog.
  const holds = useRef(new Map<string, { timer: number; jogging: boolean }>())
  const releaseHold = useCallback((id: string, fire: boolean) => {
    const hold = holds.current.get(id)
    if (!hold) return
    holds.current.delete(id)
    if (hold.timer) { window.clearTimeout(hold.timer); hold.timer = 0 }
    if (hold.jogging) { if (auth) onStop(); return }
    if (!fire) return
    let command: [Axis, -1 | 1] | undefined
    if (id.startsWith('key:')) command = KEYS[id.slice(4)]
    else {
      const parts = id.split(':').slice(1)
      if (parts.length === 2) command = [parts[0] as Axis, Number(parts[1]) as -1 | 1]
    }
    if (command && !reason(command[0])) onMove(command[0], command[1], Number(step(command[0])))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- "reason"/"step" closures re-capture on every listed state change.
  }, [auth, onStop, onMove, steps, state, uncertain, awaitingRefresh, busy, stopping, arranging])
  const pressHold = useCallback((id: string, axis: Axis, direction: -1 | 1) => {
    if (holds.current.size || reason(axis)) return
    const hold = { timer: 0, jogging: false }
    hold.timer = window.setTimeout(() => {
      if (holds.current.get(id) !== hold) return
      hold.timer = 0; hold.jogging = true; onJog(axis, direction)
    }, HOLD_MS)
    holds.current.set(id, hold)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Same closure-refresh intent as releaseHold.
  }, [onJog, steps, state, uncertain, awaitingRefresh, busy, stopping, arranging])
  const stopCallback = useRef(onStop)
  useEffect(() => { stopCallback.current = onStop }, [onStop])
  useEffect(() => () => {
    const active = [...holds.current.values()].some(hold => hold.jogging)
    for (const hold of holds.current.values()) if (hold.timer) window.clearTimeout(hold.timer)
    holds.current.clear()
    if (active) stopCallback.current()
  }, [])
  useEffect(() => {
    // Any jog already running must not outlive lost focus or hidden page.
    const stopAll = () => { for (const id of [...holds.current.keys()]) releaseHold(id, false) }
    window.addEventListener('blur', stopAll)
    document.addEventListener('visibilitychange', stopAll)
    return () => { window.removeEventListener('blur', stopAll); document.removeEventListener('visibilitychange', stopAll) }
  }, [releaseHold])
  useEffect(() => {
    if (!auth || !connected || !online || !state.connected || uncertain || awaitingRefresh || state.error) {
      for (const id of [...holds.current.keys()]) releaseHold(id, false)
    }
  }, [auth, connected, online, state.connected, uncertain, awaitingRefresh, state.error, releaseHold])
  useEffect(() => {
    const cancelKeysOrDialog = () => {
      for (const id of [...holds.current.keys()]) if (hasDialog() || !armed.current && id.startsWith('key:')) releaseHold(id, false)
    }
    const observer = new window.MutationObserver(cancelKeysOrDialog)
    observer.observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['role','aria-modal']})
    cancelKeysOrDialog()
    return () => observer.disconnect()
  }, [keyboard, releaseHold])
  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!armed.current) return
    if (event.key === 'Escape') { event.preventDefault(); for (const id of [...holds.current.keys()]) releaseHold(id, false); if (auth) onStop(); return }
    if (editable(event.target) || hasDialog()) { disableKeys(); return }
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) { if (event.repeat && KEYS[event.key]) event.preventDefault(); return }
    const command = KEYS[event.key]
    if (!command) return
    event.preventDefault()
    pressHold(`key:${event.key}`, command[0], command[1])
  }
  function handleKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    if (!armed.current || !KEYS[event.key]) return
    releaseHold(`key:${event.key}`, true)
  }
  function pointerHandlers(axis: Axis, direction: -1 | 1) {
    const id = `ptr:${axis}:${direction}`
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        pressHold(id, axis, direction)
      },
      onPointerUp: () => releaseHold(id, true),
      onPointerCancel: () => releaseHold(id, false),
      onLostPointerCapture: () => releaseHold(id, false),
      onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
    }
  }
  const joggingHere = (axis: Axis, direction: -1 | 1) =>
    state.jogging?.axis === axis && state.jogging.direction === direction

  const [editing, setEditing] = useState(false)
  const [draftPresets, setDraftPresets] = useState<string[]>([])
  const [presetError, setPresetError] = useState('')
  const [presetBusy, setPresetBusy] = useState(false)
  function startEditing() {
    setEditing(true); setPresetError('')
    setDraftPresets([...presets, ''].slice(0, 6).map(String))
  }
  async function savePresets(values: string[]) {
    const trimmed = values.map(value => value.trim()).filter(Boolean)
    const numbers = trimmed.map(Number)
    if (trimmed.some(value => !/^\d+$/.test(value)) || numbers.some(n => !Number.isSafeInteger(n) || n < 1 || n > 100000)) {
      setPresetError('每项须为 1–100000 的整数（可留空末尾项）'); return
    }
    if (numbers.length < 2 || numbers.length > 6) { setPresetError('快捷步数须为 2–6 项'); return }
    if (new Set(numbers).size !== numbers.length) { setPresetError('快捷步数不能重复'); return }
    setPresetBusy(true); setPresetError('')
    try { await onPresets(numbers); setEditing(false) }
    catch (error) { setPresetError(errorMessage(error, '保存失败')) }
    finally { setPresetBusy(false) }
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
      <div className="panel-heading"><div><h2>位移台精细控制</h2><HelpTooltip label="点动说明">单击步进，按住连续，单次上限 {config.max_steps} 步；全部停止随时可用。</HelpTooltip></div><button className="button button--quiet" disabled={!canArrange} aria-pressed={arranging} onClick={() => {
        disableKeys(); for (const id of [...holds.current.keys()]) releaseHold(id, false)
        setArranging(value => !value); setNaming(null); setPresentationError('')
      }}><GripVertical size={15}/>{arranging ? '完成整理' : '整理面板'}</button></div>
      {arranging && <div className="stage-layout-notice" role="status">拖动卡片手柄排列，或聚焦手柄后用方向键调整；名称和排列自动保存，不改变 XYZ 与 CH 映射。</div>}
      {presentationError && <div className="inline-error" role="alert">{presentationError}</div>}
      <div className="stage-presets-bar">
        <span className="subtle-note">快捷步长（全轴共用）：{presets.join(' / ')}</span>
        {!editing
          ? <button className="button button--quiet" disabled={!auth} onClick={startEditing}><Pencil size={14}/>自定义步长</button>
          : <div className="stage-presets-edit" role="group" aria-label="自定义快捷步长">
              {draftPresets.map((value, index) => <input key={index} aria-label={`快捷步数 ${index + 1}`} inputMode="numeric" value={value}
                onChange={event => setDraftPresets(draftPresets.map((item, i) => i === index ? event.target.value.replace(/[^\d]/g, '').slice(0, 6) : item))} />)}
              <button className="button button--primary" disabled={presetBusy} onClick={() => void savePresets(draftPresets)}><Check size={14}/>{presetBusy ? '保存中…' : '保存'}</button>
              <button className="button button--quiet" disabled={presetBusy} onClick={() => void savePresets(DEFAULT_PRESETS.map(String))}>恢复默认</button>
              <button className="button button--quiet" disabled={presetBusy} onClick={() => { setEditing(false); setPresetError('') }}><X size={14}/>取消</button>
            </div>}
        {editing && presetError && <span className="inline-error" role="alert">{presetError}</span>}
      </div>
      <div ref={area} tabIndex={0} className={`stage-keyboard-area ${keyboard ? 'stage-keyboard-area--armed' : ''}`} aria-label="键盘点动控制区域"
        onKeyDown={handleKey} onKeyUp={handleKeyUp} onFocusCapture={event => { if (editable(event.target)) disableKeys() }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) disableKeys() }}>
        <div className="stage-keyboard-toolbar"><div><Keyboard size={17}/><span>{keyboard ? '键盘点动已启用' : '键盘点动未启用'}</span></div>
          <button className="button button--quiet" aria-pressed={keyboard} disabled={!enabled} onClick={() => {
            if (armed.current) disableKeys()
            else if (enabled && !hasDialog()) { armed.current = true; setKeyboard(true); area.current?.focus() }
          }}>{keyboard ? '停用键盘' : '启用键盘'}</button>
          <p>← / → X · ↓ / ↑ Y · PageDown / PageUp Z · 按住连续 · Esc 停止</p>
        </div>
        <div className="stage-axis-grid">{orderedAxes(config).map(axis => {
          const row = state.channels.find(channel => channel.channel === config.axes[axis])
          const blocked = reason(axis)
          const known = state.connected && online && connected
          const operation = state.operation?.kind === 'optimize' && state.operation.axis === axis ? state.operation : null
          const optimizing = !!row?.optimizing || !!operation
          const jogging = state.jogging?.axis === axis
          const status = !known ? '状态未知' : state.error || uncertain ? '状态未确认' : jogging ? '连续点动中' : optimizing ? '优化中' : row?.moving ? '运动中' : state.motion_pending ? '等待确认' : row?.moving !== false ? '状态未知' : !row.ready ? '未就绪' : '空闲'
          const channel = config.axes[axis], name = config.channel_names?.[String(channel)]
          return <article className={`stage-axis stage-axis--${axis} ${dragTarget === channel ? 'stage-axis--drop' : ''}`} data-stage-channel={channel} aria-label={`${axis.toUpperCase()} 轴 CH${channel} 控制卡片`} key={axis}>
            {arranging && <div className="stage-layout-tools"><button className="icon-button stage-drag-handle" aria-label={`拖动排列 CH${channel}`} title="拖动排列；方向键调整" disabled={!canArrange} {...dragHandlers(channel)}><GripVertical size={18}/></button><span>CH{channel}</span><button className="button button--quiet" disabled={!canArrange} aria-label={`命名 CH${channel}`} onClick={() => {setNaming(channel); setNameDraft(name ?? ''); setPresentationError('')}}><Pencil size={14}/>命名</button></div>}
            <div className="stage-axis-title"><strong className={name ? 'stage-custom-name' : ''}>{name || axis.toUpperCase()}</strong><span className="stage-axis-channel">{name ? `${axis.toUpperCase()} · ` : ''}CH{channel} · {config.inverted[axis] ? '方向反转' : '标准方向'}</span><span className={`stage-axis-status ${status === '空闲' ? 'stage-axis-status--ready' : ''}`}>{status}</span></div>
            {arranging && naming === channel && <form className="stage-name-editor" onSubmit={event => { event.preventDefault(); void savePresentation({channel_names: {[String(channel)]: nameDraft.trim()}}) }}><input autoFocus maxLength={32} aria-label={`CH${channel} 名称`} placeholder={`CH${channel} 名称`} value={nameDraft} disabled={presentationBusy} onChange={event => setNameDraft(event.target.value)}/><button className="button button--primary" disabled={presentationBusy}>{presentationBusy ? '保存中…' : '保存名称'}</button><button type="button" className="icon-button" aria-label="取消命名" disabled={presentationBusy} onClick={() => setNaming(null)}><X size={15}/></button></form>}
            <dl className="stage-axis-details"><div><dt>识别型号</dt><dd>{row?.stage || '未识别'}</dd></div><div><dt>输出使能</dt><dd>{!known || !row ? '未知' : row.enabled ? '已使能' : '未使能'}</dd></div><div><dt>开环计数</dt><dd><b>{known && row?.command_count != null ? row.command_count : '—'}</b><HelpTooltip label="开环计数说明">控制器命令计数不代表实测位置。</HelpTooltip></dd></div><div><dt>优化状态</dt><dd>{!known || state.error || uncertain ? '状态未知' : optimizing ? '进行中 / 等待确认' : row?.optimized ? '控制器已返回优化标志' : '未返回优化标志'}</dd></div></dl>
            <label className="field stage-step-field">单次步数<input aria-label={`${axis.toUpperCase()} 轴点动步数`} type="number" inputMode="numeric" min={1} max={config.max_steps} step={1} value={step(axis)} onChange={event => setStep(axis, event.target.value)}/></label>
            <div className="stage-step-presets" aria-label={`${axis.toUpperCase()} 轴快捷步长`}>{presets.map(value => <button key={value} type="button" aria-label={`${axis.toUpperCase()} 轴 ${value} 步`} aria-pressed={step(axis) === String(value)} disabled={value > config.max_steps} onClick={() => setStep(axis, String(value))}>{value}</button>)}</div>
            <div className="stage-axis-buttons">{([-1, 1] as const).map(direction => <button key={direction} className={`button button--quiet stage-jog-button ${joggingHere(axis, direction) ? 'stage-jog-button--active' : ''}`} aria-describedby={`stage-reason-${axis}`}
              aria-label={`${axis.toUpperCase()} 轴${direction === 1 ? '正向' : '反向'}移动`} aria-pressed={joggingHere(axis, direction)}
              disabled={!!blocked && !joggingHere(axis, direction)} {...pointerHandlers(axis, direction)}>
              <span>{direction === -1 ? '−' : '+'}</span>{axis.toUpperCase()}
            </button>)}</div>
            <p className={`stage-axis-reason ${blocked ? '' : 'stage-axis-reason--ready'}`} id={`stage-reason-${axis}`}>{blocked || `单击步进 ${step(axis)} 步 · 按住连续移动`}</p>
            <fieldset disabled={arranging} className="stage-axis-tools" role="group" aria-label={`${axis.toUpperCase()} 轴通道操作`} aria-describedby={`stage-reason-${axis}`} onFocusCapture={disableKeys}>{axisTools(axis)}</fieldset>
          </article>
        })}</div>
      </div>
      <HelpTooltip label="开环与回零说明">PD1V/M 无位置反馈；实际位移随负载和驱动设置变化。Home 尝试硬件回零，不支持时仅清零计数；Optimize 会自动运动，不受点动上限限制。</HelpTooltip>
      {advanced}
    </section>
    <section id="stage-movement-history" tabIndex={-1} className="content-panel glass-panel stage-movement-history">
      <div className="panel-heading"><h2>运动记录</h2><div><span className="subtle-note">最近 20 条移动请求</span><button className="icon-button" aria-label="刷新运动记录" onClick={() => setReload(value => value + 1)}><RefreshCw size={15}/></button></div></div>
      {historyError && <p className="inline-error" role="alert">{historyError}</p>}
      {!events.length ? <div className="stage-history-empty">暂无移动请求记录</div> : <div className="stage-history-scroll"><table><thead><tr><th>北京时间</th><th>轴 / 通道</th><th>方向 / 硬件</th><th>步数</th><th>模式</th><th>请求结果</th><th>说明</th></tr></thead><tbody>{events.map(event => {
        const detail = event.details ?? {}, result = detail.result ?? 'submitted'
        const label = result === 'submitted' ? '请求已下发' : result === 'rejected' ? '未下发' : '结果未确认'
        const stamp = Date.parse(event.timestamp)
        return <tr key={event.id}><td>{Number.isFinite(stamp) ? clock.format(new Date(stamp)) : '—'}</td><td>{detail.axis?.toUpperCase() ?? '—'} / {detail.channel ? `${channelName(config, detail.channel)}${config.channel_names?.[String(detail.channel)] ? ` (CH${detail.channel})` : ''}` : '—'}</td><td>{detail.direction === 1 ? '正向 +' : detail.direction === -1 ? '反向 −' : '—'} / {detail.hardware_direction === 1 ? '+' : detail.hardware_direction === -1 ? '−' : '—'}</td><td>{detail.steps ?? (detail.continuous ? '连续' : '—')}</td><td>{detail.mode === 'simulation' ? '模拟' : detail.mode === 'real' ? '实机' : '—'}</td><td><span className={`stage-result stage-result--${result === 'submitted' ? 'submitted' : result === 'rejected' ? 'rejected' : 'unconfirmed'}`}>{label}</span></td><td>{detail.reason || event.message}</td></tr>
      })}</tbody></table></div>}
    </section>
  </>
}
