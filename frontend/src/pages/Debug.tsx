import { useState, useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import type { DebugState, Status } from '../lib/types'
import { api } from '../lib/api'

interface DebugProps {
  status: Status | null
  connected: boolean
  auth: boolean
  local: boolean
  onLogin: () => void
}

export default function Debug({ status, connected, auth, local, onLogin }: DebugProps) {
  const [relayState, setRelayState] = useState<DebugState | null>(null)
  const [debugError, setDebugError] = useState('')
  const [debugAcknowledged, setDebugAcknowledged] = useState(false)
  const [debugAutoOff, setDebugAutoOff] = useState(false)
  const [debugDuration, setDebugDuration] = useState(10)
  const [debugBusy, setDebugBusy] = useState(false)

  useEffect(() => {
    void refreshRelays()
    const timer = setInterval(() => void refreshRelays(), 1500)
    return () => clearInterval(timer)
  }, [])

  async function refreshRelays() {
    try {
      const state = await api<DebugState>('/debug/relays')
      setRelayState(state)
      setDebugError('')
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : '无法读取状态')
    }
  }

  async function switchRelay(channel: number, on: boolean) {
    setDebugBusy(true)
    setDebugError('')
    try {
      await api(`/debug/relays/${channel}`, {
        method: 'POST',
        body: JSON.stringify({
          channel,
          enabled: on,
          duration_s: on && debugAutoOff ? debugDuration : 0,
        }),
      })
      await refreshRelays()
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setDebugBusy(false)
    }
  }

  return (
    <div className="page-content">
      <section className="content-panel panel">
        <div className="panel-heading">
          <div>
            <h2>DAM0808D 手动控制</h2>
          </div>
          <button
            className="button button--quiet"
            disabled={!auth || debugBusy}
            onClick={() => void refreshRelays()}
          >
            <RefreshCw size={15} />
            刷新状态
          </button>
        </div>
        <p className="debug-warning">
          手动调试绕过压力保护，可使阀门动作；仅限停机调试。程序或通信故障时无法保证断电。
        </p>
        {!auth && !local && (
          <button className="button button--primary" onClick={onLogin}>
            登录后调试
          </button>
        )}
        <div className="settings-grid">
          <label>
            <input
              type="checkbox"
              checked={debugAutoOff}
              onChange={(e) => setDebugAutoOff(e.target.checked)}
            />
            定时关闭（否则需手动关闭）
          </label>
          {debugAutoOff && (
            <label className="field">
              自动关闭时间（秒）
              <input
                type="number"
                min="1"
                max="60"
                value={debugDuration}
                onChange={(e) =>
                  setDebugDuration(Math.max(1, Math.min(60, Number(e.target.value) || 1)))
                }
              />
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={debugAcknowledged}
              onChange={(e) => setDebugAcknowledged(e.target.checked)}
            />
            已确认设备可以动作，并已核对接线和线圈电压
          </label>
        </div>
        {debugError && (
          <div className="inline-error" role="alert">
            {debugError}
          </div>
        )}
        {status && status.interlock !== 'disarmed' && (
          <p className="inline-error">请先停用联锁，再手动开启。</p>
        )}
        <div className="debug-relay-grid">
          {Array.from({ length: 8 }, (_, channel) => (
            <article className="card debug-relay-card" key={channel}>
              <h3>
                OUT{channel + 1} <small>DO{channel}</small>
                {relayState?.output_labels?.[channel] ? (
                  <em className="relay-label">{relayState.output_labels[channel]}</em>
                ) : null}
              </h3>
              <p>
                {relayState ? (relayState.outputs[channel] ? '已开启' : '已关闭') : '状态未知'}
                {relayState?.remaining_s[String(channel)] != null &&
                  ` · ${Math.ceil(relayState.remaining_s[String(channel)])} 秒后关闭`}
                {relayState?.outputs[channel] &&
                  relayState.remaining_s[String(channel)] == null &&
                  ' · 持续开启'}
              </p>
              <div className="filter-buttons">
                <button
                  className="button button--primary"
                  aria-label={`开启 OUT${channel + 1}`}
                  disabled={
                    !connected ||
                    !auth ||
                    !debugAcknowledged ||
                    debugBusy ||
                    !relayState ||
                    status?.interlock !== 'disarmed' ||
                    relayState.interlock !== 'disarmed'
                  }
                  onClick={() => void switchRelay(channel, true)}
                >
                  开启
                </button>
                <button
                  className="button button--quiet"
                  aria-label={`关闭 OUT${channel + 1}`}
                  disabled={!connected || !auth || debugBusy || !relayState}
                  onClick={() => void switchRelay(channel, false)}
                >
                  关闭
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
