// A word with a box (T0093): its label underlined, no width of its own. A left
// press posts `{press: id}`; register.ts's `ui.message` hook opens or closes
// the box (detail.ts `pressWord`), or pins the word's preview. With `hover`
// (Layer 3: a word off the HUD, the header rows and /party), the pointer's
// entry posts `{enter: id}`, 400 ms of rest on it `{hover: id}`, and its
// leaving `{unhover: id}`. A click takes the keyboard (Esc gives it back), so the
// word's key listener ignores every key. No module-level state: every word on
// the pane shares this module.

import type { ClientSurface } from 'claude-code'

type WordProps = { id: string; label: string; hover?: boolean; bold?: boolean; dimColor?: boolean; color?: string; inverse?: boolean }
type Rec = { stop: (() => void) | null }

const DWELL_MS = 400
const recs = new WeakMap<object, Rec>()

export default function Word(props: WordProps, s: ClientSurface) {
  const { Text } = s.elements
  let rec = recs.get(s)
  if (!rec) recs.set(s, (rec = { stop: null }))
  const r = rec
  const stop = () => {
    r.stop?.()
    r.stop = null
  }
  s.onPointer((ev) => {
    if (ev.type === 'down' && ev.button === 'left') {
      stop()
      s.post({ press: props.id })
    } else if (!props.hover) return
    else if (ev.type === 'enter') {
      stop()
      r.stop = s.every(DWELL_MS, () => {
        stop()
        s.post({ hover: props.id })
      })
      s.post({ enter: props.id })
    } else if (ev.type === 'leave') {
      stop()
      s.post({ unhover: props.id })
    }
  })
  s.onKey(() => {})
  const style = {
    ...(props.bold ? { bold: true } : {}),
    ...(props.dimColor ? { dimColor: true } : {}),
    ...(props.color ? { color: props.color } : {}),
    ...(props.inverse ? { inverse: true } : {}),
  }
  return <Text underline {...style}>{props.label}</Text>
}
