import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import type { Root } from 'react-dom/client'
const initial = new JSDOM('<div/>', { url: 'http://localhost' })
Object.assign(globalThis, { window: initial.window, document: initial.window.document })
const { createRoot } = await import('react-dom/client')
const { default: HardwarePanel } = await import('../src/HardwarePanel')
let dom: JSDOM, root: Root, container: HTMLElement
let writes: { path: string; body: Record<string, unknown> }[]
let config: Record<string, unknown>
let failure: boolean
const stage = { config: { mode: 'real', connection: 'tcp', serial_number: '129123456', host: '101.6.241.172', port: 40303, axes: { x: 1, y: 2, z: 3 }, inverted: { x: false, y: false, z: false }, max_steps: 1000 }, connected: false, error: null, channels: [] }
beforeEach(() => {
  dom = new JSDOM('<div id="root"/>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })
  writes = []; failure = false
  config = { mode: 'simulation', tpg_connection: 'tcp', tpg_host: '192.168.1.2', tpg_port: 8000, tpg_serial_port: 'COM3', tpg_baudrate: 9600, io_device: 'dam0808d', dam_serial_port: 'COM4', dam_baudrate: 9600, dam_unit_id: 1, adam_host: '', adam_port: 502, adam_unit_id: 1, valve_closed_di: 0, valve_open_di: null, valve_closed_active_high: true, valve_open_active_high: true, open_output: 0 }
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (options?.method && options.method !== 'GET') {
      const body = JSON.parse(String(options.body ?? '{}')); writes.push({ path, body })
      if (failure) return new Response(JSON.stringify({ detail: 'DAM 与真空规必须使用不同串口' }), { status: 422 })
      if (path === '/api/config') config = { ...config, ...body.config }
    }
    const data = path.includes('/stage') ? stage : path.includes('/ports') ? { ports: [] } : path.includes('/hardware/status') ? { tpg: { connected: true, error: null }, io: { connected: true, error: null, inputs: Array(8).fill(false), outputs: Array(8).fill(false) } } : { config }
    return new Response(JSON.stringify(data))
  }
  container = document.getElementById('root')!; root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); dom.window.close() })
async function render(auth = true) { await act(async () => { root.render(<HardwarePanel auth={auth} connected />); await new Promise(r => setTimeout(r, 20)) }) }
function button(name: string) { const node = [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.trim() === name || x.getAttribute('aria-label') === name); assert.ok(node, name); return node }
function field(name: string) { const label = [...container.querySelectorAll('label')].find(x => x.firstChild?.textContent === name); assert.ok(label, name); return label.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')! }
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
  assert.equal(container.querySelectorAll('#hardware-terminals tbody tr').length, 26)
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
test('errors retain unsaved draft and unauthenticated controls cannot write', async () => {
  await render(); await change(field('DAM 串口'), 'COM3'); failure = true; await click('保存I/O')
  assert.equal(field('DAM 串口').value, 'COM3')
  assert.ok(container.textContent?.includes('必须使用不同串口'))
  await act(async () => root.render(<HardwarePanel auth={false} connected />))
  assert.equal(button('保存I/O').disabled, true)
  assert.equal(button('连接真空规').disabled, true)
})
