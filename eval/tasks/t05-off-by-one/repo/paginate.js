// Pagination helper: how many pages of `pageSize` items fit `total` items.
// At least one page always exists, even for empty collections.
function paginate(total, pageSize) {
  if (total <= 0) return 1
  return Math.floor(total / pageSize)
}

module.exports = { paginate }
