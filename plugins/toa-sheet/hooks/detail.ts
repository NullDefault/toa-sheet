// The detail boxes (T0093 Layer 1): a word on the pane (a weapon, a spell, a
// save, a skill, a resource, a condition, the last-seen value, the requests)
// opens one box under its row, one at a time. Pure: no mods API. Everything a
// box says is data the pane already holds (the sheet, `derived`, facts.ts);
// it applies no rule. A breakdown (`CON +4 = CON +2 · proficient +2`) is the
// server's numbers taken apart by subtraction, which is display.
//
// A word's key names its subject: `w:act:<row key>` (actions.ts's row keys),
// `w:save:<ability>`, `w:skill:<name>`, `w:res:<index>` on the focused sheet;
// `w:cond:<entry id>:<condition>`, `w:seen:<entry id>`, `w:req:<entry id>` on
// any cached sheet. A word is drawn only where `detailOf` has a box for it.

import type { Elements, RenderElement, RenderNode } from 'claude-code'
import { cantripDice, mastery, norm, sameWeapon, spellFact, weaponFact, writtenDamage } from './actions.ts'
import { SKILLS, SKILLS_CITE, SPELL_ALIASES, SPELLS } from './facts.ts'
import { CONDITIONS, SCHOOLS, type Candidate } from './lookup.ts'
import { TOKENS } from './look.ts'
import { describeChange, type Entry } from './sheet.ts'

/** The open box: the word it hangs from, and the terms opened inside it (Layer 2 nests; Layer 1 holds one). */
export type Detail = { anchor: string; path: string[] }

/** A press on a word: its box opens, replacing any other; a press on the open one closes it. */
export const pressWord = (state: Detail | null, key: string): Detail | null => (state?.anchor === key ? null : { anchor: key, path: [key] })

/** A run of a line: values bold, labels faint, a warning amber. */
export type Piece = { text: string; tone?: 'value' | 'label' | 'warn' }
/** Pieces that never break apart; a line wraps only between units. */
type Unit = Piece[]

export interface Content {
  title: string
  lines: Unit[][]
  /** Where it comes from: `XPHB · derived`, `derived`, `sheet`. */
  cite: string
  /** `[ more ]`: T0085's card for this term. */
  more: Candidate | null
  /** `[ re-read ]`: the sheet's re-read. */
  reread: boolean
}

const val = (text: string): Piece => ({ text, tone: 'value' })
const lab = (text: string): Piece => ({ text, tone: 'label' })
const warn = (text: string): Piece => ({ text, tone: 'warn' })
const plain = (text: string): Piece => ({ text })
/** Units joined by a faint ` ·` at the end of each but the last. */
const dots = (units: Unit[]): Unit[] => units.map((u, i) => (i < units.length - 1 ? [...u, lab(' ·')] : u))
/** Prose as one unit a word, so it wraps between words. */
const prose = (s: string, tone?: Piece['tone']): Unit[] =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [{ text: w, ...(tone ? { tone } : {}) }])

const signed = (n: number) => (n >= 0 ? '+' + n : String(n))
const num = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN
  return Number.isFinite(n) ? n : null
}
const ORDINAL = (l: number) => ({ 1: '1st', 2: '2nd', 3: '3rd' })[l] ?? l + 'th'
const pad2 = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => pad2(new Date(ms).getHours()) + ':' + pad2(new Date(ms).getMinutes())
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** `39 min`, `5 h`, `3 d`. */
const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}
/** The pending number's warning: `derived` is the server's, and a write since may change it. */
const PENDING: Unit[] = prose('the server has not derived this yet', 'warn')

/**
 * `ABIL +mod`, then what proficiency adds, then any rest: the server's total
 * taken apart. `prof` is 0 (none), 1 (proficient) or 2 (expertise).
 */
