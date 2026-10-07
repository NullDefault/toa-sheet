// The element trees: the pane and the band strip, one tree for every surface.
// Everything shown is the server's `sheet` and `derived`; the only arithmetic
// is "left = max − used" for slots, pips and Hit Dice. Pure: the elements come
// in from register.ts, which owns every mods API call and handles the presses.
//
// The pane is built around a player's turn, not the sheet's sections:
// - always visible: name and level, conditions when there are any, HP, AC ·
//   INIT · SPD, spell DC and attack per caster, slots, resources;
// - one row of tabs, one open at a time, by the player's question: actions
//   (what do I roll?), saves and skills, features, gear, notes;
// - faint readouts at the bottom: how fresh the numbers are, and the last check.
// It draws with look.ts: readout rules between sections, uppercase readouts,
// values in ink, gauges as glyph runs. One tree, two gauge drawings: the
// terminal draws the gauges as glyph runs, the surfaces that have `Svg` draw
// them, and the HP numerals, as pixel instruments (pixel.ts), never a word.
// The surface is read only by `tabProps` and the gauge sites.
//
// The party view (`/party`, the DM's) is a second tree in the same pane: a row
// per cached sheet, the Table log as seen here, the session, the re-read. While
// a fight is on (fight.ts), its order is drawn above the party; the entry line
// the DM types it in sits at the bottom.

import type { ButtonProps, Elements, RenderElement, RenderNode, TextProps } from 'claude-code'
import { actionGroups, type ActionRow } from './actions.ts'
import { GRAMMAR, live, orderRows, statusText, type Fight, type Member, type Row } from './fight.ts'
import { describeChange, type Entry } from './sheet.ts'
import { bandSegments, gaugeRuns, hpSegments, hpState, pipRuns, RECEIPT_INDENT, rule, TOKENS, type Run, type Segment, type Tone } from './look.ts'
import { cellsSvg, hpSvg, pipsSvg, type Art } from './pixel.ts'
import type { Receipt } from './receipt.ts'
import { stale, type TableLog } from './table.ts'

/** What `$.ui.resolve(e)` hands out, on any surface. */
export type Els = Elements[keyof Elements]

/** The elements every surface has, which the pane draws with. */
type Base = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Markdown'>

/** The tabs, by the player's question. Hotkeys leave `d h r u t` free for later taps. */
export const TABS = [
  { id: 'actions', label: 'actions', hotkey: 'a', words: ['actions', 'action', 'spells', 'attacks'] },
  { id: 'saves', label: 'saves', hotkey: 's', words: ['saves', 'save', 'skills', 'checks'] },
  { id: 'features', label: 'features', hotkey: 'f', words: ['features', 'feats', 'traits'] },
  { id: 'gear', label: 'gear', hotkey: 'g', words: ['gear', 'inventory', 'items', 'money'] },
  { id: 'notes', label: 'notes', hotkey: 'n', words: ['notes', 'rules', 'character', 'details'] },
] as const
export type TabId = (typeof TABS)[number]['id']

/** The tab a word names (`spells`, `saves`, `g`), or null. */
export function tabOf(word: string): TabId | null {
  const w = word.trim().toLowerCase()
  return TABS.find((t) => t.id === w || t.hotkey === w || (t.words as readonly string[]).includes(w))?.id ?? null
}

/** The key of the DM-rules badge, which opens the Notes tab. */
export const RULES_KEY = 'dm-rules'
export const tabKey = (id: TabId) => 'tab-' + id

/** The last re-read: `sheets` the gets that answered, `listed` the list answer's length. Module state, never stored. */
export type Reread = { at: number; sheets: number; listed: number } | { refused: string } | { failed: string }

