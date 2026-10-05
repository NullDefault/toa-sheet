// Pixel art: one palette, a 3×5 font for numerals and short labels, the
// Desktop HUD and saves strip as SVG, inline pips, and the terminal's
// half-block cells (packed as the Raster element takes them). Words are never
// drawn here: view.ts sets them as Text. Pure functions: no mods API, and
// nothing reads a sheet; view.ts hands in the facts already worded.

/** Twelve colours, the brief's ceiling. Each SVG draws its own panel, so it reads on light and dark. */
export const C = {
  panel: 0x161a23,
  inset: 0x242a38,
  edge: 0x3b4256,
  ink: 0xeceae3,
  dim: 0x8a90a2,
  green: 0x4cc552,
  amber: 0xf0a020,
  red: 0xe5484d,
  temp: 0x3fc8e0,
  empty: 0x394052,
  slot: 0xa07cff,
  gold: 0xf2c14e,
} as const

/** The Raster element's "terminal default" colour. */
export const DEFAULT = 0x01000000

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

// ------------------------------------------------------------------ font

/** 3×5 glyphs, five rows of three bits (WIDE has the few that need more). Unknown characters draw as '?'. */
const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001010010',
  '8': '111101111101111', '9': '111101111001111', '/': '001001010100100', '+': '000010111010000',
  '-': '000000111000000', ':': '000010000010000', '.': '000000000000010', ' ': '000000000000000',
  '?': '111001011000010', '·': '000000010000000', ',': '000000000010100', "'": '010010000000000',
  '(': '010100100100010', ')': '010001001001010', '!': '010010010000010', '×': '000101010101000',
  '…': '000000000000101', '=': '000111000111000', '_': '000000000000111',
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
}
/** M, N and W are illegible three pixels wide; these rows are wider. */
const WIDE: Record<string, string[]> = {
  M: ['10001', '11011', '10101', '10001', '10001'],
  N: ['1001', '1101', '1011', '1001', '1001'],
  W: ['10001', '10001', '10101', '11011', '10001'],
}

interface Glyph {
  w: number
  rows: string[]
}
const glyph = (ch: string): Glyph => {
  const wide = WIDE[ch]
  if (wide) return { w: wide[0]?.length ?? 3, rows: wide }
  const bits = GLYPHS[ch] ?? GLYPHS['?'] ?? ''
  return { w: 3, rows: [0, 1, 2, 3, 4].map((r) => bits.slice(r * 3, r * 3 + 3)) }
}

/** What the font can draw: capitals, accents dropped, curly quotes and dashes straightened. */
export function fontText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .toUpperCase()
}

/** Width in art pixels of `text` (in font form) at `scale`: each glyph's width, one pixel between. */
export const textWidth = (text: string, scale = 1) => {
  const chars = [...text]
  return (chars.length ? chars.reduce((n, ch) => n + glyph(ch).w + 1, 0) - 1 : 0) * scale
}

// ------------------------------------------------------------------ svg painter

/**
 * Rectangles on an integer grid, kept in paint order and merged into one
 * `<path>` per run of a colour: far smaller than a `<rect>` per pixel run.
 */
