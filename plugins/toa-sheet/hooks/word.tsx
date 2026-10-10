// A word with a box (T0093): its label underlined, no width of its own. A left
// press posts `{press: id}`; register.ts's `ui.message` hook opens or closes
// the box (detail.ts `pressWord`). A click takes the keyboard (Esc gives it
// back), so the word's key listener ignores every key. No module-level state:
// every word on the pane shares this module.

import type { ClientSurface } from 'claude-code'

type WordProps = { id: string; label: string; bold?: boolean; dimColor?: boolean; color?: string; inverse?: boolean }

export default function Word(props: WordProps, s: ClientSurface) {
  const { Text } = s.elements
  s.onPointer((ev) => {
    if (ev.type === 'down' && ev.button === 'left') s.post({ press: props.id })
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