export interface PaneView {
  view: 'sheet' | 'party'
  /** Every cached sheet, in roster order. */
  rows: Entry[]
  /** The session's Table log as seen here, or null. */
  log: TableLog | null
  session: string | null
  reread: Reread | null
  entry: Entry | null
  surface: string
  columns: number
  tab: TabId
  /** Milliseconds since the epoch, for the freshness readout ("READ 13:19" on the day it was read). */
  now: number
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
  /** The entry line's text as typed, so a redraw keeps a half-typed line. */
  typed: string
  /** Why the last typed line was refused, until a line applies. */
  refused: string | null
}

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
const RECHARGE: Record<string, string> = { short: 'short rest', long: 'long rest', dawn: 'dawn', none: 'no recharge' }
const ORDINAL = (l: string) => ({ '1': '1st', '2': '2nd', '3': '3rd' })[l] ?? l + 'th'
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const

// ------------------------------------------------------------------ facts (read off the entry)

const unresolvedName = (name: string, unresolved: string[]) =>
  unresolved.some((u) => u.toLowerCase() === name.toLowerCase() || u.toLowerCase().endsWith(' ' + name.toLowerCase()))

function level(e: Entry): string {
  const total = e.derived?.total_level
  return (typeof total === 'number' ? String(total) : '?') + (e.derivedPending && typeof total === 'number' ? '?' : '')
}

/** `Lv 2 · Sorcerer 1 · Cleric 1`: level once, classes without subclasses (those are in Features). */
function identityLine(e: Entry): string {
  const classes = (e.sheet.classes ?? []).map((c: any) => `${c.name} ${c.level}`)
  return [`Lv ${level(e)}`, ...classes].join(' · ')
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
  note?: string
}

/** Slot rows by level, `1` → `{label: '1st'}`; pact slots last. */
function slotRows(e: Entry): (Pips & { level: number })[] {
  const used = e.sheet.spellcasting?.slots_used ?? {}
  const pending = e.derivedPending
  const rows = Object.entries((e.derived?.spell_slots ?? {}) as Record<string, number>)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([lvl, max]) => ({ label: ORDINAL(lvl), level: Number(lvl), max, left: Math.max(0, max - (used[lvl] ?? 0)), pending }))
  const pact = e.derived?.pact_slots
  if (pact && typeof pact.slots === 'number') {
    const left = Math.max(0, pact.slots - (e.sheet.spellcasting?.pact_slots_used ?? 0))
    rows.push({ label: 'Pact', level: Number(pact.level), max: pact.slots, left, pending })
  }
  return rows
}

function resources(e: Entry): Pips[] {
  return (e.sheet.resources ?? []).map((r: any) => ({
    label: String(r.name),
    note: RECHARGE[r.recharge] ?? String(r.recharge ?? ''),
    max: r.max,
    left: Math.max(0, r.max - r.used),
    pending: false,
  }))
}

/** The alert field: `⚠ POISONED · EXHAUSTION 1`, or '' when there is nothing to say. */
export function alertText(conditions: unknown[], exhaustion: number): string {
  const list = conditions.map((c) => String(c).toUpperCase())
  if (exhaustion > 0) list.push(`EXHAUSTION ${exhaustion}`)
  return list.length ? '⚠ ' + list.join(' · ') : ''
}

/** Speeds other than walking: `swim 30`. Walking speed is the SPD stat. */
function otherSpeeds(s: any): string[] {
  const sp = s.speed ?? {}
  return ['swim', 'fly', 'climb', 'burrow'].filter((k) => typeof sp[k] === 'number').map((k) => `${k} ${sp[k]}`)
}

/**
 * The faint readout: "CHANGED 13:20 · NOT RE-READ" after a write, "READ 13:19"
 * on the day it was read, "LAST KNOWN · 3 OCT, 13:19" after that. It goes by
 * when the sheet was read, not by which session read it, so a module reload
 * changes nothing. The change itself stays as written.
 */