function painter() {
  const layers: { c: number; d: string }[] = []
  const rect = (x: number, y: number, w: number, h: number, c: number) => {
    if (w <= 0 || h <= 0) return
    const d = `M${x} ${y}h${w}v${h}h${-w}z`
    const top = layers[layers.length - 1]
    if (top && top.c === c) top.d += d
    else layers.push({ c, d })
  }
  /** Draws `s` (already in font form) and returns its width. */
  const text = (s: string, x: number, y: number, scale: number, c: number) => {
    let gx = 0
    for (const ch of s) {
      const g = glyph(ch)
      g.rows.forEach((bits, row) => {
        let col = 0
        while (col < g.w) {
          if (bits[col] !== '1') {
            col++
            continue
          }
          let end = col
          while (end < g.w && bits[end] === '1') end++
          rect(x + (gx + col) * scale, y + row * scale, (end - col) * scale, scale, c)
          col = end
        }
      })
      gx += g.w + 1
    }
    return textWidth(s, scale)
  }
  /** A shape with its corners cut one pixel per step, `steps` deep. */
  const stepped = (x: number, y: number, w: number, h: number, c: number, steps = 2) => {
    for (let i = 0; i <= steps; i++) rect(x + steps - i, y + i, w - 2 * (steps - i), h - 2 * i, c)
  }
  /** A stepped frame `t` pixels thick around a stepped fill. */
  const framed = (x: number, y: number, w: number, h: number, t: number, edge: number, fill: number) => {
    stepped(x, y, w, h, edge, 2)
    stepped(x + t, y + t, w - 2 * t, h - 2 * t, fill, 1)
  }
  const svg = (w: number, h: number, scale: number, under: typeof layers = []) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges">` +
    [...under, ...layers].map((l) => `<path fill="${hex(l.c)}" d="${l.d}"/>`).join('') +
    '</svg>'
  return { rect, text, stepped, framed, svg, layers }
}

/** The colour HP is drawn in: green above half, amber, red below a quarter. */
export const hpColour = (current: number, max: number) => {
  const frac = max > 0 ? current / max : 0
  return frac > 0.5 ? C.green : frac >= 0.25 ? C.amber : C.red
}

/**
 * Segments for current/max plus temp: one per hit point while they fit, else
 * each segment stands for several. Spent segments `empty`; temp HP as cyan
 * segments after the maximum.
 */
export function hpSegments(current: number, max: number, temp: number, room: number, empty: number): number[] {
  const total = Math.max(1, max) + Math.max(0, temp)
  const per = Math.max(1, Math.ceil(total / Math.max(1, room)))
  const n = Math.ceil(total / per)
  const fill = hpColour(current, max)
  const maxSegs = Math.ceil(Math.max(1, max) / per)
  const full = Math.min(Math.ceil(Math.max(0, current) / per), maxSegs)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(i < full ? fill : i < maxSegs ? empty : C.temp)
  return out
}

// ------------------------------------------------------------------ the Desktop HUD

/** One stat tile: a short label over a value, an optional small line under it. */
export interface HudTile {
  label: string
  value: string
  sub?: string
  /** A derived number the last write may change: drawn dim, with an amber '?'. */
  pending?: boolean
  /** The label's colour: a caster's class accent (the frame of that class's spell icons). */
  accent?: number
}

/** One row of slot pips: `1ST`, `PACT`. */
export interface HudSlots {
  label: string
  left: number
  max: number
  pending?: boolean
}

export interface Hud {
  hp: { current: number; max: number; temp: number }
  tiles: HudTile[]
  slots: HudSlots[]
}

/**
 * The art width range in art pixels. Each SVG is drawn at an integer scale
 * with an explicit size, so nothing rescales it; view.ts picks the width.
 * 148 is the narrowest that keeps five stat tiles on one row (a narrower card
 * wraps them); 140 is the narrowest the six save tiles fit; 164 is the widest
 * (328 CSS px, under the 330 px low end of the measured 38-column pane).
 */
export const ART_FLOOR = 140
export const ART_MIN = 148
export const ART_MAX = 164

const PAD = 5
/** The space between the HP row, the tiles and the slots: one rhythm. */
const GAP = 5
const PIP = 7
const PIP_STEP = 9
const MAX_PIPS = 9

const PIP_FULL = ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...']
const PIP_SPENT = ['...#...', '..#.#..', '.#...#.', '#.....#', '.#...#.', '..#.#..', '...#...']
const HEART = ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....']

type Painter = ReturnType<typeof painter>
const bitmap = (p: Painter, art: string[], x: number, y: number, c: number) =>
  art.forEach((row, dy) => [...row].forEach((ch, dx) => ch === '#' && p.rect(x + dx, y + dy, 1, 1, c)))

