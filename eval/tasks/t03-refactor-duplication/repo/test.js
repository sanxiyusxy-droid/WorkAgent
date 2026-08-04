const test = require('node:test')
const assert = require('node:assert/strict')
const { formatUserRow, formatAdminRow } = require('./report.js')

test('user row formatting is unchanged', () => {
  assert.equal(formatUserRow({ name: '  ada  ', active: true }), 'ada'.padEnd(20, ' ') + ' [on]')
  assert.equal(formatUserRow({ name: 'bob', active: false }), 'bob'.padEnd(20, ' ') + ' [off]')
})

test('admin row formatting is unchanged', () => {
  assert.equal(formatAdminRow({ name: 'cy', active: true }), 'cy'.padEnd(20, ' ') + ' [on] (admin)')
  assert.equal(formatAdminRow({ name: 'dee', active: false }), 'dee'.padEnd(20, ' ') + ' [off] (admin)')
})
