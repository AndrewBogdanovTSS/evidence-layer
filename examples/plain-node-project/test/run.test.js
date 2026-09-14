const { test } = require('node:test')
const assert = require('node:assert')
const { increment } = require('../index.js')

test('increment adds one', () => {
  assert.strictEqual(increment(1), 2)
})

test('increment handles zero', () => {
  assert.strictEqual(increment(0), 1)
})

test('increment handles negatives', () => {
  assert.strictEqual(increment(-5), -4)
})
