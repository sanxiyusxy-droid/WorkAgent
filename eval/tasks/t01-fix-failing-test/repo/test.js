const test = require('node:test')
const assert = require('node:assert/strict')
const { sum, product } = require('./math.js')

test('sum adds two numbers', () => {
  assert.equal(sum(2, 3), 5)
  assert.equal(sum(-1, 1), 0)
  assert.equal(sum(0, 0), 0)
})

test('product multiplies two numbers', () => {
  assert.equal(product(2, 3), 6)
  assert.equal(product(-2, 3), -6)
})
