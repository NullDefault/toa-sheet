// The pixel instruments of the surfaces that have `Svg` (Desktop, VS Code,
// mobile): the HP numerals and gauge, and pips. Numerals and cells only, never
// a word: every word stays the host's type. The terminal draws the same
// gauges as glyph runs (look.ts). Pure: no mods API.
//
// Drawn at a fixed integer scale (2 or 4 CSS px per art px) with the markup's
// own width and height, so nothing rescales a stroke. No frame, no panel, no
// bloom: the Svg paints nothing but its pixels. Dark is the intended look; on
// a light theme the pips vanish and the counts beside them stay.

import { hpSegments, noneSegments, segments, TOKENS, type HpState, type Segment, type Tone } from './look.ts'

/** The Svg's own colours, beside look.ts's tokens: the Text tree uses the host's ink and `dimColor` instead. */
const SVG = { ink: '#ededed', dim: '#9a9a9a', void: '#000000' } as const

/** The instrument's width budget in CSS px: the body of a 360 px Desktop pane. */
const MAX_W = 300

/**
 * The numeral font: 5×7, the HD44780 dot-matrix digits (a 1979 instrument's
 * own), a slashed zero, `1` `/` `-` three wide; `—` for a number never
 * written, `~` for one last seen; `L` `V` for the level badge.
 */
