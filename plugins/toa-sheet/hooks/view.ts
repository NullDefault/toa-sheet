// The element trees: the pane (both kinds of surface) and the band strip.
// Everything shown is the server's `sheet` and `derived`; the only arithmetic
// is "left = max − used" for slots, pips and Hit Dice. Pure: the elements come
// in from register.ts, which owns every mods API call and handles the presses.
//
// The pane is built around a player's turn, not the sheet's sections:
// - the HUD, always visible: name and level, conditions when there are any,
//   HP as the hero, AC · INIT · SPD · spell DC and attack per caster, slot
//   pips, resources;
// - one row of tabs, one open at a time, by the player's question: Actions
//   (the turn menu: what can I do, what do I roll?), Saves & skills,
//   Features, Gear, Notes;
// - a quiet line at the bottom saying how fresh the numbers are.
// Pixel type is only for numerals and two-to-four-letter labels; every word
// is Text, readable and theme-aware. Ornaments (section marks, rules, action
// icons, badges) are Svg on Desktop and Raster cells in the terminal (Paint).

import type { ButtonProps, Elements, RenderElement, RenderNode, TextProps } from 'claude-code'
import { describeChange, type Entry } from './sheet.ts'
import { actionGroups, rowText, type ActionRow } from './actions.ts'
import {
  ART_FLOOR, ART_MAX, badgeSvg, C, classAccent, hpBarCells, hpColour, hudSvg, iconCells, iconSvg, markCells, markSvg, packCells, pipCells, pipsSvg, ruleSvg, savesSvg,
  type Cell, type Hud,
} from './art.ts'

/** What `$.ui.resolve(e)` hands out, on any surface. */
export type Els = Elements[keyof Elements]

/** The elements every surface has, which the shared parts of the pane draw with. */
type Base = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Markdown'>

