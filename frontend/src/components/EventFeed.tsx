import type { EventItem } from '../lib/types'
import { time } from '../lib/format'

interface EventRowProps {
  item: EventItem
  compact?: boolean
}

export function EventRow({ item, compact = false }: EventRowProps) {
  const critical = item.severity === 'critical' || item.severity === 'error'
  return (
    <div className={`event-row ${critical ? 'event-row--critical' : ''}`}>
      <span className="event-row__time">{time(item.timestamp, !compact)}</span>
      <i className={`event-dot ${critical ? 'event-dot--critical' : ''}`} />
      <div className="event-row__body">
        <b>{item.message}</b>
        {!compact && (
          <details>
            <summary>详情</summary>
            <small>
              {item.actor} · {item.type}
            </small>
            <pre>{JSON.stringify(item.details, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

interface EventFeedProps {
  events: EventItem[]
  compact?: boolean
  emptyMessage?: string
}

export default function EventFeed({ events, compact = false, emptyMessage = '暂无事件' }: EventFeedProps) {
  return (
    <div className="event-feed">
      {events.map((e) => (
        <EventRow key={e.id} item={e} compact={compact} />
      ))}
      {!events.length && <div className="event-empty">{emptyMessage}</div>}
    </div>
  )
}
