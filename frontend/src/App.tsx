import { useCallback, useEffect, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import type { Point } from './chartData'
import type { EventItem, Page, Status, Unit } from './lib/types'
import { api } from './lib/api'
import Sidebar, { NAV } from './components/Sidebar'
import Topbar from './components/Topbar'
import EventFeed from './components/EventFeed'
import Login from './components/Login'
import { Toast } from './components/Overlays'
import Overview from './pages/Overview'
import History from './pages/History'
import Control from './pages/Control'
import Events from './pages/Events'
import Settings from './pages/Settings'
import Hardware from './pages/Hardware'
import Debug from './pages/Debug'
import StagePanel from './StagePanel'

function App() {
  const [page, setPage] = useState<Page>('overview')
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('vacuum-sidebar') === 'closed'
  )
  const [asideOpen, setAsideOpen] = useState(
    () => localStorage.getItem('vacuum-events') === 'open'
  )
  const [unit, setUnit] = useState<Unit>(() =>
    ['Pa', 'mbar', 'Torr'].includes(localStorage.getItem('vacuum-unit') || '')
      ? (localStorage.getItem('vacuum-unit') as Unit)
      : 'mbar'
  )
  const [theme, setTheme] = useState<'graphite' | 'light'>(
    () => (localStorage.getItem('vacuum-theme') === 'light' ? 'light' : 'graphite')
  )
  const [glass, setGlass] = useState(() => Number(localStorage.getItem('vacuum-glass') || 72))
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [events, setEvents] = useState<EventItem[]>([])
  const [points, setPoints] = useState<Point[]>([])
  const [auth, setAuth] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [local, setLocal] = useState(true)
  const [login, setLogin] = useState<'setup' | 'login' | null>(null)
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 4500)
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api<Status>('/status'))
      setConnected(true)
    } catch {
      setConnected(false)
    }
  }, [])

  const refreshEvents = useCallback(async () => {
    try {
      const q = new URLSearchParams({ limit: '200', offset: '0' })
      const result = await api<{ events: EventItem[] }>(`/events?${q}`)
      setEvents(result.events)
    } catch (e) {
      notify(e instanceof Error ? e.message : '日志读取失败')
    }
  }, [notify])

  const refreshAuth = useCallback(async () => {
    try {
      const x = await api<{ configured: boolean; authenticated: boolean; local: boolean }>(
        '/auth/status'
      )
      setAuth(x.authenticated)
      setConfigured(x.configured)
      setLocal(x.local)
    } catch {
      /* server starting */
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    void refreshAuth()
    const statusTimer = window.setInterval(() => void refreshStatus(), 1000)
    const authNeeded = () => {
      if (local) {
        void refreshAuth()
        return
      }
      setAuth(false)
      setLogin(configured ? 'login' : null)
    }
    window.addEventListener('auth-needed', authNeeded)

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket | null = null
    let retry = 0
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      socket = new WebSocket(`${scheme}//${location.host}/ws/status`)
      socket.onopen = () => {
        retry = 0
        setConnected(true)
      }
      socket.onmessage = (e) => {
        try {
          const s = JSON.parse(e.data) as Status
          setStatus(s)
          setPoints((prior) => {
            const stamp = s.sample_timestamp ?? s.timestamp
            if (s.sample_stale || !s.tpg_connected) {
              if (!prior.length || prior.at(-1)?.channels.every((c) => !c.valid)) return prior
              return [
                ...prior,
                { timestamp: s.timestamp, channels: s.channels.map((c) => ({ ...c, valid: false })) },
              ].slice(-240)
            }
            if (prior.at(-1)?.timestamp === stamp) return prior
            return [...prior, { timestamp: stamp, channels: s.channels }].slice(-240)
          })
        } catch {
          /* ignore malformed frame */
        }
      }
      socket.onclose = () => {
        setConnected(false)
        if (!cancelled) window.setTimeout(connect, Math.min(5000, 700 + retry++ * 500))
      }
    }

    connect()
    return () => {
      cancelled = true
      socket?.close()
      clearInterval(statusTimer)
      window.removeEventListener('auth-needed', authNeeded)
    }
  }, [refreshStatus, refreshAuth, configured, local])

  useEffect(() => {
    void refreshEvents()
    const timer = window.setInterval(() => void refreshEvents(), 7000)
    return () => clearInterval(timer)
  }, [refreshEvents])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.setProperty('--glass-alpha', String(glass / 1000))
    localStorage.setItem('vacuum-theme', theme)
    localStorage.setItem('vacuum-glass', String(glass))
  }, [theme, glass])

  useEffect(() => {
    localStorage.setItem('vacuum-unit', unit)
  }, [unit])

  useEffect(() => {
    localStorage.setItem('vacuum-sidebar', collapsed ? 'closed' : 'open')
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem('vacuum-events', asideOpen ? 'open' : 'closed')
  }, [asideOpen])

  useEffect(() => {
    if (!login) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLogin(null)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [login])

  useEffect(() => {
    if (page === 'events' || page === 'settings' || page === 'debug' || page === 'hardware') {
      void refreshAuth()
    }
  }, [page, refreshAuth])

  async function act(path: string, success: string) {
    setBusy(true)
    try {
      setStatus(await api<Status>(path, { method: 'POST', body: '{}' }))
      await refreshEvents()
      notify(success)
    } catch (e) {
      notify(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function logOut() {
    try {
      await api('/auth/logout', { method: 'POST' })
      setAuth(false)
      notify('已退出操作员会话')
    } catch (e) {
      notify(e instanceof Error ? e.message : '退出失败')
    }
  }

  async function connectDevices() {
    setBusy(true)
    try {
      const r = await api<{
        ok: boolean
        tpg?: { ok: boolean; error?: string }
        adam?: { ok: boolean; error?: string }
      }>('/devices/connect', { method: 'POST', body: '{}' })
      if (!r.ok)
        throw new Error(
          `设备连接失败：${[r.tpg?.error, r.adam?.error].filter(Boolean).join('；')}`
        )
      await refreshStatus()
      await refreshEvents()
      notify('设备已连接')
    } catch (e) {
      notify(e instanceof Error ? e.message : '设备检查失败')
    } finally {
      setBusy(false)
    }
  }

  async function simPressure(high: boolean) {
    try {
      setStatus(
        await api<Status>('/simulation/pressure', {
          method: 'POST',
          body: JSON.stringify({ channel: 1, pressure_pa: high ? 0.02 : 0.001 }),
        })
      )
      notify(high ? '已注入通道 1 压力超限' : '通道 1 压力已恢复')
    } catch (e) {
      notify(e instanceof Error ? e.message : '模拟操作失败')
    }
  }

  async function simFault(kind: 'io' | 'gauge' | 'sensor' | 'close' | 'tpg', enabled: boolean) {
    try {
      setStatus(
        await api<Status>('/simulation/fault', {
          method: 'POST',
          body: JSON.stringify({ kind, enabled, channel: 1 }),
        })
      )
      notify(enabled ? '已注入模拟故障' : '模拟故障已恢复')
    } catch (e) {
      notify(e instanceof Error ? e.message : '模拟操作失败')
    }
  }

  const showRecentEvents = asideOpen && page !== 'events'

  return (
    <div className={`app-shell ${collapsed ? 'app-shell--collapsed' : ''} ${!showRecentEvents ? 'app-shell--events-closed' : ''}`}>
      <Sidebar
        page={page}
        collapsed={collapsed}
        auth={auth}
        local={local}
        events={events}
        onNavigate={setPage}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onLogout={logOut}
        onLogin={() => setLogin(configured ? 'login' : 'setup')}
      />

      <main className="main-column">
        <Topbar
          page={page}
          unit={unit}
          theme={theme}
          connected={connected}
          mode={status?.mode || 'simulation'}
          asideOpen={asideOpen}
          onUnitChange={setUnit}
          onThemeToggle={() => setTheme((v) => (v === 'light' ? 'graphite' : 'light'))}
          onToggleAside={() => setAsideOpen((v) => !v)}
          onRefreshStatus={() => void refreshStatus()}
        />

        {!connected && (
          <div className="inline-error connection-warning" role="alert">
            <TriangleAlert size={17} />
            后台断连 · 显示上次状态，控制已暂停
          </div>
        )}
        {status && !status.history_recording && (
          <div className="inline-error connection-warning" role="alert">
            历史记录故障：{status.history_error || '存储不可用'}
          </div>
        )}

        {page === 'overview' && (
          <Overview
            status={status}
            points={points}
            unit={unit}
            connected={connected}
            auth={auth}
            local={local}
            busy={busy}
            onAct={act}
            onSimPressure={simPressure}
            onSimFault={simFault}
            onNavigate={(p: Page) => setPage(p)}
            onLogin={() => setLogin(configured ? 'login' : 'setup')}
            onConnectDevices={connectDevices}
          />
        )}

        {page === 'history' && <History unit={unit} connected={connected} auth={auth} notify={notify} />}

        {page === 'control' && (
          <Control status={status} connected={connected} auth={auth} busy={busy} onAct={act} />
        )}

        {page === 'events' && <Events />}
        {page === 'stage' && <StagePanel auth={auth} connected={connected} />}

        {page === 'hardware' && (
          <Hardware
            status={status}
            connected={connected}
            auth={auth}
            busy={busy}
            onRefreshStatus={() => void refreshStatus()}
            onAct={act}
            onConnectDevices={connectDevices}
            onNavigate={setPage}
          />
        )}

        {page === 'settings' && (
          <Settings
            unit={unit}
            connected={connected}
            auth={auth}
            busy={busy}
            glass={glass}
            onSetGlass={setGlass}
            onRefreshStatus={() => void refreshStatus()}
          />
        )}

        {page === 'debug' && (
          <Debug
            status={status}
            connected={connected}
            auth={auth}
            local={local}
            onLogin={() => setLogin(configured ? 'login' : 'setup')}
          />
        )}
      </main>

      {showRecentEvents && (
        <aside className="events-aside glass-shell">
          <div className="aside-heading">
            <h2>最近事件</h2>
            <div>
              <button
                className="icon-button"
                onClick={() => void refreshEvents()}
                title="刷新事件"
                aria-label="刷新事件"
              >
                <X size={14} />
              </button>
              <button
                className="icon-button"
                onClick={() => setAsideOpen(false)}
                aria-label="收起事件栏"
                aria-expanded={true}
              >
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="aside-events">
            <EventFeed events={events.slice(0, 18)} compact />
          </div>
          <button className="text-link" onClick={() => setPage('events')}>
            全部事件
          </button>
        </aside>
      )}

      <div className="mobile-nav">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setPage(id)}>
            <Icon size={18} />
            <span>
              {label === '联锁控制'
                ? '控制'
                : label === '历史数据'
                  ? '历史'
                  : label === '事件日志'
                    ? '事件'
                    : label === '硬件连接'
                      ? '硬件'
                      : label}
            </span>
          </button>
        ))}
      </div>

      {login && (
        <Login
          kind={login}
          onDone={() => {
            setLogin(null)
            void refreshAuth()
          }}
          onClose={() => setLogin(null)}
        />
      )}

      {toast && <Toast message={toast} onClose={() => setToast('')} />}
    </div>
  )
}

export default App
