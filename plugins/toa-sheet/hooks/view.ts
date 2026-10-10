// The element trees: the pane and the band strip, one tree for every surface.
// Everything shown is the server's `sheet` and `derived`; the only arithmetic
// is "left = max − used" for slots, pips and Hit Dice. Pure: the elements come
// in from register.ts, which owns every mods API call and handles the presses.
//
// The pane is built around a player's turn, not the sheet's sections. The top
// is a HUD, always visible and as wide as the body: the level badge, name and
// classes; conditions when there are any; one row of vitals, labels over values
// (AC, HP and its gauge, INIT, SPD, PP); the taps; spell DC and attack per
// caster; the six saves; slots and resources as pips. Under it, the tab rule:
// one tab open at a time, by the player's question: act (what do I roll?),
// skills, feats, gear, notes. A faint `seen 13:19 · [ re-read ]` only when the
// HP is not confirmed, and the last check while it warns.
// It draws with look.ts: uppercase readouts, values in ink, gauges as glyph
// runs. One tree, two drawings: the terminal draws gauges as glyph runs, the
// surfaces that have `Svg` draw them, the HP and the glance values as pixel
// instruments (pixel.ts), never a word. The surface is read only by those sites.
//
// The party view (`/party`, the DM's) is a second tree in the same pane: a row
// per cached sheet, the Table log as seen here, the session, the re-read. While
// a fight is on (fight.ts), its order is drawn above the party; the DM runs it
// by clicks: a row, then a button under it.
//
// The pane is a stack of screens (register.ts owns it): the top one is drawn,
// and `[ ‹ back ]`, top left, pops it. Every action is a drawn Button; a letter
// hotkey is a shortcut for one, never the only way.
//
// `[ look up ]` (T0085) pushes the look: a field whose matches narrow as the
// DM types, then a match's card (lookup.ts), each one more screen on the stack.

import type { ButtonProps, Elements, RenderElement, RenderNode, TextProps } from 'claude-code'
import { actionGroups, type ActionRow } from './actions.ts'
import { detailBox, detailOf, greedy, type Content, type Detail } from './detail.ts'
import { describe, live, onDeck, orderRows, statusText, type Fight, type Member, type Pack, type Row } from './fight.ts'
import type { Candidate, Card, Heard, HeardItem } from './lookup.ts'
import { coinsOf, type Entry, type Save } from './sheet.ts'
import { bandSegments, gaugeRuns, hpSegments, hpState, noneSegments, pipRuns, RECEIPT_INDENT, rule, TOKENS, type HpState, type Run, type Segment, type Tone } from './look.ts'
import { badgeSvg, cellsSvg, hpSvg, pipsSvg, readoutSvg, type Art } from './pixel.ts'
import type { Receipt } from './receipt.ts'
import type { TableLog } from './table.ts'

/** What `$.ui.resolve(e)` hands out, on any surface. */
export type Els = Elements[keyof Elements]

/** The elements every surface has, which the pane draws with. */
type Base = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Markdown'>

/**
 * The tabs, by the player's question. They are words on the tab rule, frameless,
 * so they carry no hotkey (a plain Button draws its hotkey as `a: act`): a click,
 * the focus ring or `/sheet <tab>` opens one; `m` still opens the DM's rules.
 */
export const TABS = [
  { id: 'actions', label: 'act', words: ['actions', 'action', 'act', 'spells', 'attacks'] },
  { id: 'skills', label: 'skills', words: ['skills', 'skill', 'saves', 'save', 'checks'] },
  { id: 'features', label: 'feats', words: ['features', 'feats', 'traits'] },
  { id: 'gear', label: 'gear', words: ['gear', 'inventory', 'items', 'money'] },
  { id: 'notes', label: 'notes', words: ['notes', 'rules', 'character', 'details'] },
] as const
export type TabId = (typeof TABS)[number]['id']

/** The tab a word names (`spells`, `saves`), or null. */
export function tabOf(word: string): TabId | null {
  const w = word.trim().toLowerCase()
  return TABS.find((t) => t.id === w || (t.words as readonly string[]).includes(w))?.id ?? null
}

/** The key of the DM-rules badge, which opens the Notes tab. */
export const RULES_KEY = 'dm-rules'
export const tabKey = (id: TabId) => 'tab-' + id

/**
 * The last re-read: `sheets` the sheets it holds current, `listed` the list answer's length. `off` names the tool
 * `$.tool.check` would ask about: live sync is off until it is allowed. Module state, never stored.
 */
export type Reread = { at: number; sheets: number; listed: number } | { refused: string } | { failed: string } | { off: string }
/** The number field's question: which number, for which row and member, and its text so far. */
export type Ask = { kind: 'damage' | 'heal' | 'init'; row: string; member: number; text: string }
/** The sheet view's number field: damage, healing or coins for the focused sheet, and its text so far. */
export type Tap = { kind: 'damage' | 'heal' | 'coins'; text: string }
/** The add form's five fields, as the DM has filled them so far. */
export type Adding = { name: string; count: string; hp: string; ac: string; init: string }

/** The pane's screens; register.ts keeps them as a stack and draws the top one. `look` is the look's field, `card` a match's card, `log` the whole Table log, `packet` the loaded pack's notes. */
export type Screen = 'party' | 'sheet' | 'packs' | 'look' | 'card' | 'log' | 'packet'

/** The look as drawn: the field's text and its matches, or the open card, its fetch and its page. */
export type LookView = { text: string; matches: Candidate[]; card: Card | null; loading: boolean; error: string | null; page: number }

export interface PaneView {
  screen: Screen
  /** There is a screen under this one: `[ ‹ back ]` is drawn. */
  canBack: boolean
  /** Every cached sheet, in roster order. */
  rows: Entry[]
  /** The session's Table log as seen here, or null. */
  log: TableLog | null
  /** The log entry drawn whole (its index in the log), or null: every entry is one line. */
  logOpen: number | null
  session: string | null
  reread: Reread | null
  entry: Entry | null
  surface: string
  columns: number
  tab: TabId
  /** Milliseconds since the epoch, for the `seen 13:19` readout (a day's date once it is not today). */
  now: number
  /** This machine's last tap is on this sheet and still its version: `[ undo ]` is drawn. */
  undo: boolean
  /**
   * Buttons kept from this surface's last drawing. An unchanged Button is
   * handed back as the same element, so its press handle survives the redraw
   * (each new Button gets a new handle, and the old one is retired).
   */
  memo: Map<string, RenderElement>
  /** The diff paths of the last applied write, while its flash lasts; else null. */
  flash: string[] | null
  /** The DM's fight, or null; drawn on the party view until it ends. */
  fight: Fight | null
  /** The picked row (by id) and, in a group, its member. */
  sel: { row: string; member: number } | null
  /** The open number field, with the row's name for its label. */
  ask: (Ask & { name: string }) | null
  /** The open add form. */
  adding: Adding | null
  /** Why the last press did nothing, until an op applies. */
  note: string | null
  /** The packs read from Prep/Fights.md, for the packs screen; null when there are none. */
  packs: Pack[] | null
  /** The fight on show has a pack loaded: `[ packet ]` is drawn. */
  canPacket: boolean
  /** The pack `[ next ]` loads while no fight is live, or null. */
  nextPack: string | null
  /** The packet screen's pack (null when it is gone from the file) and page. */
  packet: { pack: Pack | null; page: number } | null
  /** The sheet view's open number field, for a tap. */
  tap: Tap | null
  /** The look, while `look` or `card` is on show; else null. */
  look: LookView | null
  /** The Concentration saves the server raised and nobody has answered, by sheet id (register.ts, never stored). */
  saves: Map<string, Save[]>
  /** The live listener's fresh heard file (T0085 stage 2), on the party view; else null. */
  heard: Heard | null
  /** The party's open split field, its text so far; else null. */
  split: string | null
  /** The open detail box (T0093): the word it hangs from; else null. */
  detail: Detail | null
}

/** The fight bar's buttons: [element key, hotkey, label]. The letters are shortcuts. */
const BAR = [['next', 'n', 'next turn'], ['undo', 'u', 'undo'], ['act-a', 'a', 'add'], ['act-c', 'c', 'packs'], ['act-f', 'f', 'end fight']] as const
/** With no fight: add and packs, and undo while the last fight's end can be undone. */
const IDLE = [BAR[2], BAR[3]]
const ENDED = [...IDLE, BAR[1]]
/** The targeted row's buttons, drawn under it in two rows: what changes HP (and the turn), then its state. `sheet` only for a PC with a sheet. */
const STRIP_HP = [['act-d', 'd', 'dmg'], ['act-h', 'h', 'heal'], ['act-t', 't', 'turn']] as const
const STRIP_STATE = [['act-i', 'i', 'init'], ['act-o', 'o', 'out'], ['act-k', 'k', 'down'], ['act-x', 'x', 'kill']] as const
const SHEET = ['act-s', 's', 'sheet'] as const
/** A monster row's card (T0085); no hotkey. */
const STATS = ['act-stats', '', 'stats'] as const
const ADD_FIELDS = [
  ['name', ''], ['count', '1'], ['hp', 'blank: no HP tracked'], ['ac', ''], ['init', ''],
] as const

