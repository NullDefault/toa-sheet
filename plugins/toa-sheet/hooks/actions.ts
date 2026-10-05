// The Actions tab as a player's turn menu: the sheet's weapons and spells,
// each looked up in the generated facts table (facts.ts, the rules server's
// own snapshot) and worded the way a 2024 player reads them. Pure: no mods
// API. Nothing here computes a rule:
// - the facts are the snapshot's, copied by facts/build.py;
// - the attack bonus and save DC are the sheet's `derived` numbers for the
//   class the spell is listed under, and a weapon's bonus is the sheet's own
//   written one;
// - a cantrip's die is a lookup in the data's own scaling table at
//   `derived.total_level`.
// A name with no record is shown as the sheet writes it and flagged, never guessed.

import type { Entry } from './sheet.ts'
import { SPELL_ALIASES, SPELLS, WEAPONS, type SpellRow, type WeaponRow } from './facts.ts'

/** What an action's icon shows, most specific first: damage type, healing, reaction, save, attack, school. */
export type IconId =
  | 'fire' | 'lightning' | 'thunder' | 'cold' | 'acid' | 'poison' | 'force' | 'necrotic' | 'radiant' | 'psychic'
  | 'bludgeoning' | 'piercing' | 'slashing' | 'multi' | 'heal' | 'reaction' | 'save' | 'attack'
  | 'abjuration' | 'conjuration' | 'divination' | 'enchantment' | 'evocation' | 'illusion' | 'necromancy' | 'transmutation'
  | 'unknown'

export const DAMAGE_ICONS = ['fire', 'lightning', 'thunder', 'cold', 'acid', 'poison', 'force', 'necrotic', 'radiant', 'psychic', 'bludgeoning', 'piercing', 'slashing'] as const
const SCHOOL: Record<string, IconId> = {
  A: 'abjuration', C: 'conjuration', D: 'divination', E: 'enchantment', V: 'evocation', I: 'illusion', N: 'necromancy', T: 'transmutation',
}

export interface ActionRow {
  key: string
  /** As the sheet writes it. */
  name: string
  icon: IconId
  /** The class the spell is listed under (its accent and its numbers); '' for weapons and other magic. */
  cls: string
  /** A DM rule names it: ★. */
  dm: boolean
  /** Always prepared (a domain or subclass spell). */
  always: boolean
  /** The headline: dice and damage type, healing, or the casting time when it is not an action. */
  effect: string
  /**
   * What the turn needs first, at full strength: a casting time that is not an
   * action (a bonus action or reaction is another part of the turn), then what
   * to roll with the sheet's number: `ATK +5`, `CON save DC 11`, `ATK +2 (as written)`.
   */
  lead: string
  /** The rest, dim: casting time, range, duration, components; or a weapon's properties. */
  facts: string[]
  badges: ('conc' | 'ritual')[]
  /** The rest of the sheet's own line for a weapon, after its bonus ("1d8 bludgeoning"), shown as written. */
  written: string
  /** No record in the snapshot: shown plainly and flagged. */
  missing: boolean
  /** The book the record came from (`XPHB`), for the alt text. */
  source: string
}

export interface ActionGroup {
  id: string
  label: string
  /** A slot level's pips: left and max. */
  slots: { left: number; max: number; pending: boolean } | null
  rows: ActionRow[]
}

// ------------------------------------------------------------------ lookup

/** The server's name normalisation (`norm`): lower case, every run of other characters one space. */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Sources by name, for the name-only fallback. */
function index(table: Record<string, unknown>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const k of Object.keys(table)) {
    const at = k.lastIndexOf('|')
    const name = k.slice(0, at)
    out.set(name, [...(out.get(name) ?? []), k.slice(at + 1)])
  }
  return out
}
const SPELL_NAMES = index(SPELLS)
const WEAPON_NAMES = index(WEAPONS)

