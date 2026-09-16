// A trivial, deliberately boring module - the point of this fixture is what
// it is NOT (TypeScript, Vue, a monorepo member), not what it does.
function increment(n) {
  return n + 1
}
console.log('Hello')

module.exports = { increment }
