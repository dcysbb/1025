import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { ApiError, apiRequest } from '../src/apiClient'
import { StageRequestError, stageApi } from '../src/stageClient'

let dom: JSDOM
beforeEach(() => {
  dom = new JSDOM('<!doctype html><div/>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, Event: dom.window.Event })
})
afterEach(() => dom.window.close())

test('transport failures name the resource without inventing a hardware diagnosis', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(apiRequest('/api/events?limit=200'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.kind, 'network')
    assert.match(error.message, /读取事件日志失败/)
    assert.match(error.message, /浏览器未提供具体原因/)
    assert.match(error.message, /检查后台/)
    assert.doesNotMatch(error.message, /Failed to fetch|真空规离线|I\/O 已断开/)
    return true
  })
})

test('a command with a lost response is never retried and is explicitly unconfirmed', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
  await assert.rejects(apiRequest('/api/valve/close', { method: 'POST', body: '{}' }), error => {
    assert.match((error as Error).message, /关闭插板阀结果未确认/)
    assert.match((error as Error).message, /勿直接重复提交/)
    return true
  })
  assert.equal(calls, 1)
})

test('a deadline reports the actual operation and timeout instead of an AbortError', async () => {
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  await assert.rejects(apiRequest('/api/hardware/ports', { timeoutMs: 10 }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.kind, 'timeout')
    assert.match(error.message, /读取本机串口列表失败/)
    assert.match(error.message, /超过 0.01 秒/)
    assert.doesNotMatch(error.message, /AbortError/)
    return true
  })
})

test('authentication errors keep the server explanation and notify the login flow once', async () => {
  let needed = 0
  window.addEventListener('auth-needed', () => needed++)
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: '请登录后查看设备数据' }), { status: 401 })
  await assert.rejects(apiRequest('/api/status'), /读取压力与联锁状态失败（HTTP 401）：请登录后查看设备数据/)
  assert.equal(needed, 1)
  await assert.rejects(apiRequest('/api/auth/status'), /读取操作员登录状态失败/)
  assert.equal(needed, 1, 'an authentication status failure must not trigger recursive status requests')
})

test('non-JSON server errors and invalid successful responses remain understandable', async () => {
  globalThis.fetch = async () => new Response('<html>unavailable</html>', { status: 503 })
  await assert.rejects(apiRequest('/api/history'), /读取压力历史数据失败（HTTP 503）：后台服务暂不可用/)
  globalThis.fetch = async () => new Response('<html>old frontend</html>')
  await assert.rejects(apiRequest('/api/config'), /读取控制台设置失败：后台返回的数据为空或格式异常/)
})

test('device configuration context and field-level validation are preserved', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: [{ loc: ['body', 'config', 'dam_unit_id'], msg: '设备地址必须为 1 至 255' }] }), { status: 422 })
  await assert.rejects(apiRequest('/api/config', { method: 'PATCH', body: '{}', operation: '保存 I/O 控制器连接配置' }), /保存 I\/O 控制器连接配置失败（HTTP 422）：config.dam_unit_id：设备地址必须为 1 至 255/)
})

test('stage transport and server failures preserve uncertain delivery while a rejection stays explicit', async () => {
  const body = { axis: 'y', direction: -1, steps: 25 }
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(stageApi('/api/stage/move', 'POST', body), error => {
    assert.equal(error instanceof StageRequestError, false)
    assert.match((error as Error).message, /Y 轴反向点动 25 步结果未确认/)
    return true
  })
  globalThis.fetch = async () => new Response('internal error', { status: 500 })
  await assert.rejects(stageApi('/api/stage/move', 'POST', body), error => !(error instanceof StageRequestError) && /操作是否执行尚未确认/.test((error as Error).message))
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: '通道未就绪' }), { status: 409 })
  await assert.rejects(stageApi('/api/stage/move', 'POST', body), error => error instanceof StageRequestError && /通道未就绪/.test(error.message))
})

test('stage tool failures identify the selected axis and operation without replaying it', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
  await assert.rejects(stageApi('/api/stage/action', 'POST', {axis:'z', operation:'optimize', confirmed:true}), /Z 轴性能优化结果未确认/)
  await assert.rejects(stageApi('/api/stage/parameters/y', 'GET'), /Y 轴读取驱动参数失败/)
  await assert.rejects(stageApi('/api/stage/parameters/x', 'PUT', {step_rate:1600}), /X 轴应用驱动参数结果未确认/)
  await assert.rejects(stageApi('/api/stage/recover', 'POST', {confirmed_stationary:true}), /恢复 PDXC3 失效连接结果未确认/)
  assert.equal(calls, 4)
})
