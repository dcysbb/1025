export type Page =
  | 'overview'
  | 'history'
  | 'control'
  | 'events'
  | 'settings'
  | 'debug'
  | 'stage'
  | 'hardware'
export type Unit = 'Pa' | 'mbar' | 'Torr'

export type Channel = {
  channel: number
  label: string
  pressure_pa: number | null
  raw_value: number | null
  raw_unit: string
  status_code: number | null
  status: string
  valid: boolean
  trip_pa: number | null
  reset_pa: number | null
}

export type Status = {
  timestamp: string
  mode: 'simulation' | 'real'
  interlock: 'disarmed' | 'ready' | 'armed' | 'tripped' | 'fault'
  interlock_label: string
  trip_reason: string | null
  valve: 'unknown' | 'open' | 'closed' | 'opening' | 'closing' | 'fault'
  valve_open_sensor: boolean
  valve_closed_sensor: boolean
  tpg_connected: boolean
  adam_connected: boolean
  sample_age_s: number | null
  sample_latency_s: number | null
  sample_timestamp: string | null
  sample_stale: boolean
  io_reconnecting: boolean
  io_reconnect_attempt: number
  io_manual_reset_required: boolean
  io_error: string | null
  unit: string
  pressure_ok: boolean
  fail_closed_confirmed: boolean
  history_recording: boolean
  history_error: string | null
  channels: Channel[]
}

export type ChanConfig = {
  enabled: boolean
  label: string
  trip_pa: number | null
  reset_pa: number | null
}

export type Config = {
  io_device: 'dam0808d' | 'adam6050'
  dam_serial_port: string
  dam_baudrate: number
  dam_unit_id: number
  dam_input_labels: string[]
  dam_output_labels: string[]
  mode: 'simulation' | 'real'
  tpg_connection: 'tcp' | 'usb'
  tpg_serial_port: string
  tpg_baudrate: number
  tpg_host: string
  tpg_port: number
  adam_host: string
  adam_port: number
  adam_unit_id: number
  sample_interval_s: number
  stale_timeout_s: number
  valve_timeout_s: number
  recovery_hold_s: number
  history_retention_days: number | null
  allow_lan: boolean
  valve_closed_di: number
  valve_open_di: number | null
  valve_closed_active_high: boolean
  valve_open_active_high: boolean
  open_output: number
  fail_closed_confirmed: boolean
  channels: ChanConfig[]
}

export type DebugState = {
  mode: 'real' | 'simulation'
  outputs: boolean[]
  output_labels?: string[]
  interlock: string
  remaining_s: Record<string, number>
}

export type EventItem = {
  id: number
  timestamp: string
  type: string
  severity: string
  message: string
  actor: string
  details: Record<string, unknown>
}
