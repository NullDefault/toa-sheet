// Lookups (T0085 stage 1): what the DM or a player types into `[ look up ]`,
// matched against the spells the facts table knows, the 2024 conditions and
// the fight's monsters; and the card a match opens, drawn from the facts row
// at once and from the rules server's answer once a press fetched it. Pure:
// no mods API (register.ts calls the tools, view.ts draws).

import { norm } from './actions.ts'
import { SPELLS, type SpellRow } from './facts.ts'

export { norm }

export type Candidate = { name: string; kind: 'spell' | 'condition' | 'monster'; key: string }

export type Card = { title: string; meta: string[]; body: string[]; cite: string | null }

export const CONDITIONS = [
  'Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible',
  'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
] as const

const SMALL = new Set(['of', 'the', 'and', 'with', 'to', 'from', 'in', 'on'])

/** A facts key's name as a reader writes it: `tasha s hideous laughter` → "Tasha's Hideous Laughter". */
export function displayName(keyName: string): string {
  return keyName
    .replace(/(\w) s\b/g, "$1's")
    .split(' ')
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** One spell per name: its `|xphb` key when there is one (2024, as `spell_get` defaults), else its first. */
const SPELL_CANDS: Candidate[] = (() => {
  const keys = new Map<string, string>()
  for (const k of Object.keys(SPELLS)) {
    const name = k.slice(0, k.lastIndexOf('|'))
    const had = keys.get(name)
    if (!had || (k.endsWith('|xphb') && !had.endsWith('|xphb'))) keys.set(name, k)
  }
  return [...keys].map(([name, key]) => ({ name: displayName(name), kind: 'spell' as const, key }))
})()

const CONDITION_CANDS: Candidate[] = CONDITIONS.map((name) => ({ name, kind: 'condition', key: norm(name) }))

/** Everything a look can open: the spells, the conditions, and `monsters` (deduped by `norm`). */
export function candidates(monsters: string[]): Candidate[] {
  const seen = new Set<string>()
  const mons: Candidate[] = []
  for (const m of monsters) {
    const key = norm(m)
    if (!key || seen.has(key)) continue
    seen.add(key)
    mons.push({ name: m.trim(), kind: 'monster', key })
  }
  return [...mons, ...SPELL_CANDS, ...CONDITION_CANDS]
}

const KIND_ORDER = { monster: 0, spell: 1, condition: 2 } as const

/** 0 exact, 1 whole-name prefix, 2 word prefix, 3 substring; -1 no match. */
function tier(q: string, name: string): number {
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if ((' ' + name).includes(' ' + q)) return 2
  if (name.includes(q)) return 3
  return -1
}

/** The best `n` candidates for `query`: exact, prefix, word prefix, substring; ties monsters, spells, conditions, then A–Z. */
export function matches(query: string, cands: Candidate[], n = 5): Candidate[] {
  const q = norm(query)
  if (!q) return []
  return cands
    .map((c) => ({ c, t: tier(q, norm(c.name)) }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => a.t - b.t || KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] || a.c.name.localeCompare(b.c.name))
    .slice(0, n)
    .map((x) => x.c)
}

const ATTACK: Record<string, string> = { m: 'Melee', r: 'Ranged', 'm,r': 'Melee or Ranged', 'r,m': 'Melee or Ranged' }

/**
 * `{@damage 3d8}` → `3d8`, `{@condition prone|xphb}` → `prone`, a stat
 * block's `{@atkr m} {@hit 3}` → `Melee Attack Roll: +3` and `{@h}` → `Hit: `;
 * nested tags from the inside out.
 */
const untag = (s: string) => {
  let out = s
    .replace(/\{@atkr? ([^{}]*)\}/g, (_, k: string) => `${ATTACK[k.trim()] ?? k} Attack Roll:`)
    .replace(/\{@hit (-?\d+)\}/g, (_, n: string) => (n.startsWith('-') ? n : '+' + n))
    .replace(/\{@h\}/g, 'Hit: ')
    .replace(/\{@dc (\d+)\}/g, 'DC $1')
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = out.replace(/\{@\w+ ([^{}|]*)(?:\|[^{}]*)?\}/g, '$1')
  }
  return out
}

