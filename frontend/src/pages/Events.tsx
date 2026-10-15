import { useState, useEffect } from 'react'
import { Bell, RefreshCw } from 'lucide-react'
import EventFeed from '../components/EventFeed'
import type { EventItem } from '../lib/types'
import { api } from '../lib/api'
import { localValue } from '../lib/format'

interface EventsProps {}

export default function Events({}: EventsProps) {
  const [events, setEvents] = useState<EventItem[]>([])
  const [eventStart, setEventStart] = useState('')
  const [eventEnd, setEventEnd] = useState('')
  const [eventKind, setEventKind] = useState('')
  const [eventSeverity, setEventSeverity] = useState('')
  const [eventOffset, setEventOffset] = useState(0)
  const [eventMore, setEventMore] = useState(false)

  useEffect(() => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 3600_000)
    setEventStart(localValue(yesterday))
    setEventEnd(localValue(now))
  }, [])

  useEffect(() => {
    if (!eventStart || !eventEnd) return
    void loadEvents()
  }, [eventStart, eventEnd, eventKind, eventSeverity, eventOffset])

  async function loadEvents() {
    try {
      const params = new URLSearchParams({
        start: new Date(eventStart).toISOString(),
        end: new Date(eventEnd).toISOString(),
        limit: '200',
        offset: String(eventOffset),
      })
      if (eventKind) params.set('type', eventKind)
      if (eventSeverity) params.set('severity', eventSeverity)
      const result = await api<{ events: EventItem[]; more: boolean }>(
        `/events?${params}`
      )
      setEvents(result.events)
      setEventMore(result.more)
    } catch {
      setEvents([])
    }
  }

  return (
    <div className="page-content">
      <section className="filter-panel panel">
        <div className="settings-grid">
          <label className="field">
            日志开始时间
            <input
              type="datetime-local"
              value={eventStart}
              onChange={(e) => {
                setEventStart(e.target.value)
                setEventOffset(0)
              }}
            />
          </label>
          <label className="field">
            日志结束时间
            <input
              type="datetime-local"
              value={eventEnd}
              onChange={(e) => {
                setEventEnd(e.target.value)
                setEventOffset(0)
              }}
            />
          </label>
          <label className="field">
            事件类型
            <input
              value={eventKind}
              placeholder="例如 pressure_trip"
              onChange={(e) => {
                setEventKind(e.target.value)
                setEventOffset(0)
              }}
            />
          </label>
          <label className="field">
            级别
            <select
              value={eventSeverity}
              onChange={(e) => {
                setEventSeverity(e.target.value)
                setEventOffset(0)
              }}
            >
              <option value="">全部</option>
              {['info', 'warning', 'error', 'critical'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <section className="content-panel panel full-events">
        <div className="panel-heading">
          <div>
            <h2>系统事件</h2>
          </div>
          <button className="button button--quiet" onClick={() => void loadEvents()}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
        <EventFeed events={events} />
        {!events.length && (
          <div className="empty-state">
            <Bell size={22} />
            暂无事件
          </div>
        )}
        <div className="pagination">
          <button
            className="button"
            disabled={!eventOffset}
            onClick={() => setEventOffset((n) => Math.max(0, n - 200))}
          >
            上一页
          </button>
          <span>第 {Math.floor(eventOffset / 200) + 1} 页</span>
          <button
            className="button"
            disabled={!eventMore}
            onClick={() => setEventOffset((n) => n + 200)}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  )
}
