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
  jogging?: {axis: string; channel: number; direction: number} | null
  operation?: {kind: string; axis: 'x' | 'y' | 'z'; channel: number; elapsed_s: number; phase: 'waiting' | 'running'}
  channels: { channel: number; moving: boolean; ready: boolean; enabled: boolean; stage: string; error: string | null; open_loop?: boolean; command_count?: number }[]
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

test('each axis has one combined card for jog, output, Home, Optimize, quick params and its own count', async () => {
  state.connected = true
  state.channels.forEach(row => { row.command_count = row.channel * 100 })
  await render()
  const workbench = container.querySelector('.stage-workbench')!
  assert.equal(container.querySelectorAll('.stage-axis').length, 3)
  assert.equal(container.querySelector('.stage-channel-tools'), null)
  assert.equal(container.querySelector('.stage-advanced')?.closest('.content-panel'), workbench)
  assert.equal(container.querySelectorAll('.stage-quick-params').length, 3)
  for (const axis of ['X', 'Y', 'Z']) {
    const channel = state.config.axes[axis.toLowerCase()]
    const card = workbench.querySelector(`[aria-label="${axis} 轴 CH${channel} 控制卡片"]`)!
    for (const label of [`${axis} 轴正向移动`, `${axis} 轴反向移动`, `${axis} 轴启用输出`, `${axis} 轴禁用输出`, `${axis} 轴 Home · 回零`, `${axis} 轴 Optimize · 性能优化`]) assert.ok(card.querySelector(`[aria-label="${label}"]`), label)
    assert.equal(card.querySelectorAll('.stage-axis-details').length, 1)
    assert.ok(card.querySelector('.stage-axis-details')?.textContent?.includes(`${channel * 100}非实测位置`))
  }
  assert.deepEqual(writes, [])
})

