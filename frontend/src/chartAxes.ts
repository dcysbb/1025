// Tick values are expressed in the displayed pressure unit, not raw Pa.
export function linearTicks(min: number, max: number, target = 5): number[] {
  const raw = (max - min) / Math.max(1, target - 1)
  if (!(raw > 0) || !Number.isFinite(raw)) return []
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const fraction = raw / magnitude
  const step = ([1, 2, 2.5, 5, 10].find(n => n >= fraction) ?? 10) * magnitude
  const first = Math.ceil(min / step - 1e-10)
  const last = Math.floor(max / step + 1e-10)
  return Array.from({ length: Math.max(0, Math.min(100, last - first + 1)) }, (_, i) => Number(((first + i) * step).toPrecision(12)))
}

export function logTicks(min: number, max: number, limit = 7): number[] {
  if (!(min > 0) || !(max > min)) return []
  const start = Math.ceil(Math.log10(min) - 1e-10)
  const end = Math.floor(Math.log10(max) + 1e-10)
  if (end > start) {
    const step = Math.max(1, Math.ceil((end - start + 1) / limit))
    return Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => Number(`1e${start + i * step}`))
  }
  const candidates = (mantissas: number[]) => {
    const ticks: number[] = []
    for (let exponent = Math.floor(Math.log10(min)); exponent <= Math.ceil(Math.log10(max)); exponent++) {
      for (const n of mantissas) {
        const value = Number((n * 10 ** exponent).toPrecision(12))
        if (value >= min * (1 - 1e-10) && value <= max * (1 + 1e-10)) ticks.push(value)
      }
    }
    return ticks
  }
  let values = candidates([1, 2, 5])
  if (values.length < 2) values = candidates([1, 2, 3, 4, 5, 6, 7, 8, 9])
  if (values.length < 2) values = linearTicks(min, max, 6)
  // Avoid crowded labels even for a narrow, manually selected log range.
  return values.reduce<number[]>((kept, value) => {
    if (!kept.length || Math.log10(value / kept.at(-1)!) / Math.log10(max / min) >= .13) kept.push(value)
    return kept
  }, [])
}

export function scientificParts(value: number) {
  if (value === 0) return { coefficient: '0', exponent: 0 }
  const [coefficient, exponent] = value.toExponential(8).split('e')
  return { coefficient: String(Number(coefficient)), exponent: Number(exponent) }
}

export function linearExponent(min: number, max: number) {
  const magnitude = Math.max(Math.abs(min), Math.abs(max))
  return magnitude > 0 && (magnitude < .001 || magnitude >= 10000) ? Math.floor(Math.log10(magnitude)) : 0
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000].map(n => n * 1000)
export function timeTicks(from: number, to: number, width: number): number[] {
  const target = Math.max(2, Math.floor(width / 130))
  const raw = (to - from) / target
  const step = raw < 1000 ? Math.max(1, 10 ** Math.ceil(Math.log10(raw))) : TIME_STEPS.find(n => n >= raw) ?? Math.ceil(raw / 86400000) * 86400000
  const offset = 8 * 3600000 // Tick alignment follows Asia/Shanghai, including day boundaries.
  const first = Math.ceil((from + offset) / step) * step - offset
  const ticks: number[] = []
  for (let value = first; value <= to && ticks.length < 20; value += step) ticks.push(value)
  return ticks.length ? ticks : [(from + to) / 2]
}

export function axisTime(stamp: number, span: number): [string, string] {
  const date = new Date(stamp)
  const day = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(date)
  if (span > 14 * 86400000) return [day, '']
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', ...(span < 120000 ? { second: '2-digit' } : {}), ...(span < 2000 ? { fractionalSecondDigits: 3 } : {}), hour12: false }).format(date)
  return [time, day]
}
