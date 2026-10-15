import { useState, useEffect } from 'react'
import { ArrowDownToLine, Database, RefreshCw } from 'lucide-react'
import Chart from '../Chart'
import type { Unit, EventItem } from '../lib/types'
import type { Point } from '../chartData'
import { api } from '../lib/api'
import { localValue, pressure, time } from '../lib/format'

interface HistoryProps {
  unit: Unit
  connected: boolean
  auth: boolean
  notify: (message: string) => void
}

export default function History({ unit, connected, auth, notify }: HistoryProps) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [channels, setChannels] = useState<number[]>([1, 2, 3, 4, 5, 6])
  const [hist, setHist] = useState<Point[]>([])
  const [histCount, setHistCount] = useState<number | null>(null)
  const [histTruncated, setHistTruncated] = useState(false)
  const [histReady, setHistReady] = useState(false)
  const [histBusy, setHistBusy] = useState(false)
  const [historyEvents, setHistoryEvents] = useState<EventItem[]>([])
  const [resetHistoryOpen, setResetHistoryOpen] = useState(false)
  const [resetScope, setResetScope] = useState<'simulation' | 'all'>('simulation')
  const [resettingHistory, setResettingHistory] = useState(false)

  useEffect(() => {
    const now = new Date()
    const oneHourAgo = new Date(now.getTime() - 3600_000)
    setStart(localValue(oneHourAgo))
    setEnd(localValue(now))
  }, [])

  async function loadHistory() {
    if (!start || !end) return
    if (channels.length === 0) {
      notify('请选择有效时间范围和至少一个通道')
      return
    }
    setHistBusy(true)
    try {
      const params = new URLSearchParams({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      })
      const result = await api<{
        points: Point[]
        count: number
        truncated: boolean
        events: EventItem[]
      }>(`/history?${params}`)
      setHist(result.points)
      setHistCount(result.count)
      setHistTruncated(result.truncated)
      setHistoryEvents(result.events || [])
      setHistReady(true)
    } catch {
      setHist([])
      setHistCount(0)
      setHistTruncated(false)
      setHistoryEvents([])
    } finally {
      setHistBusy(false)
    }
  }

  async function resetHistory() {
    setResettingHistory(true)
    try {
      const result = await api<{ deleted: number }>('/history/reset', {
        method: 'POST',
        body: JSON.stringify({ scope: resetScope }),
      })
      setResetHistoryOpen(false)
      setHist([])
      setHistCount(0)
      setHistReady(false)
      const scopeLabel = resetScope === 'simulation' ? '模拟' : '全部'
      notify(`已清除 ${result.deleted} 条${scopeLabel}记录`)
    } catch (err) {
      notify(err instanceof Error ? err.message : '重置失败')
    } finally {
      setResettingHistory(false)
    }
  }

  function exportUrl() {
    if (!histReady || !histCount || !channels.length) return undefined
    const params = new URLSearchParams({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      channels: channels.join(','),
    })
    return `/api/history/export.csv?${params}`
  }

  return (
    <div className="page-content">
      <section className="filter-panel panel">
        <div className="filter-grid">
          <label className="field">
            开始时间
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => {
                setStart(e.target.value)
                setHistReady(false)
              }}
            />
          </label>
          <label className="field">
            结束时间
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => {
                setEnd(e.target.value)
                setHistReady(false)
              }}
            />
          </label>
          <div className="field channel-filter">
            <span className="field-label">显示通道</span>
            <div>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <label key={n}>
                  <input
                    type="checkbox"
                    checked={channels.includes(n)}
                    onChange={(e) => {
                      setChannels((c) =>
                        e.target.checked ? [...c, n].sort() : c.filter((x) => x !== n)
                      )
                      setHistReady(false)
                    }}
                  />
                  CH{n}
                </label>
              ))}
            </div>
          </div>
          <div className="filter-buttons">
            <button
              className="button button--quiet"
              disabled={histBusy || resettingHistory}
              onClick={() => void loadHistory()}
            >
              <RefreshCw size={15} className={histBusy ? 'spin' : ''} />
              {histBusy ? '读取中' : '查询数据'}
            </button>
            <a
              className={`button button--primary ${histCount && histReady && channels.length ? '' : 'is-disabled'}`}
              href={histCount && histReady && channels.length ? exportUrl() : undefined}
              onClick={(e) =>
                (!histCount || !histReady || !channels.length) && e.preventDefault()
              }
            >
              <ArrowDownToLine size={15} />
              导出 CSV
            </a>
            <button
              className="button button--quiet"
              disabled={!connected || !auth || histBusy || resettingHistory}
              onClick={() => {
                setResetScope('simulation')
                setResetHistoryOpen(true)
              }}
            >
              重置历史
            </button>
          </div>
        </div>
      </section>

      <section className="content-panel panel history-chart-panel">
        <div className="panel-heading">
          <div>
            <h2>历史真空曲线</h2>
          </div>
          <span className="history-count">
            {histCount == null
              ? '选择时间范围查询'
              : `${histCount.toLocaleString()} 条${histTruncated ? ' · 已达到查询上限' : ''}`}
          </span>
        </div>
        <Chart
          key={`${start}-${end}-${histCount}`}
          points={hist}
          channels={channels}
          unit={unit}
          events={historyEvents}
        />
      </section>

      <section className="content-panel panel history-table-panel">
        <div className="panel-heading">
          <div>
            <h2>采样记录</h2>
          </div>
          <span className="subtle-note">最近 80 个时间点 · CSV 导出全部</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>北京时间</th>
                <th>通道</th>
                <th>压力</th>
                <th>状态</th>
                <th>记录模式</th>
              </tr>
            </thead>
            <tbody>
              {hist
                .slice(-80)
                .reverse()
                .flatMap((p) =>
                  p.channels
                    .filter((c) => channels.includes(c.channel))
                    .map((c) => (
                      <tr key={`${p.timestamp}-${c.channel}`}>
                        <td>{time(p.timestamp, true)}</td>
                        <td>CH{c.channel}</td>
                        <td>
                          {pressure(c.pressure_pa, unit)} {unit}
                        </td>
                        <td>{c.valid ? '正常' : '异常'}</td>
                        <td>{c.mode === 'simulation' ? '模拟' : '真实'}</td>
                      </tr>
                    ))
                )}
            </tbody>
          </table>
          {histReady && !histCount && (
            <div className="empty-state">
              <Database size={22} />
              时间范围内没有记录
            </div>
          )}
        </div>
      </section>

      {resetHistoryOpen && (
        <div className="modal-backdrop">
          <section
            className="login-card glass-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-reset-title"
          >
            <h2 id="history-reset-title">重置压力历史</h2>
            <p>清除所选范围内全部压力记录，不受页面筛选限制；不可撤销。事件日志保留，采集继续。</p>
            <label className="field">
              重置范围
              <select
                value={resetScope}
                disabled={resettingHistory}
                onChange={(e) => setResetScope(e.target.value as 'simulation' | 'all')}
              >
                <option value="simulation">仅清除模拟数据（保留真实数据）</option>
                <option value="all">清除全部压力数据（包含真实数据）</option>
              </select>
            </label>
            <div className="filter-buttons">
              <button
                className="button button--quiet"
                disabled={resettingHistory}
                onClick={() => setResetHistoryOpen(false)}
              >
                取消
              </button>
              <button
                className="button button--primary"
                disabled={resettingHistory}
                onClick={() => void resetHistory()}
              >
                {resettingHistory ? '重置中' : '确认重置'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