export function freshness(e: Entry, now: number): string {
  const pend = e.derivedPending ? ' · NUMBERS MARKED ? MAY CHANGE' : ''
  if (e.refreshing) return `CHANGED ${clock(e.seenAt)} · NOT RE-READ` + (e.last ? ' · ' + describeChange(e.last, e.sheet) : '') + pend
  return (sameDay(e.readAt, now) ? `READ ${clock(e.readAt)}` : `LAST KNOWN · ${day(e.readAt)}`) + pend
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
/** A readout rule across the pane's body. */
const ruleLine = (el: Base, label: string, columns: number) => text(el, rule(label, columns), { dimColor: true, wrap: 'truncate' })
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
  const make = (props: Omit<ButtonProps, 'onPress'> & { key: string; label: string }): RenderElement => {
    const sig = JSON.stringify(props)
    const kept = used.get(sig) ?? memo.get(sig) ?? el.Button({ ...props, onPress: NOOP })
    used.set(sig, kept)
    return kept
  }
  const done = () => {
    memo.clear()
    for (const [k, v] of used) memo.set(k, v)
  }
  return { make, done }
}

/**
 * The tab row, one row: lowercase words, a hotkey each. The open tab is marked
 * by more than colour. A plain Button draws the same whatever its variant
 * (ButtonProps), so Desktop gets real buttons with the open one `primary`, and
 * the terminal gets plain ones with `▸` before the open tab's label and the
 * others dim. The engine's button chrome forces this one surface branch.
 */
export function tabProps(surface: string, tab: TabId) {
  const terminal = surface === 'terminal'
  return TABS.map((t) => {
    const open = t.id === tab
    return {
      key: tabKey(t.id),
      label: terminal && open ? '▸' + t.label : t.label,
      hotkey: t.hotkey,
      ...(terminal ? { plain: true as const } : {}),
      ...(open ? (terminal ? {} : { variant: 'primary' as const }) : { dimColor: true }),
    }
  })
}

/** Pips in a table: a fixed label column, the pips, the count at a fixed column (inverse while flashing), a note. */
function pipTable(el: Base, surface: string, rows: Pips[], labelProps: TextProps, flashing: Set<number>): RenderNode[] {
  const labelW = Math.min(20, Math.max(1, ...rows.map((r) => r.label.length)))
  const pipW = Math.min(17, Math.max(1, ...rows.map((r) => r.max * 2 - 1)))
  return rows.map((r, i) =>
    row(el, [
      el.Box({ width: labelW, flexShrink: 0, children: [text(el, r.label, { ...labelProps, wrap: 'wrap' })] }),
      el.Box({ width: pipW, flexShrink: 0, children: [pipsNode(el, surface, r.left, r.max, pipW, 'ink', of(r.left, r.max))] }),
      value(el, `${r.left}/${r.max}`, r.pending, flashing.has(i)),
      ...(r.note ? [dim(el, r.note)] : []),
    ]),
  )
}

