import React, {act} from 'react'
import {JSDOM} from 'jsdom'
import {afterEach, beforeEach, test} from 'node:test'
import assert from 'node:assert/strict'
import type {Root} from 'react-dom/client'
import AnalogOutputPanel from '../src/AnalogOutputPanel'

const initial = new JSDOM('<div/>', {url: 'http://localhost'})
Object.assign(globalThis, {window: initial.window, document: initial.window.document})
const {createRoot} = await import('react-dom/client')
let dom: JSDOM, root: Root, writes: {path: string; body: unknown}[], dirty: boolean
let state: {config: Record<string, unknown>; connected: boolean; enabled: boolean; unconfirmed: boolean; error: null; outputs: unknown[]}
const changed = (value: boolean) => {dirty = value}
beforeEach(() => {
  dom = new JSDOM('<div id="root"/>', {url: 'http://localhost'})
  Object.assign(globalThis, {window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true})
  root = createRoot(document.getElementById('root')!)
  writes = []; dirty = false
  state = {config: {mode: 'real', host: '', port: 8234, unit_id: 1, register_base: null, current_output_confirmed: false, update_interval_s: 0.5,
    outputs: Array.from({length: 4}, () => ({enabled: false, label: '', source_channel: 4, pressure_4ma_pa: null, pressure_20ma_pa: null, scale: 'log', fault_ma: 20}))},
    connected: false, enabled: false, unconfirmed: false, error: null, outputs: []}
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (options?.method !== 'GET') {
      const body = JSON.parse(String(options?.body))
      writes.push({path, body})
      if (path.endsWith('/config')) {
        const {outputs,...fields}=body
        Object.assign(state.config,fields)
        if(outputs) for(const {channel,...fields} of outputs) Object.assign((state.config.outputs as object[])[channel-1],fields)
      }
      if(path.endsWith('/apply-connect')) {Object.assign(state.config,body.config);state.connected=true;return new Response(JSON.stringify({ok:true,config_saved:true,connected:true,phase:'complete',state}))}
      if (path.endsWith('/connect')) state.connected = true
      if (path.endsWith('/enable')) state.enabled = true
    }
    return new Response(JSON.stringify(state))
  }
})
afterEach(async () => {await act(async () => root.unmount()); dom.window.close()})
async function render(auth = true) {await act(async () => {root.render(<AnalogOutputPanel auth={auth} connected onDirtyChange={changed}/>); await new Promise(r => setTimeout(r, 5))})}
function button(label: string) {const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label); assert.ok(found, label); return found}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`) ?? [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.trim() === label)?.querySelector('input')
  assert.ok(input, label)
  await act(async () => {Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', {bubbles: true}))})
}
test('opening analog settings enumerates mappings and never connects or enables', async () => {
  await render()
  assert.equal(document.querySelectorAll('.analog-mapping').length, 4)
  assert.ok(document.body.textContent?.includes('输出寄存器尚未设置'))
  assert.equal(button('开始实时输出').disabled, true)
  assert.deepEqual(writes, [])
})
test('saving analog settings has its own endpoint and never enables output', async () => {
  await render(); await fill('AO1 校准偏移', '0.125')
  assert.equal(dirty, true)
  await act(async () => {button('保存模拟量设置').click(); await new Promise(r => setTimeout(r, 5))})
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/analog-output/config')
  assert.equal(dirty, false)
})
test('connect is independent and does not send an enable or current command', async () => {
  await render()
  await act(async () => {button('应用并连接模拟量模块').click(); await new Promise(r => setTimeout(r, 5))})
  assert.deepEqual(writes, [{path: '/api/devices/analog/apply-connect', body: {config:{}}}])
  assert.equal(button('开始实时输出').disabled, true)
})
test('read-only users cannot save, connect or enable output', async () => {
  await render(false)
  assert.equal(button('保存模拟量设置').disabled, true)
  assert.equal(button('应用并连接模拟量模块').disabled, true)
  assert.equal(button('开始实时输出').disabled, true)
})

test('pressure endpoints preserve partially typed scientific notation', async () => {
  await render()
  const input = document.querySelector<HTMLInputElement>('[aria-label="AO1 4mA 对应压力"]')!
  for (const value of ['1', '1e', '1e-', '1e-6']) {
    await act(async () => {Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', {bubbles: true}))})
    assert.equal(input.value, value)
  }
})

test('hardware settings show manual output and require stopping it before changing mapping or starting pressure following', async () => {
  Object.assign(state, {connected: true, manual_active: true})
  state.config.register_base = 10; state.config.current_output_confirmed = true
  await render()
  assert.ok(document.body.textContent?.includes('手动输出中'))
  assert.equal(button('开始实时输出').disabled, true)
  assert.equal(button('停止实时输出').disabled, false)
  assert.equal(document.querySelector<HTMLFieldSetElement>('.analog-mapping')!.disabled, true)
})

test('hardware settings preserve signed calibration input and reject invalid precision before saving', async () => {
  await render()
  const input=document.querySelector<HTMLInputElement>('[aria-label="AO3 校准偏移"]')!
  for (const value of ['-', '0.0001', '17']) {
    await act(async () => {Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
    assert.equal(input.value,value)
    assert.equal(button('保存模拟量设置').disabled,true)
  }
  await act(async () => {Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'-0.125');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
  await act(async () => {button('保存模拟量设置').click();await new Promise(r=>setTimeout(r,5))})
  assert.equal((writes[0].body as {outputs:{offset_ma:string}[]}).outputs[0].offset_ma,'-0.125')
})


function ready() {
  state.connected=true
  Object.assign(state.config,{register_base:10,current_output_confirmed:true,outputs:Array.from({length:4},()=>({enabled:true,label:'',source_channel:1,pressure_4ma_pa:100000,pressure_20ma_pa:0,scale:'linear',fault_ma:20,offset_ma:0}))})
}
test('start output automatically saves edited mapping before enabling and blocks duplicate clicks', async () => {
  ready(); await render(); await fill('AO1 校准偏移','0.125')
  assert.equal(button('开始实时输出').disabled,false)
  await act(async () => {button('开始实时输出').click();button('开始实时输出').click();await new Promise(r=>setTimeout(r,5))})
  assert.deepEqual(writes.map(row=>row.path),['/api/analog-output/config','/api/analog-output/enable'])
  assert.equal((writes[0].body as {outputs:{offset_ma:string}[]}).outputs[0].offset_ma,'0.125')
  assert.equal(dirty,false)
})
test('save rejection prevents output and retains the edited draft', async () => {
  ready();await render();await fill('AO1 校准偏移','0.125')
  globalThis.fetch=async (url,options)=>{
    if (options?.method==='GET') return new Response(JSON.stringify(state))
    writes.push({path:String(url),body:JSON.parse(String(options?.body))})
    return new Response(JSON.stringify({detail:'配置保存失败'}),{status:409})
  }
  await act(async()=>{button('开始实时输出').click();await new Promise(r=>setTimeout(r,5))})
  assert.deepEqual(writes.map(row=>row.path),['/api/analog-output/config'])
  assert.equal(dirty,true)
  assert.ok(document.body.textContent?.includes('配置保存失败'))
})
test('stop during automatic save cancels the subsequent enable', async () => {
  ready();await render();await fill('AO1 校准偏移','0.125')
  const normal=globalThis.fetch
  let finish:((response:Response)=>void)|undefined
  globalThis.fetch=async (url,options)=>{
    if (String(url).endsWith('/config')) {
      writes.push({path:String(url),body:JSON.parse(String(options?.body))})
      return new Promise(resolve=>{finish=resolve})
    }
    return normal(url,options)
  }
  await act(async()=>{button('开始实时输出').click();await new Promise(r=>setTimeout(r,5))})
  assert.equal(button('停止实时输出').disabled,false)
  await act(async()=>{button('停止实时输出').click();await new Promise(r=>setTimeout(r,5))})
  await act(async()=>{finish!(new Response(JSON.stringify(state)));await new Promise(r=>setTimeout(r,5))})
  assert.deepEqual(writes.map(row=>row.path),['/api/analog-output/config','/api/analog-output/stop'])
  assert.equal(state.enabled,false)
})
