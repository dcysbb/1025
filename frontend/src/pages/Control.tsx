import {
  ChevronDown,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react'
import type { Status } from '../lib/types'

interface ChipProps {
  ok: boolean
  children: string
}

function Chip({ ok, children }: ChipProps) {
  return (
    <span className={`status-chip ${ok ? 'status-chip--ok' : 'status-chip--muted'}`}>
      <i />
      {children}
    </span>
  )
}

interface ControlProps {
  status: Status | null
  connected: boolean
  auth: boolean
  busy: boolean
  onAct: (path: string, message: string) => void
}

export default function Control({ status, connected, auth, busy, onAct }: ControlProps) {
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
    <div className="page-content control-page">
      <section className={`control-hero panel interlock-banner--${interlockClass}`}>
        <Workflow size={36} />
        <h2>插板阀 · {valveText}</h2>
        <div className="control-hero__chips">
          <Chip ok={status?.interlock === 'armed'}>
            {status?.interlock_label || '状态未知'}
          </Chip>
        </div>
        {status?.trip_reason && <p role="alert">{status.trip_reason}</p>}
      </section>

      <section className="control-actions panel">
        <div className="panel-heading">
          <div>
            <h2>操作</h2>
          </div>
        </div>
        <div className="control-action-grid">
          <button
            className="action-tile action-tile--close"
            disabled={!connected || !auth || busy}
            onClick={() => onAct('/valve/close', '关阀命令已发送')}
          >
            <span>
              <X size={19} />
            </span>
            <b>关闭插板阀</b>
          </button>
          <button
            className="action-tile"
            disabled={
              !connected ||
              !auth ||
              busy ||
              status?.interlock !== 'armed' ||
              status?.valve !== 'closed'
            }
            onClick={() => onAct('/valve/open', '开阀命令已发送')}
          >
            <span>
              <ChevronDown size={19} />
            </span>
            <b>打开插板阀</b>
            <small>需启用联锁并确认关闭到位</small>
          </button>
          {status?.interlock === 'armed' ? (
            <button
              className="action-tile action-tile--warning"
              disabled={!connected || !auth || busy}
              onClick={() => onAct('/interlock/disarm', '联锁已停用，阀门保持关闭')}
            >
              <span>
                <ShieldAlert size={19} />
              </span>
              <b>停用联锁</b>
              <small>保持关阀</small>
            </button>
          ) : status?.interlock === 'tripped' || status?.interlock === 'fault' ? (
            <button
              className="action-tile action-tile--warning"
              disabled={!connected || !auth || busy}
              onClick={() => onAct('/interlock/clear-fault', '故障已清除，联锁未启用')}
            >
              <span>
                <RotateCcw size={19} />
              </span>
              <b>复位（不启用）</b>
              <small>清除故障，联锁保持停用</small>
            </button>
          ) : (
            <button
              className="action-tile action-tile--safe"
              disabled={!connected || !auth || busy}
              onClick={() => onAct('/interlock/arm', '联锁已启用')}
            >
              <span>
                <ShieldCheck size={19} />
              </span>
              <b>启用联锁</b>
              <small>检查压力与关闭到位</small>
            </button>
          )}
        </div>
      </section>

      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>保护条件</h2>
          </div>
        </div>
        <div className="protective-grid">
          <Chip ok={status?.tpg_connected || false}>
            {status?.tpg_connected ? 'TPG 366 在线' : 'TPG 366 未连接'}
          </Chip>
          <Chip ok={status?.adam_connected || false}>{`I/O ${ioText}`}</Chip>
          <Chip ok={status?.pressure_ok || false}>
            {status?.pressure_ok ? '压力条件正常' : '压力条件未满足'}
          </Chip>
          <Chip ok={status?.fail_closed_confirmed || false}>
            {status?.fail_closed_confirmed ? '已确认断电关阀' : '未确认断电关阀'}
          </Chip>
        </div>
      </section>
    </div>
  )
}
