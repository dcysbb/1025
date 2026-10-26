import React,{act} from 'react'
import {JSDOM} from 'jsdom'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import HelpTooltip from '../src/HelpTooltip'

test('help is hidden initially, opens on focus or touch click, and closes with Escape or outside input',async()=>{
  const dom=new JSDOM('<div id="root"></div><button id="outside">outside</button>',{url:'http://localhost'})
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})
  const {createRoot}=await import('react-dom/client')
  const root=createRoot(document.getElementById('root')!)
  try {
    await act(async()=>root.render(<HelpTooltip label="电流说明">计算与接线说明</HelpTooltip>))
    const trigger=document.querySelector<HTMLButtonElement>('.help-tooltip-trigger')!
    assert.equal(document.querySelector('[role=tooltip]'),null)
    await act(async()=>trigger.focus())
    assert.equal(document.querySelector('[role=tooltip]')?.textContent,'计算与接线说明')
    assert.equal(trigger.getAttribute('aria-describedby'),document.querySelector('[role=tooltip]')?.id)
    await act(async()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'})))
    assert.equal(document.querySelector('[role=tooltip]'),null)
    await act(async()=>{trigger.blur();trigger.focus();trigger.click()})
    assert.ok(document.querySelector('[role=tooltip]'))
    await act(async()=>document.getElementById('outside')!.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true})))
    assert.equal(document.querySelector('[role=tooltip]'),null)
  } finally {await act(async()=>root.unmount());dom.window.close()}
})
