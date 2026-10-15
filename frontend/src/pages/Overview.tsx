import {
  Activity,
  ChevronDown,
  Radio,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Workflow,
} from 'lucide-react'
import Chart from '../Chart'
import type { Channel, Page, Status, Unit } from '../lib/types'
import { pressure, time } from '../lib/format'
import type { Point } from '../chartData'

interface PressureCardProps {
  channel: Channel
  unit: Unit
}

function PressureCard({ channel, unit }: PressureCardProps) {
  const near =
    channel.trip_pa != null &&
    channel.pressure_pa != null &&
    channel.pressure_pa / channel.trip_pa > 0.7
  return (
    <article
      className={`pressure-card card ${!channel.valid ? 'pressure-card--bad' : near ? 'pressure-card--near' : ''}`}
    >
      <div className="pressure-card__top">
        <span className="channel-name">
          <i className="channel-light" />
          {channel.label || `通道 ${channel.channel}`}
        </span>
        <span className={`tiny-badge ${channel.valid ? '' : 'tiny-badge--bad'}`}>
          {channel.status}
        </span>
      </div>
      <div className="pressure-value">
        {pressure(channel.pressure_pa, unit)} <small>{unit}</small>
      </div>
      <div className="pressure-meta">
        <span>关阀阈值</span>
        <strong>
          {channel.trip_pa == null
            ? '监测'
            : `${pressure(channel.trip_pa, unit)} ${unit}`}
        </strong>
      </div>
      {channel.trip_pa != null &&
        channel.pressure_pa != null &&
        channel.valid && (
          <div className="threshold-rail">
            <i
              style={{
                width: `${Math.min(100, (channel.pressure_pa / channel.trip_pa) * 100)}%`,
              }}
            />
          </div>
        )}
    </article>
  )
}

interface OverviewProps {
  status: Status | null
  points: Point[]
  unit: Unit
  connected: boolean
  auth: boolean
  local: boolean
  busy: boolean
  onAct: (path: string, message: string) => void
  onSimPressure: (high: boolean) => void
  onSimFault: (kind: 'io' | 'gauge' | 'sensor' | 'close' | 'tpg', enabled: boolean) => void
  onNavigate: (page: Page) => void
  onLogin: () => void
  onConnectDevices: () => void
}