test('entering the channel tool controls revokes keyboard jogging without sending an action', async () => {
  state.connected = true
  state.channels.forEach(row => { row.enabled = true })
  await render()
  await act(async () => button('启用键盘').click())
  assert.equal(button('停用键盘').getAttribute('aria-pressed'), 'true')
  await act(async () => button('X 轴 Home · 回零').focus())
  assert.equal(button('启用键盘').getAttribute('aria-pressed'), 'false')
  await act(async () => { keys('ArrowRight'); keyUps('ArrowRight') })
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.deepEqual(writes, [])
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

test('a quick tap sends exactly one bounded axis move and no homing or enable call', async () => {
  state.connected = true
  await render()
  await tapButton('Y 轴反向移动')
  assert.deepEqual(writes, [{ path: '/api/stage/move', body: { axis: 'y', direction: -1, steps: 10 } }])
})

test('press-and-hold sends continuous jog then stop; a quick tap stays a bounded move', async () => {
  state.connected = true
  await render()
  await holdButton('X 轴正向移动')
  assert.deepEqual(writes.filter(row => row.path.endsWith('/move')), [])
  const lease = (writes[0].body as {lease_id:string}).lease_id
  assert.ok(lease)
  assert.deepEqual(writes.map(row => ({ path: row.path.replace('/api/stage', ''), body: row.body })), [
    { path: '/jog', body: { axis: 'x', direction: 1, lease_id:lease } },
    { path: '/stop', body: {} },
  ])
  await tapButton('Y 轴反向移动')
  assert.deepEqual(writes.filter(row => row.path.endsWith('/move')), [{ path: '/api/stage/move', body: { axis: 'y', direction: -1, steps: 10 } }])
})

test('losing focus before the hold threshold cancels the pending timer without moving', async () => {
  state.connected = true
  await render()
  await act(async () => {
    pointer('pointerdown', button('X 轴正向移动'))
    window.dispatchEvent(new dom.window.Event('blur'))
    await new Promise(r => setTimeout(r, 220))
  })
  assert.deepEqual(writes, [])
})

test('a held control renews its lease and unmount sends stop and ends heartbeats', async () => {
  state.connected = true
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (path.endsWith('/jog') && options?.method === 'POST') {
      state.jogging = {axis:'x',channel:3,direction:1}; state.motion_pending = true
    }
    if (path.endsWith('/stop')) { state.jogging = null; state.motion_pending = false }
    return original(url, options)
  }
  await render()
  await act(async () => { pointer('pointerdown', button('X 轴正向移动')); await new Promise(r => setTimeout(r, 220)) })
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
  assert.ok(writes.some(row => row.path.endsWith('/jog/keepalive')))
  await act(async () => root.render(<div/>))
  const count = writes.length
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
  assert.equal(writes.length, count)
  assert.equal(writes.at(-1)?.path, '/api/stage/stop')
})

test('release while jog submission is pending sends stop and cannot restart heartbeats later', async () => {
  state.connected = true
  const original = globalThis.fetch
  let finish: () => void = () => {}
  const gate = new Promise<void>(resolve => {finish = resolve})
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/jog')) {
      writes.push({path:String(url),body:JSON.parse(String(options?.body))})
      await gate
      return new Response(JSON.stringify({...state,motion_pending:true,jogging:{axis:'x',channel:3,direction:1}}))
    }
    return original(url, options)
  }
  await render()
  await act(async () => { pointer('pointerdown', button('X 轴正向移动')); await new Promise(r => setTimeout(r, 220)) })
  await act(async () => { pointer('pointerup', button('X 轴正向移动')); await new Promise(r => setTimeout(r, 0)) })
  await act(async () => { finish(); await new Promise(r => setTimeout(r, 300)) })
  assert.deepEqual(writes.map(row => row.path), ['/api/stage/jog','/api/stage/stop'])
  assert.equal(button('Y 轴正向移动').disabled, false)
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
function keyUps(key: string) {
  const area = container.querySelector<HTMLElement>('[aria-label="键盘点动控制区域"]')!
  area.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
}
async function tap(key: string) { await act(async () => { keys(key); keyUps(key) }) }
function pointer(type: 'pointerdown' | 'pointerup', element: HTMLElement) {
  element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
}
async function tapButton(label: string) {
  const element = button(label)
  await act(async () => { pointer('pointerdown', element); pointer('pointerup', element); await new Promise(r => setTimeout(r, 0)) })
}
async function holdButton(label: string, ms = 220) {
  const element = button(label)
  await act(async () => {
    pointer('pointerdown', element)
    await new Promise(r => setTimeout(r, ms))
    pointer('pointerup', element)
    await new Promise(r => setTimeout(r, 0))
  })
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
  await act(async () => button('参数与诊断').click())
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
  assert.ok(container.querySelector('.stage-header-warning')?.textContent?.includes('运动状态未确认'))
  assert.equal(button('全部停止').disabled, false)
  for (const axis of ['X', 'Y', 'Z']) assert.equal(button(`${axis} 轴 Optimize · 性能优化`).disabled, true)
  assert.deepEqual(writes, [])
})

test('imported drive profile is a local preview and never applies without an explicit click', async () => {
  state.connected = true
  const parameters = {values:{forward_amplitude:100,reverse_amplitude:90,step_rate:5000,acceleration:1000},limits:{forward_amplitude:{min:10,max:100},reverse_amplitude:{min:10,max:100},step_rate:{min:800,max:20000},acceleration:{min:1,max:20000}}}
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => String(url).includes('/parameters/') ? new Response(JSON.stringify(parameters)) : original(url, options)
  await render()
  await act(async () => { button('驱动参数 · 幅值、步频与加速度（全部轴逐轴编辑）').click(); await new Promise(r => setTimeout(r, 5)) })
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

for (const axis of ['x', 'y', 'z']) test(`${axis} Home confirms direction and homes only its own mapped channel`, async () => {
  state.connected = true
  state.channels.forEach(row => { row.enabled = true })
  await render()
  assert.equal(container.querySelector('[aria-label="控制器工具操作轴"]'), null)
  await act(async () => { button(`${axis.toUpperCase()} 轴 Home · 回零`).click() })
  assert.deepEqual(writes, [])
  assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('尝试硬件回零'))
  assert.ok(document.querySelector('[role="dialog"] h2')?.textContent?.includes(`${axis.toUpperCase()} / CH${state.config.axes[axis]}`))
  await act(async () => { button('确认回零').click(); button('确认回零').click(); await new Promise(r => setTimeout(r, 0)) })
  assert.deepEqual(writes, [{path:'/api/stage/action',body:{axis,operation:'home',confirmed:true,home_direction:-1}}])
})

for (const axis of ['x', 'y', 'z']) test(`${axis} optimization needs its own output enabled and confirms its mapped channel`, async () => {
  state.connected = true
  await render()
  assert.equal(button(`${axis.toUpperCase()} 轴 Optimize · 性能优化`).disabled, true)
  await act(async () => { root.unmount() })
  root = createRoot(container)
  state.channels.find(row => row.channel === state.config.axes[axis])!.enabled = true
  await render()
  for (const other of ['x', 'y', 'z'].filter(value => value !== axis)) assert.equal(button(`${other.toUpperCase()} 轴 Optimize · 性能优化`).disabled, true)
  await act(async () => { button(`${axis.toUpperCase()} 轴 Optimize · 性能优化`).click() })
  assert.ok(document.querySelector('[role="dialog"] h2')?.textContent?.includes(`${axis.toUpperCase()} / CH${state.config.axes[axis]}`))
  assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('不受点动步数上限限制'))
  assert.deepEqual(writes, [])
  await act(async () => { button('确认开始优化').click(); await new Promise(r => setTimeout(r, 0)) })
  assert.deepEqual(writes, [{path:'/api/stage/action',body:{axis,operation:'optimize',confirmed:true}}])
})

