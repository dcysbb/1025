import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStageProfile, parseStageProfile } from '../src/stageProfiles'

const values = {forward_amplitude: 100, reverse_amplitude: 90, step_rate: 800, acceleration: 1000}
const current = {values, limits: {forward_amplitude: {min: 10, max: 100}, reverse_amplitude: {min: 10, max: 100}, step_rate: {min: 800, max: 20000}, acceleration: {min: 1, max: 20000}}}
const file = () => makeStageProfile(values, {serial_number: '129576359', channel: 1, stage: 'PDXC2AD'})

test('drive profile round-trip retains only the supported drive values', () => {
  assert.deepEqual(parseStageProfile(file(), current), values)
  assert.equal(JSON.parse(file()).source.channel, 1)
})

test('drive imports reject wrong models, missing/unknown values, floats, strings and excessive size', () => {
  const base = JSON.parse(file())
  for (const profile of [
    {...base, model: 'PDXC2'}, {...base, version: 2}, {...base, values: {}},
    {...base, values: {...values, extra: 1}}, {...base, values: {...values, step_rate: '800'}},
    {...base, values: {...values, acceleration: 1.5}}, {...base, values: {...values, step_rate: 0}},
    {...base, values: {...values, forward_amplitude: true}},
  ]) assert.throws(() => parseStageProfile(JSON.stringify(profile), current))
  assert.throws(() => parseStageProfile(' '.repeat(16385), current))
  assert.throws(() => parseStageProfile('invalid json', current))
})

test('import honors narrower device limits without modifying the current readback', () => {
  const limited = {...current, limits: {...current.limits, forward_amplitude: {min: 10, max: 80}}}
  assert.throws(() => parseStageProfile(file(), limited), /10–80/)
  assert.equal(limited.values.forward_amplitude, 100)
})
