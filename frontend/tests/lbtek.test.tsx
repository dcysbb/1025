import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import type { Root } from 'react-dom/client'
import type { LbtekState } from '../src/LbtekPanel'
const initial=new JSDOM('<div/>',{url:'http://localhost'})
Object.assign(globalThis,{window:initial.window,document:initial.window.document})
const {createRoot}=await import('react-dom/client')
const {default:LbtekPanel}=await import('../src/LbtekPanel')
let dom:JSDOM, root:Root, container:HTMLElement, state:LbtekState
let writes:{path:string;body:Record<string,unknown>}[], offline:boolean
const response=()=>new Response(JSON.stringify(state))
beforeEach(()=>{
  dom=new JSDOM('<div id="root"/>',{url:'http://localhost',pretendToBeVisual:true})
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true})
  state={config:{mode:'simulation',usb_port:null,max_distance:10,names:['水平','',''],units:['mm','mm','mm']},connected:true,channels:[1,2,3].map(channel=>({channel,can_run:true,stopped:true,enabled:true,home:true,home_sensor:true,limit_left:false,limit_right:false,position:0,speed:1,acceleration:2})),error:null,stale:false,motion_pending:[],uncertain:false,busy:false,lease_id:null,rocker_enabled:false,records:[],usb_port:42}
  writes=[];offline=false
  globalThis.fetch=async(url,options)=>{
    const path=String(url),body=JSON.parse(String(options?.body??'{}'))
    if(options?.method==='POST'){
      writes.push({path,body})
      if(path.endsWith('/action'))state={...state,motion_pending:[Number(body.channel)],lease_id:body.lease_id??null}
      if(path.endsWith('/stop')||path.endsWith('/cancel'))state={...state,motion_pending:[],lease_id:null,uncertain:false}
      if(path.endsWith('/parameters'))state={...state,channels:state.channels.map(r=>r.channel===body.channel?{...r,speed:body.speed,acceleration:body.acceleration}:r)}
      if(path.endsWith('/apply-connect')){state={...state,config:{...state.config,...body.config}};return new Response(JSON.stringify({ok:true,config_saved:true,connected:true,state}))}
    }else if(offline)throw new TypeError('Failed to fetch')
    if(path.endsWith('/devices'))return new Response(JSON.stringify({ports:[42]}))
    return response()
  }
  container=document.getElementById('root')!;root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());dom.window.close()})
async function render(configuration=false,auth=true){await act(async()=>{root.render(<LbtekPanel auth={auth} connected configuration={configuration}/>);await new Promise(r=>setTimeout(r,10))})}
function button(name:string){const b=[...container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.getAttribute('aria-label')===name||b.textContent?.trim()===name);assert.ok(b,name);return b}
function field(name:string){const e=container.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)??[...container.querySelectorAll('label')].find(l=>l.firstChild?.textContent===name)?.querySelector('input,select');assert.ok(e,name);return e as HTMLInputElement}
async function change(node:HTMLInputElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}))})}
async function click(name:string){await act(async()=>{button(name).click();await new Promise(r=>setTimeout(r,0))})}
async function pointer(node:HTMLElement,event:string){await act(async()=>{node.dispatchEvent(new dom.window.MouseEvent(event,{bubbles:true,button:0}));await new Promise(r=>setTimeout(r,0))})}
async function wait(ms:number){await act(async()=>{await new Promise(r=>setTimeout(r,ms))})}

