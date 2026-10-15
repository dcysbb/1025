import { Bell, Moon, Sun } from 'lucide-react'
import type { Page, Unit } from '../lib/types'

interface TopbarProps {
  page: Page
  unit: Unit
  theme: 'graphite' | 'light'
  connected: boolean
  mode: 'simulation' | 'real'
  asideOpen: boolean
  onUnitChange: (unit: Unit) => void
  onThemeToggle: () => void
  onToggleAside: () => void
  onRefreshStatus: () => void
}

const PAGE_TITLES: Record<Page, string> = {
  overview: '运行总览',
  history: '历史数据',
  control: '联锁控制',
  stage: '位移台',
  hardware: '硬件连接',
  events: '事件日志',
  settings: '设置',
  debug: '继电器调试',
}

export default function Topbar({
  page,
  unit,
  theme,
  connected,
  mode,
  asideOpen,
  onUnitChange,
  onThemeToggle,
  onToggleAside,
  onRefreshStatus,
}: TopbarProps) {
  return (
    <header className="topbar glass-shell">
      <div className="page-heading">
        <h1>{PAGE_TITLES[page]}</h1>
      </div>
      <div className="topbar-right">
        <button
          className="theme-toggle"
          aria-label={theme === 'light' ? '切换为深色' : '切换为浅色'}
          title={theme === 'light' ? '切换为深色' : '切换为浅色'}
          onClick={onThemeToggle}
        >
          {theme === 'light' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {page !== 'events' && (
          <button
            className="icon-button"
            aria-label={asideOpen ? '收起事件栏' : '展开事件栏'}
            aria-expanded={asideOpen}
            onClick={onToggleAside}
          >
            <Bell size={16} />
          </button>
        )}
        <label className="unit-select">
          <select
            aria-label="压力单位"
            value={unit}
            onChange={(e) => onUnitChange(e.target.value as Unit)}
          >
            <option>Pa</option>
            <option>mbar</option>
            <option>Torr</option>
          </select>
        </label>
        <span className="mode-badge" data-mode={mode}>
          {mode === 'simulation' ? '模拟模式' : '真实设备'}
        </span>
        <button
          className={`live-pill ${connected ? 'live-pill--on' : ''}`}
          onClick={onRefreshStatus}
        >
          <i />
          {connected ? '服务在线' : '后台断连'}
        </button>
      </div>
    </header>
  )
}
