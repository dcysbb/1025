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
  operation?: {kind: string; axis: Axis; channel: number} | null
  diagnostics?: {transport: string; latency_ms: number | null; sample_age_s: number | null; read_failures: number; sample_count: number; recovery_required: boolean}
  channels: { channel: number; moving: boolean | null; enabled: boolean; stage: string; ready: boolean; error: string | null; optimizing?: boolean; optimized?: boolean; open_loop?: boolean; command_count?: number | null; power_ok_raw?: boolean | null }[]
}
export type DriveParameters = {forward_amplitude: number; reverse_amplitude: number; step_rate: number; acceleration: number}
export type ParameterState = {values: DriveParameters; limits: Record<keyof DriveParameters, {min: number | null; max: number | null}>}
export const AXES: Axis[] = ['x', 'y', 'z']

export class StageRequestError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export async function stageApi<T>(path: string, method = 'GET', body?: unknown, timeout = 5000): Promise<T> {
  const move = path === '/api/stage/move' && body && typeof body === 'object' ? body as { axis?: string; direction?: number; steps?: number } : null
  const action = path === '/api/stage/action' && body && typeof body === 'object' ? body as {axis?: string; operation?: string} : null
  const actionNames: Record<string, string> = {enable: '启用输出', disable: '禁用输出', zero: '开环计数清零', optimize: '性能优化'}
  const parameters = path.match(/^\/api\/stage\/parameters\/([xyz])$/)
  const operation = move ? `${move.axis?.toUpperCase()} 轴${move.direction === 1 ? '正向' : '反向'}点动 ${move.steps} 步` :
    action ? `${action.axis?.toUpperCase()} 轴${actionNames[action.operation ?? ''] ?? '控制操作'}` :
    parameters ? `${parameters[1].toUpperCase()} 轴${method === 'GET' ? '读取' : '应用'}驱动参数` :
    path === '/api/stage/recover' ? '恢复 PDXC3 失效连接' : undefined
  try {
    return await apiRequest<T>(path, {
      method, timeoutMs: timeout,
      operation,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'http' && error.status != null && error.status < 500) throw new StageRequestError(error.message, error.status)
    throw error
  }
}
