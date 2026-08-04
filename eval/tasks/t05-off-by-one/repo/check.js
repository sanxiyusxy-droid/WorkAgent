const { paginate } = require('./paginate.js')
const assert = require('node:assert/strict')

assert.equal(paginate(0, 10), 1)
assert.equal(paginate(1, 10), 1)
assert.equal(paginate(10, 10), 1)
assert.equal(paginate(11, 10), 2)
assert.equal(paginate(20, 10), 2)
assert.equal(paginate(21, 10), 3)
assert.equal(paginate(100, 30), 4)

console.log('OK')