const signed = (n: unknown) => (typeof n === 'number' ? (n >= 0 ? '+' + n : String(n)) : '?')
const pad2 = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const d = new Date(ms)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const day = (ms: number) => {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(ms)}`
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
const ORDINAL = (l: string) => ({ '1': '1st', '2': '2nd', '3': '3rd' })[l] ?? l + 'th'
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const

// ------------------------------------------------------------------ facts (read off the entry)

const unresolvedName = (name: string, unresolved: string[]) =>
  unresolved.some((u) => u.toLowerCase() === name.toLowerCase() || u.toLowerCase().endsWith(' ' + name.toLowerCase()))

function level(e: Entry): string {
  const total = e.derived?.total_level
  return (typeof total === 'number' ? String(total) : '?') + (e.derivedPending && typeof total === 'number' ? '?' : '')
}

interface Caster {
  cls: string
  dc: string
  attack: string
}

function casters(e: Entry): Caster[] {
  return ((e.derived?.spellcasting ?? []) as any[]).map((c) => ({ cls: String(c.class), dc: String(c.save_dc ?? '?'), attack: String(c.attack ?? '?') }))
}

interface Pips {
  label: string
  left: number
  max: number
  pending: boolean
  /** A slot row's tap: the label is then a Button with this key and hotkey. */
  key?: string
  hotkey?: string
}

/** Slot rows by level, `1` → `{label: '1st', key: 'slot-1', hotkey: '1'}`; pact slots last (`slot-pact`, `p`). */
export function slotRows(e: Entry): (Pips & { level: number })[] {
  const used = e.sheet.spellcasting?.slots_used ?? {}
  const pending = e.derivedPending
  const rows = Object.entries((e.derived?.spell_slots ?? {}) as Record<string, number>)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([lvl, max]) => ({ label: ORDINAL(lvl), level: Number(lvl), max, left: Math.max(0, max - (used[lvl] ?? 0)), pending, key: 'slot-' + lvl, hotkey: lvl }))
  const pact = e.derived?.pact_slots
  if (pact && typeof pact.slots === 'number') {
    const left = Math.max(0, pact.slots - (e.sheet.spellcasting?.pact_slots_used ?? 0))
    rows.push({ label: 'Pact', level: Number(pact.level), max: pact.slots, left, pending, key: 'slot-pact', hotkey: 'p' })
  }
  return rows
}

function resources(e: Entry): Pips[] {
  return (e.sheet.resources ?? []).map((r: any) => ({
    label: String(r.name),
    max: r.max,
    left: Math.max(0, r.max - r.used),
    pending: false,
  }))
}


/** Speeds other than walking: `swim 30`. Walking speed is the SPD stat. */
function otherSpeeds(s: any): string[] {
  const sp = s.speed ?? {}
  return ['swim', 'fly', 'climb', 'burrow'].filter((k) => typeof sp[k] === 'number').map((k) => `${k} ${sp[k]}`)
}

/** The DM's rules that name this thing (a spell, a feature), by whole word. */
function rulesNaming(e: Entry, name: string): number {
  const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
  return (e.sheet.house_rules ?? []).filter((r: any) => re.test(String(r.rule ?? ''))).length
}
/** ★ marks a DM ruling, the same symbol as the header badge. */
const dmMark = (e: Entry, name: string) => (rulesNaming(e, name) ? ' ★' : '')

// ------------------------------------------------------------------ parts

const text = (el: Base, children: string, props: TextProps = {}) => el.Text({ ...props, children: [children] })
const row = (el: Base, children: RenderNode[], gap = 1) => el.Box({ flexDirection: 'row', columnGap: gap, children })
const wrapRow = (el: Base, children: RenderNode[], gap = 2) => el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, children })
const col = (el: Base, children: RenderNode[]) => el.Box({ flexDirection: 'column', children })
const md = (el: Base, lines: string[]) => el.Markdown({ text: lines.join('\n').slice(0, 10000) })
const dim = (el: Base, s: string) => text(el, s, { dimColor: true })
/** `s` cut with `…` to `n` cells, as `wrap: 'truncate-end'` would draw it. */
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…')
/** A gauge: its runs side by side, no gap. */
const gauge = (el: Base, runs: Run[]) => row(el, runs.map((r) => text(el, r.text, r.props)), 0)
/** The surfaces that draw pixel instruments: every one whose table has `Svg`. */
const pixel = (surface: string) => surface !== 'terminal'
/** A pixel instrument, centred on its row. */
const svg = (el: Base, art: Art) => el.Box({ alignSelf: 'center', children: [(el as Elements['desktop']).Svg({ source: art.source, alt: art.alt })] })
/** A gauge (the band's HP): glyph runs on the terminal, cells elsewhere. */
const gaugeNode = (el: Base, surface: string, segs: Segment[], tone: Tone, alt: string) =>
  pixel(surface) ? svg(el, cellsSvg(segs, tone, 4, 4, alt)) : gauge(el, gaugeRuns(segs, tone))
/** Pips for `left` of `max` in `width` columns: glyph runs on the terminal, cells elsewhere. */
const pipsNode = (el: Base, surface: string, left: number, max: number, width: number, tone: Tone, alt: string) =>
  pixel(surface) ? svg(el, pipsSvg(left, max, tone, alt)) : gauge(el, pipRuns(left, max, width, tone))
const of = (left: number, max: number) => `${left} of ${max}`
/**
 * A run of `─` that fills what its row leaves, clipped to one line: a hard-wrapped
 * run cut by its Box, where a truncated one would end in `…`.
 */
const fill = (el: Base, n: number, style: TextProps, marginLeft = 0) =>
  el.Box({ flexGrow: 1, width: 0, height: 1, overflow: 'hidden', marginLeft, children: [text(el, '─'.repeat(Math.max(1, n)), { ...style, wrap: 'wrap' })] })
/** A readout rule across the pane's body: its label, then a fill to the edge. */
function ruleLine(el: Base, label: string, columns: number): RenderNode {
  const r = rule(label, columns)
  const head = r.slice(0, r.lastIndexOf(' ') + 1)
  return el.Box({ flexDirection: 'row', children: [el.Box({ flexShrink: 0, children: [text(el, head, { dimColor: true })] }), fill(el, columns - head.length, { dimColor: true })] })
}
/** A readout rule with a control at its right end; the rule gives way. */
const ruleWith = (el: Base, label: string, columns: number, node: RenderNode) =>
  el.Box({ flexDirection: 'row', columnGap: 1, children: [el.Box({ flexGrow: 1, flexShrink: 1, children: [ruleLine(el, label, columns)] }), el.Box({ flexShrink: 0, children: [node] })] })
/** A section heading inside a tab: a dim uppercase readout, with anything beside it. */
const heading = (el: Base, label: string, extra: RenderNode[] = []) =>
  el.Box({ flexDirection: 'row', columnGap: 2, children: [dim(el, label.toUpperCase()), ...extra] })
/** A section of a tab: its heading, then its lines, no space between. */
const section = (el: Base, head: RenderNode, lines: RenderNode[]) => col(el, [head, ...lines])
/** A number that may change on the next read: amber with a `?`. Otherwise bold ink. Inverse while it flashes. */
const value = (el: Base, s: string, pending = false, flash = false) =>
  text(el, pending ? s + '?' : s, { ...(pending ? { color: TOKENS.amber } : { bold: true }), ...(flash ? { inverse: true } : {}) })
const stat = (el: Base, label: string, s: string, pending = false) => row(el, [dim(el, label), value(el, s, pending)])

/** Does nothing: register.ts's `ui.press` hook acts on every press, with a fresh `$`. */
const NOOP = () => {}

/** Builds the pane's Buttons through the memo, so an unchanged Button is the same element as last time. */
function buttons(el: Base, memo: Map<string, RenderElement>) {
  const used = new Map<string, RenderElement>()
  /** `color` draws the label in that colour (a Text child), as `HOLDING` is violet. */
  const make = (props: Omit<ButtonProps, 'onPress'> & { key: string; label: string; color?: string }): RenderElement => {
    const sig = JSON.stringify(props)
    const { color, ...rest } = props
    const kept = used.get(sig) ?? memo.get(sig) ?? el.Button({ ...rest, ...(color ? { children: [text(el, rest.label, { color })] } : {}), onPress: NOOP })
    used.set(sig, kept)
    return kept
  }
  const done = () => {
    memo.clear()
    for (const [k, v] of used) memo.set(k, v)
  }
  return { make, done }
}
type Make = ReturnType<typeof buttons>['make']

/** A word's look: as the Text it replaces. */
type WordStyle = { bold?: boolean; dimColor?: boolean; color?: string; inverse?: boolean }

/** `detailOf` once per word per render (a view is one render's): the word and its open box share the answer. */
const boxes = new WeakMap<PaneView, Map<string, Content | null>>()
function boxOf(v: PaneView, key: string): Content | null {
  const seen = boxes.get(v) ?? new Map<string, Content | null>()
  boxes.set(v, seen)
  if (!seen.has(key)) seen.set(key, detailOf(key, v.rows, v.entry, v.now))
  return seen.get(key)!
}

/**
 * A word with a box (T0093), `w:<kind>:<subject>`; detail.ts says what its box
 * holds. On the terminal and the desktop it is the word Client (word.tsx), its
 * label underlined; elsewhere a plain Button. A press opens or closes its box;
 * while it is open the word is inverse. With no box it is the Text it replaces
 * (`plain` adds that Text's own props), never underlined.
 */
function word(el: Base, v: PaneView, make: Make, key: string, label: string, style: WordStyle = {}, plain: TextProps = {}): RenderNode {
  if (!boxOf(v, key)) return text(el, label, { ...style, ...plain })
  const s = v.detail?.anchor === key ? { ...style, inverse: !style.inverse } : style
  if (v.surface === 'terminal' || v.surface === 'desktop') return (el as Elements['terminal']).Client({ key, module: './word.tsx', props: { id: key, label, ...s } })
  return make({ key, label, plain: true, ...(s.dimColor ? { dimColor: true } : {}) })
}

/** The open box, as wide as the body, where `owns` claims its word; else nothing. */
function openBox(el: Base, v: PaneView, make: Make, owns: (anchor: string) => boolean): RenderNode[] {
  const a = v.detail?.anchor
  const c = a && owns(a) ? boxOf(v, a) : null
  return c ? [detailBox(el, make, c, v.columns)] : []
}

/**
 * The top line of every screen: `[ ‹ back ]` while there is a screen to go
 * back to, then `[ look up ]` but on the look's own screens, and only where its
 * field can be typed (the phone's table has no Input; see partyTree).
 */
function navLine(el: Base, v: PaneView, make: Make): RenderNode[] {
  const look = v.screen !== 'look' && v.screen !== 'card' && 'Input' in el && v.surface !== 'mobile'
  const kids = [
    ...(v.canBack ? [make({ key: 'back', label: '‹ back', hotkey: '0' })] : []),
    ...(look ? [make({ key: 'look', label: 'look up', hotkey: 'l' })] : []),
    ...(v.screen === 'party' && v.canPacket ? [make({ key: 'act-packet', label: 'packet' })] : []),
  ]
  return kids.length ? [wrapRow(el, kids, 1)] : []
}

/** A field's submit and cancel, under it: `[ apply ]` does what Enter does. */
const goCancel = (el: Base, make: Make, field: string, go: string) =>
  wrapRow(el, [make({ key: field + '-go', label: go }), make({ key: field + '-cancel', label: 'cancel', dimColor: true })])

/** The sheet's Concentration spell is this row's: the name, and the source when the field names one, ignoring case. */
export const holding = (e: Entry, r: ActionRow) => {
  const c = e.sheet.concentration
  const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase()
  return !!c && same(c.spell, r.name) && (!c.source || same(c.source, r.source))
}

/**
 * Actions: the turn menu. Weapons, cantrips, each slot level (its pips beside the heading), other magic; a row per action.
 * A Concentration spell's `CONC` is a press (`conc-<i>`, the row's index across the groups): `HOLDING`, violet, on the held one.
 */
function actionsTab(el: Base, e: Entry, v: PaneView, make: Make): RenderNode[] {
  const slots = new Map(slotRows(e).map((s) => [s.level, s]))
  const groups = actionGroups(e, slots, (name) => rulesNaming(e, name) > 0)
  // The class leads a row only when more than one class casts, so a reader knows whose DC it is.
  const showCls = new Set(groups.flatMap((g) => g.rows.map((r) => r.cls)).filter(Boolean)).size > 1
  let index = 0
  const badge = (r: ActionRow, i: number, b: ActionRow['badges'][number]) =>
    b !== 'conc'
      ? dim(el, b.toUpperCase())
      : holding(e, r)
        ? make({ key: 'conc-' + i, label: 'HOLDING', color: TOKENS.violet })
        : make({ key: 'conc-' + i, label: 'CONC', dimColor: true })
  const actionRow = (r: ActionRow, i = index++) =>
    col(el, [
      el.Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: 1,
        children: [
          wrapRow(
            el,
            [
              ...(r.missing
                ? [text(el, r.name + (r.dm ? ' ★' : ''), { bold: true, wrap: 'wrap' })]
                : [word(el, v, make, 'w:act:' + r.key, r.name, { bold: true }, { wrap: 'wrap' }), ...(r.dm ? [text(el, '★', { bold: true })] : [])]),
              ...(r.always ? [dim(el, 'always')] : []),
              ...r.badges.map((b) => badge(r, i, b)),
            ],
            1,
          ),
          // Damage the sheet does not write is the data's dice: an amber `?` says so.
          ...(r.effect
            ? [el.Box({ flexShrink: 0, flexDirection: 'row', children: [text(el, r.effect, { bold: true }), ...(r.guess ? [text(el, '?', { color: TOKENS.amber })] : [])] })]
            : []),
        ],
      }),
      el.Box({
        paddingLeft: 2,
        children: [
          wrapRow(
            el,
            [
              ...(showCls && r.cls ? [dim(el, r.cls + ' ·')] : []),
              // The lead carries the server's number; while that number may change, amber as `value` draws it.
              ...(r.lead ? [text(el, r.lead, e.derivedPending && r.lead.endsWith('?') ? { color: TOKENS.amber } : {})] : []),
              ...(r.facts.length ? [dim(el, r.facts.join(' · '))] : []),
            ],
          ),
        ],
      }),
      ...openBox(el, v, make, (a) => a === 'w:act:' + r.key),
    ])
  const out = groups.map((g) => {
    const s = g.slots
    const pipW = s ? Math.min(17, Math.max(1, s.max * 2 - 1)) : 0
    const pips = s ? [pipsNode(el, v.surface, s.left, s.max, pipW, 'ink', of(s.left, s.max)), value(el, `${s.left}/${s.max}`, s.pending)] : []
    return section(el, heading(el, g.label, pips), g.rows.map((r) => actionRow(r)))
  })
  if (!out.length) out.push(dim(el, 'No weapons or spells on this sheet.'))
  return out
}

const mark = (el: Base, m: string) => text(el, m, { color: TOKENS.phosphor })

/** Skills: checks, skills (proficiency marked), Hit Dice. The saves and passive Perception are on the HUD. */
function skillsTab(el: Base, e: Entry, v: PaneView, make: Make): RenderNode[] {
  const d = e.derived ?? {}
  const s = e.sheet
  const pend = e.derivedPending
  const checks = wrapRow(el, [dim(el, 'CHECKS'), ...ABILITIES.map((a) => stat(el, a.toUpperCase(), signed(d.modifiers?.[a]), pend))])
  const skillProf = new Map<string, boolean>((s.proficiencies?.skills ?? []).map((k: any) => [String(k.name).toLowerCase(), !!k.expertise]))
  const skills = el.Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    children: Object.entries((d.skills ?? {}) as Record<string, number>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, n]) => {
        const p = skillProf.get(name.toLowerCase())
        return el.Box({
          width: '50%',
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingRight: 2,
          children: [row(el, [word(el, v, make, 'w:skill:' + name, name, p === undefined ? { dimColor: true } : {}), ...(p === undefined ? [] : [mark(el, p ? '◆' : '●')])]), value(el, signed(n), pend)],
        })
      }),
  })
  const hd = Object.entries((d.hit_dice ?? {}) as Record<string, number>).map(([die, n]) => `${die} ${Math.max(0, n - (s.hit_dice_spent?.[die] ?? 0))}/${n}`)
  return [
    checks,
    section(el, heading(el, 'Skills'), [
      skills,
      ...openBox(el, v, make, (a) => a.startsWith('w:skill:')),
      ...(hd.length ? [text(el, `Hit Dice ${hd.join(', ')}`, { wrap: 'wrap' })] : []),
      dim(el, '● proficient · ◆ expertise'),
    ]),
  ]
}

function featuresTab(el: Base, e: Entry): RenderNode[] {
  const s = e.sheet
  const feat = (f: any) => `- **${f.name}**` + (f.from ? ` (${f.from})` : '') + (f.choice ? `: ${f.choice}` : '') + (f.note ? ` — ${f.note}` : '') + dmMark(e, f.name)
  const features = [...(s.feats ?? []).map((f: any) => feat({ ...f, from: f.from ?? 'feat' })), ...(s.features ?? []).map(feat)]
  const subclasses = (s.classes ?? []).filter((c: any) => c.subclass?.name).map((c: any) => `- **${c.subclass.name}** (${c.name} ${c.level})`)
  const pr = s.proficiencies ?? {}
  const prof = (
    [
      ['Armour', pr.armor],
      ['Weapons', pr.weapons],
      ['Tools', pr.tools],
      ['Languages', pr.languages],
    ] as [string, unknown][]
  )
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `- **${k}:** ${(v as string[]).join(', ')}`)
  return [
    ...(subclasses.length ? [section(el, heading(el, 'Subclasses'), [md(el, subclasses)])] : []),
    section(el, heading(el, 'Features'), [md(el, features.length ? features : ['_None._'])]),
    ...(prof.length ? [section(el, heading(el, 'Proficiencies'), [md(el, prof)])] : []),
  ]
}

function gearTab(el: Base, e: Entry): RenderNode[] {
  const s = e.sheet
  const items = (s.inventory ?? []).map(
    (i: any) => `- ${i.name}` + (i.quantity !== 1 ? ` ×${i.quantity}` : '') + (i.attuned ? ' (attuned)' : '') + (i.note ? ` — ${i.note}` : ''),
  )
  const coins = Object.entries((s.currency ?? {}) as Record<string, number>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
  return [section(el, heading(el, 'Inventory'), [md(el, items.length ? items : ['_Nothing written._'])]), text(el, `Money  ${coins.join(', ') || 'none'}`, { bold: true })]
}

/** Notes: the DM's rules first, then who the character is, with unresolved names flagged beside them. */
function notesTab(el: Base, e: Entry): RenderNode[] {
  const s = e.sheet
  const out: RenderNode[] = []
  const rules = (s.house_rules ?? []).map((r: any) => `- ${r.rule}` + (r.by || r.date ? ` _(${[r.by, r.date].filter(Boolean).join(', ')})_` : ''))
  if (rules.length) out.push(section(el, heading(el, '★ DM rules'), [md(el, rules)]))
  const flag = (n: string) => (unresolvedName(n, e.unresolved) ? ' — _not in the rules snapshot_' : '')
  const who: string[] = []
  if (s.species?.name) who.push(`- **Species:** ${s.species.name}${flag(s.species.name)}` + (s.species.note ? ` — ${s.species.note}` : ''))
  if (s.background?.name) who.push(`- **Background:** ${s.background.name}${flag(s.background.name)}`)
  const named = [s.species?.name, s.background?.name].filter(Boolean) as string[]
  const otherUnresolved = e.unresolved.filter((u) => !named.some((n) => unresolvedName(n, [u])))
  if (otherUnresolved.length) who.push(`- **Not in the rules snapshot:** ${otherUnresolved.join(', ')}`)
  for (const [k, v] of Object.entries((s.details ?? {}) as Record<string, string>)) who.push(`- **${k.replace(/_/g, ' ')}:** ${v}`)
  if (who.length) out.push(section(el, heading(el, 'Character'), [md(el, who)]))
  if (s.notes) out.push(section(el, heading(el, 'Sheet notes'), [md(el, [String(s.notes)])]))
  if (!out.length) out.push(dim(el, 'No notes on this sheet.'))
  return out
}

function tabBody(el: Base, e: Entry, tab: TabId, v: PaneView, make: Make): RenderNode[] {
  switch (tab) {
    case 'skills':
      return skillsTab(el, e, v, make)
    case 'features':
      return featuresTab(el, e)
    case 'gear':
      return gearTab(el, e)
    case 'notes':
      return notesTab(el, e)
    default:
      return actionsTab(el, e, v, make)
  }
}

/** Does the flash touch a path this pattern names? */
const flashes = (v: PaneView, re: RegExp) => !!v.flash?.some((p) => re.test(p))
const slotPath = (s: { label: string; level: number }) =>
  s.label === 'Pact' ? /^\/spellcasting\/pact_slots_used(\/|$)/ : new RegExp(`^/spellcasting/slots_used/${s.level}(/|$)`)

/** `CHECK 13:19 · 3 WARNINGS · 5 NOTES`. */
function checkText(c: NonNullable<Entry['check']>): string {
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 'S'}`
  return `CHECK ${clock(c.at)} · ${n(c.warnings, 'WARNING')} · ${n(c.infos, 'NOTE')}`
}