/** The tabs, by the player's question. Hotkeys leave `d h r u t` free for later taps. */
export const TABS = [
  { id: 'actions', label: 'Actions', hotkey: 'a', words: ['actions', 'action', 'spells', 'attacks'] },
  { id: 'saves', label: 'Saves', hotkey: 's', words: ['saves', 'save', 'skills', 'checks'] },
  { id: 'features', label: 'Features', hotkey: 'f', words: ['features', 'feats', 'traits'] },
  { id: 'gear', label: 'Gear', hotkey: 'g', words: ['gear', 'inventory', 'items', 'money'] },
  { id: 'notes', label: 'Notes', hotkey: 'n', words: ['notes', 'rules', 'character', 'details'] },
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
  /** Milliseconds since the epoch, for the freshness line ("Read 13:19" on the day it was read). */
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (ms: number) => {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(ms)}`
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
const RECHARGE: Record<string, string> = { short: 'short rest', long: 'long rest', dawn: 'dawn', none: 'no recharge' }
const ORDINAL = (l: string) => ({ '1': '1st', '2': '2nd', '3': '3rd' })[l] ?? l + 'th'
const ABBR: Record<string, string> = {
  artificer: 'ART', barbarian: 'BBN', bard: 'BRD', cleric: 'CLR', druid: 'DRU', fighter: 'FTR', monk: 'MNK',
  paladin: 'PAL', ranger: 'RGR', rogue: 'ROG', sorcerer: 'SOR', warlock: 'WLK', wizard: 'WIZ',
}
const abbr = (cls: string) => ABBR[cls.toLowerCase()] ?? cls.slice(0, 3).toUpperCase()
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

function resources(e: Entry): (Pips & { note: string })[] {
  return (e.sheet.resources ?? []).map((r: any) => ({
    label: String(r.name),
    note: RECHARGE[r.recharge] ?? String(r.recharge ?? ''),
    max: r.max,
    left: Math.max(0, r.max - r.used),
    pending: false,
  }))
}

function conditions(e: Entry): string[] {
  const list = [...(e.sheet.conditions ?? [])].map(String)
  if (e.sheet.exhaustion > 0) list.push(`Exhaustion ${e.sheet.exhaustion}`)
  return list
}

/** Speeds other than walking: `swim 30`. Walking speed is the SPD stat. */
function otherSpeeds(s: any): string[] {
  const sp = s.speed ?? {}
  return ['swim', 'fly', 'climb', 'burrow'].filter((k) => typeof sp[k] === 'number').map((k) => `${k} ${sp[k]}`)
}

function hud(e: Entry): Hud {
  const d = e.derived ?? {}
  const p = e.derivedPending || !e.derived
  const hp = e.sheet.hp ?? {}
  const cs = casters(e)
  return {
    hp: { current: Number(hp.current ?? 0), max: Number(hp.max ?? 0), temp: Number(hp.temp ?? 0) },
    tiles: [
      { label: 'AC', value: String(e.sheet.ac?.value ?? '?') },
      { label: 'INIT', value: signed(d.initiative), pending: p },
      { label: 'SPD', value: String(e.sheet.speed?.walk ?? '?'), sub: otherSpeeds(e.sheet).join(' ') },
      ...cs.map((c) => ({ label: cs.length > 1 ? `${abbr(c.cls)} DC` : 'DC', value: c.dc, sub: `ATK ${c.attack}`, pending: p, accent: classAccent(c.cls) })),
    ],
    slots: slotRows(e).map((s) => ({ label: s.label, left: s.left, max: s.max, pending: s.pending })),
  }
}

/** The HUD in words, for a reader that cannot see it: every number on it. */
function hudAlt(e: Entry): string {
  const h = hud(e)
  const speeds = otherSpeeds(e.sheet)
  const cast = casters(e).map((c) => `${c.cls} spell save DC ${c.dc}, spell attack ${c.attack}`)
  const parts = [
    `HP ${h.hp.current} of ${h.hp.max}${h.hp.temp ? `, ${h.hp.temp} temporary` : ''}`,
    `AC ${h.tiles[0]?.value}, initiative ${h.tiles[1]?.value}, speed ${h.tiles[2]?.value}${speeds.length ? ` (${speeds.join(', ')})` : ''}`,
    ...(cast.length ? [cast.join('; ')] : []),
    ...(h.slots.length ? ['Slots ' + h.slots.map((s) => `${s.label} ${s.left}/${s.max}`).join(', ')] : []),
  ]
  return parts.join('. ') + '.' + (e.derivedPending ? ' Numbers marked ? may change on the next read.' : '')
}

/**
 * One quiet line: "Changed 13:20 · not re-read" after a write, "Read 13:19" on the
 * day it was read, "Last known · 3 Oct, 13:19" after that. It goes by when the
 * sheet was read, not by which session read it, so a module reload changes nothing.
 */
function freshness(e: Entry, now: number): string {
  const pend = e.derivedPending ? ' · numbers marked ? may change' : ''
  if (e.refreshing) return `Changed ${clock(e.seenAt)} · not re-read` + (e.last ? ' · ' + describeChange(e.last, e.sheet) : '') + pend
  return (sameDay(e.readAt, now) ? `Read ${clock(e.readAt)}` : `Last known · ${day(e.readAt)}`) + pend
}

/** The DM's rules that name this thing (a spell, a feature), by whole word. */
function rulesNaming(e: Entry, name: string): number {
  const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
  return (e.sheet.house_rules ?? []).filter((r: any) => re.test(String(r.rule ?? ''))).length
}
/** ★ marks a DM ruling, the same symbol as the header badge. */
const dmMark = (e: Entry, name: string) => (rulesNaming(e, name) ? ' ★' : '')

// ------------------------------------------------------------------ shared parts

const text = (el: Base, children: string, props: TextProps = {}) => el.Text({ ...props, children: [children] })
const row = (el: Base, children: RenderNode[], gap = 1) => el.Box({ flexDirection: 'row', columnGap: gap, children })
/** A column; `gap` rows between its children. The pane's one rhythm: a row between sections, none inside one. */
const col = (el: Base, children: RenderNode[], gap = 0) => el.Box({ flexDirection: 'column', ...(gap ? { rowGap: gap } : {}), children })
const md = (el: Base, lines: string[]) => el.Markdown({ text: lines.join('\n').slice(0, 10000) })
/** A section of a tab: its heading, then its lines, no space between. */
const section = (el: Base, head: RenderNode, lines: RenderNode[]) => col(el, [head, ...lines])

/**
 * What each kind of surface draws its ornaments with: the section headings
 * (a mark, the name, a slot level's pips and count, a rule), the action icons
 * and the concentration and ritual badges. Desktop paints them as Svg, the
 * terminal as Raster cells; the words are Text on both.
 */
interface Paint {
  /** Columns between an action's lead and its facts: two in the terminal, where dim is the only other cue. */
  gap: number
  /** `key` names a slot level's pips (`slots-1`). */
  head(label: string, mark: string, slots?: { left: number; max: number; pending: boolean } | null, key?: string): RenderNode
  icon(r: ActionRow): RenderNode
  badge(kind: 'conc' | 'ritual'): RenderNode
}

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
 * The tab buttons: short labels, a hotkey each. The open tab is marked by
 * more than colour. A plain Button draws the same whatever its variant (ButtonProps),
 * so Desktop gets real buttons with the open one `primary`, and the terminal gets
 * plain ones with `▸` before the open tab's label and the others dim.
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

/**
 * The tab row, with real space between the buttons: one column on Desktop
 * (about 9 CSS px; the five buttons still fit one row at 38 columns), two in
 * the terminal, where plain buttons have no chrome to separate them (one row
 * from 53 columns; at 40, three and two).
 */
export const TAB_GAP = { remote: 1, terminal: 2 }
function tabRow(el: Base, v: PaneView, make: ReturnType<typeof buttons>['make']): RenderElement {
  return el.Box({ key: 'tabs', flexDirection: 'row', flexWrap: 'wrap', columnGap: v.surface === 'terminal' ? TAB_GAP.terminal : TAB_GAP.remote, rowGap: 0, children: tabProps(v.surface, v.tab).map(make) })
}

/** The DM-rules badge: the count, a press away from the Notes tab. */
function rulesBadge(e: Entry, make: ReturnType<typeof buttons>['make']): RenderElement | null {
  const n = (e.sheet.house_rules ?? []).length
  return n ? make({ key: RULES_KEY, label: `★ ${n} DM rule${n === 1 ? '' : 's'}`, hotkey: 'm', plain: true }) : null
}

/**
 * The second line of an action: the lead at full strength (a casting time that
 * is not an action, what to roll), then the facts dim. Two Texts in a wrapping
 * row with a column between, so a long facts run moves under the lead whole.
 */
function factsLine(el: Base, r: ActionRow, gap: number): RenderNode {
  const facts = r.facts.join(' · ')
  return el.Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: gap,
    children: [...(r.lead ? [text(el, r.lead, { wrap: 'wrap' })] : []), ...(facts ? [text(el, facts, { dimColor: true, wrap: 'wrap' })] : [])],
  })
}

/**
 * One action, a row of the turn menu: the icon; the name (★ for a DM ruling,
 * the concentration and ritual badges) with the headline at the right edge
 * (dice and damage type, healing, or a casting time that is not an action);
 * under it the lead (what to roll, with the sheet's number), then the facts.
 * A weapon adds the rest of the sheet's own line, as written.
 */
function actionRow(el: Base, r: ActionRow, paint: Paint): RenderNode {
  const name = [
    text(el, r.name, { bold: true }),
    ...(r.dm ? [text(el, '★')] : []),
    ...(r.always ? [text(el, 'always', { dimColor: true })] : []),
    ...r.badges.map((b) => paint.badge(b)),
  ]
  const top = el.Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    columnGap: 1,
    children: [el.Box({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, children: name }), ...(r.effect ? [text(el, r.effect, { bold: true })] : [])],
  })
  const lines: RenderNode[] = [top, factsLine(el, r, paint.gap)]
  if (r.written) lines.push(text(el, 'Sheet: ' + r.written, { dimColor: true, wrap: 'wrap' }))
  return el.Box({ key: 'action-' + r.key, flexDirection: 'row', columnGap: 1, alignItems: 'flex-start', children: [paint.icon(r), el.Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: lines })] })
}

/** The DM's rules that name this thing (a spell, a weapon), as a test for ★. */
const dmNamed = (e: Entry) => (name: string) => rulesNaming(e, name) > 0

/**
 * Actions: the player's turn menu. Weapons, cantrips, each slot level (its
 * pips and count in the heading), other magic; one row per action, with the
 * snapshot's facts (actions.ts, facts.ts).
 */
function actionsTab(el: Base, e: Entry, paint: Paint): RenderNode[] {
  const slots = new Map(slotRows(e).map((s) => [s.level, { left: s.left, max: s.max, pending: s.pending }]))
  const MARK: Record<string, string> = { weapons: 'weapons', cantrips: 'cantrips', other: 'other' }
  const out = actionGroups(e, slots, dmNamed(e)).map((g) =>
    section(el, paint.head(g.label, MARK[g.id] ?? 'slots', g.slots, 'slots-' + g.id.replace('level-', '')), g.rows.map((r) => actionRow(el, r, paint))),
  )
  if (!out.length) out.push(text(el, 'No spells or weapons on this sheet.', { dimColor: true }))
  return out
}

function skillLines(e: Entry) {
  const d = e.derived ?? {}
  const prof = new Map<string, boolean>((e.sheet.proficiencies?.skills ?? []).map((k: any) => [String(k.name).toLowerCase(), !!k.expertise]))
  return Object.entries((d.skills ?? {}) as Record<string, number>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => {
      const p = prof.get(name.toLowerCase())
      return { name, mark: p === undefined ? '' : p ? '◆' : '●', value: signed(n) + (e.derivedPending ? '?' : '') }
    })
}

/** Saves & skills: the six saves (proficiency marked), checks, skills, passive Perception, Hit Dice. */
function savesTab(el: Base, e: Entry, saves: RenderNode, paint: Paint): RenderNode[] {
  const d = e.derived ?? {}
  const s = e.sheet
  const pend = e.derivedPending ? '?' : ''
  const checks = el.Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 2,
    children: [
      text(el, 'Checks', { dimColor: true }),
      ...ABILITIES.map((a) => row(el, [text(el, a.toUpperCase(), { dimColor: true }), text(el, signed(d.modifiers?.[a]) + pend, { bold: true })])),
    ],
  })
  const skills = el.Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    children: skillLines(e).map((k) =>
      el.Box({
        width: '50%',
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingRight: 2,
        children: [text(el, k.name + (k.mark ? ' ' + k.mark : ''), k.mark ? {} : { dimColor: true }), text(el, k.value, { bold: true })],
      }),
    ),
  })
  const hd = Object.entries((d.hit_dice ?? {}) as Record<string, number>).map(([die, n]) => `${die} ${Math.max(0, n - (s.hit_dice_spent?.[die] ?? 0))}/${n}`)
  return [
    section(el, paint.head('Saving throws', 'saves'), [saves, checks]),
    section(el, paint.head('Skills', 'section'), [
      skills,
      text(el, `Passive Perception ${d.passive_perception ?? '?'}${pend}` + (hd.length ? ` · Hit Dice ${hd.join(', ')}` : ''), { wrap: 'wrap' }),
      text(el, '● proficient · ◆ expertise', { dimColor: true }),
    ]),
  ]
}

function featuresTab(el: Base, e: Entry, paint: Paint): RenderNode[] {
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
    ...(subclasses.length ? [section(el, paint.head('Subclasses', 'section'), [md(el, subclasses)])] : []),
    section(el, paint.head('Features', 'section'), [md(el, features.length ? features : ['_None._'])]),
    ...(prof.length ? [section(el, paint.head('Proficiencies', 'section'), [md(el, prof)])] : []),
  ]
}

function gearTab(el: Base, e: Entry, paint: Paint): RenderNode[] {
  const s = e.sheet
  const items = (s.inventory ?? []).map(
    (i: any) => `- ${i.name}` + (i.quantity !== 1 ? ` ×${i.quantity}` : '') + (i.attuned ? ' (attuned)' : '') + (i.note ? ` — ${i.note}` : ''),
  )
  const coins = Object.entries((s.currency ?? {}) as Record<string, number>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
  return [section(el, paint.head('Inventory', 'section'), [md(el, items.length ? items : ['_Nothing written._'])]), text(el, `Money  ${coins.join(', ') || 'none'}`, { bold: true })]
}

/** Notes: the DM's rules first, then who the character is, with unresolved names flagged beside them. */
function notesTab(el: Base, e: Entry, paint: Paint): RenderNode[] {
  const s = e.sheet
  const out: RenderNode[] = []
  const rules = (s.house_rules ?? []).map((r: any) => `- ${r.rule}` + (r.by || r.date ? ` _(${[r.by, r.date].filter(Boolean).join(', ')})_` : ''))
  if (rules.length) out.push(section(el, paint.head('DM rules', 'rules'), [md(el, rules)]))
  const flag = (n: string) => (unresolvedName(n, e.unresolved) ? ' — _not in the rules snapshot_' : '')
  const who: string[] = []
  if (s.species?.name) who.push(`- **Species:** ${s.species.name}${flag(s.species.name)}` + (s.species.note ? ` — ${s.species.note}` : ''))
  if (s.background?.name) who.push(`- **Background:** ${s.background.name}${flag(s.background.name)}`)
  const named = [s.species?.name, s.background?.name].filter(Boolean) as string[]
  const otherUnresolved = e.unresolved.filter((u) => !named.some((n) => unresolvedName(n, [u])))
  if (otherUnresolved.length) who.push(`- **Not in the rules snapshot:** ${otherUnresolved.join(', ')}`)
  for (const [k, v] of Object.entries((s.details ?? {}) as Record<string, string>)) who.push(`- **${k.replace(/_/g, ' ')}:** ${v}`)
  if (who.length) out.push(section(el, paint.head('Character', 'section'), [md(el, who)]))
  if (s.notes) out.push(section(el, paint.head('Sheet notes', 'section'), [md(el, [String(s.notes)])]))
  if (!out.length) out.push(text(el, 'No notes on this sheet.', { dimColor: true }))
  return out
}

function tabBody(el: Base, e: Entry, v: PaneView, paint: Paint, saves: () => RenderNode): RenderNode[] {
  switch (v.tab) {
    case 'saves':
      return savesTab(el, e, saves(), paint)
    case 'features':
      return featuresTab(el, e, paint)
    case 'gear':
      return gearTab(el, e, paint)
    case 'notes':
      return notesTab(el, e, paint)
    default:
      return actionsTab(el, e, paint)
  }
}

const saveTiles = (e: Entry) => {
  const d = e.derived ?? {}
  const prof = new Set(e.sheet.proficiencies?.saves ?? [])
  return ABILITIES.map((a) => ({ label: a.toUpperCase(), value: signed(d.saving_throws?.[a]), proficient: prof.has(a), pending: e.derivedPending }))
}

// ------------------------------------------------------------------ the terminal

const withPacked = (r: { columns: number; rows: number; cells: Cell[] }) => ({ columns: r.columns, rows: r.rows, cells: packCells(r.cells) })
const themeOf = (colour: number) => (colour === C.green ? 'success' : colour === C.amber ? 'warning' : 'error')

function terminalPane(el: Elements['terminal'], e: Entry, v: PaneView): RenderElement {
  const width = Math.max(30, v.columns)
  const { make, done } = buttons(el, v.memo)
  const h = hud(e)
  const raster = (key: string, r: { columns: number; rows: number; cells: Cell[] }) => el.Raster({ key, ...withPacked(r) })
  let marks = 0
  const paint: Paint = {
    gap: 2,
    // `◆ 1st level ──────── █ █ █ 3/3`: the rule fills the row, a slot level's pips and count at its end.
    head(label, mark, slots, key) {
      const count = slots ? `${slots.left}/${slots.max}${slots.pending ? '?' : ''}` : ''
      const pipW = slots ? Math.min(17, Math.max(1, slots.max * 2 - 1)) : 0
      const used = 2 + label.length + 1 + (slots ? 1 + pipW + 1 + count.length : 0)
      return el.Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          raster('mark-' + marks++, markCells(mark)),
          text(el, label, { bold: true }),
          text(el, '─'.repeat(Math.max(2, width - used)), { dimColor: true }),
          ...(slots ? [raster(key ?? 'slots-' + marks, pipCells(slots.left, slots.max, C.slot, pipW)), text(el, count, slots.pending ? { color: 'warning' } : { bold: true })] : []),
        ],
      })
    },
    icon: (r) => raster('icon-' + r.key, iconCells(r.icon, r.cls ? classAccent(r.cls) : null)),
    badge: (kind) => text(el, kind === 'conc' ? 'conc' : 'ritual', { inverse: true }),
  }

  // Identity: name, level and classes on one line; the DM-rules badge; conditions only when present.
  const badge = rulesBadge(e, make)
  const conds = conditions(e)
  const identity = col(el, [
    el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: [text(el, e.name, { bold: true }), text(el, identityLine(e), { dimColor: true })] }),
    ...(badge ? [badge] : []),
    ...(conds.length ? [text(el, '⚠ ' + conds.join(' · '), { color: 'warning', bold: true, wrap: 'wrap' })] : []),
  ])

  // Vitals: HP, the stats, a line per caster, then slots and resources as a table.
  const { current, max, temp } = h.hp
  const digits = `${current}/${max}`
  const tempText = temp ? `+${temp} temp` : ''
  const room = Math.max(10, width - 3 - digits.length - 2 - (tempText ? tempText.length + 1 : 0))
  const vitals: RenderNode[] = [
    row(el, [
      text(el, 'HP', { bold: true }),
      text(el, digits, { bold: true, color: themeOf(hpColour(current, max)) }),
      raster('hp', hpBarCells(current, max, temp, room)),
      ...(tempText ? [text(el, tempText, { color: 'cyan', bold: true })] : []),
    ]),
  ]
  const stat = (label: string, value: string, pending = false, extra = '') =>
    row(el, [text(el, label, { dimColor: true }), text(el, value + (pending ? '?' : ''), pending ? { color: 'warning' } : { bold: true }), ...(extra ? [text(el, extra, { dimColor: true })] : [])])
  const [ac, init, spd] = h.tiles
  vitals.push(
    el.Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 2,
      children: [stat('AC', ac?.value ?? '?'), stat('INIT', init?.value ?? '?', init?.pending), stat('SPD', spd?.value ?? '?', false, otherSpeeds(e.sheet).join(', '))],
    }),
  )
  const cs = casters(e)
  if (cs.length) {
    const p = e.derivedPending
    vitals.push(el.Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: cs.map((c) => row(el, [text(el, c.cls, { dimColor: true }), stat('DC', c.dc, p), stat('atk', c.attack, p)])) }))
  }
  const table = [...h.slots.map((s) => ({ ...s, label: 'Slots ' + s.label, note: '', colour: C.slot })), ...resources(e).map((r) => ({ ...r, colour: C.gold }))]
  const labelW = Math.min(20, Math.max(9, ...table.map((r) => r.label.length)))
  const pipW = Math.min(17, Math.max(1, ...table.map((r) => r.max * 2 - 1)))
  table.forEach((r, i) =>
    vitals.push(
      el.Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          el.Box({ width: labelW, children: [text(el, r.label, { wrap: 'wrap' })] }),
          raster('pips-' + i, pipCells(r.left, r.max, r.colour, pipW)),
          text(el, `${r.left}/${r.max}` + (r.pending ? '?' : ''), r.pending ? { color: 'warning' } : { bold: true }),
          ...(r.note ? [text(el, r.note, { dimColor: true })] : []),
        ],
      }),
    ),
  )

  const saves = () =>
    el.Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      children: saveTiles(e).map((s) =>
        el.Box({
          width: 12,
          flexDirection: 'row',
          columnGap: 1,
          children: [text(el, s.label, s.proficient ? {} : { dimColor: true }), text(el, s.value + (s.pending ? '?' : ''), { bold: true }), ...(s.proficient ? [text(el, '●', { color: 'success' })] : [])],
        }),
      ),
    })
  const tree = col(
    el,
    [identity, col(el, vitals), tabRow(el, v, make), col(el, tabBody(el, e, v, paint, saves), 1), text(el, freshness(e, v.now), { dimColor: true, wrap: 'wrap' })],
    1,
  )
  done()
  return tree
}

// ------------------------------------------------------------------ desktop, editor, mobile

/** Every SVG is drawn at this many CSS px per art pixel, and given that size, so nothing rescales it. */
const SCALE = 2
/**
 * CSS px per `bodyColumns` column, measured on the Desktop Code tab (2.1.286,
 * 2026-10-04): the probe read 38 columns where the pane's content is about
 * 330–350 CSS px wide, so about 9. A remote surface counts `bodyColumns` as
 * the pane's width over its code font's advance (RenderViewport).
 */
export const PX_PER_COLUMN = 9

/**
 * The art width for this pane: its estimated slot over SCALE, one column short
 * so a slot at the low end of the estimate still holds it, at most ART_MAX
 * (328 CSS px at 38 columns and wider). A slot under ART_MIN's 296 px wraps the
 * stat tiles; ART_FLOOR (the six save tiles) is the least, 280 px, so from 32
 * columns the card is never wider than the slot. Always integer-scaled.
 */
export const artWidth = (columns: number) => Math.max(ART_FLOOR, Math.min(ART_MAX, Math.floor(((columns - 1) * PX_PER_COLUMN) / SCALE)))

function remotePane(el: Elements['desktop'], e: Entry, v: PaneView): RenderElement {
  const W = artWidth(v.columns)
  const { make, done } = buttons(el, v.memo)
  const svg = (alt: string, art: { source: string; width: number; height: number }) => el.Svg({ alt, source: art.source, width: art.width, height: art.height })

  const badge = rulesBadge(e, make)
  const conds = conditions(e)
  const identity = col(el, [
    el.Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignItems: 'center',
      children: [row(el, [text(el, e.name, { bold: true }), text(el, identityLine(e), { dimColor: true })]), ...(badge ? [badge] : [])],
    }),
    ...(conds.length ? [text(el, '⚠ ' + conds.join(' · '), { color: 'warning', bold: true, wrap: 'wrap' })] : []),
  ])
  const res = resources(e).map((r) =>
    el.Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      children: [
        row(el, [text(el, r.label), ...(r.note ? [text(el, r.note, { dimColor: true })] : [])]),
        row(el, [svg(`${r.label}: ${r.left} of ${r.max} left`, pipsSvg(r.left, r.max, C.gold, SCALE)), text(el, `${r.left}/${r.max}`, { bold: true })]),
      ],
    }),
  )
  const paint: Paint = {
    gap: 1,
    // The mark and the name, a dotted rule across the rest of the row (clipped to it, so it ends
    // where the right-aligned numbers end), then a slot level's pips and count.
    head(label, mark, slots) {
      // Only the rule gives way: it starts at no width and takes what the row has left.
      const fixed = (children: RenderNode[]) => el.Box({ flexDirection: 'row', alignItems: 'center', columnGap: 1, flexShrink: 0, children })
      const rule = el.Box({ width: 0, flexGrow: 1, flexShrink: 1, overflow: 'hidden', children: [svg('', ruleSvg(W, SCALE))] })
      const end = slots ? [fixed([svg(`${slots.left} of ${slots.max} slots left`, pipsSvg(slots.left, slots.max, C.slot, SCALE)), text(el, `${slots.left}/${slots.max}${slots.pending ? '?' : ''}`, { bold: true })])] : []
      return el.Box({ flexDirection: 'row', alignItems: 'center', columnGap: 1, children: [fixed([svg('', markSvg(mark, SCALE)), text(el, label, { bold: true })]), rule, ...end] })
    },
    icon: (r) => svg(rowText(r), iconSvg(r.icon, r.cls ? classAccent(r.cls) : C.edge, SCALE)),
    badge: (kind) => svg(kind === 'conc' ? 'Concentration' : 'Ritual', badgeSvg(kind === 'conc' ? 'CONC' : 'RIT', SCALE)),
  }
  const saves = () => {
    const tiles = saveTiles(e)
    return svg('Saving throws: ' + tiles.map((s) => `${s.label} ${s.value}${s.proficient ? ' (proficient)' : ''}`).join(', '), savesSvg(tiles, SCALE, W))
  }
  const tree = col(
    el,
    [
      identity,
      svg(hudAlt(e), hudSvg(hud(e), SCALE, W)),
      ...(res.length ? [col(el, res)] : []),
      tabRow(el, v, make),
      col(el, tabBody(el, e, v, paint, saves), 1),
      text(el, freshness(e, v.now), { dimColor: true, wrap: 'wrap' }),
    ],
    1,
  )
  done()
  return tree
}

// ------------------------------------------------------------------ entry points

/** The pane: the HUD, the tab row, the open tab, and a freshness line when the data is not fresh. */
export function paneTree(el: Els, v: PaneView): RenderElement {
  const e = v.entry
  if (!e) {
    return col(el, [
      text(el, 'No sheet yet.', { bold: true }),
      text(el, 'Ask Claude to show your sheet. The pane fills in from its sheet_read result.', { dimColor: true, wrap: 'wrap' }),
    ])
  }
  // Branch on the surface, never on the table: Claude Code completes every
  // table with every element name, and Raster draws nothing off the terminal.
  if (v.surface === 'terminal') return terminalPane(el as Elements['terminal'], e, v)
  return remotePane(el as Elements['desktop'], e, v)
}

/** The band strip, while the pane is closed: name, a 10-cell HP bar, slot pips, the key hint. */
export function bandTree(el: Els, e: Entry): RenderElement {
  const hp = e.sheet.hp ?? { current: 0, max: 1, temp: 0 }
  const frac = hp.max > 0 ? hp.current / hp.max : 0
  const filled = Math.max(0, Math.min(10, Math.round(frac * 10)))
  const slots = slotRows(e)
  const kids: RenderNode[] = [
    text(el, e.name, { bold: true }),
    row(el, [text(el, '█'.repeat(filled), { color: themeOf(hpColour(hp.current, hp.max)) }), text(el, '░'.repeat(10 - filled), { dimColor: true })], 0),
    text(el, `${hp.current}/${hp.max}` + (hp.temp ? ` +${hp.temp}` : '')),
  ]
  if (slots.length) {
    const left = slots.reduce((n, s) => n + s.left, 0)
    const max = slots.reduce((n, s) => n + s.max, 0)
    kids.push(row(el, [text(el, '◆'.repeat(left), { color: 'magenta' }), text(el, '◇'.repeat(max - left), { dimColor: true })], 0))
  }
  kids.push(text(el, '/sheet', { dimColor: true }))
  return row(el, kids)
}
