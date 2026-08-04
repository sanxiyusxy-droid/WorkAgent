const { clamp } = require('./clamp.js')
const assert = require('node:assert/strict')

assert.equal(clamp(5, 1, 10), 5)
assert.equal(clamp(0, 1, 10), 1)
assert.equal(clamp(99, 1, 10), 10)
assert.equal(clamp(1, 1, 10), 1)
assert.equal(clamp(10, 1, 10), 10)
assert.equal(clamp(-3, -2, 2), -2)

console.log('OK')