function breakdown(total: number, abil: string, d: Record<string, any>, prof: 0 | 1 | 2): Unit[] {
  const mod = num(d.modifiers?.[abil])
  const pb = num(d.proficiency_bonus)
  if (mod === null || (prof && pb === null)) return []
  const add = prof ? prof * pb! : 0
  const rest = total - mod - add
  return [
    [lab(abil.toUpperCase() + ' '), val(signed(mod))],
    ...(prof ? [[lab(prof === 2 ? 'expertise ' : 'proficient '), val(signed(add))]] : []),
    ...(rest ? [[lab('other '), val(signed(rest))]] : []),
  ]
}

// ------------------------------------------------------------------ the boxes

function weaponBox(e: Entry, n: number): Content | null {
  const item = (e.sheet.inventory ?? [])[n]
  if (!item) return null
  const name = String(item.name ?? '')
  const hit = weaponFact(name, item.source, e.sheet.ruleset)
  if (!hit) return null
  const [category, kind, dice, type, versatile, props, range, masteryName] = hit.row
  const d = e.derived ?? {}
  const dw = (Array.isArray(d.weapons) ? d.weapons : []).find((w: any) => sameWeapon(String(w?.name ?? ''), name))
  const lines: Unit[][] = []
  const attack = num(dw?.attack)
  if (dw && attack !== null) {
    const prof = dw.proficient !== false
    lines.push(dots([[val(signed(attack)), plain(' to hit')], ...breakdown(attack, String(dw.ability ?? ''), d, prof ? 1 : 0), ...(prof ? [] : [[lab('not proficient')]])]))
  }
  const own = writtenDamage(String(item.note ?? ''))
  lines.push(own ? dots([[val(own)], [lab('as written')]]) : dots([[val([dice, type].filter(Boolean).join(' '))], [lab('no damage written'), warn(' ?')]]))
  // The two-handed dice with the attack's ability modifier, as the design's `two-handed 1d10+2`.
  const vmod = num(d.modifiers?.[String(dw?.ability ?? '')])
  if (versatile) lines.push([[lab('two-handed '), val(versatile + (vmod ? signed(vmod) : ''))]])
  const score = (abil: string) => num(e.sheet.abilities?.[abil])
  const heavy = kind === 'ranged' ? 'dex' : 'str'
  lines.push(
    dots([
      [val(category)],
      [val(kind)],
      ...(props ? props.split(',') : []).map((p): Unit => {
        if ((p === 'Thrown' || p === 'Ammunition') && range) return [val(p + ' ' + range)]
        if (p === 'Heavy' && score(heavy) !== null) return [val('Heavy'), lab(` (your ${heavy.toUpperCase()} ${score(heavy)})`)]
        return [val(p)]
      }),
    ]),
  )
  const wm = mastery(e)
  if (masteryName && wm && (wm.all || wm.names.some((w) => sameWeapon(w, name)))) lines.push([[lab('mastery '), val(masteryName)]])
  const says = Object.entries((e.sheet.as_written?.weapon_attack ?? {}) as Record<string, unknown>).find(([k]) => sameWeapon(k, name))?.[1]
  if (dw && says !== undefined && String(says) !== String(dw.attack)) lines.push([[lab('the sheet says '), val(String(says))]])
  if (dw && e.derivedPending) lines.push(PENDING)
  return { title: name, lines, cite: hit.source + (dw ? ' · derived' : ''), more: null, reread: false }
}

