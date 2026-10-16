import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Root } from 'react-dom/client'
import { Disclosure, Presence } from '../src/Motion'

const initial = new JSDOM('<!doctype html><div></div>', { url: 'http://localhost' })
Object.assign(globalThis, { window: initial.window, document: initial.window.document })
const { createRoot } = await import('react-dom/client')
let dom: JSDOM, root: Root, container: HTMLElement, reduced: boolean
let listeners: Set<() => void>
beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  reduced = false; listeners = new Set()
  window.matchMedia = (() => ({ matches: reduced, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) })) as typeof window.matchMedia
  container = document.getElementById('root')!
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); dom.window.close() })
async function render(show: boolean, text = '提示内容') {
  await act(async () => root.render(<Presence show={show}>{show && <div role="status">{text}<button>关闭</button></div>}</Presence>))
}
async function wait(ms: number) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }

test('disclosures hide interaction immediately and preserve edits through rapid reversals', async () => {
  await act(async () => root.render(<Disclosure title="详情"><input defaultValue="原始备注"/></Disclosure>))
  const button = container.querySelector('button')!
  const region = container.querySelector('.motion-reveal')!
  const input = container.querySelector('input')!
  assert.equal(button.getAttribute('aria-controls'), region.id)
  assert.equal(region.hasAttribute('inert'), true)
  for (let i = 0; i < 3; i++) {
    await act(async () => button.click())
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.equal(region.hasAttribute('inert'), false)
    input.value = '未保存备注'
    await act(async () => button.click())
    assert.equal(region.getAttribute('aria-hidden'), 'true')
    assert.equal(region.hasAttribute('inert'), true)
  }
  assert.equal(container.querySelector('input'), input)
  assert.equal(input.value, '未保存备注')
})

test('exit retains the last visible message, becomes inert immediately, then unmounts', async () => {
  await render(false)
  assert.equal(container.childElementCount, 0)
  await render(true, '已保存')
  await render(false)
  assert.equal(container.textContent, '已保存关闭')
  assert.equal(container.querySelector('.motion-presence')?.hasAttribute('inert'), true)
  assert.equal(container.querySelector('.motion-presence')?.getAttribute('aria-hidden'), 'true')
  await wait(250)
  assert.equal(container.childElementCount, 0)
})

test('reopening cancels old exit cleanup without losing the new content', async () => {
  await render(true, '旧提示')
  await render(false)
  await wait(50)
  await render(true, '新提示')
  await wait(250)
  assert.equal(container.textContent, '新提示关闭')
  assert.equal(container.querySelector('.motion-presence')?.hasAttribute('inert'), false)
})

test('reduced motion closes immediately, including a preference change during exit', async () => {
  await render(true)
  await render(false)
  await act(async () => { reduced = true; listeners.forEach(fn => fn()) })
  assert.equal(container.childElementCount, 0)
  await render(true)
  await render(false)
  assert.equal(container.childElementCount, 0)
})
