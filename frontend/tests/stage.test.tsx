import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import StagePanel from '../src/StagePanel'
import { makeStageProfile } from '../src/stageProfiles'

const initialDom = new JSDOM('<!doctype html><div/>', { url: 'http://localhost' })
Object.assign(globalThis, { window: initialDom.window, document: initialDom.window.document })
const { createRoot } = await import('react-dom/client')

let dom: JSDOM, root: Root, container: HTMLElement
let state: {
  config: { mode: string; serial_number: string; host: string; port: number; axes: Record<string, number>; inverted: Record<string, boolean>; max_steps: number }
  connected: boolean; error: string | null
  motion_pending?: boolean
  operation?: {kind: string; axis: 'x'; channel: number; elapsed_s: number; phase: 'waiting' | 'running'}
  channels: { channel: number; moving: boolean; ready: boolean; enabled: boolean; stage: string; error: string | null }[]
}
let writes: { path: string; body: unknown }[]
let rejectConnection: boolean
let movementEvents: unknown[]

beforeEach(() => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })
  state = {
    config: { mode: 'real', serial_number: '', host: '', port: 40303, axes: { x: 3, y: 1, z: 2 }, inverted: { x: false, y: false, z: false }, max_steps: 1000 },
    connected: false, error: null,
    channels: [1, 2, 3].map(channel => ({ channel, moving: false, ready: true, enabled: false, stage: 'PD1V/M', error: null })),
  }
  writes = []
  rejectConnection = false
  movementEvents = []
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (options?.method !== 'GET') {
      writes.push({ path, body: JSON.parse(String(options?.body ?? '{}')) })
      if (path.endsWith('/connect') && rejectConnection) return new Response(JSON.stringify({ detail: '未找到设备' }), { status: 409 })
    }
    return new Response(JSON.stringify(path.startsWith('/api/events') ? {events: movementEvents} : state))
  }
  container = document.getElementById('root')!
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); dom.window.close() })

async function render(auth = true, configuration = false) {
  await act(async () => { root.render(<StagePanel auth={auth} connected configuration={configuration} />); await new Promise(r => setTimeout(r, 10)) })
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.trim() === label || x.getAttribute('aria-label') === label)
  assert.ok(found, label)
  return found
}

test('opening stage panel is read-only and shows configured channel permutation', async () => {
  await render()
  assert.deepEqual(writes, [])
  assert.ok(container.querySelector('.stage-axis--x')?.textContent?.includes('CH3'))
  assert.equal(button('X 轴正向移动').disabled, true)
})

test('a hardware fault blocks movement while keeping stop available', async () => {
  state.connected = true
  state.channels[2].ready = false
  state.channels[2].error = '位移台类型不匹配'
  await render()
  assert.equal(button('X 轴正向移动').disabled, true)
  assert.equal(button('全部停止').disabled, false)
  assert.ok(container.textContent?.includes('位移台类型不匹配'))
})

test('one click sends exactly one bounded axis move and no homing or enable call', async () => {
  state.connected = true
  await render()
  await act(async () => { button('Y 轴反向移动').click(); await new Promise(r => setTimeout(r, 0)) })
  assert.deepEqual(writes, [{ path: '/api/stage/move', body: { axis: 'y', direction: -1, steps: 10 } }])
})

test('failed real connection remains real and does not silently simulate', async () => {
  state.channels = []
  rejectConnection = true
  await render(true, true)
  await act(async () => { button('连接控制器').click(); await new Promise(r => setTimeout(r, 0)) })
  assert.ok(container.textContent?.includes('未找到设备'))
  assert.equal(container.querySelector('[aria-label="X 轴正向移动"]'), null)
  assert.equal(container.querySelector('.stage-simulation'), null)
})

test('unauthenticated readers cannot issue moves or connect', async () => {
  state.connected = true
  await render(false)
  assert.equal(button('X 轴正向移动').disabled, true)
  assert.equal(button('全部停止').disabled, true)
  assert.deepEqual(writes, [])
})

