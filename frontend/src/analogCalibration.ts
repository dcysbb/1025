export function validOffset(value: number | string | undefined) {
  const text = String(value ?? 0), number = Number(text)
  return text.trim() !== '' && Number.isFinite(number) && number >= -16 && number <= 16 && Math.abs(number * 1000 - Math.round(number * 1000)) < 1e-6
}

export function currentCommand(target: number, offset: number) {
  const raw = Math.round(target * 1000) + Math.round(offset * 1000)
  const bounded = Math.max(4000, Math.min(20000, raw))
  return {current: bounded / 1000, limited: raw !== bounded}
}
