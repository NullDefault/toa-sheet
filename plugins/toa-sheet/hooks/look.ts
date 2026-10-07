// The default look: Alien (1979) computer interfaces meet John Provencher.
// One text system for every surface: readout rules between sections, uppercase
// readouts for labels, values in ink, gauges as glyph runs, one phosphor accent
// for what is live. Pure: no mods API, and nothing reads a sheet; view.ts hands
// in the numbers.
//
// The screen is the terminal: the pane paints no background and sets no theme.
// Ink is the host's foreground (no `color`), dim is `dimColor`; only the raw
// colours below are set. Dark is the intended look; a light theme keeps the
// words and loses the colour.

import type { TextProps } from 'claude-code'

/**
 * The raw colours. Phosphor and faint are sampled from the workbench mock the
 * owner chose (factory T0037, `B-workbench-green.png`), which Studio
 * (`journal/`) shares, so the two tools have one green.
 */
export const TOKENS = {
  phosphor: '#4af626',
  amber: '#f0a020',
  alert: '#ff3b30',
  cyan: '#3fc8e0',
  faint: '#6a6a6a',
} as const

/**
 * A receipt's indent in the transcript: the engine's rows carry a `⏺` and two
 * columns of indent, a hook's row carries no bullet, so the verb sits in the
 * text column (probe run 5 showed the detail at column 0 beside an indented
 * engine block).
 */
export const RECEIPT_INDENT = 2

/**
 * How long a changed value stays inverse after a write. Handoff 17: "one
 * 'flash' frame on a changed value (step C: redraw it inverse once, then
 * normal)."
 */
export const FLASH_MS = 800

/** One glyph pair for every gauge. `▮`/`▯` wait for a live check of the players' fonts. */
export const GAUGE = { full: '█', spent: '░' } as const

/** HP's state: phosphor above half, amber to a quarter, alert below. */
export type HpState = 'phosphor' | 'amber' | 'alert'
/** A gauge's full-glyph colour: an HP state, or ink for slots and resources. */
export type Tone = HpState | 'ink'
export type Segment = 'full' | 'spent' | 'temp'

export function hpState(current: number, max: number): HpState {
  const frac = max > 0 ? current / max : 0
  return frac > 0.5 ? 'phosphor' : frac >= 0.25 ? 'amber' : 'alert'
}

/**
 * Segments for current/max plus temp: one per hit point while they fit in
 * `room`, else each stands for several. Temp HP follows the maximum.
 */
export function hpSegments(current: number, max: number, temp: number, room: number): Segment[] {
  const total = Math.max(1, max) + Math.max(0, temp)
  const per = Math.max(1, Math.ceil(total / Math.max(1, room)))
  const n = Math.ceil(total / per)
  const maxSegs = Math.ceil(Math.max(1, max) / per)
  const full = Math.min(Math.ceil(Math.max(0, current) / per), maxSegs)
  return Array.from({ length: n }, (_, i): Segment => (i < full ? 'full' : i < maxSegs ? 'spent' : 'temp'))
}

/** `n` segments, the first `full` of them full, the rest spent. */
export const segments = (full: number, n: number): Segment[] =>
  Array.from({ length: n }, (_, i): Segment => (i < full ? 'full' : 'spent'))

/** The band's HP gauge: `round(current / max × cells)` full, the rest spent. */
export function bandSegments(current: number, max: number, cells = 10): Segment[] {
  const frac = max > 0 ? current / max : 0
  return segments(Math.max(0, Math.min(cells, Math.round(frac * cells))), cells)
}

/** One run of a gauge: the glyphs and the props of the `Text` that draws them. */
export interface Run {
  text: string
  props: TextProps
}

const toneProps = (tone: Tone): TextProps => (tone === 'ink' ? {} : { color: TOKENS[tone] })

/**
 * The `Text` runs for one gauge: full glyphs in the tone's colour, spent ones
 * dim, temp as cyan full glyphs; empty runs dropped. `spaced` puts a space
 * between glyphs (slot and resource pips).
 */
export function gaugeRuns(segments: Segment[], tone: Tone, opts: { spaced?: boolean } = {}): Run[] {
  const sep = opts.spaced ? ' ' : ''
  const runs: Run[] = []
  const add = (seg: Segment, props: TextProps) => {
    const n = segments.filter((s) => s === seg).length
    if (!n) return
    const glyph = seg === 'spent' ? GAUGE.spent : GAUGE.full
    runs.push({ text: (runs.length ? sep : '') + Array(n).fill(glyph).join(sep), props })
  }
  add('full', toneProps(tone))
  add('spent', { dimColor: true })
  add('temp', { color: TOKENS.cyan })
  return runs
}

/**
 * Pips for `left` of `max` in `width` cells: a glyph each with a space between
 * while they fit, else a meter of `width` glyphs without spaces.
 */
export function pipRuns(left: number, max: number, width: number, tone: Tone): Run[] {
  const spaced = max * 2 - 1 <= width
  const n = spaced ? max : width
  const full = spaced ? left : Math.round((width * left) / Math.max(1, max))
  return gaugeRuns(segments(full, n), tone, { spaced })
}

/** A readout rule, `── LABEL ───…`, exactly `columns` characters; `── ───…` without a label. */
export function rule(label: string, columns: number): string {
  const head = label ? `── ${label.toUpperCase()} ` : '── '
  return (head + '─'.repeat(Math.max(0, columns - head.length))).slice(0, columns)
}