function spellBox(e: Entry, spell: any, cls: string): Content | null {
  const name = String(spell?.name ?? '')
  const hit = spellFact(name, spell?.source, e.sheet.ruleset)
  if (!hit) return null
  const [level, school, time, range, comps, duration, flagText, damage, save, diceText] = hit.row
  const flags = flagText ? flagText.split(' ') : []
  const d = e.derived ?? {}
  const lines: Unit[][] = [dots([level === 0 ? 'Cantrip' : ORDINAL(level), SCHOOLS[school] ?? school, time, range, comps, duration].filter(Boolean).map((s) => [val(s)]))]
  const caster = cls ? ((d.spellcasting ?? []) as any[]).find((c) => String(c.class) === cls) : undefined
  const q = e.derivedPending ? '?' : ''
  if (caster && (flags.includes('melee') || flags.includes('ranged'))) {
    const atk = num(caster.attack)
    lines.push([[val((atk === null ? String(caster.attack) : signed(atk)) + q), plain(' to hit')], [lab(`(${cls})`)]])
  } else if (caster && save) lines.push(dots([[val(save), plain(' save')], [lab('DC '), val(String(caster.save_dc) + q), lab(` (${cls})`)]]))
  const total = num(d.total_level)
  const dice = level === 0 ? cantripDice(diceText, total) : diceText
  if (damage) lines.push([[val(dice)], ...prose(damage.split(',').join(', '))].filter((u) => u[0]!.text))
  else if (flags.includes('heal') && dice) lines.push([[lab('heal '), val(dice + (flags.includes('mod') ? ' + mod' : ''))]])
  const tags = [...(flags.includes('conc') ? ['Concentration'] : []), ...(flags.includes('ritual') ? ['Ritual'] : [])]
  if (tags.length) lines.push(dots(tags.map((t) => [val(t)])))
  if (caster && e.derivedPending) lines.push(PENDING)
  // The card fetches the spell by name; the facts row is the one this box read.
  const n = norm(name)
  const keyName = SPELLS[n + '|' + hit.source.toLowerCase()] ? n : SPELL_ALIASES[n] ?? n
  return { title: name, lines, cite: hit.source + (caster ? ' · derived' : ''), more: { name, kind: 'spell', key: keyName + '|' + hit.source.toLowerCase() }, reread: false }
}

/** `w:act:<row key>`: `weapon-<inventory index>`, `spell-<class>-c<i>` (cantrip), `spell-<class>-<i>`, `other-<i>`. */
function actionBox(e: Entry, row: string): Content | null {
  const at = row.lastIndexOf('-')
  const kind = row.slice(0, row.indexOf('-'))
  const i = row.slice(at + 1)
  if (kind === 'weapon') return weaponBox(e, Number(i))
  if (kind === 'other') return spellBox(e, (e.sheet.spellcasting?.other ?? [])[Number(i)], '')
  if (kind !== 'spell') return null
  const cls = row.slice('spell-'.length, at)
  const sc = (e.sheet.spellcasting?.by_class ?? []).find((c: any) => String(c.class ?? '') === cls)
  const spell = i.startsWith('c') ? sc?.cantrips?.[Number(i.slice(1))] : sc?.spells?.[Number(i)]
  return spell ? spellBox(e, spell, cls) : null
}

function saveBox(e: Entry, abil: string): Content | null {
  const d = e.derived
  const total = num(d?.saving_throws?.[abil])
  if (!d || total === null) return null
  const prof = (e.sheet.proficiencies?.saves ?? []).includes(abil)
  const parts = breakdown(total, abil, d, prof ? 1 : 0)
  const lines: Unit[][] = [[[lab(abil.toUpperCase() + ' '), val(signed(total)), plain(parts.length ? ' =' : '')], ...dots(parts)]]
  if (e.derivedPending) lines.push(PENDING)
  return { title: abil.toUpperCase() + ' save', lines, cite: 'derived', more: null, reread: false }
}

function skillBox(e: Entry, skill: string): Content | null {
  const d = e.derived
  const name = Object.keys(d?.skills ?? {}).find((k) => k.toLowerCase() === skill.toLowerCase())
  const total = name ? num(d!.skills[name]) : null
  const abil = SKILLS[skill.toLowerCase()]
  if (!d || !name || total === null || !abil) return null
  const p = (e.sheet.proficiencies?.skills ?? []).find((k: any) => String(k.name).toLowerCase() === skill.toLowerCase())
  const parts = breakdown(total, abil, d, p ? (p.expertise ? 2 : 1) : 0)
  const lines: Unit[][] = [[[lab(name + ' '), val(signed(total)), plain(parts.length ? ' =' : '')], ...dots(parts)]]
  const says = Object.entries((e.sheet.as_written?.skills ?? {}) as Record<string, unknown>).find(([k]) => k.toLowerCase() === skill.toLowerCase())?.[1]
  if (says !== undefined && String(says) !== signed(total)) lines.push([[lab('the sheet says '), val(String(says))]])
  if (e.derivedPending) lines.push(PENDING)
  return { title: name, lines, cite: SKILLS_CITE + ' · derived', more: null, reread: false }
}

