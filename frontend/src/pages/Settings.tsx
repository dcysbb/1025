import { useState, useEffect } from 'react'
import {
  Activity,
  AlertOctagon,
  Check,
  LockKeyhole,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react'
import type { Config, Unit } from '../lib/types'
import { api } from '../lib/api'
import { FACTOR } from '../lib/format'

interface SettingsProps {
  unit: Unit
  connected: boolean
  auth: boolean
  busy: boolean
  glass: number
  onSetGlass: (glass: number) => void
  onRefreshStatus: () => void
}

export default function Settings({
  unit,
  connected,
  auth,
  busy,
  glass,
  onSetGlass,
  onRefreshStatus,
}: SettingsProps) {
  const [draft, setDraft] = useState<Config | null>(null)
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    void loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const response = await api<{ config: Config }>('/config')
      setDraft(response.config)
    } catch {
      setDraft(null)
    }
  }

  async function saveSettings() {
    if (!draft) return
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify(draft) })
      onRefreshStatus()
      setConfirm('')
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败')
    }
  }

  function patch<K extends keyof Config>(key: K, value: Config[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : null))
  }

  function editChannel<K extends keyof Config['channels'][0]>(
    index: number,
    key: K,
    value: Config['channels'][0][K]
  ) {
    setDraft((d) =>
      d
        ? {
            ...d,
            channels: d.channels.map((c, i) => (i === index ? { ...c, [key]: value } : c)),
          }
        : null
    )
  }

  if (!draft) {
    return (
      <div className="page-content settings-page">
        <div className="empty-state panel">
          <RefreshCw className="spin" />
          正在读取设备设置…
        </div>
      </div>
    )
  }

  return (
    <div className="page-content settings-page">
      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>运行方式</h2>
          </div>
        </div>
        <div className="mode-switch">
          <button
            className={draft.mode === 'simulation' ? 'selected' : ''}
            onClick={() => patch('mode', 'simulation')}
          >
            <Activity size={18} />
            <b>模拟模式</b>
            <small>不向真实硬件发送控制命令</small>
          </button>
          <button
            className={draft.mode === 'real' ? 'selected mode-switch__real' : ''}
            onClick={() => patch('mode', 'real')}
          >
            <TerminalSquare size={18} />
            <b>真实设备</b>
            <small>现场接线与阀位确认</small>
          </button>
        </div>
      </section>

      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>采样与保护参数</h2>
          </div>
        </div>
        <div className="settings-grid">
          <label className="field">
            历史采样间隔（秒）
            <input
              type="number"
              min="0.2"
              max="30"
              step="0.1"
              value={draft.sample_interval_s}
              onChange={(e) => patch('sample_interval_s', Number(e.target.value))}
            />
          </label>
          <label className="field">
            数据超时保护（秒）
            <input
              type="number"
              min="0.5"
              max="10"
              step="0.1"
              value={draft.stale_timeout_s}
              onChange={(e) => patch('stale_timeout_s', Number(e.target.value))}
            />
          </label>
          <label className="field">
            压力恢复稳定时间（秒）
            <input
              type="number"
              min="0"
              max="120"
              step="0.5"
              value={draft.recovery_hold_s}
              onChange={(e) => patch('recovery_hold_s', Number(e.target.value))}
            />
          </label>
          <label className="field">
            历史保留天数（留空不限）
            <input
              type="number"
              min="1"
              max="3650"
              value={draft.history_retention_days ?? ''}
              onChange={(e) =>
                patch('history_retention_days', e.target.value === '' ? null : Number(e.target.value))
              }
            />
          </label>
        </div>
      </section>

      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>通道与压力阈值</h2>
          </div>
          <span className="subtle-note">达到上限触发，低于恢复值才允许复位</span>
        </div>
        <div className="threshold-table-wrap">
          <table className="threshold-table">
            <thead>
              <tr>
                <th>保护</th>
                <th>通道</th>
                <th>名称</th>
                <th>关阀阈值 ({unit})</th>
                <th>恢复阈值 ({unit})</th>
              </tr>
            </thead>
            <tbody>
              {draft?.channels.map((c, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      aria-label={`启用通道 ${i + 1}`}
                      onChange={(e) => editChannel(i, 'enabled', e.target.checked)}
                    />
                  </td>
                  <td>CH{i + 1}</td>
                  <td>
                    <input
                      className="table-input"
                      value={c.label}
                      maxLength={24}
                      placeholder={`通道 ${i + 1}`}
                      onChange={(e) => editChannel(i, 'label', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="table-input"
                      type="number"
                      min="0"
                      step="any"
                      value={
                        c.trip_pa == null
                          ? ''
                          : Number((c.trip_pa / FACTOR[unit]).toPrecision(5))
                      }
                      placeholder="必填"
                      onChange={(e) =>
                        editChannel(
                          i,
                          'trip_pa',
                          e.target.value === '' ? null : Number(e.target.value) * FACTOR[unit]
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="table-input"
                      type="number"
                      min="0"
                      step="any"
                      value={
                        c.reset_pa == null
                          ? ''
                          : Number((c.reset_pa / FACTOR[unit]).toPrecision(5))
                      }
                      placeholder="必填"
                      onChange={(e) =>
                        editChannel(
                          i,
                          'reset_pa',
                          e.target.value === '' ? null : Number(e.target.value) * FACTOR[unit]
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {draft.mode === 'real' && (
        <section className="content-panel panel commissioning-panel">
          <div className="panel-heading">
            <div>
              <h2>真实硬件启用确认</h2>
            </div>
          </div>
          <div className="commissioning-note">
            <AlertOctagon size={20} />
            <p>程序或通信失效时无法保证关阀。启用前须验证断电关阀与阀位反馈。</p>
          </div>
          <label className="field confirm-field">
            现场确认口令
            <input
              value={confirm}
              placeholder="输入：现场确认"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.fail_closed_confirmed}
              onChange={(e) => patch('fail_closed_confirmed', e.target.checked)}
            />
            我已验证电磁阀断电关阀和阀位反馈
          </label>
        </section>
      )}

      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>局域网访问</h2>
          </div>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.allow_lan}
            onChange={(e) => patch('allow_lan', e.target.checked)}
          />
          允许局域网内设备通过 HTTPS 访问控制台
        </label>
        <div className="info-line">
          <LockKeyhole size={16} />
          远程访问需要密码和可信证书；修改后须重启服务。
        </div>
      </section>

      <details className="content-panel panel appearance-settings">
        <summary>外观</summary>
        <label className="field">
          玻璃强度
          <input
            type="range"
            min="25"
            max="100"
            value={glass}
            onChange={(e) => onSetGlass(Number(e.target.value))}
          />
        </label>
      </details>

      <div className="settings-footer">
        <span>保存会关阀；已启用的联锁将锁存。设备连接与端子定义在“硬件连接”菜单。</span>
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
    </div>
  )
}