test('parameter selection cannot retarget a channel Home confirmation', async () => {
  state.connected = true
  state.channels.forEach(row => { row.enabled = true })
  await render()
  await act(async () => { button('驱动参数 · 幅值、步频与加速度（全部轴逐轴编辑）').click(); button('Y 轴 Home · 回零').click() })
  const select = container.querySelector<HTMLSelectElement>('[aria-label="驱动参数通道"]')!
  await act(async () => { select.value = 'z'; select.dispatchEvent(new dom.window.Event('change', {bubbles: true})) })
  assert.ok(document.querySelector('[role="dialog"] h2')?.textContent?.includes('Y / CH1'))
  await act(async () => { button('确认回零').click() })
  assert.deepEqual(writes, [{path:'/api/stage/action',body:{axis:'y',operation:'home',confirmed:true,home_direction:-1}}])
})

test('changing the channel mapping revokes an open Home confirmation without sending it', async () => {
  state.connected = true
  state.channels.forEach(row => { row.enabled = true })
  await render()
  await act(async () => button('X 轴 Home · 回零').click())
  assert.ok(document.querySelector('[role="dialog"] h2')?.textContent?.includes('X / CH3'))
  state.config.axes = {x: 1, y: 3, z: 2}
  await act(async () => { await new Promise(r => setTimeout(r, 1100)) })
  assert.equal(document.querySelector('.motion-presence[data-open="true"] [role="dialog"]'), null)
  assert.ok(container.querySelector('.stage-axis--x')?.textContent?.includes('CH1'))
  assert.deepEqual(writes, [])
  await act(async () => button('X 轴 Home · 回零').click())
  assert.ok(document.querySelector('[role="dialog"] h2')?.textContent?.includes('X / CH1'))
  await act(async () => button('确认回零').click())
  assert.deepEqual(writes, [{path:'/api/stage/action',body:{axis:'x',operation:'home',confirmed:true,home_direction:-1}}])
})

for (const axis of ['x', 'y', 'z']) test(`${axis} output controls send only their own axis`, async () => {
  state.connected = true
  await render()
  await act(async () => button(`${axis.toUpperCase()} 轴启用输出`).click())
  assert.deepEqual(writes, [{path:'/api/stage/action',body:{axis,operation:'enable'}}])
})

test('channel readiness and open-loop eligibility do not follow another card', async () => {
  state.connected = true
  state.channels.forEach(row => {row.enabled = true})
  state.channels[0].ready = false
  state.channels[0].error = 'CH1 未接位移台'
  state.channels[1].open_loop = false
  await render()
  assert.equal(button('X 轴 Home · 回零').disabled, false)
  assert.equal(button('X 轴 Optimize · 性能优化').disabled, false)
  for (const axis of ['Y', 'Z']) {
    assert.equal(button(`${axis} 轴 Home · 回零`).disabled, true)
    assert.equal(button(`${axis} 轴 Optimize · 性能优化`).disabled, true)
  }
  assert.ok(container.querySelector('.stage-axis--y')?.textContent?.includes('CH1 未接位移台'))
  assert.equal(button('全部停止').disabled, false)
  assert.deepEqual(writes, [])
})

