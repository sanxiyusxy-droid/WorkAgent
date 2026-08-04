// Two report builders share identical row-formatting logic, copy-pasted.
function formatUserRow(user) {
  const name = user.name.trim()
  const padded = name.padEnd(20, ' ')
  const status = user.active ? '[on]' : '[off]'
  return `${padded} ${status}`
}

function formatAdminRow(user) {
  const name = user.name.trim()
  const padded = name.padEnd(20, ' ')
  const status = user.active ? '[on]' : '[off]'
  return `${padded} ${status} (admin)`
}

module.exports = { formatUserRow, formatAdminRow }