async function changeStep(axis: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${axis} 轴点动步数"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function step(axis: string) { return container.querySelector<HTMLInputElement>(`[aria-label="${axis} 轴点动步数"]`)!.value }
function keys(key: string, options: KeyboardEventInit = {}) {
  const area = container.querySelector<HTMLElement>('[aria-label="键盘点动控制区域"]')!
  area.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('tools navigation reveals the correct section and sends no controller action', async () => {
  await render()
  let destination = ''
  const tools = document.getElementById('stage-controller-tools')!
  tools.scrollIntoView = () => { destination = tools.id }
  await act(async () => button('Home / Optimize / 参数').click())
  assert.equal(destination, 'stage-controller-tools')
  assert.equal(document.activeElement, tools)
  assert.deepEqual(writes, [])
})

test('lost communication during optimization never presents a running or waiting progress claim', async () => {
  state.motion_pending = true
  state.operation = {kind:'optimize', axis:'x', channel:3, elapsed_s:150, phase:'waiting'}
  state.error = '停止未确认'
  state.channels = []
  await render()
  assert.ok(container.querySelector('.stage-optimization-progress')?.textContent?.includes('性能优化结果未确认'))
  assert.ok(!container.querySelector('.stage-optimization-progress')?.textContent?.includes('等待控制器开始'))
  assert.ok(container.querySelector('.stage-header-warning')?.textContent?.includes('停止尚未确认'))
  assert.equal(button('全部停止').disabled, false)
  assert.equal(button('Optimize · 性能优化').disabled, true)
  assert.deepEqual(writes, [])
})

test('imported drive profile is a local preview and never applies without an explicit click', async () => {
  state.connected = true
  const parameters = {values:{forward_amplitude:100,reverse_amplitude:90,step_rate:5000,acceleration:1000},limits:{forward_amplitude:{min:10,max:100},reverse_amplitude:{min:10,max:100},step_rate:{min:800,max:20000},acceleration:{min:1,max:20000}}}
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => String(url).includes('/parameters/') ? new Response(JSON.stringify(parameters)) : original(url, options)
  await render()
  await act(async () => { button('驱动参数 · 幅值、步频与加速度').click(); button('读取当前参数').click(); await new Promise(r => setTimeout(r, 5)) })
  const input = container.querySelector<HTMLInputElement>('[aria-label="导入 PDXC3 驱动参数文件"]')!
  const text = makeStageProfile({...parameters.values, step_rate:800}, {serial_number:'129576359',channel:1,stage:'PDXC2AD'})
  Object.defineProperty(input, 'files', {value:[{size:text.length, text:async () => text}]})
  await act(async () => { input.dispatchEvent(new dom.window.Event('change', {bubbles:true})); await new Promise(r => setTimeout(r, 5)) })
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="步频"]')?.value, '800')
  assert.ok(container.textContent?.includes('尚未发送给控制器'))
  assert.equal(button('应用驱动参数').disabled, false)
  assert.deepEqual(writes, [])
})

test('controller history distinguishes verified zero from submitted optimization', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => String(url).includes('kind=stage_action') ? new Response(JSON.stringify({events:[
    {id:1,timestamp:'2026-10-17T12:00:00Z',message:'计数读回零',details:{axis:'x',channel:3,operation:'zero',mode:'real',result:'verified'}},
    {id:2,timestamp:'2026-10-17T12:00:01Z',message:'等待控制器进度',details:{axis:'x',channel:3,operation:'optimize',mode:'real',result:'submitted'}},
  ]})) : original(url, options)
  await render()
  await act(async () => button('控制器操作记录 · Home / Optimize / 输出').click())
  const history = container.querySelector('.stage-tool-history')!
  assert.ok(history.textContent?.includes('读回已确认'))
  assert.ok(history.textContent?.includes('请求已下发'))
  assert.ok(!history.textContent?.includes('控制器报告优化完成'))
  assert.deepEqual(writes, [])
})

test('open-loop Home only sends a confirmed zero action on the selected logical axis', async () => {
  state.connected = true
  await render()
  await act(async () => { button('Home / Zero · 计数清零').click() })
  assert.deepEqual(writes, [])
  assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('不会寻找机械原点'))
  await act(async () => { button('确认清零').click(); button('确认清零').click(); await new Promise(r => setTimeout(r, 0)) })
  assert.deepEqual(writes, [{path:'/api/stage/action',body:{axis:'x',operation:'zero',confirmed:true}}])
})

test('optimization needs enabled output and a separate automatic-motion confirmation', async () => {
  state.connected = true
  await render()
  assert.equal(button('Optimize · 性能优化').disabled, true)
  await act(async () => { root.unmount() })
  root = createRoot(container)
  state.channels[2].enabled = true
  await render()
  await act(async () => { button('Optimize · 性能优化').click() })
  assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('不受点动步数上限限制'))
  assert.deepEqual(writes, [])
  await act(async () => { button('确认开始优化').click(); await new Promise(r => setTimeout(r, 0)) })
  assert.deepEqual(writes, [{path:'/api/stage/action',body:{axis:'x',operation:'optimize',confirmed:true}}])
})

