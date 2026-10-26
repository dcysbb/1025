import { apiRequest } from './apiClient'

export type ConnectionResult<T> = {ok: boolean; config_saved: boolean; connected: boolean; phase: string; error: string | null; state: T}
export const applyConnection = <T,>(device: 'tpg' | 'io' | 'stage' | 'analog', config: object) => apiRequest<ConnectionResult<T>>(`/api/devices/${device}/apply-connect`, {method: 'POST', body: JSON.stringify({config}), timeoutMs: 60000, operation: '应用并连接设备'})
export function connectionMessage<T>(result: ConnectionResult<T>) {
  if (result.ok) return '参数已应用，设备已连接'
  const phase = ({stop:'停止', disconnect:'断开旧连接', save:'保存配置', connect:'连接新目标'} as Record<string,string>)[result.phase] ?? result.phase
  return `${result.config_saved ? '配置已保存' : '配置未保存'}，${phase}失败：${result.error ?? '原因未知'}`
}
export function changedFields<T extends object>(saved: T | null, draft: T, keys: (keyof T)[]) {
  return Object.fromEntries(keys.filter(key => JSON.stringify(saved?.[key]) !== JSON.stringify(draft[key])).map(key => [key, draft[key]]))
}