/** A 2024 sheet (or one that does not say) prefers the 2024 books; a 2014 sheet the 2014 ones. */
const PREFER_2024 = ['xphb', 'efa', 'xdmg', 'phb', 'xge', 'tce', 'eepc', 'dmg', 'toa']
const PREFER_2014 = ['phb', 'xge', 'tce', 'eepc', 'dmg', 'toa', 'xphb', 'efa', 'xdmg']
const rank = (order: string[], s: string) => {
  const i = order.indexOf(s)
  return i < 0 ? order.length : i
}

function find<R>(table: Record<string, R>, names: Map<string, string[]>, wanted: string[], source: string | undefined, ruleset: unknown): { row: R; source: string } | null {
  for (const n of wanted) {
    if (source) {
      const row = table[n + '|' + source.toLowerCase()]
      if (row) return { row, source: source.toUpperCase() }
    }
  }
  const order = ruleset === '2014' ? PREFER_2014 : PREFER_2024
  for (const n of wanted) {
    const sources = [...(names.get(n) ?? [])].sort((a, b) => rank(order, a) - rank(order, b))
    const s = sources[0]
    const row = s ? table[n + '|' + s] : undefined
    if (s && row) return { row, source: s.toUpperCase() }
  }
  return null
}

/** A spell by its own name and source; else by name, the edition's books first; else null. */
export function spellFact(name: string, source?: string, ruleset?: unknown): { row: SpellRow; source: string } | null {
  const n = norm(name)
  const alias = SPELL_ALIASES[n]
  return find(SPELLS, SPELL_NAMES, alias ? [n, alias] : [n], source, ruleset)
}

/** A weapon by its own name and source, then by name; a plural ("Daggers") also tries the singular. */
export function weaponFact(name: string, source?: string, ruleset?: unknown): { row: WeaponRow; source: string } | null {
  const n = norm(name)
  const wanted = [n, ...(n.endsWith('s') ? [n.slice(0, -1)] : [])]
  return find(WEAPONS, WEAPON_NAMES, wanted, source, ruleset)
}

/** A cantrip's dice at this character level, from the data's table ("1:1d10 5:2d10 …"), or ''. */
export function cantripDice(table: string, level: number | null): string {
  if (!table.includes(':')) return table
  if (level === null) return ''
  let out = ''
  for (const pair of table.split(' ')) {
    const [lv, dice] = pair.split(':')
    if (Number(lv) <= level) out = dice ?? ''
  }
  return out
}

// ------------------------------------------------------------------ wording

const ORDINAL = (l: number) => ({ 1: '1st', 2: '2nd', 3: '3rd' })[l] ?? l + 'th'
const COMPONENTS = (c: string) => [...c].join(', ')
const signed = (n: unknown) => (typeof n === 'number' ? (n >= 0 ? '+' + n : String(n)) : typeof n === 'string' ? n : '?')

/** `1d10 fire`, `5d6 fire/radiant`, `3d8 · 6 types`, `force`. */
function damageText(dice: string, types: string[]): string {
  const t = types.length > 2 ? `${types.length} types` : types.join('/')
  return dice ? (types.length > 2 ? `${dice} · ${t}` : `${dice} ${t}`) : t
}

function spellIcon(row: SpellRow): IconId {
  const [, school, time, , , , flags, damage, save] = row
  const types = damage ? damage.split(',') : []
  if (types.length > 2) return 'multi'
  const first = types[0]
  if (first && (DAMAGE_ICONS as readonly string[]).includes(first)) return first as IconId
  const f = flags.split(' ')
  if (f.includes('heal')) return 'heal'
  if (time.includes('Reaction')) return 'reaction'
  if (save) return 'save'
  if (f.includes('melee') || f.includes('ranged')) return 'attack'
  return SCHOOL[school] ?? 'unknown'
}

interface Caster {
  dc: string
  attack: string
}

