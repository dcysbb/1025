import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import type { Root } from 'react-dom/client'
import type { TerminalSystemState } from '../src/TerminalWorkbench'
const initial = new JSDOM('<div/>', { url: 'http://localhost' })
Object.assign(globalThis, { window: initial.window, document: initial.window.document })
const { createRoot } = await import('react-dom/client')
const { default: HardwarePanel } = await import('../src/HardwarePanel')
let dom: JSDOM, root: Root, container: HTMLElement
let writes: { path: string; body: Record<string, unknown> }[]
let config: Record<string, unknown>
let failure: boolean
let detectedPorts: {device:string;description:string}[]
let outputs: boolean[], system: TerminalSystemState
const stage = { config: { mode: 'real', connection: 'tcp', serial_number: '129123456', host: '101.6.241.172', port: 40303, axes: { x: 1, y: 2, z: 3 }, inverted: { x: false, y: false, z: false }, max_steps: 1000 }, connected: false, error: null, channels: [] }
beforeEach(() => {
  dom = new JSDOM('<div id="root"/>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })
  writes = []; failure = false; outputs = Array(8).fill(false); detectedPorts = []
  system = {mode:'simulation',interlock:'disarmed',valve:'closed',pressure_ok:true,adam_connected:true,history_recording:true}
  config = { mode: 'simulation', tpg_connection: 'tcp', tpg_host: '192.168.1.2', tpg_port: 8000, tpg_serial_port: 'COM3', tpg_baudrate: 9600, io_device: 'dam0808d', dam_serial_port: 'COM4', dam_baudrate: 9600, dam_unit_id: 1, adam_host: '', adam_port: 502, adam_unit_id: 1, valve_closed_di: 0, valve_open_di: null, valve_closed_active_high: true, valve_open_active_high: true, open_output: 0 }
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (options?.method && options.method !== 'GET') {
      const body = JSON.parse(String(options.body ?? '{}')); writes.push({ path, body })
      if (failure) return new Response(JSON.stringify({ detail: 'DAM 与真空规必须使用不同串口' }), { status: 422 })
      if (path === '/api/config') config = { ...config, ...body.config }
      if (path.startsWith('/api/debug/relays/')) outputs[Number(path.split('/').at(-1))] = body.enabled
    }
    const data = path.includes('/debug/relays') ? {mode:system.mode,interlock:system.interlock,outputs,valve_output:config.open_output,valve_open_on_energized:config.valve_open_on_energized??true,remaining_s:{}} : path.includes('/stage') ? stage : path.includes('/ports') ? { ports: detectedPorts } : path.includes('/hardware/status') ? { tpg: { connected: true, error: null }, io: { connected: true, error: null, inputs: Array(8).fill(false), outputs } } : { config }
    return new Response(JSON.stringify(data))
  }
  container = document.getElementById('root')!; root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); dom.window.close() })