/**
 * How far the pane trusts a sheet's HP. Time passing is no evidence: `seen`
 * when the copy came from an earlier session or a write's diff showed it had
 * missed a version; `never` when the sheet holds no current HP; else confirmed.
 */
export type HpTruth = 'confirmed' | 'seen' | 'never'
export const hpTruth = (e: Entry): HpTruth =>
  typeof e.sheet.hp?.current !== 'number' ? 'never' : e.fromStore || e.drift ? 'seen' : 'confirmed'

export const hpOf = (e: Entry) => {
  const hp = e.sheet.hp ?? {}
  return { current: Number(hp.current ?? 0), max: Number(hp.max ?? 0), temp: Number(hp.temp ?? 0) }
}

// ------------------------------------------------------------------ the HUD (the sheet's top)

/** CSS px a column on the surfaces that draw Svg: the owner's 330 px body is about 46 columns. */
const PX = 7

/** A cell of the vitals row: its dim label over its value, `width` columns; a glance cell grows to share the slack. */
const cell = (el: Base, label: string, width: number, node: RenderNode, grow: boolean) =>
  el.Box({ flexDirection: 'column', width, flexShrink: 0, ...(grow ? { flexGrow: 1 } : {}), children: [dim(el, label), node] })
/** An Svg left in its slot (`svg` centres). */
const art = (el: Base, a: Art) => el.Box({ children: [(el as Elements['desktop']).Svg({ source: a.source, alt: a.alt })] })