export default function Overview({
  status,
  points,
  unit,
  connected,
  auth,
  local,
  busy,
  onAct,
  onSimPressure,
  onSimFault,
  onNavigate,
  onLogin,
  onConnectDevices,
}: OverviewProps) {
  const active = status?.channels || []
  const interlockClass =
    status?.interlock === 'armed'
      ? 'armed'
      : status?.interlock === 'tripped' || status?.interlock === 'fault'
        ? 'tripped'
        : 'idle'

  const ioText = status?.io_manual_reset_required
    ? '需人工复位'
    : status?.io_reconnecting
      ? `重连 ${status.io_reconnect_attempt || 1}/3`
      : status?.adam_connected
        ? '在线'
        : '未连接'

  const valveText = (
    {
      closed: '已关闭',
      open: '已打开',
      opening: '正在打开',
      closing: '正在关闭',
      fault: '反馈冲突',
      unknown: '未确认',
    } as const
  )[status?.valve || 'unknown']

  return (
    <div className="page-content">
      <section className={`interlock-banner panel interlock-banner--${interlockClass}`}>
        <div className="interlock-icon">
          {interlockClass === 'armed' ? (
            <ShieldCheck size={23} />
          ) : interlockClass === 'tripped' ? (
            <ShieldAlert size={23} />
          ) : (
            <Shield size={23} />
          )}
        </div>
        <div className="interlock-banner__copy">
          <h2>{status?.interlock_label || '正在连接控制器'}</h2>
          {status?.trip_reason && <p>{status.trip_reason}</p>}
        </div>
        <div className="interlock-banner__actions">
          {status?.interlock === 'armed' ? (
            <>
              <button
                className="button button--quiet"
                disabled={!connected || !auth || busy}
                onClick={() => onAct('/valve/close', '关阀命令已发送')}
              >
                关阀
              </button>
              <button
                className="button button--danger-soft"
                disabled={!connected || !auth || busy}
                onClick={() => onAct('/interlock/disarm', '联锁已停用，阀门保持关闭')}
              >
                停用联锁
              </button>
            </>
          ) : status?.interlock === 'tripped' || status?.interlock === 'fault' ? (
            <button
              className="button button--primary"
              disabled={!connected || busy || !auth}
              onClick={() => onAct('/interlock/clear-fault', '故障已清除，联锁未启用')}
            >
              复位（不启用） <RotateCcw size={15} />
            </button>
          ) : (
            <button
              className="button button--primary"
              disabled={!connected || busy || !auth}
              onClick={() => onAct('/interlock/arm', '联锁已启用')}
            >
              启用联锁 <ShieldCheck size={15} />
            </button>
          )}
          {!auth && !local && (
            <button className="text-link" onClick={onLogin}>
              登录后操作
            </button>
          )}
        </div>
        <div className="ambient-orb" />
      </section>

      <section className="metric-grid">
        <article className="metric-card card">
          <div className="metric-card__head">
            <span>插板阀位置</span>
            <Workflow size={16} />
          </div>
          <strong className={`valve-readout valve-readout--${status?.valve || 'unknown'}`}>
            {valveText}
          </strong>
        </article>
        <article className="metric-card card">
          <div className="metric-card__head">
            <span>设备通信</span>
            <Radio size={16} />
          </div>
          <div className="device-state-row">
            <span>TPG 366</span>
            <b>{status?.tpg_connected ? '在线' : '未连接'}</b>
          </div>
          <div className="device-state-row">
            <span>I/O 控制器</span>
            <b title={status?.io_error || undefined}>{ioText}</b>
          </div>
          {status?.mode === 'real' &&
            (!status.tpg_connected || !status.adam_connected) && (
              <button
                className="button button--quiet connect-button"
                disabled={
                  !connected ||
                  !auth ||
                  busy ||
                  status?.io_reconnecting ||
                  status?.io_manual_reset_required
                }
                onClick={onConnectDevices}
              >
                连接设备
              </button>
            )}
        </article>
        <article className="metric-card card">
          <div className="metric-card__head">
            <span>采样耗时</span>
            <Activity size={16} />
          </div>
          <strong
            title={
              status?.sample_timestamp
                ? `上次采样：${time(status.sample_timestamp, true)}`
                : undefined
            }
          >
            {!connected
              ? '后台断连'
              : !status?.tpg_connected
                ? '真空规离线'
                : status.sample_stale
                  ? '数据过期'
                  : status.sample_latency_s == null
                    ? '—'
                    : (
                        <>
                          {(status.sample_latency_s * 1000).toFixed(0)} <small>ms</small>
                        </>
                      )}
          </strong>
        </article>
      </section>

      <section className="section-heading">
        <div>
          <h2>真空通道</h2>
        </div>
        <span className="section-count">{active.length} 个通道</span>
      </section>
      <section className="pressure-grid">
        {active.map((c) => (
          <PressureCard key={c.channel} channel={c} unit={unit} />
        ))}
      </section>

      <section className="content-panel panel">
        <div className="panel-heading">
          <h2>实时压力</h2>
          <button className="text-link" onClick={() => onNavigate('history')}>
            查看历史 <ChevronDown size={14} />
          </button>
        </div>
        <Chart points={points} channels={[1, 2, 3, 4, 5, 6]} unit={unit} compact />
      </section>

      {status?.mode === 'simulation' && (
        <details className="sim-tools panel">
          <summary>模拟故障测试</summary>
          <div className="sim-tools__actions">
            <button
              className="button button--danger-soft"
              disabled={!connected || !auth}
              onClick={() => onSimPressure(true)}
            >
              <TriangleAlert size={15} />
              注入压力超限
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimPressure(false)}
            >
              恢复压力
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('io', true)}
            >
              模拟 I/O 中断
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('io', false)}
            >
              恢复 I/O
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('gauge', true)}
            >
              真空规故障
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('gauge', false)}
            >
              恢复真空规
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('sensor', true)}
            >
              位置反馈冲突
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('sensor', false)}
            >
              恢复反馈
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('close', true)}
            >
              模拟关阀失败
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('close', false)}
            >
              恢复阀动作
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('tpg', true)}
            >
              TPG 通信中断
            </button>
            <button
              className="button button--quiet"
              disabled={!connected || !auth}
              onClick={() => onSimFault('tpg', false)}
            >
              恢复 TPG 通信
            </button>
          </div>
        </details>
      )}
    </div>
  )
}