const cellText = (v: unknown): string => (typeof v === 'string' ? untag(v) : flatten([v]).join(' '))

/** 5etools entries as plain lines: strings, named entries (`Name. text`), lists (`• `), tables (cells ` | `); the rest skipped. */
export function flatten(entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  const out: string[] = []
  for (const e of entries) {
    if (typeof e === 'string') {
      out.push(untag(e))
      continue
    }
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, any>
    if (o.type === 'entries' || o.type === 'item') {
      const lines = flatten(o.entries ?? (o.entry !== undefined ? [o.entry] : []))
      if (o.name) {
        const [first, ...rest] = lines
        out.push(`${untag(String(o.name))}.` + (first ? ' ' + first : ''), ...rest)
      } else out.push(...lines)
    } else if (o.type === 'list') {
      for (const item of o.items ?? []) for (const line of flatten([item])) out.push('• ' + line)
    } else if (o.type === 'table') {
      for (const r of o.rows ?? []) if (Array.isArray(r)) out.push(r.map(cellText).join(' | '))
    }
  }
  return out
}

export const SCHOOLS: Record<string, string> = {
  A: 'Abjuration', C: 'Conjuration', D: 'Divination', E: 'Enchantment', V: 'Evocation', I: 'Illusion', N: 'Necromancy', T: 'Transmutation',
}

/** A cantrip's table (`1:1d10 5:2d10`) as `1d10, 2d10 at 5`; a slot spell's dice as they are. */
const diceText = (dice: string) =>
  dice.includes(':')
    ? dice.split(' ').map((p, i) => {
        const [lv, d] = p.split(':')
        return i ? `${d} at ${lv}` : d
      }).join(', ')
    : dice

/** A spell's facts row as the card's meta: level and school, time, range, components, duration, the roll, dice, damage types. */
function spellMeta(row: SpellRow): string[] {
  const [level, school, time, range, comps, duration, flagText, types, save, dice] = row
  const flags = flagText.split(' ')
  const sch = SCHOOLS[school] ?? school
  const meta = [
    (level === 0 ? `${sch} cantrip` : `Level ${level} ${sch}`) + (flags.includes('ritual') ? ' (ritual)' : ''),
    time,
    range,
    comps.split('').join(', '),
    (flags.includes('conc') ? 'Concentration, ' : '') + duration,
  ]
  if (flags.includes('ranged')) meta.push('ranged spell attack')
  else if (flags.includes('melee')) meta.push('melee spell attack')
  else if (save) meta.push(`${save} save`)
  if (dice) meta.push(diceText(dice))
  if (types) meta.push(types.split(',').join(', '))
  return meta.filter(Boolean)
}

const mod = (score: unknown) => {
  const n = Math.floor((Number(score) - 10) / 2)
  return Number.isFinite(n) ? (n >= 0 ? '+' + n : '−' + -n) : '?'
}

const acText = (ac: unknown) => {
  const first = Array.isArray(ac) ? ac[0] : ac
  return typeof first === 'number' ? String(first) : first && typeof first === 'object' && 'ac' in first ? String((first as any).ac) : '?'
}

const speedText = (s: unknown) => {
  if (typeof s === 'number') return `${s} ft`
  if (!s || typeof s !== 'object') return '?'
  return Object.entries(s as Record<string, any>)
    .filter(([, v]) => typeof v === 'number' || (v && typeof v === 'object' && 'number' in v))
    .map(([k, v]) => `${k === 'walk' ? '' : k + ' '}${typeof v === 'number' ? v : v.number} ft`)
    .join(', ')
}

const crText = (cr: unknown) => (typeof cr === 'string' ? cr : cr && typeof cr === 'object' && 'cr' in cr ? String((cr as any).cr) : '?')