/** `CONC BLESS`: the spell the sheet concentrates on, violet words. */
const concTag = (el: Base, e: Entry) => text(el, 'CONC ' + String(e.sheet.concentration.spell).toUpperCase(), { color: TOKENS.violet, wrap: 'truncate-end' })

/**
 * A line per Concentration save the server raised for this sheet, due now:
 * `CON SAVE DC 11 · +5 · BLESS · 4 dmg`, alert, inverse and bold, every number
 * the server's. `[ held ]` drops the line here; `[ lost ]` ends Concentration.
 */
function saveLines(el: Base, v: PaneView, e: Entry, make: Make): RenderNode[] {
  return (v.saves.get(e.id) ?? []).map((s, k) =>
    wrapRow(el, [
      text(el, `CON SAVE DC ${s.dc} · ${signed(s.bonus)} · ${s.spell.toUpperCase()}` + (s.damage !== undefined ? ` · ${s.damage} dmg` : ''), { color: TOKENS.alert, inverse: true, bold: true, wrap: 'wrap' }),
      row(el, [make({ key: `held-${e.id}-${k}`, label: 'held' }), make({ key: `lost-${e.id}-${k}`, label: 'lost' })]),
    ], 1),
  )
}

/**
 * The header: the level badge, the name bold beside it, the classes under the
 * name, and the DM-rules badge (a press away from the notes tab). On Svg
 * surfaces the badge is pixel art, a frame round `LV` and a 4× level; on the
 * terminal an inverse block between half-block caps, `▐LV 2▌`. The schema holds no XP, so no XP bar.
 */
function header(el: Base, v: PaneView, e: Entry, make: Make): RenderNode {
  const lv = level(e)
  const tone: HpState = lv.endsWith('?') ? 'amber' : 'phosphor'
  const classes = (e.sheet.classes ?? []).map((c: any) => `${c.name} ${c.level}`).join(' · ')
  const rules = (e.sheet.house_rules ?? []).length
  const pix = pixel(v.surface)
  const c = TOKENS[tone]
  const badge = pix
    ? art(el, badgeSvg(lv, tone, `Level ${lv}`))
    : row(el, [text(el, '▐', { color: c }), text(el, `LV ${lv}`, { color: c, inverse: true, bold: true }), text(el, '▌', { color: c })], 0)
  return el.Box({
    flexDirection: 'row',
    columnGap: pix ? 2 : 1,
    alignItems: pix ? 'center' : 'flex-start',
    children: [
      el.Box({ flexShrink: 0, children: [badge] }),
      el.Box({
        flexDirection: 'column',
        flexShrink: 1,
        children: [
          text(el, e.name, { bold: true, wrap: 'truncate-end' }),
          ...(classes ? [dim(el, classes)] : []),
          ...(e.sheet.concentration ? [concTag(el, e)] : []),
          ...(rules ? [row(el, [make({ key: RULES_KEY, label: `★ ${rules} dm rule${rules === 1 ? '' : 's'}`, hotkey: 'm' })])] : []),
        ],
      }),
    ],
  })
}

/**
 * The vitals row, labels over values, one strip as wide as the body: AC, HP
 * and its gauge, INIT, SPD, PP. Each glance cell is as wide as its label or
 * value; HP's gauge takes what is left (one cell an HP while they fit), and
 * any room the gauge cannot use is shared evenly by the glance cells. On the
 * terminal HP digits are ink, inverse in alert or while flashing, and the
 * state colour is on the gauge. On Svg surfaces every value is a pixel
 * readout: AC at 4×, the HP's size; INIT, SPD and PP at 4× while HP keeps its
 * smallest gauge (4 cells), else at 2×. A value that may change is amber
 * with a `?`.
 */
function vitals(el: Base, v: PaneView, e: Entry): RenderNode {
  const d = e.derived
  const pend = e.derivedPending || !d
  const { current, max, temp } = hpOf(e)
  const state = hpState(current, max)
  const flash = flashes(v, /^\/hp(\/|$)/)
  const truth = hpTruth(e)
  const glance = [
    { label: 'AC', s: String(e.sheet.ac?.value ?? '?'), pending: false },
    { label: 'INIT', s: signed(d?.initiative), pending: pend },
    { label: 'SPD', s: String(e.sheet.speed?.walk ?? '?'), pending: false },
    { label: 'PP', s: String(d?.passive_perception ?? '?'), pending: pend },
  ].map((g) => ({ ...g, s: g.pending ? g.s + '?' : g.s }))
  const C = v.columns
  // Two columns between the cells on Svg surfaces: readouts end at their last pixel, so one column lets AC and HP touch.
  const gap = pixel(v.surface) ? 2 : 1
  const room = (ws: number[]) => C - gap * glance.length - ws.reduce((n, w) => n + w, 0)
  const row5 = (hp: RenderNode, cells: RenderNode[]) => el.Box({ flexDirection: 'row', columnGap: gap, children: [cells[0]!, hp, ...cells.slice(1)] })

  if (!pixel(v.surface)) {
    const ws = glance.map((g) => Math.max(g.label.length, g.s.length))
    const lead = truth === 'seen' ? [text(el, '~', { color: TOKENS.faint })] : []
    const digits = truth === 'never' ? [text(el, '—', { color: TOKENS.faint }), dim(el, `/${max}`)] : [text(el, `${current}/${max}`, { bold: true, ...(state === 'alert' || flash ? { inverse: true } : {}) })]
    const tempText = temp > 0 && truth !== 'never' ? `+${temp}` : ''
    const used = (truth === 'seen' ? 2 : 0) + (truth === 'never' ? 1 + `/${max}`.length : `${current}/${max}`.length) + 1 + (tempText ? tempText.length + 1 : 0)
    const n = Math.max(4, room(ws) - used)
    const segs = truth === 'never' ? noneSegments(n) : hpSegments(current, max, temp, n)
    const hp = row(el, [
      row(el, [...lead, ...digits], truth === 'seen' ? 1 : 0),
      ...(tempText ? [text(el, tempText, { color: TOKENS.cyan, bold: true })] : []),
      gauge(el, gaugeRuns(segs, state)),
    ])
    const cells = glance.map((g, i) => cell(el, g.label, ws[i]!, text(el, g.s, g.pending ? { color: TOKENS.amber } : { bold: true }), true))
    return row5(cell(el, 'HP', used + segs.length, hp, false), cells)
  }

  // Svg surfaces: INIT, SPD and PP at the largest scale that leaves HP its smallest gauge.
  const hpBase = hpSvg(current, max, temp, state, { flash, truth, width: 0 }).width - 38
  const fit = (scale: 2 | 4) =>
    glance.map((g, i) => {
      const a = readoutSvg(g.s, i === 0 ? 4 : scale, g.pending ? 'amber' : 'ink', `${g.label} ${g.s}`)
      return { g, a, w: Math.max(g.label.length + 1, Math.ceil(a.width / PX)) }
    })
  const big = fit(4)
  const cs = room(big.map((c) => c.w)) * PX >= hpBase + 38 ? big : fit(2)
  const hpArt = hpSvg(current, max, temp, state, { flash, truth, width: room(cs.map((c) => c.w)) * PX })
  const cells = cs.map((c) => cell(el, c.g.label, c.w, art(el, c.a), true))
  return row5(cell(el, 'HP', Math.ceil(hpArt.width / PX), art(el, hpArt), false), cells)
}

