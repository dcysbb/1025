import React, {act} from 'react'
import {JSDOM} from 'jsdom'
import {beforeEach,afterEach,test} from 'node:test'
import assert from 'node:assert/strict'
import type {Root} from 'react-dom/client'
import Chart from '../src/Chart'
import {nearestPoint,timeRange,type Point} from '../src/chartData'
import {axisTime,linearExponent,linearTicks,logTicks,scientificParts,timeTicks} from '../src/chartAxes'

const initialDom=new JSDOM('<!doctype html><div/>',{url:'http://localhost'})
Object.assign(globalThis,{window:initialDom.window,document:initialDom.window.document})
const {createRoot}=await import('react-dom/client')
let dom:JSDOM,root:Root,container:HTMLElement
const base=Date.parse('2026-10-13T00:00:00Z')
const points:Point[]=Array.from({length:101},(_,i)=>({timestamp:new Date(base+i*1000).toISOString(),channels:[{channel:4,pressure_pa:i===0?1e-2:1e-6,valid:i!==51}]}))
beforeEach(async()=>{
  dom=new JSDOM('<!doctype html><div id="root"/>',{url:'http://localhost'})
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true})
  container=document.getElementById('root')!
  root=createRoot(container)
  await act(async()=>root.render(<Chart points={points} channels={[4]} unit="Pa"/>))
})
afterEach(async()=>{await act(async()=>root.unmount());dom.window.close()})
function button(text:string){const b=[...container.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b);return b}
async function click(text:string){await act(async()=>button(text).click())}
async function input(label:string,value:string){const el=container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})}
async function submit(){await act(async()=>container.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})))}
function axis(){const svg=container.querySelector('svg.trend-chart')!;return [Number(svg.getAttribute('data-y-min')),Number(svg.getAttribute('data-y-max'))]}

test('manual y range applies, rejects inverted bounds, and returns to auto',async()=>{
  assert.deepEqual(axis(),[1e-6,1e-2])
  await input('纵轴下限','2e-7');await input('纵轴上限','4e-3');await submit()
  assert.deepEqual(axis(),[2e-7,4e-3])
  await input('纵轴上限','1e-8');await submit()
  assert.ok(container.querySelector('[role="alert"]'))
  assert.deepEqual(axis(),[2e-7,4e-3])
  await click('自动纵轴');assert.deepEqual(axis(),[1e-6,1e-2])
})
test('auto y follows visible samples after time zoom',async()=>{
  await click('放大')
  assert.equal(axis()[0],1e-6)
  assert.ok(Math.abs(axis()[1]-1e-5)<1e-15)
  await click('完整范围');assert.deepEqual(axis(),[1e-6,1e-2])
})
test('hover shows original sample and marks an invalid reading',async()=>{
  const svg=container.querySelector<SVGSVGElement>('svg.trend-chart')!
  svg.getBoundingClientRect=()=>({left:0,width:980,top:0,height:350,right:980,bottom:350,x:0,y:0,toJSON(){}})
  await act(async()=>svg.dispatchEvent(new dom.window.MouseEvent('pointermove',{bubbles:true,clientX:86+.5*872})))
  assert.ok(container.querySelector('[role="tooltip"]')?.textContent?.includes('1.00e-6 Pa'))
  await act(async()=>svg.dispatchEvent(new dom.window.MouseEvent('pointermove',{bubbles:true,clientX:86+.51*872})))
  assert.ok(container.querySelector('[role="tooltip"]')?.textContent?.includes('无有效数据'))
})
test('manual limits use selected units and remain physical values when unit changes',async()=>{
  await act(async()=>root.render(<Chart points={points} channels={[4]} unit="mbar"/>))
  await input('纵轴下限','1e-8');await input('纵轴上限','1e-4');await submit()
  assert.deepEqual(axis(),[1e-6,1e-2])
  await act(async()=>root.render(<Chart points={points} channels={[4]} unit="Pa"/>))
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="纵轴上限"]')?.value,'1.00e-2')
})
test('nearest search uses original timestamps and bounded pan preserves span',()=>{
  assert.equal(nearestPoint(points,points.map(p=>Date.parse(p.timestamp)),base+50200,base,base+100000),points[50])
  assert.deepEqual(timeRange([-20,20],0,100),[0,40])
  assert.deepEqual(timeRange([80,120],0,100),[60,100])
})
test('fault event lines are hidden by default and shown only when requested',async()=>{
  const events=Array.from({length:80},(_,i)=>({id:i,timestamp:new Date(base+i*1000).toISOString(),severity:'critical',type:'io_error',message:'通信故障'}))
  await act(async()=>root.render(<Chart points={points} channels={[4]} unit="Pa" events={events}/>))
  assert.equal(container.querySelectorAll('[data-event-marker]').length,0)
  const checkbox=container.querySelector<HTMLInputElement>('.chart-event-toggle input')!
  await act(async()=>checkbox.click())
  assert.equal(container.querySelectorAll('[data-event-marker]').length,80)
  await act(async()=>checkbox.click())
  assert.equal(container.querySelectorAll('[data-event-marker]').length,0)
})