/** The panel every SVG sits on, then the content over it; width and height in CSS px at `scale`. */
function framedSvg(p: Painter, w: number, h: number, scale: number) {
  const bg = painter()
  bg.framed(0, 0, w, h, 2, C.edge, C.panel)
  return { source: p.svg(w, h, scale, bg.layers), width: w * scale, height: h * scale }
}

/** Tile widths: each its content plus padding, the slack shared out. */
function tileWidths(needs: number[], room: number, gap: number): number[] {
  const slack = room - needs.reduce((a, b) => a + b, 0) - gap * (needs.length - 1)
  const each = Math.floor(Math.max(0, slack) / needs.length)
  const ws = needs.map((n) => n + each)
  if (slack > 0 && ws.length) ws[ws.length - 1] = (ws[ws.length - 1] ?? 0) + (slack - each * needs.length)
  return ws
}

/**
 * What a player checks between turns, as one strip: HP (big current, small
 * maximum, the segmented bar, temp in cyan), the stat tiles, then one row of
 * pips per slot level with the count at the right edge.
 */
export function hudSvg(h: Hud, scale: number, W: number): { source: string; width: number; height: number } {
  const inner = W - 2 * PAD
  const p = painter()
  let y = PAD

  // HP: heart, big current, small maximum, temp; the bar takes the rest of the row.
  const { current, max, temp } = h.hp
  bitmap(p, HEART, PAD + 1, y + 4, C.red)
  let x = PAD + 13
  x += p.text(String(current), x, y, 3, C.ink) + 2
  x += p.text('/' + max, x, y + 5, 2, C.dim)
  if (temp > 0) x += 4 + p.text('+' + temp, x + 4, y + 5, 2, C.temp)
  let barX = x + 5
  let barY = y + 3
  let bottom = y + 15
  if (W - PAD - barX < 40) {
    // No room beside the digits: the bar goes under them, full width.
    barX = PAD
    barY = y + 20
    bottom = barY + 9
  }
  const barW = W - PAD - barX
  p.stepped(barX, barY, barW, 9, C.inset, 1)
  const segs = hpSegments(current, max, temp, Math.floor((barW - 4 + 1) / 3), C.empty)
  const step = Math.max(2, Math.floor((barW - 4 + 1) / segs.length))
  const sx = barX + 2 + Math.floor((barW - 4 - (segs.length * step - 1)) / 2)
  segs.forEach((c, i) => p.rect(sx + i * step, barY + 2, step - 1, 5, c))
  y = bottom + GAP

  // The stat tiles, sized to their content; a second row when they do not fit one.
  if (h.tiles.length) {
    const gap = 2
    const words = h.tiles.map((t) => ({ label: fontText(t.label), value: fontText(t.value), sub: fontText(t.sub ?? ''), pending: t.pending === true, accent: t.accent ?? C.dim }))
    const needs = words.map((t) => Math.max(textWidth(t.label), textWidth(t.value, 2), textWidth(t.sub)) + 4)
    const rows: number[][] = [[]]
    let used = 0
    needs.forEach((n, i) => {
      const last = rows[rows.length - 1] ?? []
      if (last.length && used + gap + n > inner) {
        rows.push([i])
        used = n
      } else {
        last.push(i)
        used += (last.length > 1 ? gap : 0) + n
      }
    })
    for (const r of rows) {
      const ws = tileWidths(r.map((i) => needs[i] ?? 0), inner, gap)
      const tileH = r.some((i) => words[i]?.sub) ? 30 : 23
      let tx = PAD
      r.forEach((i, j) => {
        const t = words[i]
        const w = ws[j] ?? 0
        if (!t) return
        p.stepped(tx, y, w, tileH, C.inset, 2)
        p.text(t.label, tx + Math.floor((w - textWidth(t.label)) / 2), y + 3, 1, t.accent)
        p.text(t.value, tx + Math.floor((w - textWidth(t.value, 2)) / 2), y + 10, 2, t.pending ? C.dim : C.ink)
        if (t.pending) p.text('?', tx + w - 5, y + 2, 1, C.amber)
        if (t.sub) p.text(t.sub, tx + Math.floor((w - textWidth(t.sub)) / 2), y + 22, 1, C.dim)
        tx += w + gap
      })
      bottom = y + tileH
      y = bottom + gap
    }
    y = bottom + GAP
  }

  // Slots: label, pips, count at the right edge.
  if (h.slots.length) {
    const labels = h.slots.map((s) => fontText(s.label))
    const labelW = Math.max(...labels.map((l) => textWidth(l)))
    h.slots.forEach((s, i) => {
      p.text(labels[i] ?? '', PAD, y + 1, 1, C.dim)
      pips(p, s.left, s.max, C.slot, PAD + labelW + 6, y)
      const count = `${s.left}/${s.max}`
      p.text(count, W - PAD - textWidth(count) - (s.pending ? 4 : 0), y + 1, 1, s.pending ? C.dim : C.ink)
      if (s.pending) p.text('?', W - PAD - 3, y + 1, 1, C.amber)
      bottom = y + PIP
      y = bottom + 3
    })
  }
  return framedSvg(p, W, bottom + PAD, scale)
}

