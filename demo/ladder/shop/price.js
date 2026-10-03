// The one place a price is formatted. The ladder demo's fixture commits
// (demo/ladder/commits/) are built on top of this file - see demo/ladder.mjs.
function formatPrice(cents) {
  return (cents / 100).toFixed(2)
}

module.exports = { formatPrice }
