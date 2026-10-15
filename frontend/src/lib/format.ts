import type { Unit } from './types'

export const FACTOR: Record<Unit, number> = { Pa: 1, mbar: 100, Torr: 133.32236842105263 }

export function pressure(value: number | null | undefined, unit: Unit): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : Number((value / FACTOR[unit]).toPrecision(3)).toExponential(2)
}

export function time(value?: string | null, full = false): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: full ? '2-digit' : undefined,
    hour12: false,
    ...(full ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
  }).format(new Date(value))
}

export function localValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