/** Diamond pips at (x, y): filled for each left, outlined for each spent; past MAX_PIPS a meter. */
function pips(p: Painter, left: number, max: number, colour: number, x: number, y: number): number {
  if (max <= MAX_PIPS) {
    for (let i = 0; i < max; i++) bitmap(p, i < left ? PIP_FULL : PIP_SPENT, x + i * PIP_STEP, y, i < left ? colour : C.dim)
    return Math.max(0, max * PIP_STEP - 2)
  }
  const w = MAX_PIPS * PIP_STEP - 2
  p.stepped(x, y, w, PIP, C.inset, 1)
  p.rect(x + 1, y + 1, Math.round(((w - 2) * left) / Math.max(1, max)), PIP - 2, colour)
  return w
}

/** One save: the ability's three letters, the bonus, whether proficient. */
export interface SaveTile {
  label: string
  value: string
  proficient: boolean
  pending?: boolean
}

/** The six saves as one strip of tiles; a proficient one has a green stepped outline and a bright label. */
export function savesSvg(saves: SaveTile[], scale: number, W: number): { source: string; width: number; height: number } {
  const p = painter()
  const gap = 2
  const words = saves.map((s) => ({ label: fontText(s.label), value: fontText(s.value) }))
  const ws = tileWidths(words.map((t) => Math.max(textWidth(t.label) + 8, textWidth(t.value, 2) + 6)), W - 2 * PAD, gap)
  let x = PAD
  words.forEach((t, i) => {
    const w = ws[i] ?? 0
    const s = saves[i]
    if (s?.proficient) p.framed(x, PAD, w, 23, 1, C.green, C.inset)
    else p.stepped(x, PAD, w, 23, C.inset, 2)
    p.text(t.label, x + Math.floor((w - textWidth(t.label)) / 2), PAD + 3, 1, s?.proficient ? C.ink : C.dim)
    p.text(t.value, x + Math.floor((w - textWidth(t.value, 2)) / 2), PAD + 10, 2, s?.pending ? C.dim : C.ink)
    if (s?.pending) p.text('?', x + 2, PAD + 2, 1, C.amber)
    x += w + gap
  })
  return framedSvg(p, W, PAD + 23 + PAD, scale)
}

/** Inline pips beside a word (a resource, a spell level), with no panel: they read on light and dark. */
export function pipsSvg(left: number, max: number, colour: number, scale: number): { source: string; width: number; height: number } {
  const p = painter()
  const w = Math.max(1, Math.min(max, MAX_PIPS) * PIP_STEP - 2)
  pips(p, left, max, colour, 0, 0)
  return { source: p.svg(w, PIP, scale), width: w * scale, height: PIP * scale }
}

// ------------------------------------------------------------------ action icons

