export type Axis = 'x' | 'y' | 'z'
export type StageConfig = {
  mode: 'real' | 'simulation'
  connection: 'usb' | 'tcp'
  serial_number: string
  host: string
  port: number
  axes: Record<Axis, number>
  inverted: Record<Axis, boolean>
  max_steps: number
}
export type StageState = {
  config: StageConfig
  connected: boolean
  error: string | null
  motion_pending: boolean
  channels: { channel: number; moving: boolean | null; enabled: boolean; stage: string; ready: boolean; error: string | null }[]
}
export const AXES: Axis[] = ['x', 'y', 'z']

export class StageRequestError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export async function stageApi<T>(path: string, method = 'GET', body?: unknown, timeout = 5000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('auth-needed'))
      throw new StageRequestError(typeof result.detail === 'string' ? result.detail : '请检查配置或输入范围', response.status)
    }
    return result as T
  } finally { clearTimeout(timer) }
}
