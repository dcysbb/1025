import { useEffect, useState } from 'react'
import { Disclosure } from './Motion'
import { stageApi } from './stageClient'
import { errorMessage } from './apiClient'

type ToolEvent = {id: number; timestamp: string; message: string; details?: {axis?: string; channel?: number; operation?: string; mode?: string; result?: string}}
const names: Record<string, string> = {zero: 'Home / Zero', optimize: 'Optimize', enable: '启用输出', disable: '禁用输出'}
const results: Record<string, string> = {submitted: '请求已下发', verified: '读回已确认', rejected: '未下发', unconfirmed: '结果未确认', completed: '控制器报告优化完成', not_optimized: '优化结束，未返回成功标志', stopped: '已停止'}
const clock = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false})

export default function StageToolHistory({version}: {version: number}) {
  const [events, setEvents] = useState<ToolEvent[]>([]), [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data = await stageApi<{events: ToolEvent[]}>('/api/events?kind=stage_action&limit=20')
        if (!cancelled) { setEvents(Array.isArray(data.events) ? data.events.slice(0, 20) : []); setError('') }
      } catch (e) { if (!cancelled) setError(errorMessage(e, '控制器操作记录读取失败，当前列表可能已过期；停止入口仍可使用。')) }
      finally { if (!cancelled) timer = setTimeout(refresh, 2000) }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [version])
  return <Disclosure title="控制器操作记录 · Home / Optimize / 输出" className="stage-tool-history">
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!events.length ? <p className="stage-note">暂无控制器工具操作记录</p> : <ol>{events.map(event => {
      const detail = event.details ?? {}, stamp = Date.parse(event.timestamp)
      return <li key={event.id}><time>{Number.isFinite(stamp) ? clock.format(new Date(stamp)) : '—'}</time><strong>{detail.axis?.toUpperCase() ?? '—'} / {detail.channel ? `CH${detail.channel}` : '—'} · {names[detail.operation ?? ''] ?? '控制操作'}</strong><span>{results[detail.result ?? 'submitted'] ?? '结果未知'}{detail.mode ? ` · ${detail.mode === 'real' ? '实机' : '模拟'}` : ''}</span><p>{event.message}</p></li>
    })}</ol>}
  </Disclosure>
}
