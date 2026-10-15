import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import StagePanel from '../src/StagePanel'

let dom: JSDOM, root: Root, container: HTMLElement
let state: {
  config: { mode: string; serial_number: string; host: string; port: number; axes: Record<string, number>; inverted: Record<string, boolean>; max_steps: number }
  connected: boolean; error: string | null
  channels: { channel: number; moving: boolean; ready: boolean; enabled: boolean; stage: string; error: string | null }[]
}
let writes: { path: string; body: unknown }[]
let rejectConnection: boolean

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
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (options?.method !== 'GET') {
      writes.push({ path, body: JSON.parse(String(options?.body ?? '{}')) })
      if (path.endsWith('/connect') && rejectConnection) return new Response(JSON.stringify({ detail: '未找到设备' }), { status: 409 })
    }
    return new Response(JSON.stringify(state))
  }
  container = document.getElementById('root')!
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); dom.window.close() })

async function render(auth = true, configuration = false) {
  await act(async () => { root.render(<StagePanel auth={auth} connected configuration={configuration} />); await new Promise(r => setTimeout(r, 10)) })
}
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.trim() === label || x.getAttribute('aria-label') === label)
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
