import React, {act} from 'react'
import {JSDOM} from 'jsdom'
import {afterEach, beforeEach, test} from 'node:test'
import assert from 'node:assert/strict'
import type {Root} from 'react-dom/client'
import SystemMenu from '../src/SystemMenu'

const initial = new JSDOM('<div/>', {url: 'http://localhost'})
Object.assign(globalThis, {window: initial.window, document: initial.window.document})
const {createRoot} = await import('react-dom/client')
let dom: JSDOM, root: Root, writes: unknown[], phases: string[], fail: boolean
let info = {version: '0.2.0', revision: '1234abc', built_at: '2026-10-23T06:00:00Z', instance_id: 'old', can_manage: true, unavailable_reason: '', pending: null}
const changed = (state: string) => {phases.push(state)}
beforeEach(() => {
  dom = new JSDOM('<div id="root"/>', {url: 'http://localhost'})
  Object.assign(globalThis, {window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true})
  root = createRoot(document.getElementById('root')!)
  writes = []; phases = []; fail = false
  info = {...info, instance_id: 'old', can_manage: true}
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      writes.push(JSON.parse(String(options.body)))
      return new Response(JSON.stringify(fail ? {detail: '输出关闭未确认'} : {accepted: true}), {status: fail ? 409 : 200})
    }
    return new Response(JSON.stringify(info))
  }
})
afterEach(async () => {await act(async () => root.unmount()); dom.window.close()})
async function render(local = true) {await act(async () => {root.render(<SystemMenu auth local={local} connected dirty={false} onStateChange={changed}/>); await new Promise(r => setTimeout(r, 5))})}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
  assert.ok(found, label); return found
}
async function click(label: string) {await act(async () => {button(label).click(); await new Promise(r => setTimeout(r, 5))})}

test('version and Beijing build time are visible without a control request', async () => {
  await render()
  assert.ok(document.body.textContent?.includes('v0.2.0'))
  assert.ok(document.body.textContent?.includes('2026/10/23 14:00'))
  assert.deepEqual(writes, [])
})
test('exit acts directly without a confirmation dialog', async () => {
  await render(); await click('控制台退出与重启菜单'); await click('退出控制台')
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.deepEqual(writes, [{action: 'exit'}]); assert.deepEqual(phases, ['exit'])
  assert.ok(document.body.textContent?.includes('退出请求已接受'))
})
test('shutdown failure stays actionable and does not claim to have exited', async () => {
  fail = true
  await render(); await click('控制台退出与重启菜单'); await click('退出控制台')
  assert.ok(document.body.textContent?.includes('输出关闭未确认'))
  assert.deepEqual(phases, [])
  assert.equal(button('退出控制台').disabled, false)
})
test('LAN browsers cannot exit or restart the host', async () => {
  await render(false); await click('控制台退出与重启菜单')
  assert.equal(button('退出控制台').disabled, true)
  assert.equal(button('重启控制台').disabled, true)
  assert.deepEqual(writes, [])
})
test('restart waits for a new process identity rather than an old healthy response', async () => {
  await render(); await click('控制台退出与重启菜单'); await click('重启控制台')
  assert.deepEqual(phases, ['restart'])
  await act(async () => {await new Promise(r => setTimeout(r, 20))})
  assert.deepEqual(phases, ['restart'])
  info.instance_id = 'new'
  await act(async () => {await new Promise(r => setTimeout(r, 1050))})
  assert.deepEqual(phases, ['restart', 'running'])
})
