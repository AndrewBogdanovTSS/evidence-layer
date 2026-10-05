/**
 * The README's "how it works" diagram, generated rather than drawn.
 *
 * Writes `docs/assets/how-it-works.svg`: one self-contained dark card that
 * reads the same on GitHub's light and dark themes and on npm. Hand-built
 * shapes and text only - no scripts, no styles, no external images - so the
 * file renders anywhere an `<img>` does.
 *
 * Every label is a statement about this package, so edit it here and
 * regenerate when the package changes; the README's alt text says the same
 * things in prose and has to move with it. The journal chart is the one part
 * that is not a fact about the package: its numbers are illustrative, and the
 * drawing says so.
 *
 * `node scripts/diagram.mjs` (or `pnpm diagram`) is the whole contract.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets')
const W = 1040
const H = 560
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
const C = {
  bg: '#0d1117', card: '#161b22', text: '#e6edf3', muted: '#8b949e', faint: '#30363d',
  blue: '#79c0ff', amber: '#e3b341', green: '#56d364', violet: '#bc8cff', red: '#ff7b72', grey: '#8b949e',
}
const PHASES = [
  { n: 1, title: 'GATHER', sub: 'before the review is written', color: C.blue, tint: '#1f6feb' },
  { n: 2, title: 'WRITE', sub: 'by an agent or a person', color: C.amber, tint: '#bb8009' },
  { n: 3, title: 'VERIFY', sub: 'in CI, by a different party', color: C.green, tint: '#2ea043' },
  { n: 4, title: 'OVER TIME', sub: 'the clock', color: C.violet, tint: '#8957e5' },
]
const COL = 260
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const o = []
const t = (x, y, s, { size = 13, font = SANS, fill = C.text, weight = 400, anchor = 'start', italic = false } = {}) =>
  o.push(`<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`)
const card = (x, y, w, h, { fill = C.card, stroke = '#ffffff', strokeOpacity = 0.18, r = 10 } = {}) =>
  o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" fill-opacity="0.2" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2"/>`)
const pill = (x, y, label, color, { size = 10.5, font = MONO, w } = {}) => {
  const width = w ?? Math.round(label.length * size * 0.62 + 16)
  o.push(`<rect x="${x}" y="${y}" width="${width}" height="20" rx="10" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.75" stroke-width="1"/>`)
  t(x + width / 2, y + 14, label, { size, font, fill: color, anchor: 'middle' })
  return width
}
const HEAD_L = 9
const HEAD_W = 5
const head = (x, y, dir, color) => {
  const pts = {
    r: [[x - HEAD_L, y - HEAD_W], [x, y], [x - HEAD_L, y + HEAD_W]],
    l: [[x + HEAD_L, y - HEAD_W], [x, y], [x + HEAD_L, y + HEAD_W]],
    u: [[x - HEAD_W, y + HEAD_L], [x, y], [x + HEAD_W, y + HEAD_L]],
    d: [[x - HEAD_W, y - HEAD_L], [x, y], [x + HEAD_W, y - HEAD_L]],
  }[dir]
  o.push(`<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${color}"/>`)
}
const stroke = (d, color, dash) =>
  o.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"${dash ? ' stroke-dasharray="6 4"' : ''}/>`)
// Vertical arrow, tip at (x, y2).
const vArrow = (x, y1, y2, color) => {
  const dir = y2 > y1 ? 1 : -1
  stroke(`M${x},${y1} V${y2 - dir * HEAD_L}`, color)
  head(x, y2, dir > 0 ? 'd' : 'u', color)
}
// Horizontal - vertical - horizontal elbow through column x = xm, tip at (x2, y2).
const elbow = (x1, y1, xm, y2, x2, color, { dash = false } = {}) => {
  const r = 6
  const out = xm > x1 ? 1 : -1
  const into = x2 > xm ? 1 : -1
  const vy = y2 > y1 ? 1 : -1
  const end = x2 - into * HEAD_L
  stroke(y1 === y2
    ? `M${x1},${y1} H${end}`
    : `M${x1},${y1} H${xm - out * r} Q${xm},${y1} ${xm},${y1 + vy * r} V${y2 - vy * r} Q${xm},${y2} ${xm + into * r},${y2} H${end}`, color, dash)
  head(x2, y2, into > 0 ? 'r' : 'l', color)
}

// Icons, drawn around a centre point.
const tick = (cx, cy, color = C.green) => {
  o.push(`<circle cx="${cx}" cy="${cy}" r="7" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.2"/>`)
  o.push(`<path d="M${cx - 3.5},${cy} l2.5,2.6 l4.6,-5" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
}
const cross = (cx, cy, color = C.red) => {
  o.push(`<circle cx="${cx}" cy="${cy}" r="7" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.2"/>`)
  o.push(`<path d="M${cx - 3},${cy - 3} l6,6 M${cx + 3},${cy - 3} l-6,6" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>`)
}
const iconBranch = (cx, cy, c) => o.push(`<g fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"><circle cx="${cx - 6}" cy="${cy - 9}" r="3"/><circle cx="${cx - 6}" cy="${cy + 9}" r="3"/><circle cx="${cx + 7}" cy="${cy - 4}" r="3"/><path d="M${cx - 6},${cy - 6} v12 M${cx + 7},${cy - 1} c0,6 -13,4 -13,8"/></g>`)
const iconGear = (cx, cy, c) => {
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    return `M${(cx + Math.cos(a) * 8).toFixed(1)},${(cy + Math.sin(a) * 8).toFixed(1)} L${(cx + Math.cos(a) * 12).toFixed(1)},${(cy + Math.sin(a) * 12).toFixed(1)}`
  }).join(' ')
  o.push(`<g fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="7.5"/><path d="${spokes}"/></g><circle cx="${cx}" cy="${cy}" r="2.6" fill="${c}"/>`)
}
const iconDoc = (cx, cy, c) => o.push(`<g fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"><path d="M${cx - 9},${cy - 12} h12 l6,6 v18 h-18 z M${cx + 3},${cy - 12} v6 h6"/><path d="M${cx - 5},${cy} h10 M${cx - 5},${cy + 5} h10" stroke-linecap="round"/></g>`)
const iconRobot = (cx, cy, c) => o.push(`<g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><rect x="${cx - 15}" y="${cy - 9}" width="30" height="22" rx="7"/><path d="M${cx},${cy - 9} v-6"/><path d="M${cx - 18},${cy + 2} v-4 M${cx + 18},${cy + 2} v-4"/></g><circle cx="${cx}" cy="${cy - 17}" r="2.6" fill="${c}"/><circle cx="${cx - 6}" cy="${cy + 1}" r="2.6" fill="${c}"/><circle cx="${cx + 6}" cy="${cy + 1}" r="2.6" fill="${c}"/>`)
const iconPerson = (cx, cy, c) => o.push(`<g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><circle cx="${cx}" cy="${cy - 7}" r="7"/><path d="M${cx - 13},${cy + 14} c0,-9 6,-13 13,-13 s13,4 13,13"/></g>`)
const iconShield = (cx, cy, c) => o.push(`<path d="M${cx},${cy - 13} l11,4 v8 c0,8 -5,12 -11,14 c-6,-2 -11,-6 -11,-14 v-8 z" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/><path d="M${cx - 5},${cy} l3.5,3.5 l6.5,-7" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`)
const iconCommit = (cx, cy, c) => o.push(`<g fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"><circle cx="${cx}" cy="${cy}" r="5"/><path d="M${cx - 13},${cy} h8 M${cx + 5},${cy} h8"/></g>`)

o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How evidence-layer works, in four phases: gather evidence at the commit before the review is written, write the review by keeping the addressed artifact blocks, verify claims and the Access Receipt in CI, and count findings and misses over time in the journal.">`)
o.push('<defs>')
for (const p of PHASES) {
  o.push(`<linearGradient id="g-${p.n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.tint}" stop-opacity="0.30"/><stop offset="1" stop-color="${p.tint}" stop-opacity="0.04"/></linearGradient>`)
}
o.push(`<clipPath id="frame"><rect width="${W}" height="${H}" rx="16"/></clipPath>`)
o.push('</defs>')
o.push(`<g clip-path="url(#frame)">`)
o.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`)
PHASES.forEach((p, i) => {
  o.push(`<rect x="${i * COL}" y="48" width="${COL}" height="${H - 96}" fill="url(#g-${p.n})"/>`)
  if (i) o.push(`<line x1="${i * COL}" y1="48" x2="${i * COL}" y2="${H - 48}" stroke="#ffffff" stroke-opacity="0.08"/>`)
  t(i * COL + COL / 2, 78, `Phase ${p.n} · ${p.title}`, { size: 16.5, weight: 700, fill: p.color, anchor: 'middle' })
  t(i * COL + COL / 2, 97, p.sub, { size: 12, fill: C.muted, anchor: 'middle' })
})
t(W / 2, 32, 'evidence-layer · how a claim becomes checkable', { size: 19, weight: 700, anchor: 'middle' })

// Phase 1 - gather
card(16, 112, 228, 56)
iconBranch(40, 140, C.blue)
t(62, 136, 'The commit under review', { size: 13.5, weight: 600 })
t(62, 155, 'vs merge-base origin/<target>', { size: 10.5, font: MONO, fill: C.muted })
stroke('M130,168 V180', C.muted)
const GATE = 'checked out?'
const gateW = Math.round(GATE.length * 11 * 0.62 + 16)
pill(130 - gateW / 2, 180, GATE, C.amber, { font: SANS, size: 11, w: gateW })
cross(130 + gateW / 2 + 14, 190)
t(130 + gateW / 2 + 26, 194, 'refuses', { size: 11.5, fill: C.red })
vArrow(130, 200, 214, C.muted)
card(16, 214, 228, 104, { stroke: C.blue, strokeOpacity: 0.55 })
iconGear(40, 240, C.blue)
t(62, 245, 'gatherEvidence()', { size: 13.5, font: MONO, weight: 700, fill: C.blue })
t(62, 264, 'runs your own commands', { size: 12 })
let cx = 28
for (const chip of ['lint', 'typecheck', 'lockfile', 'test']) cx += pill(cx, 274, chip, C.blue, { size: 10, w: chip.length * 6 + 12 }) + 4
t(28, 309, 'id = hash(command, commit, output)', { size: 10, font: MONO, fill: C.muted })
vArrow(130, 318, 345, C.muted)
t(140, 335, 'writes', { size: 11, fill: C.muted })
card(16, 346, 228, 124)
iconDoc(40, 374, C.blue)
t(62, 379, 'evidence.local.md', { size: 13.5, font: MONO, weight: 700 })
pill(28, 394, 'artifact:tests-a3f91c@f8ae76a', C.amber, { size: 10.5 })
tick(36, 434, C.blue)
t(50, 438, 'claim skeleton, ids filled in', { size: 12 })
tick(36, 456, C.blue)
t(50, 460, 'Sample integrity table', { size: 12 })

// Phase 2 - write
iconRobot(350, 140, C.amber)
t(390, 148, '/', { size: 22, fill: C.muted, anchor: 'middle' })
iconPerson(430, 140, C.amber)
card(276, 172, 228, 298, { stroke: C.amber, strokeOpacity: 0.45 })
iconDoc(298, 198, C.amber)
t(318, 203, 'review.md', { size: 13.5, font: MONO, weight: 700 })
card(288, 216, 204, 62, { fill: '#0d1117', r: 8 })
t(300, 236, 'Access Receipt', { size: 12.5, weight: 600 })
t(300, 254, 'HEAD · base · files in diff', { size: 11.5, fill: C.muted })
t(300, 270, 'first line of each cited file', { size: 11.5, fill: C.muted })
tick(296, 302)
t(310, 306, 'honest: keep the block', { size: 12, weight: 600, fill: C.green })
pill(296, 316, 'VERIFIED[tests-a3f91c]', C.amber, { size: 11 })
t(298, 354, '+ its artifact block, as-is', { size: 11.5, fill: C.muted })
o.push('<line x1="288" y1="372" x2="492" y2="372" stroke="#ffffff" stroke-opacity="0.08"/>')
cross(296, 394)
t(310, 398, 'shortcut: bare tag, no id', { size: 12, weight: 600, fill: C.red })
const bare = pill(296, 408, 'VERIFIED', C.red, { size: 11 })
o.push('<line x1="300" y1="418" x2="' + (296 + bare - 4) + '" y2="418" stroke="' + C.red + '" stroke-width="1.4"/>')
t(298, 448, 'costs a deletion; claims warns', { size: 11.5, fill: C.muted })

// Phase 3 - verify
card(536, 112, 228, 128)
t(552, 136, 'evidence-layer claims', { size: 13, font: MONO, weight: 700, fill: C.green })
;['each id resolves to an artifact', 'collected at this commit', 'at most 2 claims per artifact', 'success words need an Effect'].forEach((s, i) => {
  tick(558, 156 + i * 21)
  t(572, 160 + i * 21, s, { size: 12 })
})
card(536, 252, 228, 108)
t(552, 276, 'evidence-layer receipt', { size: 13, font: MONO, weight: 700, fill: C.green })
;['matches git’s own output', 'base = merge-base, not ancestry', 'quoted first lines match'].forEach((s, i) => {
  tick(558, 296 + i * 21)
  t(572, 300 + i * 21, s, { size: 12 })
})
vArrow(650, 360, 375, C.muted)
card(536, 376, 228, 94, { stroke: C.green, strokeOpacity: 0.55 })
t(552, 398, 'exit code is the contract', { size: 12.5, weight: 600 })
cx = 552
for (const [label, color] of [['pass', C.green], ['warning', C.amber], ['error', C.red]]) cx += pill(cx, 408, label, color, { size: 10, font: SANS }) + 5
cx = 552
for (const [label, color] of [['flaky', C.violet], ['unverifiable', C.grey]]) cx += pill(cx, 434, label, color, { size: 10, font: SANS }) + 5
t(552, 466, 'an agent reads its grade and fixes', { size: 10.5, fill: C.muted })

// Phase 4 - over time
card(796, 112, 228, 140)
iconShield(818, 138, C.violet)
t(838, 136, 'evidence-layer', { size: 12.5, font: MONO, weight: 700, fill: C.violet })
t(838, 152, 'governance', { size: 12.5, font: MONO, weight: 700, fill: C.violet })
;['invariants reach a hook or CI', 'no exception past expiry', 'decision records not stale', 'JSON block on every run'].forEach((s, i) => {
  tick(812, 174 + i * 21, C.violet)
  t(826, 178 + i * 21, s, { size: 12 })
})
card(796, 264, 228, 136)
t(810, 286, 'journal report', { size: 12.5, font: MONO, weight: 700, fill: C.violet })
t(810, 302, 'per check · illustrative numbers', { size: 10, fill: C.muted })
// Per-check stacked bars, the shape `journal report` prints: real, false, untagged.
;[['claims', [6, 2, 3]], ['receipt', [4, 1, 2]]].forEach(([name, d], i) => {
  const y = 314 + i * 20
  t(810, y + 10, name, { size: 11, font: MONO })
  let x = 870
  ;[C.green, C.amber, C.grey].forEach((color, k) => {
    const w = d[k] * 11
    o.push('<rect x="' + x + '" y="' + y + '" width="' + (w - 2) + '" height="12" rx="2" fill="' + color + '" fill-opacity="0.85"/>')
    x += w
  })
})
cx = 810
for (const [label, color] of [['real', C.green], ['false', C.amber], ['untagged', C.grey]]) {
  o.push('<circle cx="' + (cx + 4) + '" cy="368" r="4" fill="' + color + '"/>')
  t(cx + 12, 372, label, { size: 10.5, fill: C.muted })
  cx += label.length * 6.5 + 24
}
t(810, 390, '+ open misses, via recordNewMisses()', { size: 10, fill: C.muted })
card(796, 418, 228, 52)
iconCommit(818, 436, C.red)
t(838, 440, 'a later fix commit', { size: 12.5, weight: 600 })
t(812, 460, 'Missed-By: <review or PR>', { size: 10.5, font: MONO, fill: C.red })
vArrow(1004, 418, 401, C.red)
t(994, 413, 'trailer', { size: 10, fill: C.red, anchor: 'end' })

// Flows between phases.
elbow(244, 404, 260, 326, 295, C.amber)
t(260, 426, 'copy', { size: 11, fill: C.amber, anchor: 'middle' })
elbow(504, 236, 520, 176, 535, C.green)
elbow(504, 320, 520, 306, 535, C.green)
t(520, 166, 'checks', { size: 11, fill: C.green, anchor: 'middle' })
elbow(536, 452, 520, 440, 505, C.amber, { dash: true })
t(520, 484, 'fix, rerun', { size: 11, fill: C.amber, anchor: 'middle' })
elbow(764, 392, 780, 330, 795, C.violet)
t(770, 371, 'outcomes, if logged', { size: 10, fill: C.violet, anchor: 'end' })

t(W / 2, H - 18, 'The honest path must be cheaper than the convenient one.', { size: 13, fill: C.muted, anchor: 'middle', italic: true })
o.push('</g>')
o.push('</svg>')

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'how-it-works.svg'), o.join('\n') + '\n')
console.log('wrote ' + join(OUT, 'how-it-works.svg'))