/**
 * The six saves in a grid: the abilities over their bonuses, a `SAVE` label at
 * the left. A proficient save is bold with a phosphor `●`, its ability in ink;
 * the others plain, their ability dim.
 */
function saveGrid(el: Base, v: PaneView, e: Entry, make: Make): RenderNode {
  const d = e.derived
  const pend = e.derivedPending || !d
  const prof = new Set<string>(e.sheet.proficiencies?.saves ?? [])
  const w = Math.max(4, Math.floor((v.columns - 6) / 6))
  const lead = (s: string) => el.Box({ width: 6, flexShrink: 0, children: [dim(el, s)] })
  const at = (node: RenderNode) => el.Box({ width: w, flexShrink: 0, children: [node] })
  return col(el, [
    row(el, [lead(''), ...ABILITIES.map((a) => at(word(el, v, make, 'w:save:' + a, a.toUpperCase(), prof.has(a) ? {} : { dimColor: true })))], 0),
    row(
      el,
      [
        lead('SAVE'),
        ...ABILITIES.map((a) => {
          const s = signed(d?.saving_throws?.[a])
          const val = pend ? text(el, s + '?', { color: TOKENS.amber }) : text(el, s, prof.has(a) ? { bold: true } : {})
          return at(row(el, [val, ...(prof.has(a) ? [mark(el, '●')] : [])], 0))
        }),
      ],
      0,
    ),
  ])
}

/** Pips as glyphs: available a phosphor `●`, spent a faint `○`; past 10, a bold `left/max`. Inverse while flashing. */
function pipGlyphs(el: Base, left: number, max: number, flash: boolean): RenderNode {
  const inv = flash ? { inverse: true } : {}
  if (max > 10) return text(el, `${left}/${max}`, { bold: true, ...inv })
  return row(
    el,
    [
      ...(left ? [text(el, '●'.repeat(left), { color: TOKENS.phosphor, ...inv })] : []),
      ...(max - left ? [text(el, '○'.repeat(max - left), { color: TOKENS.faint, ...inv })] : []),
    ],
    0,
  )
}

/**
 * Slots and resources inline, two to a line: a slot is its tap (`[ 1st ]`, its
 * digit a silent shortcut) and its pips; a resource its name and pips, the name
 * faint once all of it is spent. A slot count that may change gets an amber `?`.
 */
function pipCells(el: Base, v: PaneView, e: Entry, make: Make): RenderNode[] {
  const w = Math.max(12, Math.floor((v.columns - 2) / 2))
  const at = (children: RenderNode[]) => el.Box({ width: w, flexShrink: 0, flexDirection: 'row', columnGap: 1, children })
  const slots = slotRows(e).map((s) =>
    at([
      make({ key: s.key!, label: s.label, hotkey: s.hotkey! }),
      pipGlyphs(el, s.left, s.max, flashes(v, slotPath(s))),
      ...(s.pending ? [text(el, '?', { color: TOKENS.amber })] : []),
    ]),
  )
  // A resource's name is a word, cut beforehand to what its cell leaves beside the pips (a Client has no truncation of its own).
  const res = resources(e).map((r, i) =>
    at([
      el.Box({
        flexShrink: 1,
        children: [word(el, v, make, 'w:res:' + i, cut(r.label, w - 1 - (r.max > 10 ? `${r.left}/${r.max}`.length : r.max)), r.left ? {} : { color: TOKENS.faint }, { wrap: 'truncate-end' })],
      }),
      el.Box({ flexShrink: 0, children: [pipGlyphs(el, r.left, r.max, flashes(v, new RegExp(`^/resources/${i}(/|$)`)))] }),
    ]),
  )
  return [...slots, ...res]
}

/**
 * The tab rule: the section rule, its words the tabs, one row that never
 * wraps. The open tab is inverse text (pressing it would do nothing); the
 * others are plain, dim Buttons with no hotkey.
 */
function tabRule(el: Base, v: PaneView, make: Make): RenderNode {
  const faint = (s: string) => el.Box({ flexShrink: 0, children: [text(el, s, { color: TOKENS.faint })] })
  const kids: RenderNode[] = [faint('─ ')]
  TABS.forEach((t, i) => {
    if (i) kids.push(faint(' ─ '))
    kids.push(
      el.Box({
        flexShrink: 0,
        children: [t.id === v.tab ? text(el, ` ${t.label} `, { inverse: true, bold: true }) : make({ key: tabKey(t.id), label: t.label, plain: true, dimColor: true })],
      }),
    )
  })
  kids.push(fill(el, v.columns, { color: TOKENS.faint }, 1))
  return el.Box({ flexDirection: 'row', marginTop: 1, overflow: 'hidden', children: kids })
}

// ------------------------------------------------------------------ entry points

/** The pane: the top screen. The sheet: the HUD, the tab rule, the open tab, the readouts. */
export function paneTree(el: Els, v: PaneView): RenderElement {
  if (v.screen === 'party') return partyTree(el, v)
  if (v.screen === 'packs') return packsTree(el, v)
  if (v.screen === 'packet') return packetTree(el, v)
  if (v.screen === 'log') return logTree(el, v)
  if (v.screen === 'look' || v.screen === 'card') return lookTree(el, v)
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = navLine(el, v, make)
  const e = v.entry
  if (!e) {
    kids.push(
      row(el, [text(el, 'AWAITING SHEET'), text(el, '█', { color: TOKENS.phosphor })]),
      text(el, 'Ask Claude to show your sheet; the pane fills in from its sheet_read result.', { dimColor: true, wrap: 'wrap' }),
    )
    done()
    return col(el, kids)
  }
  kids.push(header(el, v, e, make))
  // The alert field, `⚠ POISONED · EXHAUSTION 1`: inverse amber, the MU-TH-UR highlight. The words are the signal,
  // the colour the second one. Each condition is a word with its box; the line is laid out here, a nowrap row a line.
  const ex = Number(e.sheet.exhaustion ?? 0)
  const alerts = [
    ...(e.sheet.conditions ?? []).map((c: unknown) => ({ key: String(c).toLowerCase(), label: String(c).toUpperCase() })),
    ...(ex > 0 ? [{ key: 'exhaustion', label: `EXHAUSTION ${ex}` }] : []),
  ]
  const alertFlash = flashes(v, /^\/(conditions(\/|$)|exhaustion$)/)
  const loud = { color: TOKENS.amber, inverse: true, bold: true }
  const flashed = alertFlash ? { underline: true } : {}
  const units = alerts.map((a, i) => {
    const head = i ? '' : '⚠ '
    const tail = i < alerts.length - 1 ? ' · ' : ''
    const nodes = [
      ...(head ? [text(el, head, { ...loud, ...flashed })] : []),
      word(el, v, make, `w:cond:${e.id}:${a.key}`, a.label, loud, flashed),
      ...(tail ? [text(el, tail, { ...loud, ...flashed })] : []),
    ]
    return { width: head.length + a.label.length + tail.length, node: el.Box({ flexDirection: 'row', flexShrink: 0, children: nodes }) }
  })
  for (const line of greedy(units, (u) => u.width, v.columns, 0)) kids.push(el.Box({ flexDirection: 'row', children: line.map((u) => u.node) }))
  kids.push(...openBox(el, v, make, (a) => a.startsWith(`w:cond:${e.id}:`)))
  kids.push(...saveLines(el, v, e, make))
  kids.push(vitals(el, v, e))
  const speeds = otherSpeeds(e.sheet)
  if (speeds.length) kids.push(text(el, speeds.join(' · '), { color: TOKENS.faint }))

  // The taps (register.ts): damage and heal at the left; at the right, undo while
  // there is a tap of this machine's to undo, then coins; the number field while one asks,
  // with its apply and cancel. The phone has no Input (see partyTree), so the surface is asked too.
  kids.push(
    el.Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      children: [
        row(el, [make({ key: 'tap-d', label: 'dmg', hotkey: 'd' }), make({ key: 'tap-h', label: 'heal', hotkey: 'h' })]),
        row(el, [...(v.undo ? [make({ key: 'tap-u', label: 'undo', hotkey: 'u' })] : []), make({ key: 'tap-c', label: 'coins' })]),
      ],
    }),
  )
  if (v.note) kids.push(text(el, v.note, { color: TOKENS.amber, wrap: 'wrap' }))
  if (v.tap && 'Input' in el && v.surface !== 'mobile') {
    kids.push(
      el.Input({ key: 'tap-amount', label: `${v.tap.kind} · ${e.name}`, value: v.tap.text, autoFocus: true, submitLabel: 'apply', onSubmit: NOOP }),
      // No number: the server raises the save and its DC after the write (patch 19).
      ...(v.tap.kind === 'damage' && e.sheet.concentration ? [text(el, 'CON save due unless this drops them to 0', { color: TOKENS.violet, wrap: 'wrap' })] : []),
      goCancel(el, make, 'tap', 'apply'),
    )
  }
  const cs = casters(e)
  if (cs.length) kids.push(wrapRow(el, cs.map((c) => row(el, [dim(el, c.cls), stat(el, 'DC', c.dc, e.derivedPending), stat(el, 'ATK', c.attack, e.derivedPending)]))))
  kids.push(saveGrid(el, v, e, make), ...openBox(el, v, make, (a) => a.startsWith('w:save:')))
  const pips = pipCells(el, v, e, make)
  if (pips.length) kids.push(el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: pips }), ...openBox(el, v, make, (a) => a.startsWith('w:res:')))

  // The tab rule, the open tab, and the readouts: when HP is not confirmed, when
  // it was seen and a re-read; the last check's count while it warns.
  const c = e.check
  const truth = hpTruth(e)
  kids.push(tabRule(el, v, make), ...tabBody(el, e, v.tab, v, make))
  const off = v.reread && !('at' in v.reread) ? rereadText(v) : null
  const foot: RenderNode[] = [
    ...(off ? [text(el, off, { color: TOKENS.faint, wrap: 'wrap' })] : []),
    ...(truth !== 'confirmed'
      ? [
          row(el, [
            word(el, v, make, 'w:seen:' + e.id, `seen ${sameDay(e.readAt, v.now) ? clock(e.readAt) : day(e.readAt)}`, { color: TOKENS.faint }),
            text(el, '·', { color: TOKENS.faint }),
            make({ key: 'reread', label: 're-read', hotkey: 'e' }),
          ]),
        ]
      : []),
    ...(c && c.warnings > 0 && c.version === e.version ? [text(el, checkText(c), { color: TOKENS.faint, wrap: 'wrap' })] : []),
  ]
  if (foot.length) kids.push(el.Box({ flexDirection: 'column', marginTop: 1, children: foot }))
  kids.push(...openBox(el, v, make, (a) => a === 'w:seen:' + e.id))
  done()
  return col(el, kids)
}