test('three physical channel cards mount read-only and name stays with channel',async()=>{
  await render()
  assert.equal(container.querySelectorAll('.lbtek-axis').length,3)
  assert.match(container.querySelector('[aria-label="LBTEK CH1 控制"]')!.textContent!,/水平/)
  assert.ok(container.textContent?.includes('开环坐标'))
  assert.deepEqual(writes,[])
})
test('independent step submits once to the selected channel',async()=>{
  await render()
  await change(field('CH2 单次位移（mm）'),'.2')
  await click('CH2 负向移动')
  assert.equal(writes.length,1)
  assert.deepEqual(writes[0],{path:'/api/lbtek-stage/action',body:{channel:2,operation:'relative',value:-.2}})
  assert.equal(field('CH1 单次位移（mm）').value,'0.01')
  assert.equal(button('CH2 正向移动').disabled,true)
  await click('CH2 正向移动')
  assert.equal(writes.length,1)
})
test('oversized and empty step block submission but leave stop available',async()=>{
  await render();await change(field('CH1 单次位移（mm）'),'11')
  assert.equal(button('CH1 正向移动').disabled,true)
  assert.match(container.textContent!,/单次位移上限 10 mm/)
  assert.equal(button('全部停止').disabled,false)
  await change(field('CH1 单次位移（mm）'),'')
  assert.equal(button('CH1 正向移动').disabled,true)
  assert.deepEqual(writes,[])
})
test('short press uses a single finite relative movement',async()=>{
  await render()
  await pointer(button('CH1 正向移动'),'pointerdown')
  await pointer(button('CH1 正向移动'),'pointerup')
  assert.equal(writes.filter(w=>w.path.endsWith('/action')).length,1)
  assert.equal(writes[0].body.operation,'relative')
  await wait(210)
  assert.equal(writes.length,1)
})
test('held button remains releasable during pending movement and stops on release',async()=>{
  await render()
  const plus=button('CH1 正向移动')
  await pointer(plus,'pointerdown');await wait(210)
  assert.equal(writes[0].body.operation,'drive')
  assert.equal(plus.disabled,false)
  await pointer(plus,'pointerup')
  assert.ok(writes.some(w=>w.path.endsWith('/stop')))
  const count=writes.length;await wait(300)
  assert.equal(writes.length,count)
})
test('release before delayed start response cannot restart keepalive',async()=>{
  const original=globalThis.fetch
  let resolve:((response:Response)=>void)|undefined
  globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith('/action')){
      writes.push({path:String(url),body:JSON.parse(String(options?.body))})
      return new Promise<Response>(r=>{resolve=r})
    }
    return original(url,options)
  }
  await render();const plus=button('CH1 正向移动')
  await pointer(plus,'pointerdown');await wait(210)
  await pointer(plus,'pointerup')
  assert.equal(writes[1].path,'/api/lbtek-stage/stop')
  await act(async()=>{resolve!(response());await new Promise(r=>setTimeout(r,0))})
  await wait(300)
  assert.equal(writes.filter(w=>w.path.endsWith('/keepalive')).length,0)
  assert.equal(button('CH1 正向移动').disabled,false)
})
test('blur cancels a held movement and permission revocation cancels pending hold',async()=>{
  await render();await pointer(button('CH3 负向移动'),'pointerdown');await wait(210)
  await act(async()=>window.dispatchEvent(new dom.window.Event('blur')))
  assert.equal(writes.at(-1)?.path,'/api/lbtek-stage/stop')
  writes=[];await pointer(button('CH2 正向移动'),'pointerdown');await render(false,false);await wait(210)
  assert.deepEqual(writes,[])
})
test('parameter drafts survive polling and only explicit apply changes hardware',async()=>{
  await render();await change(field('CH2 速度'),'.5')
  state={...state,channels:state.channels.map(r=>({...r,speed:2}))}
  await wait(550)
  assert.equal(field('CH2 速度').value,'.5')
  assert.deepEqual(writes,[])
  await click('应用 CH2 参数')
  assert.deepEqual(writes[0],{path:'/api/lbtek-stage/parameters',body:{channel:2,speed:.5,acceleration:2}})
  assert.equal(field('CH2 速度').value,'0.5')
})
test('configuration remains editable while connected and applies only changed fields',async()=>{
  await render(true)
  await change(field('LBTEK 单次位移上限'),'5')
  await click('刷新 LBTEK 设备')
  await change(field('LBTEK USB 设备'),'42')
  assert.equal(field('LBTEK USB 设备').disabled,false)
  await click('应用并重新连接 LBTEK')
  assert.deepEqual(writes[0],{path:'/api/devices/lbtek/apply-connect',body:{config:{usb_port:42,max_distance:5}}})
})
test('loss of polling disables movement and error describes backend failure',async()=>{
  await render();offline=true;await wait(550)
  assert.equal(button('CH1 正向移动').disabled,true)
  assert.equal(button('全部停止').disabled,false)
  assert.ok(container.textContent?.includes('状态已过期'))
  assert.equal(container.textContent?.includes('Failed to fetch'),false)
})
test('home targets its own physical channel, rocker and unconfirmed state gate movement',async()=>{
  await render();await click('CH3 回零')
  assert.deepEqual(writes[0].body,{channel:3,operation:'home'})
  state={...state,uncertain:true};await wait(550)
  assert.equal(button('CH1 正向移动').disabled,true)
  assert.equal(button('全部停止并恢复').disabled,false)
})

test('custom quick values persist per channel without touching hardware',async()=>{
  await render()
  await change(field('CH1 快捷 2'),'.025')
  const card=container.querySelector('[aria-label="LBTEK CH1 控制"]')!
  const quick=[...card.querySelectorAll<HTMLButtonElement>('.lbtek-presets button')].find(b=>b.textContent==='.025')!
  await act(async()=>quick.click())
  assert.equal(field('CH1 单次位移（mm）').value,'.025')
  assert.equal(field('CH2 单次位移（mm）').value,'0.01')
  assert.match(localStorage.getItem('lbtek-step:simulation:auto:1:mm:presets')!,/.025/)
  assert.deepEqual(writes,[])
})

test('a poll issued before a move cannot overwrite pending motion',async()=>{
  const original=globalThis.fetch
  let delayed=false,resolve:((response:Response)=>void)|undefined
  globalThis.fetch=async(url,options)=>{
    if(delayed&&(!options?.method||options.method==='GET')&&String(url)==='/api/lbtek-stage'){
      const stale=JSON.stringify(state);delayed=false
      return new Promise<Response>(r=>{resolve=()=>r(new Response(stale))})
    }
    return original(url,options)
  }
  await render();delayed=true;await wait(550)
  assert.ok(resolve)
  await click('CH1 正向移动')
  await act(async()=>{resolve!(response());await new Promise(r=>setTimeout(r,0))})
  assert.equal(button('CH1 正向移动').disabled,true)
})

test('unsuccessful parameter writes retain the input draft',async()=>{
  const original=globalThis.fetch
  globalThis.fetch=async(url,options)=>String(url).endsWith('/parameters')?new Response(JSON.stringify({detail:'控制器拒绝速度范围'}),{status:409}):original(url,options)
  await render();await change(field('CH1 速度'),'123')
  await click('应用 CH1 参数');await wait(550)
  assert.equal(field('CH1 速度').value,'123')
  assert.match(container.textContent!,/控制器拒绝速度范围/)
})