test('optimization progress is scoped to its channel while all new actions stay blocked', async () => {
  state.connected = true
  state.channels.forEach(row => {row.enabled = true})
  state.operation = {kind:'optimize',axis:'z',channel:2,elapsed_s:12,phase:'running'}
  state.motion_pending = true
  await render()
  assert.equal(container.querySelectorAll('.stage-optimization-progress').length, 1)
  assert.ok(container.querySelector('.stage-axis--z .stage-optimization-progress')?.textContent?.includes('Z / CH2'))
  for (const axis of ['X','Y','Z']) for (const operation of ['Home · 回零','Optimize · 性能优化']) assert.equal(button(`${axis} 轴 ${operation}`).disabled, true)
  assert.equal(button('全部停止').disabled, false)
  assert.deepEqual(writes, [])
})

test('drive parameters auto-read on open, validate limits and apply only edited fields', async () => {
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
  await act(async () => { button('驱动参数 · 幅值、步频与加速度（全部轴逐轴编辑）').click(); await new Promise(r => setTimeout(r, 5)) })
  assert.deepEqual(writes, [])
  assert.ok(container.querySelector<HTMLInputElement>('[aria-label="步频"]'))
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

test('per-axis quick params auto-read on open and apply rate and acceleration', async () => {
  state.connected = true
  const original = globalThis.fetch
  const parameters = {values:{forward_amplitude:100,reverse_amplitude:90,step_rate:5000,acceleration:1000},limits:{forward_amplitude:{min:10,max:100},reverse_amplitude:{min:10,max:100},step_rate:{min:800,max:20000},acceleration:{min:1,max:20000}}}
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/parameters/')) {
      if (options?.method === 'PUT') writes.push({path:String(url),body:JSON.parse(String(options.body))})
      return new Response(JSON.stringify(parameters))
    }
    return original(url, options)
  }
  await render()
  const toggles = [...container.querySelectorAll<HTMLButtonElement>('.stage-quick-params .disclosure__toggle')]
  assert.equal(toggles.length, 3)
  await act(async () => { toggles[0].click(); await new Promise(r => setTimeout(r, 5)) })
  const rate = container.querySelector<HTMLInputElement>('[aria-label="X 轴步频"]')!
  assert.equal(rate.value, '5000')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(rate,'1600')
    rate.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
  })
  await act(async () => { button('应用').click(); await new Promise(r => setTimeout(r, 5)) })
  assert.deepEqual(writes,[{path:'/api/stage/parameters/x',body:{forward_amplitude:100,reverse_amplitude:90,step_rate:1600,acceleration:1000}}])
})

test('step presets are editable, validated and saved server-side while connected', async () => {
  state.connected = true
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/presets')) {
      writes.push({path:String(url), body: JSON.parse(String(options?.body ?? '{}'))})
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        state.config = { ...state.config, step_presets: body.presets }
      }
    }
    return new Response(JSON.stringify(state))
  }
  await render()
  await act(async () => { button('自定义步长').click() })
  const inputs = [...container.querySelectorAll<HTMLInputElement>('[aria-label^="快捷步数"]')]
  assert.equal(inputs.length, 5)
  await act(async () => {
    for (const [index, value] of ['2', '20', '200', '', ''].entries()) {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(inputs[index], value)
      inputs[index].dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    }
    button('保存').click()
    await new Promise(r => setTimeout(r, 5))
  })
  assert.deepEqual(writes, [{path:'/api/stage/presets', body:{presets:[2,20,200]}}])
  assert.ok(container.textContent?.includes('2 / 20 / 200'))
  assert.ok(button('Y 轴 20 步'))
  await act(async () => { button('自定义步长').click() })
  const again = [...container.querySelectorAll<HTMLInputElement>('[aria-label^="快捷步数"]')]
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(again[1], '2')
    again[1].dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    button('保存').click()
    await new Promise(r => setTimeout(r, 5))
  })
  assert.ok(container.textContent?.includes('快捷步数不能重复'))
})

