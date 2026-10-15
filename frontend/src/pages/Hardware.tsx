import { useEffect, useState } from 'react'
import { Activity, Check, Database, Radio, RefreshCw, Workflow } from 'lucide-react'
import type { Config, Page, Status } from '../lib/types'
import { api } from '../lib/api'

type StageSnapshot = {
  config: { mode: 'real' | 'simulation'; serial_number: string; host: string; port: number }
  connected: boolean
}

interface HardwareProps {
  status: Status | null
  connected: boolean
  auth: boolean
  busy: boolean
  onRefreshStatus: () => void
  onAct: (path: string, message: string) => void
  onConnectDevices: () => void
  onNavigate: (page: Page) => void
}

const DAM_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7]

export default function Hardware({
  status,
  connected,
  auth,
  busy,
  onRefreshStatus,
  onAct,
  onConnectDevices,
  onNavigate,
}: HardwareProps) {
  const [draft, setDraft] = useState<Config | null>(null)
  const [stage, setStage] = useState<StageSnapshot | null>(null)

  useEffect(() => {
    void loadConfig()
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await api<StageSnapshot>('/stage')
        if (!cancelled) setStage(snapshot)
      } catch {
        if (!cancelled) setStage(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function loadConfig() {
    try {
      const response = await api<{ config: Config }>('/config')
      setDraft({
        ...response.config,
        dam_input_labels: response.config.dam_input_labels ?? [],
        dam_output_labels: response.config.dam_output_labels ?? [],
      })
    } catch {
      setDraft(null)
    }
  }

  async function saveSettings() {
    if (!draft) return
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify(draft) })
      onRefreshStatus()
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败')
    }
  }

  function patch<K extends keyof Config>(key: K, value: Config[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : null))
  }

  function editTerminal(key: 'dam_input_labels' | 'dam_output_labels', index: number, value: string) {
    setDraft((d) =>
      d ? { ...d, [key]: d[key].map((item, i) => (i === index ? value : item)) } : null
    )
  }

  if (!draft) {
    return (
      <div className="page-content settings-page">
        <div className="empty-state panel">
          <RefreshCw className="spin" />
          正在读取硬件配置…
        </div>
      </div>
    )
  }

  const dam = draft.io_device === 'dam0808d'

  const inputRole = (index: number): string => {
    if (draft.valve_closed_di === index) return '关闭到位'
    if (draft.valve_open_di === index) return '打开到位'
    return ''
  }

  const outputRole = (index: number): string => {
    return draft.open_output === index ? '开阀电磁阀' : ''
  }

  const ioChip = status?.io_manual_reset_required
    ? { text: '需人工复位', cls: 'status-chip--warn' }
    : status?.io_reconnecting
      ? { text: `自动重连中（第 ${status.io_reconnect_attempt} 次）`, cls: 'status-chip--warn' }
      : status?.adam_connected
        ? { text: '已连接', cls: 'status-chip--on' }
        : { text: '未连接', cls: '' }

  return (
    <div className="page-content settings-page">
      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>TPG 366 真空规</h2>
          </div>
          <span className={`status-chip ${status?.tpg_connected ? 'status-chip--on' : ''}`}>
            {status?.tpg_connected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className="settings-grid">
          <label className="field">
            连接方式
            <select
              value={draft.tpg_connection}
              onChange={(e) => patch('tpg_connection', e.target.value as 'tcp' | 'usb')}
            >
              <option value="tcp">网口（以太网 TCP）</option>
              <option value="usb">USB 串口</option>
            </select>
          </label>
          {draft.tpg_connection === 'usb' && (
            <>
              <label className="field">
                USB 串口
                <input
                  placeholder="COM3"
                  value={draft.tpg_serial_port}
                  onChange={(e) => patch('tpg_serial_port', e.target.value.trim())}
                />
              </label>
              <label className="field">
                USB 波特率
                <select
                  value={draft.tpg_baudrate}
                  onChange={(e) => patch('tpg_baudrate', Number(e.target.value))}
                >
                  {[9600, 19200, 38400, 57600, 115200].map((rate) => (
                    <option key={rate}>{rate}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {draft.tpg_connection === 'tcp' && (
            <>
              <label className="field">
                IP 地址
                <input
                  value={draft.tpg_host}
                  placeholder="例如 192.168.1.20"
                  onChange={(e) => patch('tpg_host', e.target.value)}
                />
              </label>
              <label className="field">
                TCP 端口
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={draft.tpg_port}
                  onChange={(e) => patch('tpg_port', Number(e.target.value))}
                />
              </label>
            </>
          )}
        </div>
        <div className="info-line">
          <Activity size={16} />
          串口格式 8N1；不得向真空规串口发送其他设备指令。
        </div>
      </section>

      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>I/O 模块（继电器与阀位反馈）</h2>
          </div>
          <span className={`status-chip ${ioChip.cls}`}>{ioChip.text}</span>
        </div>
        <div className="settings-grid">
          <label className="field">
            I/O 控制器
            <select
              value={draft.io_device}
              onChange={(e) => patch('io_device', e.target.value as 'dam0808d' | 'adam6050')}
            >
              <option value="dam0808d">DAM0808D RS485</option>
              <option value="adam6050">ADAM6050 TCP</option>
            </select>
          </label>
          {dam ? (
            <>
              <label className="field">
                连接方式
                <select disabled value="usb" title="DAM0808D 仅支持 USB 转 RS485 接入">
                  <option value="usb">USB（USB 转 RS485）</option>
                </select>
              </label>
              <label className="field">
                RS485 串口
                <input
                  placeholder="例如 COM4（须区别于真空规）"
                  value={draft.dam_serial_port}
                  onChange={(e) => patch('dam_serial_port', e.target.value.trim())}
                />
              </label>
              <label className="field">
                波特率
                <select
                  value={draft.dam_baudrate}
                  onChange={(e) => patch('dam_baudrate', Number(e.target.value))}
                >
                  {[2400, 4800, 9600, 19200, 38400].map((rate) => (
                    <option key={rate}>{rate}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                设备地址
                <input
                  type="number"
                  min="1"
                  max="255"
                  value={draft.dam_unit_id}
                  onChange={(e) => patch('dam_unit_id', Number(e.target.value))}
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                连接方式
                <select disabled value="tcp" title="ADAM6050 仅支持网口接入">
                  <option value="tcp">网口（以太网 TCP）</option>
                </select>
              </label>
              <label className="field">
                ADAM IP
                <input
                  value={draft.adam_host}
                  onChange={(e) => patch('adam_host', e.target.value)}
                />
              </label>
              <label className="field">
                TCP 端口
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={draft.adam_port}
                  onChange={(e) => patch('adam_port', Number(e.target.value))}
                />
              </label>
              <label className="field">
                设备地址
                <input
                  type="number"
                  value={draft.adam_unit_id}
                  onChange={(e) => patch('adam_unit_id', Number(e.target.value))}
                />
              </label>
            </>
          )}
        </div>
        {status?.io_error && (
          <div className="inline-error" role="alert">
            {status.io_error}
          </div>
        )}
        <div className="info-line">
          <Activity size={16} />
          {dam
            ? 'DAM0808D 经 USB 转 RS485 接入，串口须区别于真空规；地址按现场拨码填写。'
            : 'ADAM6050 经网口接入（Modbus TCP）。'}
        </div>
      </section>

      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>端子定义与插板阀对应</h2>
          </div>
          <span className="subtle-note">通电开阀 · 断电关阀</span>
        </div>
        <div className="io-map-grid">
          {dam ? (
            <>
              <label className="field">
                关闭到位传感器
                <select
                  value={draft.valve_closed_di}
                  onChange={(e) => patch('valve_closed_di', Number(e.target.value))}
                >
                  {DAM_CHANNELS.map((i) => (
                    <option key={i} value={i}>
                      IN{i + 1}（DI{i}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                打开到位传感器（可选）
                <select
                  value={draft.valve_open_di ?? ''}
                  onChange={(e) =>
                    patch('valve_open_di', e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">未安装</option>
                  {DAM_CHANNELS.map((i) => (
                    <option key={i} value={i}>
                      IN{i + 1}（DI{i}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                开阀电磁阀输出
                <select
                  value={draft.open_output}
                  onChange={(e) => patch('open_output', Number(e.target.value))}
                >
                  {DAM_CHANNELS.map((i) => (
                    <option key={i} value={i}>
                      OUT{i + 1}（DO{i}）
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="field">
                关闭到位 DI
                <input
                  type="number"
                  min="0"
                  max="11"
                  value={draft.valve_closed_di}
                  onChange={(e) => patch('valve_closed_di', Number(e.target.value))}
                />
              </label>
              <label className="field">
                打开到位 DI（可选）
                <input
                  type="number"
                  min="0"
                  max="11"
                  placeholder="未安装"
                  value={draft.valve_open_di ?? ''}
                  onChange={(e) =>
                    patch('valve_open_di', e.target.value === '' ? null : Number(e.target.value))
                  }
                />
              </label>
              <label className="field">
                电磁阀控制 DO
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={draft.open_output}
                  onChange={(e) => patch('open_output', Number(e.target.value))}
                />
              </label>
            </>
          )}
        </div>
        <div className="polarity-grid">
          {(
            [
              ['valve_closed_active_high', '关闭传感器高电平有效'],
              ['valve_open_active_high', '打开传感器高电平有效'],
            ] as const
          )
            .filter(([key]) => key === 'valve_closed_active_high' || draft.valve_open_di != null)
            .map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(e) => patch(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
        </div>
        {dam && (
          <>
            <h3 className="terminal-group-title">输入端子（IN1–IN8 → DI0–DI7）</h3>
            <div className="threshold-table-wrap">
              <table className="threshold-table">
                <thead>
                  <tr>
                    <th>端子</th>
                    <th>信号</th>
                    <th>功能标签</th>
                    <th>当前角色</th>
                  </tr>
                </thead>
                <tbody>
                  {DAM_CHANNELS.map((i) => (
                    <tr key={i}>
                      <td>IN{i + 1}</td>
                      <td>DI{i}</td>
                      <td>
                        <input
                          className="table-input"
                          maxLength={24}
                          placeholder="未定义"
                          value={draft.dam_input_labels[i] ?? ''}
                          aria-label={`IN${i + 1} 功能标签`}
                          onChange={(e) => editTerminal('dam_input_labels', i, e.target.value)}
                        />
                      </td>
                      <td className={inputRole(i) ? 'terminal-role' : 'terminal-role--none'}>
                        {inputRole(i) || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="terminal-group-title">输出端子（OUT1–OUT8 → DO0–DO7）</h3>
            <div className="threshold-table-wrap">
              <table className="threshold-table">
                <thead>
                  <tr>
                    <th>端子</th>
                    <th>信号</th>
                    <th>功能标签</th>
                    <th>当前角色</th>
                  </tr>
                </thead>
                <tbody>
                  {DAM_CHANNELS.map((i) => (
                    <tr key={i}>
                      <td>OUT{i + 1}</td>
                      <td>DO{i}</td>
                      <td>
                        <input
                          className="table-input"
                          maxLength={24}
                          placeholder="未定义"
                          value={draft.dam_output_labels[i] ?? ''}
                          aria-label={`OUT${i + 1} 功能标签`}
                          onChange={(e) => editTerminal('dam_output_labels', i, e.target.value)}
                        />
                      </td>
                      <td className={outputRole(i) ? 'terminal-role' : 'terminal-role--none'}>
                        {outputRole(i) || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="info-line">
          <Database size={16} />
          IN1 → DI0，OUT1 → DO0；标签仅用于显示与记录，控制逻辑由上方对应关系决定。
        </div>
        <div className="info-line">
          <Database size={16} />
          电磁阀通电开阀、断电关阀；接线与线圈电压须现场核实后才能启用联锁。
        </div>
      </section>

      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>PDXC3 位移台</h2>
          </div>
          <button className="button button--quiet" onClick={() => onNavigate('stage')}>
            前往位移台页面
          </button>
        </div>
        <div className="stage-summary-grid">
          <div className="summary-item">
            <span>连接方式</span>
            <b>网口（以太网）</b>
          </div>
          <div className="summary-item">
            <span>运行模式</span>
            <b>{stage ? (stage.config.mode === 'real' ? '真实设备' : '模拟设备') : '—'}</b>
          </div>
          <div className="summary-item">
            <span>控制器序列号</span>
            <b>{stage?.config.serial_number || '未设置'}</b>
          </div>
          <div className="summary-item">
            <span>IP 地址</span>
            <b>{stage ? (stage.config.host || '自动发现') : '—'}</b>
          </div>
          <div className="summary-item">
            <span>TCP 端口</span>
            <b>{stage ? stage.config.port : '—'}</b>
          </div>
          <div className="summary-item">
            <span>连接状态</span>
            <b className={stage?.connected ? 'summary-ok' : ''}>
              {stage?.connected ? '已连接' : '未连接'}
            </b>
          </div>
        </div>
        <div className="info-line">
          <Workflow size={16} />
          位移台连接参数与轴映射在位移台页面修改，此处仅展示当前状态。
        </div>
      </section>

      <div className="settings-footer">
        <span>保存会关阀；已启用的联锁将锁存。</span>
        <div>
          <button className="button button--quiet" onClick={() => void loadConfig()}>
            放弃更改
          </button>
          <button
            className="button button--primary"
            disabled={!connected || busy || !auth}
            onClick={() => void saveSettings()}
          >
            {busy ? '保存中' : '保存设置'} <Check size={15} />
          </button>
        </div>
      </div>

      {draft.mode === 'real' && (
        <section className="real-connection-row panel">
          <div>
            <b>连接设备</b>
            <span>保存设置后连接</span>
          </div>
          <button
            className="button button--quiet"
            disabled={!connected || !auth || busy}
            onClick={() => onAct('/devices/connect-gauge', '真空规已连接，控制保持未启用')}
          >
            仅连接真空规
          </button>
          <button
            className="button button--quiet"
            disabled={
              !connected ||
              !auth ||
              busy ||
              status?.io_reconnecting ||
              status?.io_manual_reset_required
            }
            onClick={onConnectDevices}
          >
            <Radio size={15} />
            连接设备
          </button>
        </section>
      )}
    </div>
  )
}