/** The log's entries a party view shows: the last 3 in a fight, else the last 8; `[ all ]` shows the rest. */
const LOG_FIGHT = 3
const LOG_IDLE = 8
/** The clock's fixed column: `22:31`. */
const CLOCK_W = 5

/**
 * The log's entries from `from` on: a faint clock in a fixed column, top-aligned,
 * and the entry as one plain Button cut with `…`; a press draws it whole in place.
 */
function logRows(el: Base, v: PaneView, make: Make, from: number): RenderNode[] {
  const entries = v.log?.entries ?? []
  const w = Math.max(8, v.columns - CLOCK_W - 1)
  return entries.slice(from).map((t, k) => {
    const i = from + k
    const label = v.logOpen === i || t.text.length <= w ? t.text : t.text.slice(0, w - 1) + '…'
    return el.Box({
      flexDirection: 'row',
      columnGap: 1,
      alignItems: 'flex-start',
      children: [
        el.Box({ width: CLOCK_W, flexShrink: 0, children: [text(el, clock(t.at), { color: TOKENS.faint })] }),
        el.Box({ flexGrow: 1, flexShrink: 1, children: [make({ key: 'log-' + i, label, plain: true })] }),
      ],
    })
  })
}

/** The whole Table log, from `[ all ]`. */
function logTree(el: Els, v: PaneView): RenderElement {
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = [...navLine(el, v, make), ruleLine(el, 'Log', v.columns), ...logRows(el, v, make, 0)]
  done()
  return col(el, kids)
}

/** The faint readout under the party: the last re-read, else the oldest read. */
function rereadText(v: PaneView): string | null {
  const r = v.reread
  if (r && 'refused' in r) return `RE-READ REFUSED · ALLOW ${r.refused}`
  if (r && 'failed' in r) return `RE-READ FAILED · ${r.failed}`
  if (r && 'off' in r) return `LIVE SYNC OFF · ALLOW ${r.off} IN /permissions`
  if (r) return `RE-READ ${clock(r.at)} · SHEETS ${r.sheets} OF ${r.listed}`
  if (!v.rows.length) return null
  const oldest = Math.min(...v.rows.map((e) => e.readAt))
  return sameDay(oldest, v.now) ? `OLDEST READ ${clock(oldest)}` : `OLDEST READ · ${day(oldest)}`
}

/**
 * The party view: the session, a row per sheet (AC, HP, the gauge, PP), the
 * Table log's last entries, the re-read and its readout. HP is drawn by
 * `hpTruth`: never a blank where the pane knows a number; a last-seen value
 * carries a faint `~`, and the re-read moves onto the first section rule while
 * any does.
 *
 * While a fight is on, the status line and the last op come under the
 * session, and `── ORDER` takes `── PARTY`'s place: the PCs not yet in the
 * fight are listed under the order, so none is drawn twice. A click on an Order row's name
 * targets it and draws its buttons under it; a click on a Party name opens that
 * sheet. The number field and the add form are drawn only while asked, where
 * the surface has `Input`, each with its apply and cancel.
 */
