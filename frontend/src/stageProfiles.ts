import type { DriveParameters, ParameterState } from './stageClient'

const keys = ['forward_amplitude', 'reverse_amplitude', 'step_rate', 'acceleration'] as const
const bounds = {forward_amplitude: [10, 100], reverse_amplitude: [10, 100], step_rate: [800, 20000], acceleration: [1, 20000]}

/** Profiles are previews only. The existing authenticated apply operation performs writes. */
export function parseStageProfile(text: string, current: ParameterState): DriveParameters {
  if (text.length > 16384) throw new Error('参数文件过大，请选择控制台导出的 JSON 文件。')
  const profile = JSON.parse(text)
  if (!profile || profile.format !== 'pdxc3-open-loop' || profile.version !== 1 || profile.model !== 'PDXC3') throw new Error('文件不是受支持的 PDXC3 开环驱动参数。')
  const values = profile.values
  if (!values || Object.keys(values).length !== keys.length || !keys.every(key => Object.hasOwn(values, key))) throw new Error('参数字段不完整或包含未知字段。')
  for (const key of keys) {
    const value = values[key], limit = current.limits[key]
    const min = Math.max(bounds[key][0], limit.min ?? -Infinity), max = Math.min(bounds[key][1], limit.max ?? Infinity)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 必须为 ${min}–${max} 范围内的整数。`)
  }
  return Object.fromEntries(keys.map(key => [key, values[key]])) as DriveParameters
}

export function makeStageProfile(values: DriveParameters, source: {serial_number: string; channel: number; stage: string}) {
  return JSON.stringify({format: 'pdxc3-open-loop', version: 1, model: 'PDXC3', source, exported_at: new Date().toISOString(), values}, null, 2)
}