async function render(auth = true) { await act(async () => { root.render(<HardwarePanel auth={auth} connected systemState={system}/>); await new Promise(r => setTimeout(r, 20)) }) }
function button(name: string) { const node = [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.trim() === name || x.getAttribute('aria-label') === name); assert.ok(node, name); return node }
function field(name: string) { const label = [...container.querySelectorAll('label')].find(x => !x.closest('[hidden]') && x.firstChild?.textContent === name); assert.ok(label, name); return label.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')! }
async function change(node: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value)
    node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
async function click(name: string) { await act(async () => { button(name).click(); await new Promise(r => setTimeout(r, 0)) }) }

test('opening and inspecting all terminals issues no writes', async () => {
  await render(); await click('DAM 端子')
  assert.ok(container.textContent?.includes('37 COM / 36 NO / 38 NC'))
  assert.ok(container.textContent?.includes('26、25 · 常开触点两端'))
  assert.equal(container.querySelectorAll('#hardware-terminals tbody tr').length, 18)
  assert.equal(container.querySelectorAll('.terminal-output-card').length, 8)
  assert.deepEqual(writes, [])
})

test('network failure names hardware reads, pauses writes and permits a read-only recovery', async () => {
  const original = globalThis.fetch
  let offline = true
  globalThis.fetch = async (url, options) => {
    if (offline && !String(url).includes('/stage')) throw new TypeError('Failed to fetch')
    return original(url, options)
  }
  await render()
  assert.ok(container.textContent?.includes('读取硬件连接配置失败'))
  assert.ok(container.textContent?.includes('读取真空规与 I/O 控制器状态失败'))
  assert.ok(container.textContent?.includes('设备是否在线尚未确认'))
  assert.equal(container.textContent?.includes('Failed to fetch'), false)
  assert.deepEqual(writes, [])
  offline = false
  await click('重新读取硬件配置')
  assert.equal(container.textContent?.includes('读取硬件连接配置失败'), false)
  assert.equal(button('连接真空规').disabled, false)
  assert.deepEqual(writes, [])
})
test('transport switches preserve hidden fields and saves only that device', async () => {
  await render(); await change(field('真空规连接方式'), 'usb')
  assert.equal(field('真空规串口').value, 'COM3')
  assert.equal(button('连接真空规').disabled, true)
  await change(field('真空规连接方式'), 'tcp')
  assert.equal(field('真空规 IP 地址').value, '192.168.1.2')
  await change(field('真空规 TCP 端口'), '8001'); await click('保存真空规')
  assert.deepEqual(Object.keys(writes[0].body.config as object).sort(), ['tpg_connection', 'tpg_serial_port', 'tpg_baudrate', 'tpg_host', 'tpg_port'].sort())
  assert.equal(writes.length, 1)
})
test('terminal caption edits survive tab switches and save no valve or pressure fields', async () => {
  await render(); await click('DAM 端子')
  await change(container.querySelector<HTMLInputElement>('[aria-label="OUT1 名称"]')!, '插板阀')
  await click('插板阀映射'); await click('DAM 端子')
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="OUT1 名称"]')!.value, '插板阀')
  await click('保存端子定义')
  assert.deepEqual(Object.keys(writes[0].body.config as object).sort(), ['dam_input_labels', 'dam_output_labels', 'dam_input_notes', 'dam_output_notes'].sort())
  assert.ok(container.textContent?.includes('已保存'))
})
test('independent IO connection never connects gauge or moves stage', async () => {
  await render(); await click('连接I/O')
  assert.deepEqual(writes.map(x => x.path), ['/api/devices/connect-io'])
})

test('serial suggestions load automatically and do not restrict manual connection parameters', async () => {
  detectedPorts = [{device:'COM9',description:'CP210x USB bridge'}]
  await render()
  assert.ok(container.textContent?.includes('系统识别到：COM9'))
  assert.equal(container.querySelector('datalist option')?.getAttribute('value'),'COM9')
  assert.equal(container.querySelector('input[readonly]'),null)
  await change(field('DAM 串口'),'com12')
  await change(field('DAM 波特率'),'19200')
  await change(field('DAM 设备地址'),'7')
  assert.equal(field('DAM 串口').value,'COM12')
  assert.deepEqual(writes,[])
  await click('保存I/O')
  const values=writes[0].body.config as Record<string,unknown>
  assert.equal(values.dam_serial_port,'COM12')
  assert.equal(values.dam_baudrate,19200)
  assert.equal(values.dam_unit_id,7)
  assert.deepEqual(writes.map(row=>row.path),['/api/config'])
})

test('baud menus contain device-supported rates and save numeric values independently', async () => {
  await render()
  await change(field('真空规连接方式'),'usb')
  const rates=(name:string)=>[...field(name).querySelectorAll('option')].map(option=>Number(option.value))
  assert.equal(field('真空规波特率').tagName,'SELECT')
  assert.equal(field('DAM 波特率').tagName,'SELECT')
  assert.deepEqual(rates('真空规波特率'),[9600,19200,38400,57600,115200])
  assert.deepEqual(rates('DAM 波特率'),[2400,4800,9600,19200,38400])
  await change(field('真空规波特率'),'115200')
  await change(field('真空规连接方式'),'tcp')
  await change(field('真空规连接方式'),'usb')
  assert.equal(field('真空规波特率').value,'115200')
  await change(field('DAM 波特率'),'38400')
  assert.deepEqual(writes,[])
  await click('保存I/O')
  assert.equal((writes[0].body.config as Record<string,unknown>).dam_baudrate,38400)
  assert.equal(field('真空规波特率').value,'115200')
  await click('保存真空规')
  assert.equal((writes[1].body.config as Record<string,unknown>).tpg_baudrate,115200)
  assert.deepEqual(writes.map(row=>row.path),['/api/config','/api/config'])
})