test('drive parameters require explicit reads, validate limits and apply only selected fields', async () => {
  state.connected = true
  const original = globalThis.fetch
  const parameters = {values:{forward_amplitude:100,reverse_amplitude:90,step_rate:5000,acceleration:1000},limits:{forward_amplitude:{min:10,max:100},reverse_amplitude:{min:10,max:100},step_rate:{min:800,max:20000},acceleration:{min:1,max:20000}}}
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/parameters/')) {
      if (options?.method === 'PUT') {
        writes.push({path:String(url),body:JSON.parse(String(options.body))})
        parameters.values = JSON.parse(String(options.body))
      }
      return new Response(JSON.stringify(parameters))
    }
    return original(url, options)
  }
  await render()
  await act(async () => { button('驱动参数 · 幅值、步频与加速度').click(); button('读取当前参数').click(); await new Promise(r => setTimeout(r, 5)) })
  assert.deepEqual(writes, [])
  const input = container.querySelector<HTMLInputElement>('[aria-label="正向驱动幅值"]')!
  async function fill(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value)
      input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
  }
  await fill('101')
  assert.equal(button('应用驱动参数').disabled,true)
  await fill('80')
  await act(async () => { button('应用驱动参数').click(); button('应用驱动参数').click(); await new Promise(r => setTimeout(r,5)) })
  assert.deepEqual(writes,[{path:'/api/stage/parameters/x',body:{forward_amplitude:80,reverse_amplitude:90,step_rate:5000,acceleration:1000}}])
})

test('session recovery requires the stationary acknowledgement and never enables output', async () => {
  state.connected = false
  state.error = '通信超时，停止未确认'
  await render()
  await act(async () => { button('连接诊断与恢复').click(); button('恢复失效连接').click() })
  assert.equal(button('确认恢复连接').disabled,true)
  await act(async () => { (document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement).click() })
  await act(async () => { button('确认恢复连接').click(); await new Promise(r => setTimeout(r,0)) })
  assert.deepEqual(writes,[{path:'/api/stage/recover',body:{confirmed_stationary:true}}])
})

test('read-only users cannot enable, zero, optimize or change drive parameters', async () => {
  state.connected = true
  state.channels[2].enabled = true
  await render(false)
  for (const label of ['X 轴启用输出','X 轴禁用输出','Home / Zero · 计数清零','Optimize · 性能优化']) assert.equal(button(label).disabled,true)
  await act(async () => { button('驱动参数 · 幅值、步频与加速度').click() })
  assert.equal(button('读取当前参数').disabled,true)
  assert.deepEqual(writes,[])
})

test('axis steps are independent, persisted, bounded and scoped to the device mapping', async () => {
  state.connected = true
  await render()
  await changeStep('X', '25')
  await act(async () => { button('Y 轴 100 步').click() })
  assert.equal(step('X'), '25'); assert.equal(step('Y'), '100'); assert.equal(step('Z'), '10')
  await act(async () => { button('X 轴正向移动').click() })
  assert.deepEqual(writes.at(-1)?.body, { axis: 'x', direction: 1, steps: 25 })
  await act(async () => root.unmount())
  root = createRoot(container)
  await render()
  assert.equal(step('X'), '25'); assert.equal(step('Y'), '100')
  state.config.max_steps = 20
  await act(async () => root.unmount())
  root = createRoot(container)
  await render()
  assert.equal(step('X'), '25')
  assert.equal(button('X 轴正向移动').disabled, true)
  assert.equal(button('Y 轴 100 步').disabled, true)
  assert.ok(container.textContent?.includes('1–20'))
  state.config.axes = { x: 1, y: 2, z: 3 }
  state.config.max_steps = 5
  await act(async () => root.unmount())
  root = createRoot(container)
  await render()
  assert.equal(step('X'), '5'); assert.equal(step('Y'), '5')
  assert.equal(button('X 轴 10 步').disabled, true)
})