const RECHARGE: Record<string, string> = { long: 'a Long Rest', short: 'a Short Rest' }

function resourceBox(e: Entry, i: number): Content | null {
  const r = (e.sheet.resources ?? [])[i]
  const max = num(r?.max)
  if (!r || max === null) return null
  const lines: Unit[][] = [
    dots([[val(`${Math.max(0, max - (num(r.used) ?? 0))} of ${max}`)], ...(r.recharge ? [[lab('recharges on '), val(RECHARGE[r.recharge] ?? String(r.recharge))]] : [])]),
  ]
  if (r.note) lines.push(prose(String(r.note)))
  return { title: String(r.name), lines, cite: 'sheet', more: null, reread: false }
}

/** A condition on the sheet: its name (no duration field exists yet), exhaustion's level, the card a press away. */
function conditionBox(e: Entry, cond: string): Content | null {
  const known = CONDITIONS.find((c) => norm(c) === norm(cond))
  if (!known) return null
  const level = num(e.sheet.exhaustion) ?? 0
  const ok = known === 'Exhaustion' ? level > 0 : (e.sheet.conditions ?? []).some((c: unknown) => norm(String(c)) === norm(cond))
  if (!ok) return null
  return {
    title: known,
    lines: known === 'Exhaustion' ? [[[lab('level '), val(String(level))]]] : [],
    cite: 'sheet',
    more: { name: known, kind: 'condition', key: norm(known) },
    reread: false,
  }
}

function seenBox(e: Entry, now: number): Content {
  const today = new Date(e.readAt).toDateString() === new Date(now).toDateString()
  const at = today ? clock(e.readAt) : `${new Date(e.readAt).getDate()} ${MONTHS[new Date(e.readAt).getMonth()]}, ${clock(e.readAt)}`
  const lines: Unit[][] = [[[lab('seen '), val(at)], [lab(`(${ago(now - e.readAt)})`)]]]
  if (e.last) lines.push([[lab('last')], ...prose(describeChange(e.last, e.sheet))])
  return { title: e.name, lines, cite: 'sheet', more: null, reread: true }
}

/** The DM's requests on a sheet (T0084): one line each; the pane decides nothing. */
function requestBox(e: Entry): Content | null {
  const reqs = Array.isArray(e.sheet.requests) ? e.sheet.requests : []
  if (!reqs.length) return null
  // Each field's words wrap apart; a faint ` ·` follows a field's last word.
  const lines: Unit[][] = reqs.map((r: any) =>
    [r?.ask, Array.isArray(r?.keys) ? r.keys.join(', ') : r?.keys, r?.by, r?.date]
      .filter((x) => x !== undefined && x !== null && String(x).trim())
      .map((x) => prose(String(x)))
      .flatMap((us, i, all) => (i < all.length - 1 ? [...us.slice(0, -1), [...us.at(-1)!, lab(' ·')]] : us)),
  )
  lines.push(prose('decide in chat', 'label'))
  return { title: `${e.name} · ${reqs.length} request${reqs.length === 1 ? '' : 's'}`, lines, cite: 'sheet', more: null, reread: false }
}

/** What a word's box holds, or null when it has none (the word is then plain text). */
export function detailOf(key: string, rows: Entry[], focused: Entry | null, now: number): Content | null {
  const [w, kind] = key.split(':', 2)
  if (w !== 'w' || !kind) return null
  const rest = key.slice(`w:${kind}:`.length)
  const byId = (id: string) => [...(focused ? [focused] : []), ...rows].find((e) => e.id === id) ?? null
  switch (kind) {
    case 'act':
      return focused ? actionBox(focused, rest) : null
    case 'save':
      return focused ? saveBox(focused, rest) : null
    case 'skill':
      return focused ? skillBox(focused, rest) : null
    case 'res':
      return focused ? resourceBox(focused, Number(rest)) : null
    case 'cond': {
      const at = rest.lastIndexOf(':')
      const e = byId(rest.slice(0, at))
      return e ? conditionBox(e, rest.slice(at + 1)) : null
    }
    case 'seen': {
      const e = byId(rest)
      return e ? seenBox(e, now) : null
    }
    case 'req': {
      const e = byId(rest)
      return e ? requestBox(e) : null
    }
    default:
      return null
  }
}