test('loaded connection drafts remain editable during a status outage while writes stay disabled', async () => {
  const original=globalThis.fetch
  globalThis.fetch=async(url,options)=>{
    if(String(url)==='/api/hardware/status') throw new TypeError('Failed to fetch')
    return original(url,options)
  }
  await render()
  assert.equal(field('DAM 串口').matches(':disabled'),false)
  await change(field('DAM 串口'),'COM12')
  assert.equal(field('DAM 串口').value,'COM12')
  assert.equal(button('保存I/O').disabled,true)
  assert.equal(button('连接I/O').disabled,true)
  assert.deepEqual(writes,[])
  await act(async()=>root.render(<HardwarePanel auth={false} connected/>))
  assert.equal(field('DAM 串口').matches(':disabled'),true)
  assert.ok(container.textContent?.includes('需要操作员权限才能修改'))
})

test('an invalid serial list reports its own error without crashing or blocking manual drafts', async () => {
  const original=globalThis.fetch
  globalThis.fetch=async(url,options)=>String(url)==='/api/hardware/ports' ? new Response(JSON.stringify({unexpected:true})) : original(url,options)
  await render()
  assert.ok(container.textContent?.includes('后台返回的列表格式异常'))
  await change(field('DAM 串口'),'COM12')
  assert.equal(button('保存I/O').disabled,false)
  assert.deepEqual(writes,[])
})
test('errors retain unsaved draft and unauthenticated controls cannot write', async () => {
  await render(); await change(field('DAM 串口'), 'COM3'); failure = true; await click('保存I/O')
  assert.equal(field('DAM 串口').value, 'COM3')
  assert.ok(container.textContent?.includes('必须使用不同串口'))
  await act(async () => root.render(<HardwarePanel auth={false} connected />))
  assert.equal(button('保存I/O').disabled, true)
  assert.equal(button('连接真空规').disabled, true)
})