test('invalid steps block only their own axis and never produce a move', async () => {
  state.connected = true
  await render()
  for (const value of ['', '0', '-1', '1.5', '1001']) {
    await changeStep('X', value)
    assert.equal(button('X 轴正向移动').disabled, true)
    assert.equal(button('Y 轴正向移动').disabled, false)
    await act(async () => { button('X 轴正向移动').click() })
  }
  assert.deepEqual(writes, [])
})

test('same-turn repeated clicks are dropped and stop remains independent of an outstanding move', async () => {
  state.connected = true
  await render()
  const waiting = deferred<Response>(), original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/move')) {
      writes.push({path: String(url), body: JSON.parse(String(init?.body))})
      return waiting.promise
    }
    return original(url, init)
  }
  await act(async () => { button('X 轴正向移动').click(); button('X 轴正向移动').click() })
  assert.equal(writes.filter(row => row.path.endsWith('/move')).length, 1)
  assert.equal(button('全部停止').disabled, false)
  await act(async () => { button('全部停止').click() })
  assert.ok(writes.some(row => row.path.endsWith('/stop')))
  await act(async () => waiting.resolve(new Response(JSON.stringify({...state, motion_pending: true}))))
  assert.equal(button('X 轴正向移动').disabled, false)
  assert.ok(container.textContent?.includes('控制器已报告全部通道空闲'))
})

test('motion_pending blocks new requests until a subsequent status update confirms idle', async () => {
  state.connected = true
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/move')) {
      writes.push({path: String(url), body: JSON.parse(String(init?.body))})
      return new Response(JSON.stringify({...state, motion_pending: true}))
    }
    return original(url, init)
  }
  await render()
  await act(async () => { button('X 轴正向移动').click() })
  assert.equal(button('Y 轴正向移动').disabled, true)
  assert.ok(container.textContent?.includes('等待后续状态采样确认空闲'))
  await act(async () => { await new Promise(done => setTimeout(done, 1100)) })
  assert.equal(button('Y 轴正向移动').disabled, false)
})

test('an older in-flight poll cannot overwrite the move response with cached idle', async () => {
  state.connected = true
  await render()
  const oldPoll = deferred<Response>(), entered = deferred<void>(), original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/stage' && init?.method === 'GET') { entered.resolve(); return oldPoll.promise }
    if (String(url).endsWith('/move')) return new Response(JSON.stringify({...state, motion_pending: true}))
    return original(url, init)
  }
  await act(async () => { await entered.promise })
  await act(async () => { button('X 轴正向移动').click() })
  await act(async () => oldPoll.resolve(new Response(JSON.stringify({...state, motion_pending: false}))))
  assert.equal(button('Y 轴正向移动').disabled, true)
})

test('keyboard is opt-in, ignores repeat and modifiers, and deactivates on edits, blur and dialogs', async () => {
  state.connected = true
  await render()
  await act(async () => { keys('ArrowRight') })
  assert.deepEqual(writes, [])
  await act(async () => { button('启用键盘').click() })
  assert.equal(document.activeElement?.getAttribute('aria-label'), '键盘点动控制区域')
  await act(async () => { keys('ArrowRight', {repeat: true}); keys('ArrowUp', {ctrlKey: true}); keys('PageUp', {shiftKey: true}) })
  assert.deepEqual(writes, [])
  await act(async () => { keys('ArrowLeft') })
  assert.deepEqual(writes.at(-1)?.body, {axis: 'x', direction: -1, steps: 10})
  await act(async () => { keys('Escape') })
  assert.ok(writes.some(row => row.path.endsWith('/stop')))
  await act(async () => { container.querySelector<HTMLInputElement>('[aria-label="X 轴点动步数"]')!.focus() })
  assert.equal(button('启用键盘').getAttribute('aria-pressed'), 'false')
  await act(async () => { button('启用键盘').click(); window.dispatchEvent(new dom.window.Event('blur')) })
  assert.equal(button('启用键盘').getAttribute('aria-pressed'), 'false')
  await act(async () => {
    button('启用键盘').click()
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog)
  })
  assert.equal(button('启用键盘').getAttribute('aria-pressed'), 'false')
})

test('poll failure marks controls stale while a stop can still be attempted', async () => {
  state.connected = true
  await render()
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/stage' && init?.method === 'GET') throw new Error('offline')
    return original(url, init)
  }
  await act(async () => { await new Promise(done => setTimeout(done, 1100)) })
  assert.equal(button('X 轴正向移动').disabled, true)
  assert.equal(button('全部停止').disabled, false)
  assert.ok(container.textContent?.includes('状态过期'))
  assert.ok(container.textContent?.includes('读取 PDXC3 位移台状态失败'))
  assert.ok(container.textContent?.includes('停止入口保留'))
})

