/**
 * The README's "how it works" diagram, generated rather than drawn.
 *
 * Writes `docs/assets/how-it-works.svg` (dark) and `how-it-works-light.svg`,
 * which the README's `<picture>` picks between by colour scheme. Hand-built
 * shapes and text only - no scripts, no styles, no external images - so each
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
const H = 610
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
// Every colour lives here. The dark theme is the one npm and GitHub's dark
// mode show; the light one uses GitHub's light-theme colours, with each accent
// darkened so it still reads on a pale ground.
const THEMES = {
  dark: {
    file: 'how-it-works.svg',
    C: {
      bg: '#0d1117', card: '#161b22', inset: '#0d1117', text: '#e6edf3', muted: '#8b949e',
      blue: '#79c0ff', amber: '#e3b341', green: '#56d364', violet: '#bc8cff', red: '#ff7b72', grey: '#8b949e',
    },
    tints: ['#1f6feb', '#bb8009', '#2ea043', '#8957e5'],
    tintTop: '0.30', tintBottom: '0.04',
    cardOpacity: '0.2', edge: '#ffffff', edgeOpacity: 0.18, dividerOpacity: '0.08',
    frame: null,
  },
  light: {
    file: 'how-it-works-light.svg',
    C: {
      bg: '#f6f8fa', card: '#ffffff', inset: '#f6f8fa', text: '#1f2328', muted: '#59636e',
      blue: '#0969da', amber: '#9a6700', green: '#1a7f37', violet: '#8250df', red: '#cf222e', grey: '#6e7781',
    },
    tints: ['#54aeff', '#d4a72c', '#4ac26b', '#c297ff'],
    tintTop: '0.28', tintBottom: '0.05',
    cardOpacity: '0.2', edge: '#1f2328', edgeOpacity: 0.16, dividerOpacity: '0.12',
    frame: '#d1d9e0',
  },
}
const COL = 260
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function render(theme) {
  const { C } = theme
  const PHASES = [
    { n: 1, title: 'GATHER', sub: 'before the review is written', color: C.blue },
    { n: 2, title: 'WRITE', sub: 'by an agent or a person', color: C.amber },
    { n: 3, title: 'VERIFY', sub: 'at the agent\'s stop, then in CI', color: C.green },
    { n: 4, title: 'OVER TIME', sub: 'the clock', color: C.violet },
  ].map((p, i) => ({ ...p, tint: theme.tints[i] }))
  const o = []
  const t = (x, y, s, { size = 13, font = SANS, fill = C.text, weight = 400, anchor = 'start', italic = false } = {}) =>
    o.push(`<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`)
  const card = (x, y, w, h, { fill = C.card, stroke = theme.edge, strokeOpacity = theme.edgeOpacity, r = 10 } = {}) =>
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" fill-opacity="${theme.cardOpacity}" stroke="${stroke}" stroke-opacity="${strokeOpacity}" stroke-width="1.2"/>`)
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

  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How evidence-layer works, in four phases: gather evidence at the commit before the review is written, write the review by keeping the addressed artifact blocks, verify claims, the sealed run and the Access Receipt when the agent stops and again in CI, and count findings, gate decisions and misses over time in the journal.">`)
  o.push('<defs>')
  for (const p of PHASES) {
    o.push(`<linearGradient id="g-${p.n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.tint}" stop-opacity="${theme.tintTop}"/><stop offset="1" stop-color="${p.tint}" stop-opacity="${theme.tintBottom}"/></linearGradient>`)
  }
  o.push(`<clipPath id="frame"><rect width="${W}" height="${H}" rx="16"/></clipPath>`)
  o.push('</defs>')
  o.push(`<g clip-path="url(#frame)">`)
  o.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`)
  PHASES.forEach((p, i) => {
    o.push(`<rect x="${i * COL}" y="48" width="${COL}" height="${H - 96}" fill="url(#g-${p.n})"/>`)
    if (i) o.push(`<line x1="${i * COL}" y1="48" x2="${i * COL}" y2="${H - 48}" stroke="${theme.edge}" stroke-opacity="${theme.dividerOpacity}"/>`)
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
  card(16, 214, 228, 124, { stroke: C.blue, strokeOpacity: 0.55 })
  iconGear(40, 240, C.blue)
  t(62, 245, 'gatherEvidence()', { size: 13.5, font: MONO, weight: 700, fill: C.blue })
  t(62, 264, 'runs your own commands', { size: 12 })
  let cx = 28
  for (const chip of ['lint', 'typecheck', 'lockfile', 'test']) cx += pill(cx, 274, chip, C.blue, { size: 10, w: chip.length * 6 + 12 }) + 4
  t(28, 309, 'id = hash(command, commit, output)', { size: 10, font: MONO, fill: C.muted })
  t(28, 327, '+ [SUMMARY tests: passed=3 …]', { size: 10, font: MONO, fill: C.muted })
  vArrow(130, 338, 365, C.muted)
  t(140, 355, 'writes, and seals', { size: 11, fill: C.muted })
  card(16, 366, 228, 154)
  iconDoc(40, 394, C.blue)
  t(62, 399, 'evidence.local.md', { size: 13.5, font: MONO, weight: 700 })
  pill(28, 414, 'artifact:tests-a3f91c@f8ae76a', C.amber, { size: 10.5 })
  ;['claim skeleton, counts filled in', 'Sample integrity table', 'the run sealed in .git'].forEach((s, i) => {
    tick(36, 454 + i * 22, C.blue)
    t(50, 458 + i * 22, s, { size: 12 })
  })

  // Phase 2 - write
  iconRobot(350, 140, C.amber)
  t(390, 148, '/', { size: 22, fill: C.muted, anchor: 'middle' })
  iconPerson(430, 140, C.amber)
  card(276, 172, 228, 348, { stroke: C.amber, strokeOpacity: 0.45 })
  iconDoc(298, 198, C.amber)
  t(318, 203, 'review.md', { size: 13.5, font: MONO, weight: 700 })
  card(288, 216, 204, 62, { fill: C.inset, r: 8 })
  t(300, 236, 'Access Receipt', { size: 12.5, weight: 600 })
  t(300, 254, 'HEAD · base · files in diff', { size: 11.5, fill: C.muted })
  t(300, 270, 'first line of each cited file', { size: 11.5, fill: C.muted })
  tick(296, 302)
  t(310, 306, 'honest: keep the block', { size: 12, weight: 600, fill: C.green })
  pill(288, 316, 'VERIFIED[tests-a3f91c: passed>=3]', C.amber, { size: 9.4, w: 204 })
  t(298, 354, '+ its artifact block, as-is', { size: 11.5, fill: C.muted })
  o.push(`<line x1="288" y1="372" x2="492" y2="372" stroke="${theme.edge}" stroke-opacity="${theme.dividerOpacity}"/>`)
  cross(296, 394)
  t(310, 398, 'shortcut: bare tag, no id', { size: 12, weight: 600, fill: C.red })
  const bare = pill(296, 408, 'VERIFIED', C.red, { size: 11 })
  o.push('<line x1="300" y1="418" x2="' + (296 + bare - 4) + '" y2="418" stroke="' + C.red + '" stroke-width="1.4"/>')
  t(298, 448, 'costs a deletion; claims warns', { size: 11.5, fill: C.muted })
  o.push(`<line x1="288" y1="464" x2="492" y2="464" stroke="${theme.edge}" stroke-opacity="${theme.dividerOpacity}"/>`)
  cross(296, 486)
  t(310, 490, 'edit the block: seal/edited', { size: 12, weight: 600, fill: C.red })
  t(298, 510, 'and the gate denies writes to the run', { size: 11.5, fill: C.muted })

  // Phase 3 - verify
  card(536, 112, 228, 170)
  t(552, 136, 'evidence-layer claims', { size: 13, font: MONO, weight: 700, fill: C.green })
  ;['each id resolves to an artifact', 'its predicates hold', 'collected at this commit', '--seal: the block the run wrote', '--seal: code unchanged since', 'at most 2 claims per artifact'].forEach((s, i) => {
    tick(558, 156 + i * 21)
    t(572, 160 + i * 21, s, { size: 12 })
  })
  card(536, 292, 228, 100)
  t(552, 314, 'evidence-layer receipt', { size: 13, font: MONO, weight: 700, fill: C.green })
  ;['matches git’s own output', 'base = merge-base, not ancestry', 'quoted first lines match'].forEach((s, i) => {
    tick(558, 333 + i * 21)
    t(572, 337 + i * 21, s, { size: 12 })
  })
  vArrow(650, 392, 405, C.muted)
  card(536, 406, 228, 114, { stroke: C.green, strokeOpacity: 0.55 })
  t(552, 427, 'exit code is the contract', { size: 12.5, weight: 600 })
  cx = 552
  for (const [label, color] of [['pass', C.green], ['warning', C.amber], ['error', C.red]]) cx += pill(cx, 436, label, color, { size: 10, font: SANS }) + 5
  cx = 552
  for (const [label, color] of [['flaky', C.violet], ['unverifiable', C.grey]]) cx += pill(cx, 461, label, color, { size: 10, font: SANS }) + 5
  t(552, 495, 'a code per finding · annotations in CI', { size: 10.5, fill: C.muted })
  t(552, 511, 'an agent reads its grade and fixes', { size: 10.5, fill: C.muted })

  // Phase 4 - over time
  card(796, 112, 228, 140)
  iconShield(818, 138, C.violet)
  t(838, 136, 'evidence-layer', { size: 12.5, font: MONO, weight: 700, fill: C.violet })
  t(838, 152, 'governance', { size: 12.5, font: MONO, weight: 700, fill: C.violet })
  ;['invariants reach a hook or CI', 'no exception past expiry', 'decision records not stale', 'JSON block on every run'].forEach((s, i) => {
    tick(812, 174 + i * 21, C.violet)
    t(826, 178 + i * 21, s, { size: 12 })
  })
  card(796, 264, 228, 152)
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
  t(810, 390, '+ open misses, recorded by governance', { size: 10, fill: C.muted })
  t(810, 406, '+ gate blocks, real or false, and denies', { size: 10, fill: C.muted })
  card(796, 468, 228, 52)
  iconCommit(818, 486, C.red)
  t(838, 490, 'a later fix commit', { size: 12.5, weight: 600 })
  t(812, 510, 'Missed-By: <review or PR>', { size: 10.5, font: MONO, fill: C.red })
  vArrow(1004, 468, 417, C.red)
  t(994, 446, 'trailer', { size: 10, fill: C.red, anchor: 'end' })

  // Flows between phases.
  elbow(244, 424, 260, 326, 287, C.amber)
  t(260, 446, 'copy', { size: 11, fill: C.amber, anchor: 'middle' })
  elbow(504, 236, 520, 176, 535, C.green)
  elbow(504, 326, 520, 340, 535, C.green)
  t(520, 166, 'checks', { size: 11, fill: C.green, anchor: 'middle' })
  elbow(536, 478, 520, 466, 505, C.amber, { dash: true })
  t(520, 536, 'the stop gate hands it back: fix, rerun', { size: 11, fill: C.amber, anchor: 'middle' })
  elbow(764, 440, 780, 340, 795, C.violet)
  t(790, 446, 'the gate logs its decisions', { size: 10, fill: C.violet })

  t(W / 2, H - 18, 'The honest path must be cheaper than the convenient one.', { size: 13, fill: C.muted, anchor: 'middle', italic: true })
  o.push('</g>')
  // A pale card on a white page needs an edge; the dark one stands on its own.
  if (theme.frame) o.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="none" stroke="${theme.frame}"/>`)
  o.push('</svg>')
  return o.join('\n') + '\n'
}


mkdirSync(OUT, { recursive: true })
for (const theme of Object.values(THEMES)) {
  writeFileSync(join(OUT, theme.file), render(theme))
  console.log('wrote ' + join(OUT, theme.file))
}