/**
 * The icon set for the Actions tab: 9×9 glyphs on a 13×13 stepped tile, one
 * letter per pixel (k ink, d dim, r red, a amber, y gold, g green, c cyan, v
 * violet, e edge; '.' the tile). The glyph says what the action does (its damage
 * type, healing, a reaction, a save or attack, else its school); the tile's
 * frame says who casts it (the class's accent), so the same language reads in
 * every row. Drawn for this project; no book art.
 */
const INK: Record<string, number> = { k: C.ink, d: C.dim, r: C.red, a: C.amber, y: C.gold, g: C.green, c: C.temp, v: C.slot, e: C.edge, i: C.inset }

export const ICONS: Record<string, string[]> = {
  fire: [
    '....r....',
    '...rr....',
    '...rrr.r.',
    '..rrarrr.',
    '.rrraarr.',
    '.rraayarr',
    'rraayyaar',
    '.raayyar.',
    '..rrrrr..',
  ],
  lightning: [
    '....yyyy.',
    '...yyyy..',
    '..yyyy...',
    '.yyyyyyy.',
    '....yyy..',
    '...yyy...',
    '..yyy....',
    '..yy.....',
    '.y.......',
  ],
  thunder: [
    '.....k...',
    '..k...k..',
    '...k...k.',
    'k..k...k.',
    'kk.k...k.',
    'k..k...k.',
    '...k...k.',
    '..k...k..',
    '.....k...',
  ],
  cold: [
    '....c....',
    '.c..c..c.',
    '..c.c.c..',
    '...ccc...',
    'ccccccccc',
    '...ccc...',
    '..c.c.c..',
    '.c..c..c.',
    '....c....',
  ],
  acid: [
    '....g....',
    '...ggg...',
    '...ggg...',
    '..ggggg..',
    '.ggggggg.',
    '.gkggggg.',
    '.gkggggg.',
    '..ggggg..',
    '...ggg...',
  ],
  poison: [
    '...kkk...',
    '....k....',
    '...k.k...',
    '..k...k..',
    '.kgggggk.',
    'kgggggggk',
    'kggkggggk',
    'kgggggggk',
    '.kkkkkkk.',
  ],
  force: [
    '....v....',
    '....v....',
    '...vvv...',
    '..vvkvv..',
    'vvvkkkvvv',
    '..vvkvv..',
    '...vvv...',
    '....v....',
    '....v....',
  ],
  necrotic: [
    '..ddddd..',
    '.ddddddd.',
    'ddddddddd',
    'dd..d..dd',
    'dd..d..dd',
    'ddddddddd',
    '.ddd.ddd.',
    '..ddddd..',
    '..d.d.d..',
  ],
  radiant: [
    '....y....',
    '.y..y..y.',
    '..y...y..',
    '...yyy...',
    'yy.yyy.yy',
    '...yyy...',
    '..y...y..',
    '.y..y..y.',
    '....y....',
  ],
  psychic: [
    '.vvvvvvv.',
    'v.......v',
    'v.vvvvv.v',
    'v.v...v.v',
    'v.v.v.v.v',
    'v.v.vvv.v',
    'v.v.....v',
    'v.vvvvvvv',
    '.........',
  ],
  bludgeoning: [
    '...kkk...',
    '..kdkdk..',
    '..kkkkk..',
    '..kdkdk..',
    '...kkk...',
    '....a....',
    '....a....',
    '....a....',
    '...aaa...',
  ],
  piercing: [
    '....k....',
    '...kdk...',
    '...kdk...',
    '...kdk...',
    '...kdk...',
    '.aaaaaaa.',
    '....a....',
    '....a....',
    '...aaa...',
  ],
  slashing: [
    '.......kk',
    '......kdk',
    '.....kdk.',
    '....kdk..',
    '.a.kdk...',
    '..akk....',
    '..aa.....',
    '.a..a....',
    'a........',
  ],
  multi: [
    '....r....',
    '...rry...',
    '..rrryy..',
    '.rrrryyy.',
    'ccccggggg',
    '.cccggg..',
    '..ccgg...',
    '...cg....',
    '....g....',
  ],
  heal: [
    '...ggg...',
    '...ggg...',
    '...ggg...',
    'ggggggggg',
    'ggggggggg',
    'ggggggggg',
    '...ggg...',
    '...ggg...',
    '...ggg...',
  ],
  reaction: [
    '.k.kkkk..',
    '.kk....k.',
    '.kkk....k',
    '........k',
    '........k',
    '........k',
    '.k.....k.',
    '..kkkkk..',
    '.........',
  ],
  save: [
    'kkkkkkkkk',
    'k.......k',
    'k..ddd..k',
    'k..ddd..k',
    'k...d...k',
    '.k.....k.',
    '..k...k..',
    '...k.k...',
    '....k....',
  ],
  attack: [
    '....k....',
    '....k....',
    '..kkkkk..',
    '..k...k..',
    'kkk.k.kkk',
    '..k...k..',
    '..kkkkk..',
    '....k....',
    '....k....',
  ],
  abjuration: [
    'ccccccccc',
    'ccccccccc',
    'cccckcccc',
    'ccckkkccc',
    'cccckcccc',
    '.ccccccc.',
    '..ccccc..',
    '...ccc...',
    '....c....',
  ],
  conjuration: [
    '..vvvvv..',
    '.v.....v.',
    'v..vvv..v',
    'v.v...v.v',
    'v.v.v.v.v',
    'v.v.vv..v',
    'v.v....v.',
    '.v.vvvv..',
    '..v......',
  ],
  divination: [
    '.........',
    '...kkk...',
    '.kk...kk.',
    'k..ccc..k',
    'k.ccdcc.k',
    'k..ccc..k',
    '.kk...kk.',
    '...kkk...',
    '.........',
  ],
  enchantment: [
    '.v.......',
    'vvv......',
    '.v...v...',
    '....vvv..',
    '...vvkvv.',
    '....vvv..',
    '.v...v...',
    'vvv......',
    '.v.......',
  ],
  evocation: [
    'a...a...a',
    '.a..a..a.',
    '..a.a.a..',
    '...aya...',
    'aaayyyaaa',
    '...aya...',
    '..a.a.a..',
    '.a..a..a.',
    'a...a...a',
  ],
  illusion: [
    'vvvvvvvvv',
    'vvvvvvvvv',
    'v..vvv..v',
    'v..vvv..v',
    'vvvvvvvvv',
    '.vvvvvvv.',
    '.vv...vv.',
    '..vvvvv..',
    '...vvv...',
  ],
  necromancy: [
    '..ddddd..',
    '.ddddddd.',
    'ddddddddd',
    'dd..d..dd',
    'dd..d..dd',
    'ddddddddd',
    '.ddd.ddd.',
    '..ddddd..',
    '..d.d.d..',
  ],
  transmutation: [
    '....g....',
    '...g.g...',
    '...g.g...',
    '..g...g..',
    '..g.g.g..',
    '.g.ggg.g.',
    '.g.....g.',
    'g.......g',
    'ggggggggg',
  ],
  unknown: [
    '..ddddd..',
    '.dd...dd.',
    '.......dd',
    '......dd.',
    '....ddd..',
    '....dd...',
    '.........',
    '....dd...',
    '....dd...',
  ],
}

