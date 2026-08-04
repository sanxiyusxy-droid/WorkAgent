const { tokenize, countTokens } = require('./tokens.js')
const assert = require('node:assert/strict')

assert.deepEqual(tokenize('hello world'), ['hello', 'world'])
assert.deepEqual(tokenize('  a   b  '), ['a', 'b'])
assert.deepEqual(tokenize(''), [])
assert.deepEqual(tokenize('   '), [])
assert.deepEqual(tokenize('one'), ['one'])

assert.equal(countTokens('hello world'), 2)
assert.equal(countTokens(''), 0)
assert.equal(countTokens('a b c d'), 4)

console.log('OK')