test('log axis uses whole decades and bounds tick density over wide pressure ranges',()=>{
  assert.deepEqual(logTicks(1e-7,1e-3),[1e-7,1e-6,1e-5,1e-4,1e-3])
  const wide=logTicks(1e-12,1e3)
  assert.ok(wide.length<=7)
  assert.ok(wide.every(n=>Math.abs(Math.log10(n)-Math.round(Math.log10(n)))<1e-10))
  assert.deepEqual(logTicks(2e-7,4e-7),[2e-7,3e-7,4e-7])
  const narrow=logTicks(2.11e-7,2.19e-7)
  assert.ok(narrow.length>=2&&narrow.every(n=>n>=2.11e-7&&n<=2.19e-7))
})

test('linear ticks use readable increments and one shared scientific exponent',()=>{
  assert.deepEqual(linearTicks(0,9.8e-6,6),[0,2e-6,4e-6,6e-6,8e-6])
  assert.equal(linearExponent(0,9.8e-6),-6)
  assert.equal(linearExponent(0,98),0)
  assert.deepEqual(scientificParts(1e-7),{coefficient:'1',exponent:-7})
  assert.deepEqual(scientificParts(2.5e-6),{coefficient:'2.5',exponent:-6})
})

test('time ticks use local clock intervals and fewer labels on narrow plots',()=>{
  const end=base+86400000
  const wide=timeTicks(base,end,1000),narrow=timeTicks(base,end,240)
  assert.ok(wide.length>narrow.length&&narrow.length<=3)
  assert.ok(wide.every(n=>n>=base&&n<=end&&n%3600000===0))
  assert.deepEqual(axisTime(base,86400000),['08:00','10/13'])
  const days=timeTicks(base,base+8*86400000,800)
  assert.ok(days.every(n=>(n+8*3600000)%86400000===0))
})

test('Torr auto bounds and rendered major ticks align to the displayed unit',async()=>{
  await act(async()=>root.render(<Chart points={points} channels={[4]} unit="Torr"/>))
  const ticks=[...container.querySelectorAll('[data-y-tick]')].map(n=>Number(n.getAttribute('data-y-tick')))
  assert.deepEqual(ticks,[1e-9,1e-8,1e-7,1e-6,1e-5,1e-4])
  assert.ok(container.querySelector('.chart-axis-title')?.textContent?.includes('Torr'))
  assert.ok([...container.querySelectorAll('.chart-axis--y tspan')].every(n=>n.getAttribute('baseline-shift')==='super'))
})

test('responsive chart changes its coordinates without scaling the CSS pixel height',async()=>{
  let onResize:ResizeObserverCallback|undefined,disconnected=false
  const prior=globalThis.ResizeObserver
  globalThis.ResizeObserver=class {
    constructor(callback:ResizeObserverCallback){onResize=callback}
    observe(){}
    unobserve(){}
    disconnect(){disconnected=true}
  } as unknown as typeof ResizeObserver
  try{
    await act(async()=>root.unmount())
    root=createRoot(container)
    await act(async()=>root.render(<Chart points={points} channels={[4]} unit="Pa"/>))
    await act(async()=>onResize!([{contentRect:{width:328}}] as ResizeObserverEntry[],{} as ResizeObserver))
    assert.equal(container.querySelector('.trend-chart')?.getAttribute('viewBox'),'0 0 328 340')
    assert.ok(container.querySelectorAll('[data-time-tick]').length<=3)
    await act(async()=>root.unmount())
    assert.equal(disconnected,true)
    root=createRoot(container)
  }finally{
    if(prior)globalThis.ResizeObserver=prior
    else Reflect.deleteProperty(globalThis,'ResizeObserver')
  }
})