test('a server error during movement stays unconfirmed until an explicit stop resolves it', async () => {
  state.connected = true
  await render()
  const original = globalThis.fetch
  let moves = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/move')) { moves++; return new Response('internal error', { status: 500 }) }
    return original(url, init)
  }
  await act(async () => { button('Y 轴反向移动').click() })
  assert.ok(container.textContent?.includes('Y 轴反向点动 10 步失败（HTTP 500）'))
  assert.ok(container.textContent?.includes('结果未确认'))
  assert.equal(button('Y 轴反向移动').disabled, true)
  assert.equal(button('全部停止').disabled, false)
  assert.equal(moves, 1)
  await act(async () => { button('全部停止').click() })
  assert.equal(button('Y 轴反向移动').disabled, false)
})

test('ambiguous HTTP delivery never unlocks movement just because polling later reports idle', async () => {
  state.connected = true
  await render()
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/move')) throw new Error('lost response')
    return original(url, init)
  }
  await act(async () => { button('X 轴正向移动').click() })
  assert.ok(container.textContent?.includes('结果未确认'))
  await act(async () => { await new Promise(done => setTimeout(done, 1100)) })
  assert.equal(button('X 轴正向移动').disabled, true)
  await act(async () => { button('全部停止').click() })
  assert.equal(button('X 轴正向移动').disabled, false)
})

test('history renders legacy and new results without claiming physical arrival, and failures are isolated', async () => {
  state.connected = true
  movementEvents = [undefined, 'rejected', 'unconfirmed'].map((result, i) => ({id:i+1, timestamp:'2026-10-16T02:00:00Z', message:'移动请求', details:{axis:'y', channel:1, direction:-1, hardware_direction:1, steps:25, mode:'simulation', result, reason: result === 'unconfirmed' ? '应答丢失' : ''}}))
  await render()
  assert.ok(container.textContent?.includes('请求已下发'))
  assert.ok(container.textContent?.includes('未下发'))
  assert.ok(container.textContent?.includes('结果未确认'))
  assert.ok(container.textContent?.includes('应答丢失'))
  assert.equal(container.textContent?.includes('模拟累计'), false)
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('/api/events')) throw new Error('history unavailable')
    return original(url, init)
  }
  await act(async () => { button('刷新运动记录').click() })
  assert.ok(container.textContent?.includes('运动记录读取失败'))
  assert.equal(button('X 轴正向移动').disabled, false)
  assert.equal(button('全部停止').disabled, false)
})

test('Y and Z keyboard commands use their own steps and hidden pages revoke keyboard authority', async () => {
  state.connected = true
  await render()
  await changeStep('Y', '25'); await changeStep('Z', '100')
  await act(async () => { button('启用键盘').click() })
  await act(async () => { keys('ArrowUp') })
  await act(async () => { keys('PageDown') })
  assert.deepEqual(writes.filter(row => row.path.endsWith('/move')).map(row => row.body), [
    {axis: 'y', direction: 1, steps: 25}, {axis: 'z', direction: -1, steps: 100},
  ])
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'})
    document.dispatchEvent(new dom.window.Event('visibilitychange'))
    keys('ArrowRight')
  })
  assert.equal(writes.filter(row => row.path.endsWith('/move')).length, 2)
  assert.equal(button('启用键盘').getAttribute('aria-pressed'), 'false')
})

test('stored steps do not leak to a different serial number or to simulation', async () => {
  state.config.serial_number = '129111111'
  await render(); await changeStep('X', '45')
  for (const [serial, mode, expected] of [['129222222', 'real', '10'], ['129111111', 'simulation', '10'], ['129111111', 'real', '45']]) {
    state.config.serial_number = serial!; state.config.mode = mode!
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    assert.equal(step('X'), expected)
  }
})

test('long channel faults remain visible next to disabled motion controls and preserve stop', async () => {
  state.connected = true
  const detail = 'CH3 位移台类型不匹配，请核对控制器识别型号及接线。'.repeat(15)
  state.channels[2].ready = false
  state.channels[2].error = detail
  await render()
  assert.equal(container.querySelector('#stage-reason-x')?.textContent, detail)
  assert.equal(button('X 轴正向移动').disabled, true)
  assert.equal(button('全部停止').disabled, false)
})