test('motion unlock requires the stationary acknowledgement and never enables output', async () => {
  state.connected = false
  state.error = '通信超时，停止未确认'
  state.motion_pending = true
  await render()
  await act(async () => { button('连接诊断与恢复').click(); button('解除运动锁定').click() })
  assert.equal(button('确认解除运动锁定').disabled,true)
  await act(async () => { (document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement).click() })
  await act(async () => { button('确认解除运动锁定').click(); await new Promise(r => setTimeout(r,0)) })
  assert.deepEqual(writes,[{path:'/api/stage/recover',body:{confirmed_stationary:true}}])
})

test('hardware connection directly connects with a previous motion lock and no confirmation dialog', async () => {
  state.error = '上次停止未确认'
  state.motion_pending = true
  state.channels = []
  await render(true, true)
  assert.equal(button('连接控制器').disabled, false)
  await act(async () => { button('连接控制器').click(); button('连接控制器').click(); await new Promise(r => setTimeout(r,0)) })
  assert.deepEqual(writes, [{path:'/api/stage/connect',body:{}}])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('stage page also allows direct connection despite a previous error without unlocking motion', async () => {
  state.error = '停止未确认'
  state.motion_pending = true
  await render()
  assert.equal(button('连接控制器').disabled, false)
  await act(async () => { state.connected = true; button('连接控制器').click(); await new Promise(r => setTimeout(r,0)) })
  assert.deepEqual(writes, [{path:'/api/stage/connect',body:{}}])
  assert.equal(button('X 轴正向移动').disabled, true)
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await act(async () => { button('连接诊断与恢复').click(); button('解除运动锁定').click() })
  assert.equal(button('确认解除运动锁定').disabled, true)
})

test('read-only users cannot enable, home, optimize or change drive parameters', async () => {
  state.connected = true
  state.channels[2].enabled = true
  await render(false)
  for (const axis of ['X','Y','Z']) for (const label of ['启用输出','禁用输出','Home · 回零','Optimize · 性能优化']) assert.equal(button(`${axis} 轴${label.includes(' · ') ? ' ' : ''}${label}`).disabled,true)
  await act(async () => { button('驱动参数 · 幅值、步频与加速度（全部轴逐轴编辑）').click() })
  assert.equal(button('重新读取').disabled,true)
  assert.deepEqual(writes,[])
})

test('axis steps are independent, persisted, bounded and scoped to the device mapping', async () => {
  state.connected = true
  await render()
  await changeStep('X', '25')
  await act(async () => { button('Y 轴 100 步').click() })
  assert.equal(step('X'), '25'); assert.equal(step('Y'), '100'); assert.equal(step('Z'), '10')
  await tapButton('X 轴正向移动')
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
    await tapButton('X 轴正向移动')
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
  await act(async () => { pointer('pointerdown', button('X 轴正向移动')); pointer('pointerup', button('X 轴正向移动')) })
  await act(async () => { pointer('pointerdown', button('X 轴正向移动')); pointer('pointerup', button('X 轴正向移动')) })
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
      state.motion_pending = true
      return new Response(JSON.stringify({...state, motion_pending: true}))
    }
    return original(url, init)
  }
  await render()
  await tapButton('X 轴正向移动')
  assert.equal(button('Y 轴正向移动').disabled, true)
  assert.ok(container.textContent?.includes('等待后续状态采样确认空闲'))
  state.motion_pending = false
  await act(async () => { await new Promise(done => setTimeout(done, 200)) })
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
  await tapButton('X 轴正向移动')
  await act(async () => oldPoll.resolve(new Response(JSON.stringify({...state, motion_pending: false}))))
  assert.equal(button('Y 轴正向移动').disabled, true)
})

test('keyboard is opt-in, ignores repeat and modifiers, and deactivates on edits, blur and dialogs', async () => {
  state.connected = true
  await render()
  await act(async () => { keys('ArrowRight'); keyUps('ArrowRight') })
  assert.deepEqual(writes, [])
  await act(async () => { button('启用键盘').click() })
  assert.equal(document.activeElement?.getAttribute('aria-label'), '键盘点动控制区域')
  await act(async () => { keys('ArrowRight', {repeat: true}); keys('ArrowUp', {ctrlKey: true}); keys('PageUp', {shiftKey: true}) })
  assert.deepEqual(writes, [])
  await tap('ArrowLeft')
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
  await tapButton('Y 轴反向移动')
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
  await tapButton('X 轴正向移动')
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
  await tap('ArrowUp')
  await tap('PageDown')
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
