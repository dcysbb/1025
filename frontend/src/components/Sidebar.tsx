import {
  Bell,
  Cable,
  Gauge,
  History,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Settings2,
  Shield,
  TerminalSquare,
  ChevronDown,
  Workflow,
} from 'lucide-react'
import type { Page } from '../lib/types'

export const NAV: { id: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'history', label: '历史数据', icon: History },
  { id: 'control', label: '联锁控制', icon: Shield },
  { id: 'stage', label: '位移台', icon: Workflow },
  { id: 'hardware', label: '硬件连接', icon: Cable },
  { id: 'events', label: '事件日志', icon: Bell },
  { id: 'settings', label: '设置', icon: Settings2 },
  { id: 'debug', label: 'Debug', icon: TerminalSquare },
]

interface SidebarProps {
  page: Page
  collapsed: boolean
  auth: boolean
  local: boolean
  events: Array<{ severity: string }>
  onNavigate: (page: Page) => void
  onToggleCollapse: () => void
  onLogout: () => void
  onLogin: () => void
}

export default function Sidebar({
  page,
  collapsed,
  auth,
  local,
  events,
  onNavigate,
  onToggleCollapse,
  onLogout,
  onLogin,
}: SidebarProps) {
  return (
    <aside className={`sidebar glass-shell ${collapsed ? 'sidebar--collapsed' : ''}`}>
      <div className="brand-row">
        <div className="brand-mark">
          <Gauge size={20} />
        </div>
        {!collapsed && (
          <div className="brand-copy">
            <b>真空联锁</b>
          </div>
        )}
        <button
          className="icon-button sidebar-toggle"
          aria-label={collapsed ? '展开导航' : '折叠导航'}
          aria-expanded={!collapsed}
          aria-controls="primary-navigation"
          title={collapsed ? '展开导航' : '折叠导航'}
          onClick={onToggleCollapse}
        >
          <Menu size={17} />
        </button>
      </div>

      <nav id="primary-navigation" className="nav-list" aria-label="主导航">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${page === id ? 'nav-item--active' : ''}`}
            onClick={() => onNavigate(id)}
            title={collapsed ? label : undefined}
          >
            <Icon size={18} />
            <span>{label}</span>
            {id === 'events' && events.some((e) => e.severity === 'critical') && (
              <i className="nav-alert" />
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-spacer" />

      {local ? (
        <div className="user-row">
          <span className="user-avatar">PC</span>
          {!collapsed && (
            <span className="user-copy">
              <b>本机控制</b>
            </span>
          )}
        </div>
      ) : (
        <button
          className="user-row"
          onClick={() => (auth ? onLogout() : onLogin())}
          title={collapsed ? '操作员账户' : undefined}
        >
          <span className="user-avatar">{auth ? 'OP' : <LockKeyhole size={16} />}</span>
          {!collapsed && (
            <span className="user-copy">
              <b>{auth ? '操作员已登录' : '操作员登录'}</b>
              <small>{auth ? '退出操作员会话' : '需验证后控制'}</small>
            </span>
          )}
          {!collapsed && (auth ? <LogOut size={15} /> : <ChevronDown size={15} />)}
        </button>
      )}
    </aside>
  )
}
