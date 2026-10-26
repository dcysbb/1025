import React, {act} from 'react'
import {JSDOM} from 'jsdom'
import {afterEach, beforeEach, test} from 'node:test'
import assert from 'node:assert/strict'
import type {Root} from 'react-dom/client'
import AnalogManualPanel from '../src/AnalogManualPanel'
import {currentCommand} from '../src/analogCalibration'

const initial = new JSDOM('<div/>', {url: 'http://localhost'})
Object.assign(globalThis, {window: initial.window, document: initial.window.document})
const {createRoot} = await import('react-dom/client')
let dom: JSDOM, root: Root, writes: {path: string; body: unknown}[]
let state: {config: {mode: string; host: string; port: number; unit_id: number; register_base: number | null; current_output_confirmed: boolean; outputs: {label: string; fault_ma: number; offset_ma?: number}[]}; connected: boolean; enabled: boolean; manual_active: boolean; unconfirmed: boolean; error: string | null; outputs: {channel: number; current_ma: number; status: string; target_ma?: number; offset_ma?: number}[]}
let failRead: boolean, failWrite: boolean, holdWrite: ((response: Response) => void) | null
beforeEach(() => {
  dom = new JSDOM('<div id="root"/>', {url: 'http://localhost'})
  Object.assign(globalThis, {window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true})
  dom.window.confirm = () => {throw new Error('Unexpected confirmation popup')}
  root = createRoot(document.getElementById('root')!)
  writes = []; failRead = false; failWrite = false; holdWrite = null
  state = {config: {mode: 'real', host: '192.168.0.7', port: 8234, unit_id: 1, register_base: 10, current_output_confirmed: true,
    outputs: Array.from({length: 4}, () => ({label: '', fault_ma: 20}))}, connected: true, enabled: false, manual_active: false, unconfirmed: false, error: null,
    outputs: [1, 2, 3, 4].map(channel => ({channel, current_ma: 20, status: '寄存器设定值'}))}
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (options?.method !== 'GET') {
      const body = JSON.parse(String(options?.body))
      writes.push({path, body})
      if (failWrite) throw new TypeError('Failed to fetch')
      if (path.endsWith('/stop')) {state.enabled = false; state.manual_active = false}
      else if (path.endsWith('/calibration')) state.config.outputs[body.channel-1].offset_ma=body.offset_ma
      else {
        state.manual_active = true
        state.outputs = state.outputs.map(row => row.channel === body.channel ? {...row, current_ma: body.current_ma, status: '手动设定'} : row)
      }
    } else if (failRead) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(state))
  }
})
afterEach(async () => {await act(async () => root.unmount()); dom.window.close()})
async function render(auth = true) {await act(async () => {root.render(<AnalogManualPanel auth={auth} connected/>); await new Promise(r => setTimeout(r, 5))})}
function button(text: string) {const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text); assert.ok(node, text); return node}
async function click(node: HTMLElement) {await act(async () => {node.click(); await new Promise(r => setTimeout(r, 5))})}
async function fill(channel: number, value: string) {
  const node = document.querySelector<HTMLInputElement>(`input[aria-label="AO${channel} 电流"]`)!
  await act(async () => {Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new dom.window.Event('input', {bubbles: true}))})
}
test('entering debug renders four channels and never writes; drafting a current also never writes', async () => {
  await render()
  assert.equal(document.querySelectorAll('.analog-manual-card').length, 4)
  await fill(2, '8.125')
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="AO1 电流"]')!.value, '20')
  assert.deepEqual(writes, [])
  await click(button('下发 AO2'))
  assert.deepEqual(writes, [{path: '/api/debug/analog-output', body: {channel: 2, current_ma: 8.125}}])
  assert.ok(document.body.textContent?.includes('8.125 mA'))
})
test('pressure following must explicitly stop before manual writes and never resumes automatically', async () => {
  state.enabled = true
  await render()
  assert.equal(button('下发 AO1').disabled, true)
  await click(button('切换为手动调节'))
  assert.equal(button('下发 AO1').disabled, false)
  assert.deepEqual(writes, [{path: '/api/analog-output/stop', body: {}}])
})
test('invalid range and precision block sending; valid real output needs no popup', async () => {
  await render()
  for (const value of ['', '3.999', '20.001', '4.0001']) {
    await fill(1, value)
    assert.equal(button('下发 AO1').disabled, true)
  }
  await fill(1, '12.001')
  await click(button('下发 AO1'))
  assert.deepEqual(writes, [{path:'/api/debug/analog-output',body:{channel:1,current_ma:12.001}}])
})
test('permissions, missing register and unconfirmed state disable manual output with a reason', async () => {
  await render(false)
  assert.equal(button('下发 AO1').disabled, true)
  assert.ok(document.body.textContent?.includes('需要操作员权限'))
  await act(async () => root.unmount())
  root = createRoot(document.getElementById('root')!)
  state.config.register_base = null
  await render()
  assert.equal(button('下发 AO1').disabled, true)
  assert.ok(document.body.textContent?.includes('核对输出寄存器'))
})
test('request failure explains uncertainty and does not automatically retry a write', async () => {
  await render()
  failWrite = true
  await click(button('下发 AO3'))
  assert.equal(writes.length, 1)
  assert.ok(document.body.textContent?.includes('结果未确认'))
  assert.equal(button('下发 AO4').disabled, true)
  assert.equal(button('停止模拟量输出').disabled, false)
  failWrite = false
  await click(button('停止模拟量输出'))
  assert.equal(button('下发 AO4').disabled, false)
})
test('poll failure disables writes without losing the stop entry or typed current', async () => {
  state.manual_active = true
  await render(); await fill(1, '7.123'); failRead = true
  await act(async () => {await new Promise(r => setTimeout(r, 1050))})
  assert.equal(button('下发 AO1').disabled, true)
  assert.equal(button('停止模拟量输出').disabled, false)
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="AO1 电流"]')!.value, '7.123')
})
test('duplicate clicks are blocked and stop stays available during an outstanding manual request', async () => {
  await render()
  const normal = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/debug/analog-output')) {
      writes.push({path: String(url), body: JSON.parse(String(options?.body))})
      return new Promise(resolve => {holdWrite = resolve})
    }
    return normal(url, options)
  }
  await act(async () => {button('下发 AO1').click(); button('下发 AO1').click(); await new Promise(r => setTimeout(r, 5))})
  assert.equal(writes.length, 1)
  assert.equal(button('停止模拟量输出').disabled, false)
  await click(button('停止模拟量输出'))
  assert.ok(holdWrite)
  await act(async () => {holdWrite!(new Response(JSON.stringify({...state, manual_active: true}))); await new Promise(r => setTimeout(r, 5))})
  assert.equal(document.querySelector('.panel-heading .status-chip')!.textContent, '已连接 · 待机')
})
test('a poll started before a manual command cannot overwrite its response with old idle state', async () => {
  await render()
  const normal = globalThis.fetch
  let oldPoll: ((response: Response) => void) | undefined
  const idle = JSON.stringify(state)
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'GET') return new Promise(resolve => {oldPoll = resolve})
    return normal(url, options)
  }
  await act(async () => {await new Promise(r => setTimeout(r, 1050))})
  assert.ok(oldPoll)
  await click(button('下发 AO4'))
  await act(async () => {oldPoll!(new Response(idle)); await new Promise(r => setTimeout(r, 5))})
  assert.equal(document.querySelector('.panel-heading .status-chip')!.textContent, '手动输出中')
})