/** Actions: the turn menu. Weapons, cantrips, each slot level (its pips beside the heading), other magic; a row per action. */
function actionsTab(el: Base, e: Entry, surface: string): RenderNode[] {
  const slots = new Map(slotRows(e).map((s) => [s.level, s]))
  const groups = actionGroups(e, slots, (name) => rulesNaming(e, name) > 0)
  // The class leads a row only when more than one class casts, so a reader knows whose DC it is.
  const showCls = new Set(groups.flatMap((g) => g.rows.map((r) => r.cls)).filter(Boolean)).size > 1
  const actionRow = (r: ActionRow) =>
    col(el, [
      el.Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: 1,
        children: [
          wrapRow(
            el,
            [
              text(el, r.name + (r.dm ? ' ★' : ''), { bold: true, wrap: 'wrap' }),
              ...(r.always ? [dim(el, 'always')] : []),
              ...r.badges.map((b) => dim(el, b.toUpperCase())),
            ],
            1,
          ),
          ...(r.effect ? [el.Box({ flexShrink: 0, children: [text(el, r.effect, { bold: true })] })] : []),
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
      ...(r.written ? [el.Box({ paddingLeft: 2, children: [dim(el, 'Sheet: ' + r.written)] })] : []),
    ])
  const out = groups.map((g) => {
    const s = g.slots
    const pipW = s ? Math.min(17, Math.max(1, s.max * 2 - 1)) : 0
    const pips = s ? [pipsNode(el, surface, s.left, s.max, pipW, 'ink', of(s.left, s.max)), value(el, `${s.left}/${s.max}`, s.pending)] : []
    return section(el, heading(el, g.label, pips), g.rows.map(actionRow))
  })
  if (!out.length) out.push(dim(el, 'No spells or written attacks on this sheet.'))
  return out
}

const mark = (el: Base, m: string) => text(el, m, { color: TOKENS.phosphor })

/** Saves & skills: the six saves (proficiency marked), checks, skills, passive Perception, Hit Dice. */
function savesTab(el: Base, e: Entry): RenderNode[] {
  const d = e.derived ?? {}
  const s = e.sheet
  const pend = e.derivedPending
  const prof = new Set(s.proficiencies?.saves ?? [])
  const saves = el.Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    children: ABILITIES.map((a) =>
      el.Box({
        width: 12,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          text(el, a.toUpperCase(), prof.has(a) ? {} : { dimColor: true }),
          value(el, signed(d.saving_throws?.[a]), pend),
          ...(prof.has(a) ? [mark(el, '●')] : []),
        ],
      }),
    ),
  })
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
          children: [row(el, [text(el, name, p === undefined ? { dimColor: true } : {}), ...(p === undefined ? [] : [mark(el, p ? '◆' : '●')])]), value(el, signed(n), pend)],
        })
      }),
  })
  const hd = Object.entries((d.hit_dice ?? {}) as Record<string, number>).map(([die, n]) => `${die} ${Math.max(0, n - (s.hit_dice_spent?.[die] ?? 0))}/${n}`)
  return [
    section(el, heading(el, 'Saving throws'), [saves, checks]),
    section(el, heading(el, 'Skills'), [
      skills,
      text(el, `Passive Perception ${d.passive_perception ?? '?'}${pend ? '?' : ''}` + (hd.length ? ` · Hit Dice ${hd.join(', ')}` : ''), { wrap: 'wrap' }),
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

function tabBody(el: Base, e: Entry, tab: TabId, surface: string): RenderNode[] {
  switch (tab) {
    case 'saves':
      return savesTab(el, e)
    case 'features':
      return featuresTab(el, e)
    case 'gear':
      return gearTab(el, e)
    case 'notes':
      return notesTab(el, e)
    default:
      return actionsTab(el, e, surface)
  }
}

/** Does the flash touch a path this pattern names? */
const flashes = (v: PaneView, re: RegExp) => !!v.flash?.some((p) => re.test(p))
/** The indexes of the rows whose pattern the flash touches. */
const flashing = (v: PaneView, patterns: RegExp[]) => new Set(patterns.flatMap((re, i) => (flashes(v, re) ? [i] : [])))
const slotPath = (s: { label: string; level: number }) =>
  s.label === 'Pact' ? /^\/spellcasting\/pact_slots_used(\/|$)/ : new RegExp(`^/spellcasting/slots_used/${s.level}(/|$)`)

/** `CHECK 13:19 · 3 WARNINGS · 5 NOTES`. */
function checkText(c: NonNullable<Entry['check']>): string {
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 'S'}`
  return `CHECK ${clock(c.at)} · ${n(c.warnings, 'WARNING')} · ${n(c.infos, 'NOTE')}`
}

const hpOf = (e: Entry) => {
  const hp = e.sheet.hp ?? {}
  return { current: Number(hp.current ?? 0), max: Number(hp.max ?? 0), temp: Number(hp.temp ?? 0) }
}

// ------------------------------------------------------------------ entry points

/** The pane: identity, vitals, slots, resources, the tab row, the open tab, the freshness readout. */
export function paneTree(el: Els, v: PaneView): RenderElement {
  if (v.view === 'party') return partyTree(el, v)
  const e = v.entry
  if (!e) {
    return col(el, [
      row(el, [text(el, 'AWAITING SHEET'), text(el, '█', { color: TOKENS.phosphor })]),
      text(el, 'Ask Claude to show your sheet; the pane fills in from its sheet_read result.', { dimColor: true, wrap: 'wrap' }),
    ])
  }
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = [wrapRow(el, [text(el, e.name, { bold: true }), text(el, identityLine(e), { dimColor: true, wrap: 'wrap' })])]

  // The DM-rules badge, a press away from the Notes tab.
  const rules = (e.sheet.house_rules ?? []).length
  // Beside it, the way to the party view, once there is more than this sheet to show.
  const showParty = v.rows.length > 1 || v.log !== null
  const badges = [
    ...(rules ? [make({ key: RULES_KEY, label: `★ ${rules} dm rule${rules === 1 ? '' : 's'}`, hotkey: 'm', plain: true })] : []),
    ...(showParty ? [make({ key: 'view-party', label: 'party', hotkey: '0', plain: true })] : []),
  ]
  if (badges.length) kids.push(wrapRow(el, badges))
  // The alert field: inverse, the MU-TH-UR highlight. The words are the signal, the colour the second one.
  const alert = alertText(e.sheet.conditions ?? [], Number(e.sheet.exhaustion ?? 0))
  const alertFlash = flashes(v, /^\/(conditions(\/|$)|exhaustion$)/)
  if (alert) kids.push(text(el, alert, { color: TOKENS.amber, inverse: true, bold: true, ...(alertFlash ? { underline: true } : {}), wrap: 'wrap' }))

  // Vitals. On the terminal HP digits are always ink, inverse once HP is in
  // alert; the state colour is on the gauge. Elsewhere the numbers are the
  // pixel instrument, knocked out on an alert plate, and its alt carries them.
  const { current, max, temp } = hpOf(e)
  const state = hpState(current, max)
  const hpFlash = flashes(v, /^\/hp(\/|$)/)
  const digits = `${current}/${max}`
  const tempText = temp > 0 ? `+${temp} TEMP` : ''
  const room = Math.max(10, v.columns - 2 - 2 - digits.length - 2 - (tempText ? tempText.length + 2 : 0))
  kids.push(
    ruleLine(el, 'Vitals', v.columns),
    pixel(v.surface)
      ? el.Box({ flexDirection: 'row', columnGap: 2, alignItems: 'center', children: [dim(el, 'HP'), svg(el, hpSvg(current, max, temp, state, { flash: hpFlash }))] })
      : row(
          el,
          [
            dim(el, 'HP'),
            text(el, digits, { bold: true, ...(state === 'alert' || hpFlash ? { inverse: true } : {}) }),
            gauge(el, gaugeRuns(hpSegments(current, max, temp, room), state)),
            ...(tempText ? [text(el, tempText, { color: TOKENS.cyan, bold: true })] : []),
          ],
          2,
        ),
  )
  const pending = e.derivedPending || !e.derived
  const speeds = otherSpeeds(e.sheet)
  kids.push(
    wrapRow(el, [
      stat(el, 'AC', String(e.sheet.ac?.value ?? '?')),
      stat(el, 'INIT', signed(e.derived?.initiative), pending),
      row(el, [stat(el, 'SPD', String(e.sheet.speed?.walk ?? '?')), ...(speeds.length ? [dim(el, speeds.join(', '))] : [])]),
    ]),
  )
  const cs = casters(e)
  if (cs.length) kids.push(wrapRow(el, cs.map((c) => row(el, [dim(el, c.cls), stat(el, 'DC', c.dc, e.derivedPending), stat(el, 'ATK', c.attack, e.derivedPending)]))))
  const slots = slotRows(e)
  if (slots.length) kids.push(ruleLine(el, 'Slots', v.columns), ...pipTable(el, v.surface, slots, { dimColor: true }, flashing(v, slots.map(slotPath))))
  const res = resources(e)
  const resPaths = res.map((_, i) => new RegExp(`^/resources/${i}(/|$)`))
  if (res.length) kids.push(ruleLine(el, 'Resources', v.columns), ...pipTable(el, v.surface, res, {}, flashing(v, resPaths)))

  // The tab row and the open tab; a blank row above the tab row and the readouts
  // (freshness, then the last check's count: bookkeeping, faint unless it warns).
  const c = e.check
  kids.push(
    el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, marginTop: 1, children: tabProps(v.surface, v.tab).map(make) }),
    ruleLine(el, v.tab, v.columns),
    ...tabBody(el, e, v.tab, v.surface),
    el.Box({
      flexDirection: 'column',
      marginTop: 1,
      children: [
        text(el, freshness(e, v.now), { color: TOKENS.faint, wrap: 'wrap' }),
        ...(c && c.warnings > 0 && c.version === e.version ? [text(el, checkText(c), { color: TOKENS.faint, wrap: 'wrap' })] : []),
      ],
    }),
  )
  done()
  return col(el, kids)
}

/** `TABLE LOG · OPEN · 3 ENTRIES SEEN`, `· CLOSED 13:52`; `· NONE YET` with a session and nothing seen. */
function logState(session: string | null, log: TableLog | null): string | null {
  if (!session) return null
  const n = log?.entries.length ?? 0
  const closed = log?.closedAt ? ` · CLOSED ${clock(log.closedAt)}` : log?.manifest?.tableExists ? ' · CLOSED' : ''
  if (!n && !closed) return 'TABLE LOG · NONE YET'
  return `TABLE LOG · ${closed ? '' : 'OPEN · '}${n} ENTR${n === 1 ? 'Y' : 'IES'} SEEN` + closed
}

/** The faint readout under the party: the last re-read, else the oldest read. */
function rereadText(v: PaneView): string | null {
  const r = v.reread
  if (r && 'refused' in r) return `RE-READ REFUSED · ALLOW ${r.refused}`
  if (r && 'failed' in r) return `RE-READ FAILED · ${r.failed}`
  if (r) return `RE-READ ${clock(r.at)} · SHEETS ${r.sheets} OF ${r.listed}`
  if (!v.rows.length) return null
  const oldest = Math.min(...v.rows.map((e) => e.readAt))
  return sameDay(oldest, v.now) ? `OLDEST READ ${clock(oldest)}` : `OLDEST READ · ${day(oldest)}`
}

/**
 * The party view: the session, the log's state, a row per sheet (AC, HP, the
 * gauge, PP), the Table log's last entries, the re-read and its readout. A
 * sheet not confirmed in the last 15 minutes is drawn hollow: its current HP
 * unknown, the gauge empty, its freshness under the name.
 *
 * While a fight is on, the status line, the last typed line and `next`/`undo`
 * take the log state's place, and `── ORDER` comes above `── PARTY`: the PCs in
 * the fight move into it, so none is drawn twice. The entry line is last, where
 * the surface has `Input`; the grammar beneath it after a refusal or with no fight.
 */
function partyTree(el: Els, v: PaneView): RenderElement {
  const { make, done } = buttons(el, v.memo)
  const kids: RenderNode[] = []
  const m = v.log?.manifest
  const f = live(v.fight)
  kids.push(
    v.session
      ? row(el, [dim(el, 'SESSION'), text(el, v.session + (m?.title ? ` · ${m.title}` : ''), { wrap: 'wrap' })], 2)
      : text(el, 'NO SESSION · /party S04, or start the Table operation', { dimColor: true, wrap: 'wrap' }),
  )
  const state = logState(v.session, v.log)
  if (f) {
    kids.push(text(el, statusText(f), { wrap: 'wrap' }))
    const last = f.log[f.log.length - 1]
    if (last) kids.push(dim(el, `${clock(last.at)}  ${last.text}` + (last.working ? `  ${last.working}` : '') + (last.reverted ? '  undone' : '')))
    kids.push(row(el, [make({ key: 'next', label: 'next', hotkey: 'n', plain: true }), make({ key: 'undo', label: 'undo', hotkey: 'u', plain: true })], 2))
  } else if (state) kids.push(text(el, state, { dimColor: true, wrap: 'wrap' }))

  /** A PC's name as the party view's button, hotkey 1–9 by roster position, padded to `w`. */
  const pcButton = (e: Entry, w: number) => {
    const i = v.rows.indexOf(e)
    const name = e.name.slice(0, w)
    const pad = w - name.length
    return row(el, [make({ key: 'pc-' + e.id, label: name, ...(i < 9 ? { hotkey: String(i + 1) } : {}), plain: true }), ...(pad ? [text(el, ' '.repeat(pad))] : [])], 0)
  }
  /** A PC's HP and gauge, from the sheet; hollow when stale. */
  const pcHp = (e: Entry): RenderNode[] => {
    const { current, max } = hpOf(e)
    const hollow = stale(e.readAt, v.now)
    const hp = hpState(current, max)
    return [
      text(el, hollow ? `—/${max}` : `${current}/${max}`, { bold: true, ...(!hollow && hp === 'alert' ? { inverse: true } : {}) }),
      hollow
        ? gaugeNode(el, v.surface, bandSegments(0, max), 'ink', `HP unknown, max ${max}`)
        : gaugeNode(el, v.surface, bandSegments(current, max), hp, `HP ${current} of ${max}`),
    ]
  }
  /** Under a PC's row, indented: its freshness when hollow, its alert field. */
  const pcNotes = (e: Entry, left: number): RenderNode[] => {
    const indent = (node: RenderNode) => el.Box({ paddingLeft: left, children: [node] })
    const notes: RenderNode[] = []
    if (stale(e.readAt, v.now)) notes.push(indent(text(el, freshness(e, v.now), { color: TOKENS.faint, wrap: 'wrap' })))
    const alert = alertText(e.sheet.conditions ?? [], Number(e.sheet.exhaustion ?? 0))
    if (alert) notes.push(indent(text(el, alert, { color: TOKENS.amber, inverse: true, bold: true, wrap: 'wrap' })))
    return notes
  }

  const fought = new Set(f?.rows.map((r) => r.id) ?? [])
  if (f) {
    kids.push(ruleLine(el, 'Order', v.columns))
    const order = orderRows(f)
    const sheetOf = (r: Row) => (r.side === 'pc' ? v.rows.find((e) => e.id === r.id) : undefined)
    const drawn = (r: Row) => sheetOf(r)?.name ?? (r.members.length > 1 ? `${r.name} ×${r.members.length}` : r.name)
    const w = Math.min(14, Math.max(1, ...order.map((r) => drawn(r).length)))
    for (const r of order) {
      const e = sheetOf(r)
      const acting = f.pointer === r.id
      const name = drawn(r).slice(0, w)
      const sheetAc = e ? String(e.sheet.ac?.value ?? '?') : '?'
      const ac =
        r.side === 'pc' && r.ac !== null
          ? row(el, [dim(el, 'AC'), row(el, [text(el, sheetAc + '→'), value(el, String(r.ac))], 0)])
          : stat(el, 'AC', r.side === 'pc' ? sheetAc : r.ac === null ? '?' : String(r.ac))
      kids.push(
        el.Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 2,
          children: [
            row(el, [
              text(el, (acting ? '▶ ' : '  ') + (r.init === null ? '?' : String(r.init)).padStart(2)),
              r.side === 'pc' ? text(el, '◆', { color: TOKENS.phosphor }) : text(el, '▲', { dimColor: true }),
              e ? pcButton(e, w) : text(el, name.padEnd(w), { wrap: 'truncate', ...(acting ? { bold: true } : {}) }),
            ]),
            ac,
            ...(e ? pcHp(e) : r.side === 'monster' ? monsterHp(el, v.surface, r) : []),
            ...(r.down ? [text(el, '▒DOWN▒', { color: TOKENS.amber, inverse: true, bold: true })] : []),
            ...(r.out ? [dim(el, 'OUT')] : []),
          ],
        }),
      )
      if (e) kids.push(...pcNotes(e, w + 12))
    }
  }

  const party = v.rows.filter((e) => !fought.has(e.id))
  if (party.length || !f) kids.push(ruleLine(el, 'Party', v.columns))
  const nameW = Math.min(12, Math.max(1, ...v.rows.map((e) => e.name.length)))
  for (const e of party) {
    kids.push(
      el.Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 2,
        children: [
          pcButton(e, nameW),
          stat(el, 'AC', String(e.sheet.ac?.value ?? '?')),
          ...pcHp(e),
          stat(el, 'PP', String(e.derived?.passive_perception ?? '?'), e.derivedPending || !e.derived),
        ],
      }),
      ...pcNotes(e, nameW + 5),
    )
  }
  if (!v.rows.length) {
    kids.push(
      row(el, [text(el, 'AWAITING SHEETS'), text(el, '█', { color: TOKENS.phosphor })]),
      text(el, 'Press e to read every sheet this connector serves, or ask Claude to.', { dimColor: true, wrap: 'wrap' }),
    )
  }

  const entries = v.log?.entries ?? []
  if (entries.length) {
    kids.push(ruleLine(el, 'Table log', v.columns))
    if (entries.length > 8) kids.push(dim(el, `${entries.length - 8} earlier`))
    for (const t of entries.slice(-8)) kids.push(row(el, [dim(el, clock(t.at)), text(el, t.text, { wrap: 'wrap' })], 2))
  }

  kids.push(el.Box({ flexDirection: 'row', marginTop: 1, children: [make({ key: 'reread', label: 're-read', hotkey: 'e', plain: true })] }))
  const readout = rereadText(v)
  if (readout) kids.push(text(el, readout, { color: TOKENS.faint, wrap: 'wrap' }))

  // The entry line: the ui.input hook in register.ts applies what is typed. The
  // phone's table has no Input (Elements['mobile']), but resolve hands it one
  // that draws an empty Box, so the surface is asked too.
  if ('Input' in el && v.surface !== 'mobile') {
    const placeholder = 'm3 -9 · nux 16 · smoke mephit x6 hp 22 ac 12'
    kids.push(el.Box({ marginTop: 1, children: [el.Input({ key: 'entry', label: 'entry', placeholder, value: v.typed, autoFocus: true, submitLabel: 'apply', onSubmit: NOOP })] }))
    if (v.refused) kids.push(text(el, v.refused, { color: TOKENS.amber, wrap: 'wrap' }))
    if (v.refused || !f) kids.push(...GRAMMAR.map((g) => text(el, g, { dimColor: true, wrap: 'wrap' })))
  }
  done()
  return col(el, kids)
}

/** A monster's HP: a single one's `hp/max` and gauge, `0?` or `✕`; a group's members as a run, `22 13 0? ✕`. */
function monsterHp(el: Base, surface: string, r: Row): RenderNode[] {
  const one = (m: Member) => (m.dead ? '✕' : m.zero ? '0?' : String(m.hp))
  if (r.members.length > 1) return [text(el, r.members.map(one).join(' '))]
  const m = r.members[0]!
  if (m.dead || m.zero) return [text(el, one(m), { bold: true })]
  return [text(el, `${m.hp}/${m.max}`, { bold: true }), gaugeNode(el, surface, bandSegments(m.hp, m.max), hpState(m.hp, m.max), `HP ${m.hp} of ${m.max}`)]
}

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
