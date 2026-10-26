type FailureKind = 'network' | 'timeout' | 'http' | 'response'
type Options = RequestInit & { operation?: string; timeoutMs?: number }

export class ApiError extends Error {
  readonly kind: FailureKind
  readonly status: number | null
  readonly operation: string
  constructor(message: string, kind: FailureKind, status: number | null, operation: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.operation = operation
  }
}

function operationFor(path: string, method: string) {
  const url = path.split('?')[0]
  const operations: Record<string, string> = {
    '/api/status': '读取压力与联锁状态', '/api/auth/status': '读取操作员登录状态',
    '/api/auth/login': '操作员登录', '/api/auth/setup': '设置操作员密码', '/api/auth/logout': '退出操作员会话',
    '/api/config': method === 'GET' ? '读取控制台设置' : '保存控制台设置',
    '/api/events': path.includes('kind=stage_move') ? '读取位移台运动记录' : '读取事件日志',
    '/api/history': '读取压力历史数据', '/api/history/reset': '重置压力历史数据',
    '/api/hardware/status': '读取真空规与 I/O 控制器状态', '/api/hardware/ports': '读取本机串口列表',
    '/api/devices/connect': '连接真空规与 I/O 控制器', '/api/devices/connect-gauge': '连接 TPG366 真空规',
    '/api/devices/connect-io': '连接 I/O 控制器', '/api/stage': '读取 PDXC3 位移台状态',
    '/api/stage/config': '保存 PDXC3 连接与轴映射', '/api/stage/connect': '连接 PDXC3 位移台控制器',
    '/api/stage/disconnect': '断开 PDXC3 位移台控制器', '/api/stage/stop': '停止位移台全部通道',
    '/api/stage/move': '提交位移台点动请求', '/api/debug/relays': '读取 DAM 继电器状态',
    '/api/interlock/arm': '启用压力联锁', '/api/interlock/disarm': '停用联锁并关阀',
    '/api/interlock/clear-fault': '复位联锁故障', '/api/interlock/reset': '复位并启用联锁',
    '/api/valve/open': '打开插板阀', '/api/valve/close': '关闭插板阀',
    '/api/simulation/pressure': '修改模拟压力', '/api/simulation/fault': '修改模拟故障状态',
  }
  const relay = url.match(/^\/api\/debug\/relays\/(\d+)$/)
  return operations[url] ?? (relay ? `控制 DAM 继电器 OUT${Number(relay[1]) + 1}` : method === 'GET' ? '读取控制台数据' : '提交控制台操作')
}

function httpReason(status: number) {
  if (status === 401) return '操作员会话失效或尚未登录，请登录后重试。'
  if (status === 403) return '后台拒绝访问，请从控制台自身地址打开页面并检查操作权限。'
  if (status === 404) return '后台没有此接口，请刷新页面；如仍失败，请检查前后端版本是否一致。'
  if (status === 405) return '后台不支持此接口的请求方式，通常是前后端版本不一致。请更新后台后刷新页面。'
  if (status === 409) return '当前设备或联锁状态不允许此操作，请核对状态和接线。'
  if (status === 422) return '配置或输入校验未通过，请检查字段范围和通道映射。'
  if (status === 429) return '请求过于频繁，请稍后再试。'
  if (status === 502 || status === 503 || status === 504) return '后台服务暂不可用，请检查后台是否正常运行。'
  if (status >= 500) return '后台处理请求时发生内部错误，请检查后台日志。'
  return '后台拒绝了请求，请检查权限、输入和设备状态。'
}

function validationReason(detail: unknown) {
  if (!Array.isArray(detail)) return ''
  return detail.slice(0, 5).map(issue => {
    if (!issue || typeof issue !== 'object') return ''
    const fields = Array.isArray(issue.loc) ? issue.loc.filter((part: unknown) => part !== 'body').join('.') : '输入字段'
    return `${fields}：${typeof issue.msg === 'string' ? issue.msg : '取值不符合要求'}`
  }).filter(Boolean).join('；')
}

/** A browser transport failure says nothing about whether a hardware command executed. */
export async function apiRequest<T>(path: string, options: Options = {}): Promise<T> {
  const { operation: suppliedOperation, timeoutMs, ...init } = options
  const method = (init.method ?? 'GET').toUpperCase()
  const writing = method !== 'GET' && method !== 'HEAD'
  const operation = suppliedOperation ?? operationFor(path, method)
  const timeout = timeoutMs ?? (path.includes('/connect') || path.startsWith('/api/history?') ? 30000 : writing ? 10000 : 5000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const uncertain = writing ? '操作是否执行尚未确认，请先核对状态，勿直接重复提交。' : ''
  try {
    const response = await fetch(path, {
      credentials: 'same-origin', ...init, signal: controller.signal,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
    const text = await response.text()
    let data: unknown
    try { data = text.trim() ? JSON.parse(text) : undefined } catch { /* Classify HTTP errors before response format errors. */ }
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('auth-needed'))
      const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : undefined
      const specific = typeof detail === 'string' ? detail.trim().replace(/[。；;]+$/, '') : validationReason(detail)
      const reason = specific ? `${specific}。${httpReason(response.status)}` : httpReason(response.status)
      throw new ApiError(`${operation}失败（HTTP ${response.status}）：${reason}${writing && response.status >= 500 ? uncertain : ''}`, 'http', response.status, operation)
    }
    if ((data == null || typeof data !== 'object') && response.status !== 204) {
      throw new ApiError(`${operation}失败：后台返回的数据为空或格式异常。请刷新页面；如仍失败，请检查后台版本与日志。${uncertain}`, 'response', response.status, operation)
    }
    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    const timedOut = controller.signal.aborted
    const reason = timedOut
      ? `等待控制台后台响应超过 ${timeout / 1000} 秒。请检查后台负载与连接。`
      : '页面未收到控制台后台的响应，浏览器未提供具体原因。请检查后台是否运行，以及当前访问地址和网络连接。'
    throw new ApiError(`${operation}${writing ? '结果未确认' : '失败'}：${reason}当前后台地址：${window.location.origin}。${uncertain}`, timedOut ? 'timeout' : 'network', null, operation)
  } finally { clearTimeout(timer) }
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
