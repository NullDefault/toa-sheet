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
// - a faint readout at the bottom: how fresh the numbers are.
// It draws with look.ts: readout rules between sections, uppercase readouts,
// values in ink, gauges as glyph runs. One tree, two gauge drawings: the
// terminal draws the gauges as glyph runs, the surfaces that have `Svg` draw
// them, and the HP numerals, as pixel instruments (pixel.ts), never a word.
// The surface is read only by `tabProps` and the gauge sites.

import type { ButtonProps, Elements, RenderElement, RenderNode, TextProps } from 'claude-code'
import { describeChange, type Entry } from './sheet.ts'
import { bandSegments, gaugeRuns, hpSegments, hpState, pipRuns, rule, TOKENS, type Run, type Segment, type Tone } from './look.ts'
import { cellsSvg, hpSvg, pipsSvg, type Art } from './pixel.ts'

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

export interface PaneView {
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
function freshness(e: Entry, now: number): string {
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
/** A number that may change on the next read: amber with a `?`. Otherwise bold ink. */
const value = (el: Base, s: string, pending = false) => (pending ? text(el, s + '?', { color: TOKENS.amber }) : text(el, s, { bold: true }))
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

/** Pips in a table: a fixed label column, the pips, the count at a fixed column, a note. */
function pipTable(el: Base, surface: string, rows: Pips[], labelProps: TextProps): RenderNode[] {
  const labelW = Math.min(20, Math.max(1, ...rows.map((r) => r.label.length)))
  const pipW = Math.min(17, Math.max(1, ...rows.map((r) => r.max * 2 - 1)))
  return rows.map((r) =>
    row(el, [
      el.Box({ width: labelW, flexShrink: 0, children: [text(el, r.label, { ...labelProps, wrap: 'wrap' })] }),
      el.Box({ width: pipW, flexShrink: 0, children: [pipsNode(el, surface, r.left, r.max, pipW, 'ink', of(r.left, r.max))] }),
      value(el, `${r.left}/${r.max}`, r.pending),
      ...(r.note ? [dim(el, r.note)] : []),
    ]),
  )
}

/**
 * A weapon line as a player reads it: "+2 · 1d8 bludgeoning". The transcription
 * writes "attack written +2, 1d8 bludgeoning; …"; only that prefix is taken off,
 * the rest follows after a ·. Anything else is shown as written. No bonus is computed.
 */
export function weaponLine(note: string): string {
  const m = /^attack written ([+-]\d+), (.+)$/.exec(note.trim())
  return m ? [m[1], ...(m[2] ?? '').split('; ')].join(' · ') : note
}

/** Actions: what can I roll? Spells by level (slot pips beside each heading, a line per class), then weapons. */
function actionsTab(el: Base, e: Entry, surface: string): RenderNode[] {
  const out: RenderNode[] = []
  const slots = new Map(slotRows(e).map((s) => [s.level, s]))
  const byLevel = new Map<number, Map<string, string[]>>()
  const add = (lvl: number, cls: string, name: string) => {
    const level = byLevel.get(lvl) ?? new Map<string, string[]>()
    level.set(cls, [...(level.get(cls) ?? []), name])
    byLevel.set(lvl, level)
  }
  for (const sc of e.sheet.spellcasting?.by_class ?? []) {
    for (const c of sc.cantrips ?? []) add(0, sc.class, c.name + dmMark(e, c.name))
    for (const sp of sc.spells ?? []) add(sp.level ?? 0, sc.class, sp.name + (sp.always ? ' (always)' : '') + dmMark(e, sp.name))
  }
  const classW = Math.max(0, ...[...byLevel.values()].flatMap((m) => [...m.keys()].map((c) => c.length))) + 1
  const classLine = (cls: string, names: string[]) =>
    el.Box({ flexDirection: 'row', children: [el.Box({ width: classW, flexShrink: 0, children: [dim(el, cls)] }), text(el, names.join(', '), { wrap: 'wrap' })] })
  for (const [lvl, classes] of [...byLevel].sort(([a], [b]) => a - b)) {
    const s = slots.get(lvl)
    const label = lvl === 0 ? 'Cantrips' : `${ORDINAL(String(lvl))} level`
    const pipW = s ? Math.min(17, Math.max(1, s.max * 2 - 1)) : 0
    const pips = s ? [pipsNode(el, surface, s.left, s.max, pipW, 'ink', of(s.left, s.max)), value(el, `${s.left}/${s.max}`, s.pending)] : []
    out.push(section(el, heading(el, label, pips), [...classes].map(([cls, names]) => classLine(cls, names))))
  }
  const other = (e.sheet.spellcasting?.other ?? []).map((x: any) => x.name + dmMark(e, x.name))
  if (other.length) out.push(section(el, heading(el, 'Other magic'), [text(el, other.join(', '), { wrap: 'wrap' })]))
  // Weapons: the items whose transcription note carries the written attack.
  const weapons = (e.sheet.inventory ?? []).filter((i: any) => /\battack\b/i.test(String(i.note ?? '')))
  if (weapons.length) {
    out.push(
      section(
        el,
        heading(el, 'Weapons (as written)'),
        weapons.map((i: any) => row(el, [text(el, i.name, { bold: true }), text(el, weaponLine(String(i.note)), { wrap: 'wrap' })])),
      ),
    )
  }
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

const hpOf = (e: Entry) => {
  const hp = e.sheet.hp ?? {}
  return { current: Number(hp.current ?? 0), max: Number(hp.max ?? 0), temp: Number(hp.temp ?? 0) }
}

// ------------------------------------------------------------------ entry points

/** The pane: identity, vitals, slots, resources, the tab row, the open tab, the freshness readout. */
export function paneTree(el: Els, v: PaneView): RenderElement {
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
  if (rules) kids.push(make({ key: RULES_KEY, label: `★ ${rules} dm rule${rules === 1 ? '' : 's'}`, hotkey: 'm', plain: true }))
  // The alert field: inverse, the MU-TH-UR highlight. The words are the signal, the colour the second one.
  const alert = alertText(e.sheet.conditions ?? [], Number(e.sheet.exhaustion ?? 0))
  if (alert) kids.push(text(el, alert, { color: TOKENS.amber, inverse: true, bold: true, wrap: 'wrap' }))

  // Vitals. On the terminal HP digits are always ink, inverse once HP is in
  // alert; the state colour is on the gauge. Elsewhere the numbers are the
  // pixel instrument, knocked out on an alert plate, and its alt carries them.
  const { current, max, temp } = hpOf(e)
  const state = hpState(current, max)
  const digits = `${current}/${max}`
  const tempText = temp > 0 ? `+${temp} TEMP` : ''
  const room = Math.max(10, v.columns - 2 - 2 - digits.length - 2 - (tempText ? tempText.length + 2 : 0))
  kids.push(
    ruleLine(el, 'Vitals', v.columns),
    pixel(v.surface)
      ? el.Box({ flexDirection: 'row', columnGap: 2, alignItems: 'center', children: [dim(el, 'HP'), svg(el, hpSvg(current, max, temp, state))] })
      : row(
          el,
          [
            dim(el, 'HP'),
            text(el, digits, { bold: true, ...(state === 'alert' ? { inverse: true } : {}) }),
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
  if (slots.length) kids.push(ruleLine(el, 'Slots', v.columns), ...pipTable(el, v.surface, slots, { dimColor: true }))
  const res = resources(e)
  if (res.length) kids.push(ruleLine(el, 'Resources', v.columns), ...pipTable(el, v.surface, res, {}))

  // The tab row and the open tab; a blank row above the tab row and the readout.
  kids.push(
    el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, marginTop: 1, children: tabProps(v.surface, v.tab).map(make) }),
    ruleLine(el, v.tab, v.columns),
    ...tabBody(el, e, v.tab, v.surface),
    el.Box({ marginTop: 1, children: [text(el, freshness(e, v.now), { color: TOKENS.faint, wrap: 'wrap' })] }),
  )
  done()
  return col(el, kids)
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