function partyTree(el: Els, v: PaneView): RenderElement {
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = navLine(el, v, make)
  const m = v.log?.manifest
  const f = live(v.fight)
  kids.push(
    v.session
      ? row(el, [dim(el, 'SESSION'), text(el, v.session + (m?.title ? ` · ${m.title}` : ''), { wrap: 'wrap' })], 2)
      : text(el, 'NO SESSION · /party S04, or start the Table operation', { dimColor: true, wrap: 'wrap' }),
  )
  if (v.heard) kids.push(heardRow(el, v.heard, v.now, make))
  if (f) {
    kids.push(text(el, statusText(f), { wrap: 'wrap' }))
    const last = f.log[f.log.length - 1]
    if (last) kids.push(dim(el, `${clock(last.at)}  ${last.text}` + (last.working ? `  ${last.working}` : '') + (last.reverted ? '  undone' : '')))
  }
  const bar = f ? BAR : v.fight?.ended ? ENDED : IDLE
  const next = !f && v.nextPack ? [make({ key: 'act-nextpack', label: 'next: ' + (v.nextPack.length > 24 ? v.nextPack.slice(0, 23) + '…' : v.nextPack) })] : []
  kids.push(wrapRow(el, [...bar.map(([key, hotkey, label]) => make({ key, label, hotkey })), ...next, make({ key: 'split', label: 'split gold' })]))
  if (v.note) kids.push(text(el, v.note, { color: TOKENS.amber, wrap: 'wrap' }))
  // The number field, the add form and the split: the ui.input hook in register.ts takes
  // what is entered. The phone's table has no Input (Elements['mobile']), but
  // resolve hands it one that draws an empty Box, so the surface is asked too.
  const inputs = 'Input' in el && v.surface !== 'mobile'
  if (inputs && v.split !== null) {
    kids.push(
      (el as Elements['terminal']).Input({ key: 'split-amount', label: 'split gold · party', value: v.split, autoFocus: true, submitLabel: 'apply', onSubmit: NOOP }),
      goCancel(el, make, 'split', 'apply'),
    )
  }
  if (inputs && v.adding) {
    const form = v.adding
    for (const [field, placeholder] of ADD_FIELDS) {
      kids.push(
        el.Input({
          key: 'add-' + field,
          label: field,
          ...(placeholder ? { placeholder } : {}),
          value: form[field],
          ...(field === 'name' ? { autoFocus: true } : {}),
          submitLabel: field === 'init' ? 'add' : 'next',
          onSubmit: NOOP,
        }),
      )
    }
    kids.push(goCancel(el, make, 'add', 'add'))
  }
  /** Under a row, indented: the number field while it asks about this row, with its apply and cancel. */
  const askFor = (id: string, left: number): RenderNode[] => {
    if (!inputs || !v.ask || v.ask.row !== id) return []
    const members = f?.rows.find((r) => r.id === id)?.members.length ?? 0
    const who = members > 1 ? `${v.ask.name} ${v.ask.member + 1} of ${members}` : v.ask.name
    const submitLabel = v.ask.kind === 'init' ? 'set' : 'apply'
    const field = (el as Elements['terminal']).Input({ key: 'amount', label: `${v.ask.kind} · ${who}`, value: v.ask.text, autoFocus: true, submitLabel, onSubmit: NOOP })
    return [el.Box({ flexDirection: 'column', paddingLeft: left, children: [field, goCancel(el, make, 'amount', 'apply')] })]
  }

  /**
   * A row's name cell: the name as a plain Button (no brackets: the grid's column), `▸` while targeted, which the
   * cell may clip; then a group's ` ×N`, which it never clips (a number we know). The column keeps room for the mark.
   */
  const nameCell = (id: string, label: string, keep = ''): RenderNode[] => [
    el.Box({ flexShrink: 1, minWidth: 0, overflow: 'hidden', children: [make({ key: 'row-' + id, label: (v.sel?.row === id ? '▸' : '') + label, plain: true })] }),
    ...(keep ? [el.Box({ flexShrink: 0, children: [text(el, keep)] })] : []),
  ]
  /** A PC's HP by `hpTruth`: plain; a faint `~` before a last-seen value; a faint `—/max` and an empty gauge when never written. */
  const pcHp = (e: Entry): { gauge: RenderNode; value: RenderNode } => {
    const { current, max } = hpOf(e)
    const truth = hpTruth(e)
    if (truth === 'never') return { gauge: gaugeNode(el, v.surface, noneSegments(), 'ink', `HP not on the sheet, max ${max}`), value: text(el, `—/${max}`, { color: TOKENS.faint }) }
    const hp = hpState(current, max)
    const look = { bold: true, ...(hp === 'alert' ? { inverse: true } : {}) }
    return {
      gauge: gaugeNode(el, v.surface, bandSegments(current, max), hp, `HP ${current} of ${max}` + (truth === 'seen' ? ', last seen' : '')),
      // A last-seen value is a word: its box says when it was seen, with the re-read.
      value: truth === 'seen' ? row(el, [text(el, '~', { color: TOKENS.faint }), word(el, v, make, 'w:seen:' + e.id, `${current}/${max}`, look)], 0) : text(el, `${current}/${max}`, look),
    }
  }
  /** A row's tags, as words: the sheet's conditions and exhaustion (amber), the DM's `req N`, `down`, `out`; last a PC's gold, dim, the first cut at the edge. */
  const tagsOf = (e: Entry | undefined, r: Row | null): RenderNode[] => [
    ...(e ? conditionWords(e) : []).map((w) => word(el, v, make, `w:cond:${e!.id}:${w.startsWith('exhaustion ') ? 'exhaustion' : w}`, w, { color: TOKENS.amber }, { wrap: 'truncate-end' })),
    ...(e && Array.isArray(e.sheet.requests) && e.sheet.requests.length ? [word(el, v, make, 'w:req:' + e.id, `req ${e.sheet.requests.length}`, { color: TOKENS.amber })] : []),
    ...(e?.sheet.concentration ? [concTag(el, e)] : []),
    ...(r?.down ? [text(el, 'down', { color: TOKENS.amber, inverse: true, bold: true })] : []),
    ...(r?.out ? [text(el, 'out', { color: TOKENS.faint })] : []),
    ...(e ? [text(el, `${coinsOf(e.sheet, 'gp')} gp`, { dimColor: true })] : []),
  ]
  /** The open box under a PC's row, when one of its words (HP, a condition, `req`) holds it. */
  const rowBox = (e: Entry) => openBox(el, v, make, (a) => a === 'w:seen:' + e.id || a === 'w:req:' + e.id || a.startsWith(`w:cond:${e.id}:`))
  /** A cell of the grid: a fixed Box width (Desktop's type is proportional, so never padded spaces), cut at its edge. */
  const cell = (width: number, children: RenderNode[], right = false) =>
    el.Box({ width, flexShrink: 0, flexDirection: 'row', overflow: 'hidden', ...(right ? { justifyContent: 'flex-end' } : {}), children })
  const gaugeW = pixel(v.surface) ? GRID.gaugePixel : GRID.gauge
  const acW = pixel(v.surface) ? GRID.acPixel : GRID.ac
  /** One grid row, never wrapped: the turn mark, the name, AC, the gauge and HP (or a group's members across both), init or PP, then the tags, cut at the edge. */
  const gridRow = (nameW: number, mark: RenderNode | null, name: RenderNode[], ac: RenderNode, hp: Hp, last: RenderNode | null, tags: RenderNode[]) =>
    el.Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        cell(GRID.mark, mark ? [mark] : []),
        cell(nameW, name),
        cell(acW, [ac], true),
        ...('span' in hp
          ? [el.Box({ width: gaugeW + 1 + GRID.hp, flexShrink: 0, flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: hp.span })]
          : [cell(gaugeW, hp.gauge ? [hp.gauge] : []), cell(GRID.hp, hp.value ? [hp.value] : [], true)]),
        cell(GRID.last, last ? [last] : [], true),
        ...(tags.length ? [el.Box({ flexDirection: 'row', columnGap: 1, flexShrink: 1, overflow: 'hidden', children: tags })] : []),
      ],
    })
  /** The grid's one faint header: `name AC hp in`, or `PP` out of a fight. */
  const header = (nameW: number, last: string) => {
    const faint = (s: string) => text(el, s, { color: TOKENS.faint })
    return gridRow(nameW, null, [faint('name')], faint('AC'), { gauge: faint('hp'), value: null }, faint(last), [])
  }
  /** The name column: the longest name and room for `▸`, at most what the pane leaves after the other columns. */
  const rest = GRID.mark + acW + gaugeW + GRID.hp + GRID.last + 5
  const nameWidth = (names: string[]) => Math.max(5, Math.min(v.columns - rest, Math.max(4, ...names.map((n) => n.length)) + 1))
  /** `name` cut with `…` to fit `w` cells beside `keep` (a group's ` ×N`, drawn after it by `nameCell`). */
  const fit = (name: string, w: number, keep = '') => (name.length + keep.length <= w ? name : name.slice(0, Math.max(1, w - keep.length - 1)) + '…')

  // While any HP is last seen, the one re-read sits on the first section rule; else at the bottom.
  const reread = make({ key: 'reread', label: 're-read', hotkey: 'e' })
  const seen = v.rows.some((e) => hpTruth(e) === 'seen')
  const sectionRule = (label: string, first: boolean) => (seen && first ? ruleWith(el, label, v.columns, reread) : ruleLine(el, label, v.columns))

  const fought = new Set(f?.rows.map((r) => r.id) ?? [])
  const party = v.rows.filter((e) => !fought.has(e.id))
  if (f) {
    // The PCs appear only here: those not yet in the fight under the order, each with its `[ init ]`.
    kids.push(sectionRule('Order', true))
    const order = orderRows(f)
    const deck = onDeck(f)
    const sheetOf = (r: Row) => (r.side === 'pc' ? v.rows.find((e) => e.id === r.id) : undefined)
    const suffix = (r: Row) => (r.members.length > 1 ? ` ×${r.members.length}` : '')
    const base = (r: Row) => sheetOf(r)?.name ?? r.name
    const nameW = nameWidth([...order.map((r) => base(r) + suffix(r)), ...party.map((e) => e.name)])
    const w = nameW - 1
    kids.push(header(nameW, 'in'))
    for (const r of order) {
      const e = sheetOf(r)
      const on = v.sel?.row === r.id
      const mark = f.pointer === r.id ? text(el, '▶', { bold: true, color: TOKENS.phosphor }) : deck === r.id ? text(el, '▷', { color: TOKENS.amber }) : null
      const ac = text(el, e ? String(e.sheet.ac?.value ?? '?') : r.ac === null ? '?' : String(r.ac), { bold: true })
      // No members and no sheet: no HP tracked, which tonight is a player without a sheet.
      const hp = e ? pcHp(e) : monsterHp(el, v.surface, r, on ? v.sel!.member : null, make)
      kids.push(gridRow(nameW, mark, nameCell(r.id, fit(base(r), w, suffix(r)), suffix(r)), ac, hp, text(el, r.init === null ? '?' : String(r.init)), tagsOf(e, r)))
      if (e) kids.push(...saveLines(el, v, e, make), ...rowBox(e))
      // The targeted row's buttons, under it in two rows; then its number field.
      if (on) {
        const strip = (keys: readonly (readonly [string, string, string])[]) => wrapRow(el, keys.map(([key, hotkey, label]) => make({ key, label, ...(hotkey ? { hotkey } : {}) })), 1)
        const extra = e ? [SHEET] : r.side === 'pc' ? [] : [STATS]
        kids.push(el.Box({ flexDirection: 'column', paddingLeft: 5, children: [strip([...STRIP_HP, ...extra]), strip(STRIP_STATE)] }))
      }
      kids.push(...askFor(r.id, 5))
    }
    // A PC not yet in the fight: its `[ init ]` stands in the gauge's cell until it joins.
    for (const e of party) {
      const ac = text(el, String(e.sheet.ac?.value ?? '?'), { bold: true })
      const join = make({ key: 'init-' + e.id, label: 'init', dimColor: true })
      kids.push(gridRow(nameW, null, nameCell(e.id, fit(e.name, w)), ac, { gauge: join, value: pcHp(e).value }, null, tagsOf(e, null)), ...rowBox(e))
      kids.push(...saveLines(el, v, e, make))
      kids.push(...askFor(e.id, 5))
    }
  } else {
    kids.push(sectionRule('Party', true))
    const nameW = nameWidth(v.rows.map((e) => e.name))
    if (v.rows.length) kids.push(header(nameW, 'PP'))
    for (const e of v.rows) {
      const ac = text(el, String(e.sheet.ac?.value ?? '?'), { bold: true })
      const pp = value(el, String(e.derived?.passive_perception ?? '?'), e.derivedPending || !e.derived)
      kids.push(gridRow(nameW, null, nameCell(e.id, fit(e.name, nameW - 1)), ac, pcHp(e), pp, tagsOf(e, null)), ...rowBox(e))
      kids.push(...saveLines(el, v, e, make))
    }
  }
  if (!v.rows.length) {
    kids.push(
      row(el, [text(el, 'AWAITING SHEETS'), text(el, '█', { color: TOKENS.phosphor })]),
      text(el, 're-read reads every sheet this connector serves, or ask Claude to.', { dimColor: true, wrap: 'wrap' }),
    )
  }

  const entries = v.log?.entries ?? []
  if (entries.length) {
    const from = Math.max(0, entries.length - (f ? LOG_FIGHT : LOG_IDLE))
    kids.push(from ? ruleWith(el, 'Log', v.columns, make({ key: 'log-all', label: 'all' })) : ruleLine(el, 'Log', v.columns))
    kids.push(...logRows(el, v, make, from))
  }

  if (!seen) kids.push(el.Box({ flexDirection: 'row', marginTop: 1, children: [reread] }))
  const readout = rereadText(v)
  if (readout) kids.push(text(el, readout, { color: TOKENS.faint, wrap: 'wrap' }))
  done()
  return col(el, kids)
}