/** A class's accent: the frame of its spells' icons and its DC tile's label. Others get the plain edge. */
export function classAccent(cls: string): number {
  const c = cls.toLowerCase()
  if (['sorcerer', 'warlock', 'bard'].includes(c)) return C.slot
  if (['cleric', 'paladin'].includes(c)) return C.gold
  if (['druid', 'ranger'].includes(c)) return C.green
  if (c === 'wizard') return C.temp
  if (c === 'artificer') return C.amber
  return C.edge
}

/** Paints a glyph's letters at (x, y). */
const glyphArt = (p: Painter, rows: string[], x: number, y: number) =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => ch !== '.' && INK[ch] !== undefined && p.rect(x + dx, y + dy, 1, 1, INK[ch] as number)))

export const ICON = 13

/** An action's icon: the glyph on a 13×13 stepped tile, framed in `frame` (a class accent, or the edge). */
export function iconSvg(id: string, frame: number, scale: number): { source: string; width: number; height: number } {
  const p = painter()
  p.stepped(0, 0, ICON, ICON, frame, 2)
  p.stepped(1, 1, ICON - 2, ICON - 2, C.panel, 1)
  glyphArt(p, ICONS[id] ?? ICONS.unknown ?? [], 2, 2)
  return { source: p.svg(ICON, ICON, scale), width: ICON * scale, height: ICON * scale }
}

