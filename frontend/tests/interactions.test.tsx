import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { domain, reducePoints, type Point } from '../src/chartData'

const initialDom=new JSDOM('<!doctype html><div></div>',{url:'http://localhost'})
Object.assign(globalThis,{window:initialDom.window,document:initialDom.window.document})
const {createRoot}=await import('react-dom/client')

let dom:JSDOM, root:Root, container:HTMLElement
let offline=false
let resetCalls:Array<{scope:string}>=[]
let resetFailure=false
const status={timestamp:new Date().toISOString(),mode:'simulation',interlock:'disarmed',interlock_label:'未启用',valve:'closed',valve_closed_sensor:true,tpg_connected:true,adam_connected:true,permit_ok:true,history_recording:true,channels:[]}
const config={io_device:'dam0808d',dam_serial_port:'',dam_baudrate:9600,dam_unit_id:1,external_watchdog_confirmed:false,mode:'simulation',tpg_connection:'tcp',tpg_serial_port:'',tpg_baudrate:9600,tpg_host:'',tpg_port:8000,adam_host:'',adam_port:502,adam_unit_id:1,sample_interval_s:1,stale_timeout_s:1,valve_timeout_s:2,recovery_hold_s:5,history_retention_days:null,allow_lan:false,valve_closed_di:0,valve_open_di:null,valve_closed_active_high:true,valve_open_active_high:true,permit_ok_di:1,permit_ok_active_high:true,watchdog_ok_di:2,watchdog_ok_active_high:true,latch_ready_di:3,latch_ready_active_high:true,air_ok_di:null,air_ok_active_high:true,open_output:0,heartbeat_output:1,reset_output:2,fail_closed_confirmed:false,channels:Array.from({length:6},()=>({enabled:false,label:'',trip_pa:null,reset_pa:null}))}
class Socket {
  static instances:Socket[]=[]
  onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null
  constructor(){Socket.instances.push(this)}
  close(){}
}
beforeEach(async()=>{
  offline=false;resetCalls=[];resetFailure=false;Socket.instances=[]
  dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost'})
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,location:dom.window.location,Event:dom.window.Event,WebSocket:Socket,IS_REACT_ACT_ENVIRONMENT:true})
  Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true})
  globalThis.fetch=async(url,options)=>{
    if(offline)throw new Error('offline')
    const path=String(url)
    if(path.endsWith('/history/reset')){
      assert.equal(options?.method,'POST')
      resetCalls.push(JSON.parse(String(options?.body)))
      return new Response(JSON.stringify(resetFailure?{detail:'历史重置失败'}:{ok:true,deleted:6}),{status:resetFailure?503:200,headers:{'Content-Type':'application/json'}})
    }
    const data=path.includes('/auth/status')?{configured:true,authenticated:true,local:true}:path.includes('/config')?{config}:path.includes('/events')?{events:[],has_more:false}:path.includes('/history')?{rows:[],count:0,truncated:false}:status
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
  }
  container=document.getElementById('root')!
  root=createRoot(container)
  await act(async()=>{root.render(<App/>);await new Promise(r=>setTimeout(r,20))})
})
afterEach(async()=>{await act(async()=>root.unmount());dom.window.close()})
function byLabel(label:string){const node=container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);assert.ok(node,`Missing control: ${label}`);return node}
function byText(text:string){const node=[...container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text||b.querySelector('b')?.textContent?.trim()===text);assert.ok(node,`Missing button: ${text}`);return node}
async function click(button:HTMLElement){await act(async()=>{button.click();await new Promise(r=>setTimeout(r,0))})}