// ------------------------------------------------------------------ drawing

type El = Pick<Elements['mobile'], 'Box' | 'Text'>
type Make = (props: { key: string; label: string }) => RenderElement

/** The most body rows a box draws; past it, a faint `and N more` (never `…`). */
const MAX_ROWS = 6
const width = (u: Unit) => u.reduce((n, p) => n + p.text.length, 0)

/**
 * Items in rows of at most `w` columns, `gap` between them: the greedy wrap.
 * Each row is drawn as its own nowrap row (the spike's line layout), since
 * flex shrink would split a word and `flexWrap` alone hides the columns.
 */
export function greedy<T>(items: T[], width: (t: T) => number, w: number, gap = 1): T[][] {
  const rows: T[][] = []
  let cur: T[] = []
  let used = 0
  for (const t of items) {
    const tw = width(t)
    if (cur.length && used + gap + tw > w) {
      rows.push(cur)
      cur = []
      used = 0
    }
    used += (cur.length ? gap : 0) + tw
    cur.push(t)
  }
  if (cur.length) rows.push(cur)
  return rows
}

/**
 * The box: a round border as wide as the pane's body, the title and `[ × ]`,
 * up to six rows (each a nowrap row the wrap laid out), then `[ more ]` or
 * `[ re-read ]` and the faint cite at the bottom right. Its Buttons carry no
 * hotkey.
 */
export function detailBox(el: El, make: Make, c: Content, columns: number): RenderElement {
  const inner = Math.max(8, columns - 4)
  const span = (p: Piece) =>
    el.Text({ children: [p.text], ...(p.tone === 'value' ? { bold: true } : p.tone === 'label' ? { dimColor: true } : p.tone === 'warn' ? { color: TOKENS.amber } : {}) })
  const drawRow = (r: Unit[]) =>
    el.Box({ flexDirection: 'row', columnGap: 1, children: r.map((u) => el.Box({ flexDirection: 'row', flexShrink: 0, children: u.map(span) })) })
  const laid = c.lines.map((l) => greedy(l, width, inner))
  const total = laid.reduce((n, rs) => n + rs.length, 0)
  const body: RenderNode[] = []
  if (total <= MAX_ROWS) for (const rs of laid) body.push(...rs.map(drawRow))
  else {
    let shown = 0
    let k = 0
    for (; k < laid.length && shown + laid[k]!.length <= MAX_ROWS - 1; k++) {
      body.push(...laid[k]!.map(drawRow))
      shown += laid[k]!.length
    }
    body.push(el.Text({ children: [`and ${laid.length - k} more`], dimColor: true }))
  }
  const buttons = [...(c.more ? [make({ key: 'detail-more', label: 'more' })] : []), ...(c.reread ? [make({ key: 'detail-reread', label: 're-read' })] : [])]
  return el.Box({
    key: 'detail',
    borderStyle: 'round',
    width: columns,
    paddingX: 1,
    flexDirection: 'column',
    children: [
      el.Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [el.Box({ flexGrow: 1, flexShrink: 1, children: [el.Text({ children: [c.title], bold: true, wrap: 'wrap' })] }), el.Box({ flexShrink: 0, children: [make({ key: 'detail-x', label: '×' })] })],
      }),
      ...body,
      el.Box({
        flexDirection: 'row',
        justifyContent: buttons.length ? 'space-between' : 'flex-end',
        columnGap: 1,
        children: [...(buttons.length ? [el.Box({ flexDirection: 'row', columnGap: 1, children: buttons })] : []), el.Text({ children: [c.cite], dimColor: true })],
      }),
    ],
  })
}