/** A monster's answer as meta lines: AC, HP and formula, speed, the six modifiers, CR. */
function monsterMeta(p: Record<string, any>): string[] {
  const hp = p.hp && typeof p.hp === 'object' ? (p.hp.average !== undefined ? `HP ${p.hp.average}${p.hp.formula ? ` (${p.hp.formula})` : ''}` : `HP ${p.hp.special ?? '?'}`) : 'HP ?'
  return [
    `AC ${acText(p.ac)}`,
    hp,
    `Speed ${speedText(p.speed)}`,
    ['str', 'dex', 'con', 'int', 'wis', 'cha'].map((a) => `${a.toUpperCase()} ${mod(p[a])}`).join(' '),
    `CR ${crText(p.cr)}`,
  ]
}

/** A monster's traits, then actions, bonus actions and reactions, each `Name. text`. */
const monsterBody = (p: Record<string, any>) =>
  ['trait', 'action', 'bonus', 'reaction'].flatMap((k) =>
    flatten((Array.isArray(p[k]) ? p[k] : []).map((x: any) => ({ type: 'entries', name: x?.name, entries: x?.entries ?? [] }))),
  )

/** A spell candidate's facts row, for its card's meta before the fetch lands; null for the rest. */
export const factsRow = (cand: Candidate): SpellRow | null => (cand.kind === 'spell' ? SPELLS[cand.key] ?? null : null)

/** The card: the facts row's meta at once (spells), then the server's answer: its name, body and citation. */
export function cardOf(cand: Candidate, payload: unknown, row: SpellRow | null): Card {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, any>) : null
  const c = p?.citation
  const cite = c && typeof c === 'object' && c.source ? `${c.source} p${c.page ?? '?'}, ${c.edition ?? '?'}` : null
  const title = typeof p?.name === 'string' ? p.name : cand.name
  if (cand.kind === 'spell') {
    return { title, meta: row ? spellMeta(row) : [], body: p ? [...flatten(p.entries), ...flatten(p.entriesHigherLevel)] : [], cite }
  }
  if (cand.kind === 'monster') return { title, meta: p ? monsterMeta(p) : [], body: p ? monsterBody(p) : [], cite }
  return { title, meta: [], body: p ? flatten(p.entries) : [], cite }
}

/**
 * Ask Claude's prompt: the subject only (the typed text, or the card's title
 * and cite), the session, and the pane it came from; and `tail`, the heard
 * file's last minute of text, when the party pane has a fresh one. Nothing in it logs.
 */
export function askText({ subject, pane, session, tail }: { subject: string | { title: string; cite: string | null }; pane: 'Party' | 'Sheet'; session: string | null; tail?: string | null }): string {
  const s = session ? ` (${session})` : ''
  const about = typeof subject === 'string' ? `Table question${s}: ${subject}` : `Table question${s} about ${subject.title}` + (subject.cite ? ` (${subject.cite})` : '')
  const heard = tail ? ` Heard at the table in the last minute (local live transcript; names may be misheard): "${tail}".` : ''
  return `${about}, from the ${pane} pane.${heard} Answer from the rules server and cite it, in at most four lines. If the text doesn't settle it, say so and give the options; the DM rules.`
}

// ------------------------------------------------------------------ heard (T0085 stage 2)

/** The live listener's file (capture/live.py): text only, rewritten every few seconds, deleted when it stops. */
export const HEARD_PATH = '/tmp/toa-live/heard.json'
/** A heard file not rewritten for this long is treated as absent. */
const HEARD_STALE_MS = 10 * 60_000

export type HeardItem = { at: number; name: string; kind: 'spell' | 'condition' }
/** The heard file: its items newest first, and the last minute of heard text. */
export type Heard = { updated: number; items: HeardItem[]; tail: string }

/** The heard file's text as a Heard; null when there is none, it does not parse, its `v` is not 1, or it is stale. */
export function asHeard(text: string | null, now: number): Heard | null {
  if (!text) return null
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!j || j.v !== 1 || typeof j.updated !== 'number' || now - j.updated > HEARD_STALE_MS || !Array.isArray(j.items)) return null
  const items: HeardItem[] = j.items
    .filter((x: any) => x && typeof x.at === 'number' && typeof x.name === 'string' && (x.kind === 'spell' || x.kind === 'condition'))
    .map((x: any) => ({ at: x.at, name: x.name, kind: x.kind }))
  return { updated: j.updated, items, tail: typeof j.tail === 'string' ? j.tail : '' }
}