test('navigation can repeatedly collapse and expand with reachable controls',async()=>{
  for(let i=0;i<3;i++){
    await click(byLabel('折叠导航'))
    assert.ok(container.querySelector('.app-shell--collapsed'))
    assert.equal(byLabel('展开导航').getAttribute('aria-expanded'),'false')
    await click(byLabel('展开导航'))
    assert.equal(container.querySelector('.app-shell--collapsed'),null)
  }
})
test('event pane can expand and collapse independently of navigation',async()=>{
  await click(byLabel('折叠导航'))
  await click(byLabel('收起事件栏'))
  assert.ok(container.querySelector('.app-shell--events-closed'))
  assert.equal(container.querySelector('.aside-events'),null)
  await click(byLabel('展开事件栏'))
  assert.ok(container.querySelector('.aside-events'))
  assert.ok(container.querySelector('.app-shell--collapsed'))
})
test('sidebar preference survives a new component mount',async()=>{
  await click(byLabel('折叠导航'))
  assert.equal(localStorage.getItem('vacuum-sidebar'),'closed')
  await act(async()=>{root.unmount();root=createRoot(container);root.render(<App/>);await new Promise(r=>setTimeout(r,10))})
  assert.ok(container.querySelector('.app-shell--collapsed'))
})
test('backend disconnect is visible and disables valve controls',async()=>{
  await click(byText('联锁控制'))
  await act(async()=>{offline=true;Socket.instances.at(-1)!.onclose?.()})
  assert.ok(container.textContent?.includes('后台断连'))
  assert.equal(byText('关闭插板阀').disabled,true)
  assert.ok(container.querySelector('[role="alert"]'))
})
test('login dialog can close with Escape and explicit close control',async()=>{
  await act(async()=>window.dispatchEvent(new Event('auth-needed')))
  assert.ok(container.querySelector('[role="dialog"]'))
  await click(byLabel('关闭登录窗口'))
  assert.equal(container.querySelector('[role="dialog"]'),null)
  await act(async()=>window.dispatchEvent(new Event('auth-needed')))
  await act(async()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'})))
  assert.equal(container.querySelector('[role="dialog"]'),null)
})
test('history rejects an empty channel selection without retaining export',async()=>{
  await click(byText('历史数据'))
  const inputs=container.querySelectorAll<HTMLInputElement>('.channel-filter input')
  await act(async()=>{inputs.forEach(x=>x.click());await new Promise(r=>setTimeout(r,0))})
  await click(byText('查询数据'))
  const link=container.querySelector('a')
  assert.equal(link?.getAttribute('href'),null)
  assert.ok(container.textContent?.includes('至少一个通道'))
})
test('all five pages render without exceptions',async()=>{
  for(const label of ['设置','事件日志','历史数据','联锁控制','总览']){
    await click(byText(label))
    assert.ok(container.querySelector('h1'))
  }
})
test('USB connection fields and gauge-only action are available in real mode',async()=>{
  await click(byText('设置'));await click(byText('真实设备'))
  const select=[...container.querySelectorAll<HTMLSelectElement>('select')].find(x=>x.querySelector('option[value="usb"]'))!
  await act(async()=>{select.value='usb';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
  assert.ok(container.querySelector('input[placeholder="COM3"]'))
  assert.ok(container.textContent?.includes('USB 波特率'))
  assert.ok(byText('仅连接真空规'))
})
test('DAM serial settings expose eight channels and independent watchdog confirmation',async()=>{
  await click(byText('设置'))
  assert.ok(container.querySelector('input[placeholder="例如 COM4（须区别于真空规）"]'))
  const inputs=[...container.querySelectorAll<HTMLInputElement>('input[type="number"]')]
  assert.ok(inputs.some(x=>x.max==='7'))
  assert.ok(container.textContent?.includes('DAM 不输出高频机械心跳'))
  assert.ok(container.querySelector('select option[value="dam0808d"]'))
})
test('large histories preserve spikes, troughs and invalid gaps',()=>{
  const points:Point[]=Array.from({length:100000},(_,i)=>({timestamp:new Date(i*1000).toISOString(),channels:[{channel:4,pressure_pa:i===55555?1:i===33333?1e-9:.01,valid:i!==44444}]}))
  const reduced=reducePoints(points)
  assert.ok(reduced.length<2000)
  assert.ok(reduced.some(p=>p.channels[0].pressure_pa===1))
  assert.ok(reduced.some(p=>p.channels[0].pressure_pa===1e-9))
  assert.ok(reduced.some(p=>!p.channels[0].valid))
  assert.deepEqual(domain(points,[4]),[-9,0])
})

test('history reset defaults to simulation and cancellation sends no request',async()=>{
  await click(byText('历史数据'));await click(byText('重置历史'))
  assert.ok(container.querySelector('[aria-labelledby="history-reset-title"]'))
  const select=container.querySelector<HTMLSelectElement>('[aria-labelledby="history-reset-title"] select')!
  assert.equal(select.value,'simulation')
  await click(byText('取消'))
  assert.equal(resetCalls.length,0)
  await click(byText('重置历史'));await click(byText('确认重置'))
  assert.deepEqual(resetCalls,[{scope:'simulation'}])
  assert.equal(container.querySelector('[aria-labelledby="history-reset-title"]'),null)
  assert.ok(container.textContent?.includes('已清除 6 条模拟记录'))
  assert.ok(container.textContent?.includes('0 条'))
})

test('all history reset is an explicit choice and failure keeps the dialog open',async()=>{
  resetFailure=true
  await click(byText('历史数据'));await click(byText('重置历史'))
  const select=container.querySelector<HTMLSelectElement>('[aria-labelledby="history-reset-title"] select')!
  await act(async()=>{select.value='all';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
  await click(byText('确认重置'))
  assert.deepEqual(resetCalls,[{scope:'all'}])
  assert.ok(container.querySelector('[aria-labelledby="history-reset-title"]'))
  assert.ok(container.textContent?.includes('历史重置失败'))
})