/** The packs screen: a button per pack in Prep/Fights.md; a press loads it and returns to Party. */
function packsTree(el: Els, v: PaneView): RenderElement {
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = [...navLine(el, v, make), ruleLine(el, 'Packs', v.columns)]
  ;(v.packs ?? []).forEach((p, k) => {
    kids.push(wrapRow(el, [make({ key: 'pack-' + (k + 1), label: `${p.name} · ${p.rows.length} group${p.rows.length === 1 ? '' : 's'}` })]))
  })
  if (v.note) kids.push(text(el, v.note, { color: TOKENS.amber, wrap: 'wrap' }))
  done()
  return col(el, kids)
}

/** A card's body lines a page: the pane does not scroll (the surface does), so a long card pages by `[ more ]`. */
export const CARD_PAGE = 30

/** The packet screen: the pack's name, its groups dim, then its notes, each under its heading, paged as a card is. */
function packetTree(el: Els, v: PaneView): RenderElement {
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = navLine(el, v, make)
  const p = v.packet?.pack
  if (p) {
    kids.push(ruleLine(el, p.name, v.columns))
    for (const add of p.rows) kids.push(text(el, describe(add, null), { dimColor: true, wrap: 'wrap' }))
    const body = p.notes.flatMap((s) => [ruleLine(el, s.heading, v.columns), ...s.lines.map((line) => text(el, line.replace(/\*\*|__/g, ''), { wrap: 'wrap' }))])
    const pages = Math.max(1, Math.ceil(body.length / CARD_PAGE))
    const page = (v.packet?.page ?? 0) % pages
    if (body.length) kids.push(el.Box({ flexDirection: 'column', marginTop: 1, children: body.slice(page * CARD_PAGE, (page + 1) * CARD_PAGE) }))
    if (pages > 1) kids.push(wrapRow(el, [make({ key: 'pkt-more', label: `more (${((page + 1) % pages) + 1}/${pages})` })]))
  }
  if (v.note) kids.push(text(el, v.note, { color: TOKENS.amber, wrap: 'wrap' }))
  done()
  return col(el, kids)
}

/**
 * The look's screens. The field: the Input, up to five matches (the top one
 * phosphor, Enter's), `no match`, and `[ ask Claude ]` once there is text. The
 * card: the title, the meta faint, a page of the body, `[ more (2/3) ]`, the
 * fetch's state, the cite, `[ ask Claude ]`.
 */
function lookTree(el: Els, v: PaneView): RenderElement {
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = navLine(el, v, make)
  const l = v.look ?? { text: '', matches: [], card: null, loading: false, error: null, page: 0 }
  const ask = (hotkey?: string) => wrapRow(el, [make({ key: 'look-ask', label: 'ask Claude', ...(hotkey ? { hotkey } : {}) })])
  if (v.screen === 'look' || !l.card) {
    if ('Input' in el && v.surface !== 'mobile') {
      kids.push(el.Input({ key: 'look-field', label: 'look up', placeholder: 'spell, condition or monster', value: l.text, autoFocus: true, submitLabel: 'open', onSubmit: NOOP }))
    }
    // No hotkeys here: letters go into the field.
    l.matches.forEach((c, i) => kids.push(wrapRow(el, [make({ key: `look-${i + 1}`, label: c.name, ...(i === 0 ? { variant: 'primary' as const } : {}) })])))
    if (l.text.trim() && !l.matches.length) kids.push(dim(el, 'no match'))
    if (l.text.trim()) kids.push(ask())
    done()
    return col(el, kids)
  }
  const c = l.card
  kids.push(text(el, c.title, { bold: true, wrap: 'wrap' }))
  for (const m of c.meta) kids.push(text(el, m, { dimColor: true, wrap: 'wrap' }))
  const pages = Math.max(1, Math.ceil(c.body.length / CARD_PAGE))
  const page = l.page % pages
  if (c.body.length) {
    kids.push(
      el.Box({ flexDirection: 'column', marginTop: 1, children: c.body.slice(page * CARD_PAGE, (page + 1) * CARD_PAGE).map((line) => text(el, line, { wrap: 'wrap' })) }),
    )
  }
  if (pages > 1) kids.push(wrapRow(el, [make({ key: 'look-more', label: `more (${((page + 1) % pages) + 1}/${pages})` })]))
  if (l.loading) kids.push(dim(el, 'fetching…'))
  else if (l.error) kids.push(dim(el, l.error))
  if (c.cite) kids.push(dim(el, c.cite))
  kids.push(ask('q'))
  done()
  return col(el, kids)
}

/** A grid row's HP: a gauge and its value, or a group's members across both columns. */
type Hp = { gauge: RenderNode | null; value: RenderNode | null } | { span: RenderNode[] }

/**
 * The party grid's fixed columns, in character cells. The gauge is ten glyphs on the terminal and a 98 px Svg elsewhere;
 * there AC takes a column more, so a name's pill and the `AC` header never reach its digits.
 */
const GRID = { mark: 1, ac: 2, acPixel: 3, gauge: 10, gaugePixel: 14, hp: 7, last: 3 } as const

/** A sheet's conditions as the grid's tags: lowercase words, and `exhaustion N`. */
const conditionWords = (e: Entry): string[] => {
  const words = (e.sheet.conditions ?? []).map((c: unknown) => String(c).toLowerCase())
  const ex = Number(e.sheet.exhaustion ?? 0)
  return ex > 0 ? [...words, `exhaustion ${ex}`] : words
}

/** A monster's HP: a single one's gauge and `hp/max`, `0?` or `✕`; a group's members as buttons, `[ 22 ] [ 13 ] [ 0? ]`, the targeted one primary; none with no HP tracked. */
function monsterHp(el: Base, surface: string, r: Row, picked: number | null, make: Make): Hp {
  const one = (m: Member) => (m.dead ? '✕' : m.zero ? '0?' : String(m.hp))
  if (r.members.length > 1) {
    return { span: r.members.map((m, i) => make({ key: `mem-${r.id}-${i}`, label: one(m), ...(i === picked ? { variant: 'primary' as const } : {}) })) }
  }
  const m = r.members[0]
  if (!m) return { gauge: null, value: null }
  if (m.dead || m.zero) return { gauge: null, value: text(el, one(m), { bold: true }) }
  const hp = hpState(m.hp, m.max)
  return { gauge: gaugeNode(el, surface, bandSegments(m.hp, m.max), hp, `HP ${m.hp} of ${m.max}`), value: text(el, `${m.hp}/${m.max}`, { bold: true, ...(hp === 'alert' ? { inverse: true } : {}) }) }
}

/** How long ago something was heard: `4s` under a minute, then `3m`. */
const heardAge = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m`)

/**
 * The HEARD row (T0085 stage 2): the newest three names the table said, newest
 * first, each a Button to its card with its age; then ask Claude about what was
 * just said, the only press that sends the heard text.
 */
function heardRow(el: Els, h: Heard, now: number, make: Make): RenderNode {
  return col(el, [
    wrapRow(el, [
      text(el, 'HEARD', { color: TOKENS.cyan, bold: true }),
      ...h.items.slice(0, 3).map((x, i) => make({ key: `heard-${i + 1}`, label: `${x.name} ${heardAge(now - x.at)}` })),
    ], 1),
    wrapRow(el, [make({ key: 'heard-ask', label: 'ask Claude about what was just said' })]),
  ])
}

/** The band's heard line: `HEARD Hold Person · 4s`, while the newest name is under a minute old. */
export const heardBand = (el: Els, x: HeardItem, now: number): RenderElement =>
  row(el, [text(el, 'HEARD', { color: TOKENS.cyan, bold: true }), text(el, `${x.name} · ${heardAge(now - x.at)}`)])

/** The band strip, while the pane is closed: name, a 10-cell HP gauge, HP, slots, the key hint. */
export function bandTree(el: Els, e: Entry, surface: string): RenderElement {
  const { current, max, temp } = hpOf(e)
  const kids: RenderNode[] = [
    text(el, e.name, { bold: true }),
    gaugeNode(el, surface, bandSegments(current, max), hpState(current, max), `HP ${current} of ${max}`),
    row(el, [text(el, `${current}/${max}`), ...(temp > 0 ? [text(el, `+${temp}`, { color: TOKENS.cyan })] : [])]),
  ]
  const slots = slotRows(e)
  if (slots.length) {
    const left = slots.reduce((n, s) => n + s.left, 0)
    const total = slots.reduce((n, s) => n + s.max, 0)
    // width = total: on the terminal, one unspaced cell per slot, as before
    kids.push(pipsNode(el, surface, left, total, total, 'ink', of(left, total)))
  }
  kids.push(text(el, '/sheet', { dimColor: true }))
  return row(el, kids)
}

/**
 * A connector call's row in the transcript: the verb readout in a ten-column
 * box, then the words. One line, the same on every surface; an error's verb is
 * the alert field's amber inverse, a running call's words are dim.
 */
export function receiptTree(el: Els, r: Receipt): RenderElement {
  const verbProps: TextProps = r.state === 'error' ? { color: TOKENS.amber, inverse: true, bold: true, wrap: 'truncate' } : { dimColor: true, wrap: 'truncate' }
  return el.Box({
    flexDirection: 'row',
    columnGap: 1,
    paddingLeft: RECEIPT_INDENT,
    children: [el.Box({ width: 10, flexShrink: 0, children: [text(el, r.verb, verbProps)] }), text(el, r.body, { wrap: 'wrap', ...(r.state === 'running' ? { dimColor: true } : {}) })],
  })
}

/** A receipt's result block (ctrl+o): the detail lines dim, then Claude Code's own block, last and once. */
export function detailTree(el: Els, r: Receipt, engine: RenderNode): RenderElement {
  return el.Box({ flexDirection: 'column', paddingLeft: RECEIPT_INDENT, children: [...r.detail.map((l) => text(el, l, { dimColor: true, wrap: 'wrap' })), engine] })
}