test('calibration edits never write; saving only patches its own channel and preserves other drafts', async () => {
  await render()
  const one=document.querySelector<HTMLInputElement>('[aria-label="AO1 校准偏移"]')!
  const two=document.querySelector<HTMLInputElement>('[aria-label="AO2 校准偏移"]')!
  await act(async () => {
    for (const [node,value] of [[one,'-0.125'],[two,'0.100']] as const) {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value)
      node.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    }
  })
  assert.deepEqual(writes,[])
  await click(button('保存 AO1 偏移'))
  assert.deepEqual(writes,[{path:'/api/analog-output/calibration',body:{channel:1,offset_ma:-0.125}}])
  assert.equal(two.value,'0.100')
  assert.equal(button('保存 AO1 偏移').disabled,true)
  await fill(1,'12')
  assert.ok(document.querySelector('.analog-manual-card')!.textContent?.includes('预计下发 11.875mA'))
})

test('saving calibration requires stopping output and invalid precision never reaches the server', async () => {
  state.manual_active=true
  await render()
  const offset=document.querySelector<HTMLInputElement>('[aria-label="AO1 校准偏移"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(offset,'0.100')
    offset.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
  })
  assert.equal(button('保存 AO1 偏移').disabled,true)
  assert.ok(document.body.textContent?.includes('请先停止输出，再保存偏移'))
  await click(button('停止模拟量输出'))
  assert.equal(button('保存 AO1 偏移').disabled,false)
  for (const value of ['-', '16.001', '-16.001', '0.0001']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(offset,value)
      offset.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
    assert.equal(button('保存 AO1 偏移').disabled,true)
  }
  assert.equal(writes.length,1)
})

test('manual re-entry uses the nominal target without accumulating compensation and shows endpoint clipping', async () => {
  state.config.outputs[0].offset_ma=.1
  state.outputs[0]={channel:1,current_ma:12.1,target_ma:12,offset_ma:.1,status:'手动设定'}
  await render()
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="AO1 电流"]')!.value,'12')
  assert.ok(document.body.textContent?.includes('目标 12.000mA'))
  await fill(1,'20')
  assert.ok(document.querySelector('.analog-manual-card')!.textContent?.includes('预计下发 20.000mA（已限幅）'))
  assert.deepEqual(currentCommand(4,-.1),{current:4,limited:true})
  assert.deepEqual(currentCommand(12,.001),{current:12.001,limited:false})
})