export const FONT: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '/': ['..#', '..#', '.#.', '.#.', '.#.', '#..', '#..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '-': ['...', '...', '...', '###', '...', '...', '...'],
  '—': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '~': ['.....', '.....', '.##.#', '#..#.', '.....', '.....', '.....'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
}

/** A character's glyph; an unknown one draws as `?`. */
const glyph = (ch: string) => FONT[ch] ?? FONT['?']!

/** Width in art px: the glyphs' widths plus one between. */
export const textWidth = (s: string) => [...s].reduce((n, ch) => n + glyph(ch)[0]!.length + 1, 0) - 1

/** A drawing: the markup, what it says, its size in CSS px. */
export interface Art {
  source: string
  alt: string
  width: number
  height: number
}

/** Rectangles on an integer grid, merged into one `<path>` per run of a colour. */
export function painter() {
  const runs: { fill: string; d: string }[] = []
  const rect = (x: number, y: number, w: number, h: number, fill: string) => {
    if (w <= 0 || h <= 0) return
    const d = `M${x} ${y}h${w}v${h}h${-w}z`
    const top = runs[runs.length - 1]
    if (top && top.fill === fill) top.d += d
    else runs.push({ fill, d })
  }
  /** Draws `s` with its top-left at (x, y), each art px `scale` CSS px. */
  const text = (s: string, x: number, y: number, scale: number, fill: string) => {
    let gx = 0
    for (const ch of s) {
      const g = glyph(ch)
      g.forEach((bits, row) => {
        for (const m of bits.matchAll(/#+/g)) {
          rect(x + (gx + m.index!) * scale, y + row * scale, m[0].length * scale, scale, fill)
        }
      })
      gx += g[0]!.length + 1
    }
  }
  const svg = (w: number, h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">` +
    runs.map((r) => `<path fill="${r.fill}" d="${r.d}"/>`).join('') +
    '</svg>'
  return { rect, text, svg }
}

const colourOf = (tone: Tone) => (tone === 'ink' ? SVG.ink : TOKENS[tone])

/**
 * Cells `cw`×`ch` art px at scale 2, one art px apart, from (x, y): full solid
 * in the tone, spent a checkerboard of it, temp solid cyan, none a faint floor
 * (never the checkerboard: that is spent). Returns the width.
 */
function cells(p: ReturnType<typeof painter>, segs: Segment[], tone: Tone, x: number, y: number, cw: number, ch: number): number {
  const fill = colourOf(tone)
  segs.forEach((seg, k) => {
    const cx = x + k * (cw + 1) * 2
    if (seg === 'none') return p.rect(cx, y + (ch - 1) * 2, cw * 2, 2, TOKENS.faint)
    if (seg !== 'spent') return p.rect(cx, y, cw * 2, ch * 2, seg === 'temp' ? TOKENS.cyan : fill)
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if ((i + j) % 2 === 0) p.rect(cx + i * 2, y + j * 2, 2, 2, fill)
  })
  return Math.max(0, (segs.length * (cw + 1) - 1) * 2)
}

/** A gauge or pips alone: cells at scale 2. */
export function cellsSvg(segs: Segment[], tone: Tone, cw: number, ch: number, alt: string): Art {
  const p = painter()
  const width = cells(p, segs, tone, 0, 0, cw, ch)
  return { source: p.svg(width, ch * 2), alt, width, height: ch * 2 }
}

/**
 * The HP instrument: the current HP at 4× in the state's colour (knocked out,
 * void on a plate of that colour under a quarter or while `flash`), `/max` dim
 * at 2× on its baseline, temp cyan, then the gauge centred beside it, as many
 * cells as fit in `width` CSS px (4 to 20). Always 36 CSS px high. `seen` puts
 * a faint `~` before a last-seen value; `never` draws a faint `—` and an empty
 * faint gauge (never the checkerboard: that is spent).
 */
export function hpSvg(
  current: number,
  max: number,
  temp: number,
  state: HpState,
  opts: { flash?: boolean; truth?: 'confirmed' | 'seen' | 'never'; width?: number } = {},
): Art {
  const p = painter()
  const never = opts.truth === 'never'
  let x = 0
  if (opts.truth === 'seen') {
    p.text('~', 0, 14, 2, TOKENS.faint)
    x = textWidth('~') * 2 + 4
  }
  const cur = never ? '—' : String(current)
  const heroW = textWidth(cur) * 4
  if (!never && (opts.flash || state === 'alert')) {
    p.rect(x, 0, heroW + 8, 36, TOKENS[state])
    p.text(cur, x + 4, 4, 4, SVG.void)
    x += heroW + 10
  } else {
    p.text(cur, x, 4, 4, never ? TOKENS.faint : TOKENS[state])
    x += heroW + 4
  }
  const rest = '/' + max
  p.text(rest, x, 18, 2, SVG.dim)
  x += textWidth(rest) * 2
  if (temp > 0 && !never) {
    const t = '+' + temp
    p.text(t, x + 6, 18, 2, TOKENS.cyan)
    x += 6 + textWidth(t) * 2
  }
  x += 8
  const room = Math.max(4, Math.min(20, Math.floor(((opts.width ?? MAX_W) - x + 2) / 10)))
  const segs = never ? noneSegments(room) : hpSegments(current, max, temp, room)
  const width = x + cells(p, segs, state, x, 11, 4, 7)
  const alt = never ? `HP not on the sheet, max ${max}` : `HP ${current} of ${max}` + (temp > 0 ? `, +${temp} temp` : '') + (opts.truth === 'seen' ? ', last seen' : '')
  return { source: p.svg(width, 36), alt, width, height: 36 }
}

/**
 * A glance value beside the HP, in its 36 px box: at 4× level with the HP's
 * numerals, or at 2× on its `/max` baseline.
 */
export function readoutSvg(s: string, scale: 2 | 4, tone: Tone, alt: string): Art {
  const p = painter()
  const w = textWidth(s) * scale
  p.text(s, 0, scale === 4 ? 4 : 18, scale, colourOf(tone))
  return { source: p.svg(w, 36), alt, width: w, height: 36 }
}

/** The level badge, 40 CSS px high: a frame round `LV` (dim, 2×) on the baseline of the level (4×). */
export function badgeSvg(lv: string, tone: Tone, alt: string): Art {
  const p = painter()
  const fill = colourOf(tone)
  const numX = 6 + textWidth('LV') * 2 + 6
  const w = numX + textWidth(lv) * 4 + 6
  p.rect(0, 0, w, 2, fill)
  p.rect(0, 38, w, 2, fill)
  p.rect(0, 2, 2, 36, fill)
  p.rect(w - 2, 2, 2, 36, fill)
  p.text('LV', 6, 20, 2, SVG.dim)
  p.text(lv, numX, 6, 4, fill)
  return { source: p.svg(w, 40), alt, width: w, height: 40 }
}

/** Pips: 4×4 cells, one per use while they fit in 10, else a 10-cell meter. */
export function pipsSvg(left: number, max: number, tone: Tone, alt: string): Art {
  const n = Math.min(max, 10)
  const full = n === max ? left : Math.round((10 * left) / max)
  return cellsSvg(segments(full, n), tone, 4, 4, alt)
}