function terminalSelect(label: string) { const node = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`); assert.ok(node,label); return node }
async function acknowledge() {
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(node => node.parentElement?.textContent?.includes('启用普通输出手动控制'))!
  await act(async () => { if (!input.checked) input.click() })
}

test('terminal assignments edit the actual shared valve mapping and save only mapping fields', async () => {
  await render(); await click('DAM 端子')
  await change(terminalSelect('IN2 控制功能'),'closed')
  assert.equal(terminalSelect('IN1 控制功能').value,'monitor')
  await change(terminalSelect('IN3 控制功能'),'open')
  await change(terminalSelect('IN3 反馈有效电平'),'false')
  await change(terminalSelect('OUT5 控制功能'),'valve')
  assert.deepEqual(writes,[])
  assert.equal(button('吸合 OUT2').disabled,true)
  await click('插板阀映射')
  assert.equal(field('电磁阀控制输出').value,'4')
  assert.equal(field('关闭到位输入').value,'1')
  assert.equal(field('打开到位输入').value,'2')
  await click('DAM 端子');await click('保存功能分配')
  assert.equal(writes.length,1)
  assert.equal(writes[0].path,'/api/config')
  assert.deepEqual(writes[0].body.config,{valve_closed_di:1,valve_open_di:2,open_output:4,valve_closed_active_high:true,valve_open_active_high:false,valve_open_on_energized:true})
})

test('valve polarity shares one draft across mapping and terminal menus and saves without moving', async () => {
  await render(); await click('插板阀映射')
  assert.equal(field('开关映射').value,'true')
  await change(field('开关映射'),'false')
  assert.deepEqual([...container.querySelectorAll('.valve-truth span')].map(node=>node.textContent),['关阀请求','开阀请求'])
  await click('DAM 端子')
  assert.equal(terminalSelect('OUT1 开关映射').value,'false')
  assert.equal(button('端子页打开插板阀').disabled,true)
  assert.deepEqual(writes,[])
  await click('保存功能分配')
  assert.equal((writes[0].body.config as Record<string,unknown>).valve_open_on_energized,false)
  assert.deepEqual(writes.map(row=>row.path),['/api/config'])
  assert.ok(container.textContent?.includes('吸合 → 关阀请求；释放 → 开阀请求'))
  await click('插板阀映射')
  assert.equal(field('开关映射').value,'false')
})

test('saving an unconfirmed close retains the applied config and displays the server warning', async () => {
  const original=globalThis.fetch
  globalThis.fetch=async(url,options)=>{
    const response=await original(url,options)
    if(String(url)==='/api/config'&&options?.method==='PATCH')return new Response(JSON.stringify({config,warning:'配置已保存，但关阀请求尚未确认'}))
    return response
  }
  await render();await click('插板阀映射');await change(field('开关映射'),'false');await click('保存阀门映射')
  assert.equal(field('开关映射').value,'false')
  assert.ok(container.textContent?.includes('配置已保存，但关阀请求尚未确认'))
  assert.equal(button('保存阀门映射').disabled,true)
})

test('required closed feedback and the single valve output cannot be silently unassigned', async () => {
  await render(); await click('DAM 端子')
  assert.equal(terminalSelect('IN1 控制功能').querySelector<HTMLOptionElement>('option[value=monitor]')!.disabled,true)
  assert.equal(terminalSelect('IN1 控制功能').querySelector<HTMLOptionElement>('option[value=open]')!.disabled,true)
  assert.equal(terminalSelect('OUT1 控制功能').querySelector<HTMLOptionElement>('option[value=manual]')!.disabled,true)
  await change(terminalSelect('IN2 控制功能'),'open')
  assert.equal(terminalSelect('IN2 控制功能').querySelector<HTMLOptionElement>('option[value=closed]')!.disabled,true)
  await change(terminalSelect('IN2 控制功能'),'monitor')
  await click('插板阀映射')
  assert.equal(field('打开到位输入').value,'')
  assert.deepEqual(writes,[])
})

test('ordinary output controls require acknowledgement and route one finite request to the selected relay', async () => {
  await render(); await click('DAM 端子')
  assert.equal(button('吸合 OUT2').disabled,true)
  await acknowledge()
  assert.equal(button('吸合 OUT2').disabled,false)
  await act(async () => { button('吸合 OUT2').click(); button('吸合 OUT2').click(); await new Promise(resolve=>setTimeout(resolve,0)) })
  assert.deepEqual(writes,[{path:'/api/debug/relays/1',body:{enabled:true,duration_s:0}}])
  assert.ok(container.textContent?.includes('OUT2 已读回吸合'))
  await click('释放 OUT2')
  assert.deepEqual(writes.at(-1),{path:'/api/debug/relays/1',body:{enabled:false,duration_s:0}})
  assert.ok(container.textContent?.includes('OUT2 已读回释放'))
})

test('ordinary timed output sends the selected duration and rejects an invalid duration', async () => {
  await render(); await click('DAM 端子');await acknowledge()
  const timer = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(node=>node.parentElement?.textContent?.includes('普通输出定时释放'))!
  await act(async()=>timer.click())
  const duration=container.querySelector<HTMLInputElement>('[aria-label="普通输出自动释放秒数"]')!
  await change(duration,'61')
  assert.equal(button('吸合 OUT8').disabled,true)
  await change(duration,'12');await click('吸合 OUT8')
  assert.deepEqual(writes,[{path:'/api/debug/relays/7',body:{enabled:true,duration_s:12}}])
})

test('valve output uses the protected valve APIs and never bypasses interlock with a raw relay write', async () => {
  system.interlock='armed'
  await render();await click('DAM 端子')
  assert.equal(button('端子页打开插板阀').disabled,false)
  assert.equal(button('吸合 OUT2').disabled,true)
  await click('端子页打开插板阀')
  await click('端子页关闭插板阀')
  assert.deepEqual(writes.map(write=>write.path),['/api/valve/open','/api/valve/close'])
  assert.ok(container.textContent?.includes('实际位置以到位反馈为准'))
})

test('read-only users cannot assign functions or control outputs',async()=>{
  await render(false);await click('DAM 端子')
  assert.equal(terminalSelect('IN2 控制功能').disabled,true)
  assert.equal(terminalSelect('OUT2 控制功能').disabled,true)
  assert.equal(button('吸合 OUT2').disabled,true)
  assert.equal(button('释放 OUT2').disabled,true)
  assert.equal(button('端子页关闭插板阀').disabled,true)
  assert.deepEqual(writes,[])
})

test('an unknown output result blocks further energising while release remains reachable',async()=>{
  await render();await click('DAM 端子');await acknowledge()
  const original=globalThis.fetch
  globalThis.fetch=async(url,options)=>{
    if(String(url)==='/api/debug/relays/1' && options?.method==='POST' && JSON.parse(String(options.body)).enabled)throw new TypeError('Failed to fetch')
    return original(url,options)
  }
  await click('吸合 OUT2')
  assert.ok(container.textContent?.includes('结果未确认'))
  await acknowledge()
  assert.equal(button('吸合 OUT3').disabled,true)
  assert.equal(button('释放 OUT2').disabled,false)
  await click('释放 OUT2');await acknowledge()
  assert.equal(button('吸合 OUT3').disabled,false)
})

test('release remains independent of an outstanding energise request and its older response cannot win',async()=>{
  await render();await click('DAM 端子');await acknowledge()
  const original=globalThis.fetch
  let finish:((response:Response)=>void)|undefined
  globalThis.fetch=async(url,options)=>{
    if(String(url)==='/api/debug/relays/1'&&options?.method==='POST'&&JSON.parse(String(options.body)).enabled){
      writes.push({path:String(url),body:JSON.parse(String(options.body))})
      return new Promise<Response>(resolve=>{finish=resolve})
    }
    return original(url,options)
  }
  await act(async()=>{button('吸合 OUT2').click();await new Promise(resolve=>setTimeout(resolve,0))})
  assert.equal(button('释放 OUT2').disabled,false)
  await click('释放 OUT2')
  assert.deepEqual(writes.map(row=>row.body.enabled),[true,false])
  await act(async()=>{finish!(new Response(JSON.stringify({mode:'simulation',interlock:'disarmed',valve_output:0,outputs:[false,true,...Array(6).fill(false)],remaining_s:{}})));await new Promise(resolve=>setTimeout(resolve,0))})
  const card=container.querySelectorAll('.terminal-output-card')[1]
  assert.equal(card.querySelector('.terminal-level')?.textContent,'释放')
  assert.ok(card.textContent?.includes('OUT2 已读回释放'))
})

test('a pre-command output poll cannot overwrite a confirmed relay result',async()=>{
  await render();await click('DAM 端子');await acknowledge()
  const original=globalThis.fetch
  let finish:((response:Response)=>void)|undefined,held=false
  globalThis.fetch=async(url,options)=>{
    if(String(url)==='/api/debug/relays'&&!held){held=true;return new Promise<Response>(resolve=>{finish=resolve})}
    return original(url,options)
  }
  await click('刷新输出状态')
  await click('吸合 OUT2')
  await act(async()=>{finish!(new Response(JSON.stringify({mode:'simulation',interlock:'disarmed',valve_output:0,outputs:Array(8).fill(false),remaining_s:{}})));await new Promise(resolve=>setTimeout(resolve,0))})
  assert.equal(container.querySelectorAll('.terminal-output-card')[1].querySelector('.terminal-level')?.textContent,'吸合')
  assert.equal(writes.length,1)
})