/** One spell row: the facts as a 2024 player reads them, the roll with the class's own number. */
export function spellRow(key: string, name: string, source: string | undefined, e: Entry, opts: { cls: string; caster: Caster | null; dm: boolean; always: boolean; otherLevel?: boolean }): ActionRow {
  const hit = spellFact(name, source, e.sheet.ruleset)
  const base = { key, name, cls: opts.cls, dm: opts.dm, always: opts.always, written: '', badges: [] as ActionRow['badges'] }
  if (!hit) return { ...base, icon: 'unknown', effect: '', lead: '', facts: ['Not in the rules snapshot'], missing: true, source: source ?? '' }
  const [level, , time, range, comps, duration, flagText, damage, save, diceText] = hit.row
  const flags = flagText ? flagText.split(' ') : []
  const types = damage ? damage.split(',') : []
  const total = typeof e.derived?.total_level === 'number' ? e.derived.total_level : null
  const dice = level === 0 ? cantripDice(diceText, total) : diceText
  const pend = e.derivedPending ? '?' : ''
  let effect = types.length ? damageText(dice, types) : flags.includes('heal') && dice ? `heal ${dice}${flags.includes('mod') ? ' + mod' : ''}` : ''
  if (!effect && time !== 'Action') effect = time
  const attack = flags.includes('melee') ? 'Melee' : flags.includes('ranged') ? 'Ranged' : ''
  const roll = attack
    ? `${attack} ATK${opts.caster ? ' ' + opts.caster.attack + pend : ''}`
    : save
      ? `${save} save${opts.caster ? ' DC ' + opts.caster.dc + pend : ''}`
      : ''
  const lead = [...(time !== 'Action' && effect !== time ? [time] : []), ...(roll ? [roll] : [])].join(' · ')
  const facts = [
    ...(opts.otherLevel ? [level === 0 ? 'Cantrip' : ORDINAL(level)] : []),
    ...(time === 'Action' ? [time] : []),
    range,
    ...(duration && duration !== 'Instant' ? [duration] : []),
    COMPONENTS(comps),
  ].filter(Boolean)
  const badges: ActionRow['badges'] = [...(flags.includes('conc') ? ['conc' as const] : []), ...(flags.includes('ritual') ? ['ritual' as const] : [])]
  return { ...base, icon: spellIcon(hit.row), effect, lead, facts, badges, missing: false, source: hit.source }
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

/**
 * Weapon Mastery (a 2024 class feature). Its `choice`, when written, names the
 * weapons it covers ("Longsword, Handaxe"); without one, every weapon's
 * mastery property is shown.
 */
function mastery(e: Entry): { all: boolean; names: string[] } | null {
  const f = [...(e.sheet.features ?? []), ...(e.sheet.feats ?? [])].find((x: any) => norm(String(x.name ?? '')) === 'weapon mastery')
  if (!f) return null
  const names = typeof f.choice === 'string' ? f.choice.split(/,|;|\band\b/).map(norm).filter(Boolean) : []
  return { all: !names.length, names }
}
const singular = (n: string) => (n.endsWith('s') ? n.slice(0, -1) : n)

/** The weapon's data line: `Melee · Versatile 1d8 · Topple`, mastery only with Weapon Mastery. */
export function weaponFacts(row: WeaponRow, withMastery: boolean): string[] {
  const [, kind, , , versatile, props, range, masteryName] = row
  const words = (props ? props.split(',') : []).map((p) =>
    p === 'Versatile' && versatile ? `Versatile ${versatile}` : (p === 'Thrown' || p === 'Ammunition') && range ? `${p} ${range}` : p,
  )
  return [kind === 'ranged' ? 'Ranged' : 'Melee', ...words, ...(withMastery && masteryName ? [masteryName] : [])]
}

function weaponRows(e: Entry, dmNames: (name: string) => boolean): ActionRow[] {
  const wm = mastery(e)
  const out: ActionRow[] = []
  ;(e.sheet.inventory ?? []).forEach((i: any, n: number) => {
    const name = String(i.name ?? '')
    const note = String(i.note ?? '')
    const hit = weaponFact(name, i.source, e.sheet.ruleset)
    const writtenAttack = /^attack written /i.test(note.trim())
    if (!hit && !writtenAttack) return
    // The written bonus is the roll, labelled as written; the rest of the sheet's line follows the facts.
    const parts = note ? weaponLine(note).split(' · ') : []
    const lead = writtenAttack ? `ATK ${parts[0]} (as written)` : ''
    const written = (writtenAttack ? parts.slice(1) : parts).join(' · ')
    const base = { key: 'weapon-' + n, name, cls: '', dm: dmNames(name), always: false, lead, written, badges: [] as ActionRow['badges'] }
    if (!hit) {
      out.push({ ...base, icon: 'unknown', effect: '', facts: ['Not in the rules snapshot'], missing: true, source: String(i.source ?? '') })
      return
    }
    const [, , dice, type] = hit.row
    const covered = !!wm && (wm.all || wm.names.some((w) => singular(w) === singular(norm(name))))
    const icon: IconId = (DAMAGE_ICONS as readonly string[]).includes(type) ? (type as IconId) : 'unknown'
    out.push({ ...base, icon, effect: [dice, type].filter(Boolean).join(' '), facts: weaponFacts(hit.row, covered), missing: false, source: hit.source })
  })
  return out
}

/**
 * The turn menu: Weapons, Cantrips, then each slot level (its pips in the
 * heading), then Other magic (spells from species, feats or items, and any
 * spell whose level neither the sheet nor the snapshot gives).
 */
export function actionGroups(e: Entry, slots: Map<number, { left: number; max: number; pending: boolean }>, dmNames: (name: string) => boolean): ActionGroup[] {
  const groups: ActionGroup[] = []
  const weapons = weaponRows(e, dmNames)
  if (weapons.length) groups.push({ id: 'weapons', label: 'Weapons', slots: null, rows: weapons })
  const casters = new Map<string, Caster>(((e.derived?.spellcasting ?? []) as any[]).map((c) => [String(c.class), { dc: String(c.save_dc ?? '?'), attack: signed(c.attack) }]))
  const byLevel = new Map<number, ActionRow[]>()
  const other: ActionRow[] = []
  for (const sc of e.sheet.spellcasting?.by_class ?? []) {
    const cls = String(sc.class ?? '')
    const caster = casters.get(cls) ?? null
    const add = (lvl: number | null, row: ActionRow) => {
      if (lvl === null) other.push(row)
      else byLevel.set(lvl, [...(byLevel.get(lvl) ?? []), row])
    }
    ;(sc.cantrips ?? []).forEach((c: any, i: number) => add(0, spellRow(`spell-${cls}-c${i}`, c.name, c.source, e, { cls, caster, dm: dmNames(c.name), always: false })))
    ;(sc.spells ?? []).forEach((sp: any, i: number) => {
      const level = typeof sp.level === 'number' ? sp.level : spellFact(sp.name, sp.source, e.sheet.ruleset)?.row[0] ?? null
      add(level, spellRow(`spell-${cls}-${i}`, sp.name, sp.source, e, { cls, caster, dm: dmNames(sp.name), always: !!sp.always, otherLevel: level === null }))
    })
  }
  for (const [lvl, rows] of [...byLevel].sort(([a], [b]) => a - b)) {
    groups.push({ id: lvl === 0 ? 'cantrips' : 'level-' + lvl, label: lvl === 0 ? 'Cantrips' : `${ORDINAL(lvl)} level`, slots: lvl === 0 ? null : slots.get(lvl) ?? null, rows })
  }
  ;(e.sheet.spellcasting?.other ?? []).forEach((x: any, i: number) => other.push(spellRow('other-' + i, x.name, x.source, e, { cls: '', caster: null, dm: dmNames(x.name), always: false, otherLevel: true })))
  if (other.length) groups.push({ id: 'other', label: 'Other magic', slots: null, rows: other })
  return groups
}

/** A row in words, for the icon's alt text: `Fire Bolt: 1d10 fire. Ranged ATK +5 · Action · 120 ft · V, S.` */
export function rowText(r: ActionRow): string {
  const head = r.name + (r.dm ? ' ★' : '') + (r.effect ? ': ' + r.effect : '')
  const line = [r.lead, ...r.facts, ...r.badges.map((b) => (b === 'conc' ? 'Concentration' : 'Ritual'))].filter(Boolean).join(' · ')
  return head + '. ' + line + '.' + (r.written ? ` Sheet: ${r.written}.` : '')
}
