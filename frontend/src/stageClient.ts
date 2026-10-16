import { ApiError, apiRequest } from './apiClient'

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
  const move = path === '/api/stage/move' && body && typeof body === 'object' ? body as { axis?: string; direction?: number; steps?: number } : null
  try {
    return await apiRequest<T>(path, {
      method, timeoutMs: timeout,
      operation: move ? `${move.axis?.toUpperCase()} 轴${move.direction === 1 ? '正向' : '反向'}点动 ${move.steps} 步` : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'http' && error.status != null && error.status < 500) throw new StageRequestError(error.message, error.status)
    throw error
  }
}