/** The 7×7 ornaments before a section's name, each in its accent; they sit on the page, so mid tones only. */
const MARKS: Record<string, { rows: string[]; c: number }> = {
  weapons: { rows: ['......d', '.....dd', '....dd.', 'a..dd..', '.add...', '.aa....', 'a..a...'], c: C.dim },
  cantrips: { rows: ['...v...', '...v...', '..vvv..', 'vvvvvvv', '..vvv..', '...v...', '...v...'], c: C.slot },
  slots: { rows: PIP_FULL.map((r) => r.replace(/#/g, 'v')), c: C.slot },
  other: { rows: ['...a...', '..a.a..', '.a...a.', 'a..a..a', '.a...a.', '..a.a..', '...a...'], c: C.amber },
  saves: { rows: ['ggggggg', 'g.....g', 'g.....g', 'g.....g', '.g...g.', '..g.g..', '...g...'], c: C.green },
  rules: { rows: ['...a...', '...a...', 'aaaaaaa', '.aaaaa.', '..aaa..', '.aa.aa.', 'a.....a'], c: C.amber },
  section: { rows: ['.......', '...d...', '..ddd..', '.ddddd.', '..ddd..', '...d...', '.......'], c: C.dim },
}

export const MARK_IDS = Object.keys(MARKS)

/** A section heading's ornament, 7×7 art pixels, no panel. */
export function markSvg(id: string, scale: number): { source: string; width: number; height: number } {
  const p = painter()
  const m = MARKS[id] ?? MARKS.section
  glyphArt(p, m?.rows ?? [], 0, 0)
  return { source: p.svg(7, 7, scale), width: 7 * scale, height: 7 * scale }
}

/**
 * The rule in a section heading: a dotted line in the dim tone, one pixel
 * tall, `W` long. view.ts clips it to the room left on the heading's row, so
 * it ends where the right-aligned numbers end.
 */
export function ruleSvg(W: number, scale: number): { source: string; width: number; height: number } {
  const p = painter()
  for (let x = 0; x < W; x += 2) p.rect(x, 0, 1, 1, C.dim)
  return { source: p.svg(W, 1, scale), width: W * scale, height: scale }
}

/** A two-to-four-letter badge (`CONC`, `RIT`): pixel type on a stepped dark chip, readable on light and dark. */
export function badgeSvg(label: string, scale: number): { source: string; width: number; height: number } {
  const p = painter()
  const t = fontText(label)
  const w = textWidth(t) + 6
  p.stepped(0, 0, w, 9, C.inset, 1)
  p.text(t, 3, 2, 1, C.ink)
  return { source: p.svg(w, 9, scale), width: w * scale, height: 9 * scale }
}

// ------------------------------------------------------------------ raster (terminal)

export type Cell = [ch: string, fg: number, bg: number]

/** The packed `cells` string a Raster takes: per cell, code point, colour, background (uint32, little-endian), base64. */
export function packCells(cells: Cell[]): string {
  const bytes = new Uint8Array(cells.length * 12)
  const view = new DataView(bytes.buffer)
  cells.forEach(([ch, fg, bg], i) => {
    view.setUint32(i * 12, ch.codePointAt(0) ?? 32, true)
    view.setUint32(i * 12 + 4, fg, true)
    view.setUint32(i * 12 + 8, bg, true)
  })
  return base64(bytes)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }
  return out
}

const BLANK: Cell = [' ', DEFAULT, DEFAULT]

/** The HP bar, one row: a '▌' per segment (the half cell is the gap), spent ones a low '▖', temp in cyan. */
export function hpBarCells(current: number, max: number, temp: number, room: number): { columns: number; rows: number; cells: Cell[] } {
  const segs = hpSegments(current, max, temp, room, C.empty)
  return { columns: segs.length, rows: 1, cells: segs.map((c): Cell => (c === C.empty ? ['▖', C.dim, DEFAULT] : ['▌', c, DEFAULT])) }
}

/**
 * Pips in a column `width` cells wide: '█' for each one left, a low '▁' for
 * each one spent, a space between. Past `width`, a meter of '█' and '▁'.
 */
export function pipCells(left: number, max: number, colour: number, width: number): { columns: number; rows: number; cells: Cell[] } {
  const cells: Cell[] = []
  if (max * 2 - 1 <= width) {
    for (let i = 0; i < max; i++) {
      if (i) cells.push(BLANK)
      cells.push(i < left ? ['█', colour, DEFAULT] : ['▁', C.dim, DEFAULT])
    }
  } else {
    const full = Math.round((width * left) / Math.max(1, max))
    for (let i = 0; i < width; i++) cells.push(i < full ? ['█', colour, DEFAULT] : ['▁', C.dim, DEFAULT])
  }
  while (cells.length < width) cells.push(BLANK)
  return { columns: Math.max(1, width), rows: 1, cells: cells.length ? cells : [BLANK] }
}

/**
 * An action's icon in the terminal, two cells: the class accent as a thin bar
 * (blank without one), then one glyph in the icon's colour. The words beside it
 * name the damage type, so the glyph only has to be told apart at a glance.
 */
const TERM_GLYPH: Record<string, [string, number]> = {
  fire: ['▲', C.red], lightning: ['◆', C.gold], thunder: ['◆', C.ink], cold: ['◆', C.temp], acid: ['◆', C.green],
  poison: ['◆', C.green], force: ['◆', C.slot], necrotic: ['◆', C.dim], radiant: ['◆', C.gold], psychic: ['◆', C.slot],
  bludgeoning: ['■', C.ink], piercing: ['▲', C.ink], slashing: ['◢', C.ink], multi: ['◈', C.gold], heal: ['+', C.green],
  reaction: ['↺', C.ink], save: ['◇', C.ink], attack: ['◎', C.ink], abjuration: ['●', C.temp], conjuration: ['●', C.slot],
  divination: ['●', C.temp], enchantment: ['●', C.slot], evocation: ['●', C.amber], illusion: ['●', C.slot],
  necromancy: ['●', C.dim], transmutation: ['●', C.green], unknown: ['?', C.dim],
}

export function iconCells(id: string, accent: number | null): { columns: number; rows: number; cells: Cell[] } {
  const [ch, c] = TERM_GLYPH[id] ?? TERM_GLYPH.unknown ?? ['?', C.dim]
  return { columns: 2, rows: 1, cells: [accent === null ? BLANK : ['▌', accent, DEFAULT], [ch, c, DEFAULT]] }
}

/** A section heading's ornament in the terminal: one cell in the mark's accent. */
const TERM_MARK: Record<string, [string, number]> = {
  weapons: ['◆', C.dim], cantrips: ['◆', C.slot], slots: ['◆', C.slot], other: ['◇', C.amber], saves: ['◆', C.green], rules: ['★', C.amber], section: ['◆', C.dim],
}

export function markCells(id: string): { columns: number; rows: number; cells: Cell[] } {
  const [ch, c] = TERM_MARK[id] ?? TERM_MARK.section ?? ['◆', C.dim]
  return { columns: 1, rows: 1, cells: [[ch, c, DEFAULT]] }
}
