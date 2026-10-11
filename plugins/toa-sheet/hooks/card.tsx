// The hover preview's body (T0093 Layer 3): rows of cells that detail.ts's
// `cardRows` laid out, on the card's ground, a column of padding each side. A
// keyed cell is a term, underlined; the card hit-tests its own moves for it.
// It posts `{card: 'enter' | 'leave', depth}` so the hooks hold the preview
// open (the grace), `{hoverTerm, depth}` after a 400 ms dwell on a term (depth
// 1 only: deeper needs a click), and on a left press `{pressTerm, depth}` or
// `{pressCard: depth}`. A click takes the keyboard (Esc gives it back), so its
// key listener ignores every key. No module-level state: every card shares this module.

import type { ClientSurface } from 'claude-code'
import type { Cell } from './detail.ts'

type CardProps = { depth: number; width: number; rows: Cell[][]; bg: string }
type Span = { y: number; x0: number; x1: number; key: string }
type Rec = { stop: (() => void) | null; on: string | null }

const DWELL_MS = 400
const recs = new WeakMap<object, Rec>()

export default function Card(props: CardProps, s: ClientSurface<{ on: string | null }>) {
  const { Box, Text } = s.elements
  let rec = recs.get(s)
  if (!rec) recs.set(s, (rec = { stop: null, on: null }))
  const r = rec
  const spans: Span[] = []
  props.rows.forEach((row, y) => {
    let x = 1
    for (const c of row) {
      if (c.key) spans.push({ y, x0: x, x1: x + c.text.length, key: c.key })
      x += c.text.length
    }
  })
  const at = (x: number, y: number) => spans.find((sp) => sp.y === y && x >= sp.x0 && x < sp.x1)?.key ?? null
  const stop = () => {
    r.stop?.()
    r.stop = null
  }
  const hot = (key: string | null) => {
    if (key === r.on) return
    r.on = key
    s.setState({ on: key })
  }

  s.onPointer((ev) => {
    if (ev.type === 'enter') s.post({ card: 'enter', depth: props.depth })
    else if (ev.type === 'leave') {
      stop()
      hot(null)
      s.post({ card: 'leave', depth: props.depth })
    } else if (ev.type === 'move' && !ev.button) {
      const key = at(ev.x, ev.y)
      if (key === r.on) return
      hot(key)
      stop()
      if (!key || props.depth > 1) return
      r.stop = s.every(DWELL_MS, () => {
        stop()
        s.post({ hoverTerm: key, depth: props.depth })
      })
    } else if (ev.type === 'down' && ev.button === 'left') {
      stop()
      const key = at(ev.x, ev.y)
      s.post(key ? { pressTerm: key, depth: props.depth } : { pressCard: props.depth })
    }
  })
  s.onKey(() => {})

  const on = s.state?.on ?? null
  const bg = { backgroundColor: props.bg }
  return (
    <Box flexDirection="column" width={props.width}>
      {props.rows.map((row) => {
        const used = row.reduce((n, c) => n + c.text.length, 1)
        return (
          <Box flexDirection="row">
            <Text {...bg}> </Text>
            {row.map((c) => (
              <Text
                {...bg}
                {...(c.bold ? { bold: true } : {})}
                {...(c.dimColor ? { dimColor: true } : {})}
                {...(c.color ? { color: c.color } : {})}
                {...(c.key ? { underline: true, ...(c.key === on ? { inverse: true } : {}) } : {})}
              >
                {c.text}
              </Text>
            ))}
            <Text {...bg}>{''.padEnd(Math.max(0, props.width - used))}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
