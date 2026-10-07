// The DM's fight (handoff 18, step A part 1): the entry line's tracking subset.
// The store holds the lines the DM typed (events); a Fight is their fold. Pure:
// no mods API. The only arithmetic is the DM's own HP sums and the round count.

export type Side = 'pc' | 'monster'
/** `working` is the signed changes in order (`22 − 9 = 13`); `zero` is `0?` pending, `dead` is confirmed by `x`. */
export type Member = { hp: number; max: number; working: number[]; dead: boolean; zero: boolean }
/** A PC row has no members (its HP is the sheet's); a single monster has one. `added` is its event index. */
export type Row = { id: string; side: Side; name: string; init: number | null; ac: number | null; members: Member[]; out: boolean; down: boolean; added: number }
/** A line as the DM typed it; `working` is an HP line's result (`22 − 9 = 13`). */
export type LogLine = { at: number; text: string; working?: string; reverted?: true }
export type Fight = { id: string; startedAt: number; rows: Row[]; pointer: string | null; round: number; ended: number | null; log: LogLine[] }
/** `undo` names the index of the event it reverts. */
export type Event = { at: number; line: string; source: 'dm' } | { at: number; undo: number }
export type Ctx = { pcs: { id: string; name: string }[]; fight: Fight | null }

/** A creature a line names: a PC (its row may not exist yet) or a fight row. */
type Who = { id: string; name: string; pc: boolean; row: Row | null }
type Op =
  | { op: 'add'; name: string; count: number; init: number | null; hp: number; ac: number | null }
  | { op: 'init'; who: Who; value: number }
  | { op: 'hp'; row: string; member: number; delta: number }
  | { op: 'kill'; row: string; member: number }
  | { op: 'out'; row: string }
  | { op: 'setHp'; row: string; value: number }
  | { op: 'setAc'; who: Who; value: number }
  | { op: 'down'; who: Who; value: boolean }
  | { op: 'point'; row: string }
  | { op: 'next' }
  | { op: 'end' }

/** The help drawn dim under the field: the README table's "Typed" column. */
export const GRAMMAR = [
  'u · undo',
  'n · next',
  'end',
  '<name> [x<n>] - <init> : <hp>',
  '<name> [x<n>] hp <N> [ac <N>]',
  '<name> hp <N> · <name> ac <N>',
  '<name> x · <name> out',
  '<name> down · <name> up',
  '<ref> ±N',
  '<name> <N> [<name> <N> …]',
  '<name>',
]

const RESERVED = new Set(['n', 'next', 'u', 'undo', 'x', 'end', 'out', 'hp', 'ac', 'down', 'up'])
const SAVES = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const UNKNOWN = 'unknown line'
const NO_FIGHT = 'no fight yet'

export const live = (f: Fight | null) => (f && f.ended === null ? f : null)
const words = (name: string) => name.toLowerCase().split(/\s+/).filter(Boolean)
const isInt = (t: string | undefined) => !!t && /^\d+$/.test(t)
const isSigned = (t: string | undefined) => !!t && /^[+-]\d+$/.test(t)
const group = (r: Row) => r.side === 'monster' && r.members.length > 1
const allDead = (r: Row) => r.side === 'monster' && r.members.every((m) => m.dead)

/** Do `typed` match consecutive words of `name`, each a prefix, starting at any word? */
function matches(typed: string[], name: string): boolean {
  const w = words(name)
  for (let j = 0; j + typed.length <= w.length; j++) if (typed.every((t, i) => w[j + i]!.startsWith(t))) return true
  return false
}

/** Every creature a name can reach: the PCs, then a live fight's monsters. */
function creatures(ctx: Ctx): Who[] {
  const f = live(ctx.fight)
  const pcs = ctx.pcs.map((p) => ({ id: p.id, name: p.name, pc: true, row: f?.rows.find((r) => r.id === p.id) ?? null }))
  const monsters = (f?.rows ?? []).filter((r) => r.side === 'monster').map((r) => ({ id: r.id, name: r.name, pc: false, row: r }))
  return [...pcs, ...monsters]
}

type Named = { who: Who; used: number } | { refused: string }

const exactly = (typed: string[], name: string) => words(name).join(' ') === typed.join(' ')

/** The longest run of leading tokens naming exactly one creature, or one whose whole name it is; the tokens after it are arguments. */
function resolve(tokens: string[], ctx: Ctx): Named {
  let run = 0
  while (run < tokens.length && !RESERVED.has(tokens[run]!) && !isSigned(tokens[run])) run++
  if (!run || tokens[0]!.length < 2) return { refused: UNKNOWN }
  const all = creatures(ctx)
  for (let k = run; k > 0; k--) {
    const hits = all.filter((c) => matches(tokens.slice(0, k), c.name))
    if (hits.length === 1) return { who: hits[0]!, used: k }
    const exact = hits.filter((h) => exactly(tokens.slice(0, k), h.name))
    if (exact.length === 1) return { who: exact[0]!, used: k }
    if (hits.length > 1) return { refused: 'ambiguous: ' + hits.map((h) => h.name.toLowerCase()).join(', ') }
  }
  return { refused: 'no such creature' }
}

/** `m3`: member 3 of the one group whose name has a word starting `m`. Null when no group answers to the letters. */
function memberRef(token: string, ctx: Ctx): { row: Row; member: number } | { refused: string } | null {
  const m = /^([a-z]+)(\d+)$/.exec(token)
  const f = live(ctx.fight)
  if (!m || !f) return null
  const groups = f.rows.filter((r) => group(r) && words(r.name).some((w) => w.startsWith(m[1]!)))
  if (!groups.length) return null
  if (groups.length > 1) return { refused: 'ambiguous: ' + groups.map((g) => g.name.toLowerCase()).join(', ') }
  const row = groups[0]!
  const n = Number(m[2])
  if (n < 1 || n > row.members.length) return { refused: whichMember(m[1]!, row) }
  return { row, member: n - 1 }
}

const whichMember = (letters: string, r: Row) => `which member? ${letters}1…${letters}${r.members.length}`
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Initiatives: `<name> <N> [<name> <N> …]`, every pair or nothing. */
function inits(tokens: string[], ctx: Ctx): Op[] | { refused: string } {
  const ops: Op[] = []
  while (tokens.length) {
    const r = resolve(tokens, ctx)
    if ('refused' in r) return r
    const n = tokens[r.used]
    if (!isInt(n) || (!r.who.pc && !live(ctx.fight))) return { refused: UNKNOWN }
    ops.push({ op: 'init', who: r.who, value: Number(n) })
    tokens = tokens.slice(r.used + 1)
  }
  return ops
}

/** One typed line to the operations it means, or why it is refused. `u`/`undo` is the caller's. */
export function parseLine(line: string, ctx: Ctx): Op[] | { refused: string } {
  const lower = line.trim().toLowerCase().replace(/\s+/g, ' ')
  const tokens = lower.split(' ').filter(Boolean)
  const f = live(ctx.fight)
  if (!tokens.length) return { refused: UNKNOWN }
  if (tokens.length === 1 && (tokens[0] === 'n' || tokens[0] === 'next')) return f ? [{ op: 'next' }] : { refused: NO_FIGHT }
  if (lower === 'end') return f ? [{ op: 'end' }] : { refused: NO_FIGHT }
  if (tokens.some((t) => SAVES.has(t))) return { refused: 'saves come with the rules engine' }

  const header = /^(.*?[a-z].*?)(?: x(\d+))? - (\d+) : (\d+)$/.exec(lower)
  if (header) return [{ op: 'add', name: capital(header[1]!), count: Number(header[2] ?? 1), init: Number(header[3]), hp: Number(header[4]), ac: null }]

  const hpForm = /^(.*?[a-z].*?)(?: x(\d+))? hp (\d+)(?: ac (\d+))?$/.exec(lower)
  if (hpForm) {
    const [, name, count, hp, ac] = hpForm
    const named = count ? null : resolve(words(name!), ctx)
    if (named && 'refused' in named && named.refused !== 'no such creature') return named
    // Only a monster's whole name resets it; `goblin hp 7` beside a Goblin boss adds a goblin.
    if (!named || 'refused' in named || named.used < words(name!).length || (!named.who.pc && !exactly(words(name!), named.who.name))) {
      return [{ op: 'add', name: capital(name!), count: Number(count ?? 1), init: null, hp: Number(hp), ac: ac === undefined ? null : Number(ac) }]
    }
    if (named.who.pc) return { refused: 'PC HP comes from the sheet' }
    const ops: Op[] = [{ op: 'setHp', row: named.who.id, value: Number(hp) }]
    if (ac !== undefined) ops.push({ op: 'setAc', who: named.who, value: Number(ac) })
    return ops
  }

  const spaced = /^(.+) ([+-]) (\d+)$/.exec(lower)
  if (spaced) return { refused: `did you mean ${spaced[2]}${spaced[3]}?` }

  const ref = memberRef(tokens[0]!, ctx)
  if (ref && 'refused' in ref) return ref
  if (ref) {
    const rest = tokens.slice(1)
    if (rest.length === 1 && isSigned(rest[0])) return [{ op: 'hp', row: ref.row.id, member: ref.member, delta: Number(rest[0]) }]
    if (rest.length === 1 && rest[0] === 'x') return [{ op: 'kill', row: ref.row.id, member: ref.member }]
    if (rest.length === 1 && ['out', 'down', 'up'].includes(rest[0]!)) return { refused: `${rest[0]} takes a name: a member's row is its group` }
    if (!rest.length) return [{ op: 'point', row: ref.row.id }]
    return { refused: UNKNOWN }
  }

  const named = resolve(tokens, ctx)
  if ('refused' in named) return named
  const { who } = named
  const rest = tokens.slice(named.used)
  const letter = tokens[0]!.charAt(0)
  if (rest.length === 2 && rest[0] === 'ac' && isInt(rest[1])) {
    if (!who.pc && !f) return { refused: NO_FIGHT }
    return [{ op: 'setAc', who, value: Number(rest[1]) }]
  }
  if (rest.length === 1 && (isSigned(rest[0]) || rest[0] === 'x')) {
    if (who.pc) return { refused: 'PC HP comes from the sheet' }
    if (group(who.row!)) return { refused: whichMember(letter, who.row!) }
    return [isSigned(rest[0]) ? { op: 'hp', row: who.id, member: 0, delta: Number(rest[0]) } : { op: 'kill', row: who.id, member: 0 }]
  }
  if (rest.length === 1 && ['out', 'down', 'up'].includes(rest[0]!)) {
    if (!f) return { refused: NO_FIGHT }
    if (rest[0] === 'out') return who.row ? [{ op: 'out', row: who.id }] : { refused: 'not in the fight' }
    return [{ op: 'down', who, value: rest[0] === 'down' }]
  }
  if (!rest.length) {
    if (!f) return { refused: NO_FIGHT }
    return who.row ? [{ op: 'point', row: who.id }] : { refused: 'not in the fight' }
  }
  if (isInt(rest[0])) return inits(tokens, ctx)
  return { refused: UNKNOWN }
}

const undoneOf = (events: Event[]) => new Set(events.flatMap((e) => ('undo' in e ? [e.undo] : [])))

/** The index of the event the next `undo` reverts, or null. */
export function undoTarget(events: Event[]): number | null {
  const undone = undoneOf(events)
  for (let i = events.length - 1; i >= 0; i--) if (!('undo' in events[i]!) && !undone.has(i)) return i
  return null
}

/** Can the pointer land here? Not `out`, not a dead group, not a `?` row. */
const eligible = (r: Row) => !r.out && r.init !== null && !allDead(r)

/** Initiative order: rows with one (highest first, then as added), then `?` rows as added; out and dead rows sink in each. */
export function orderRows(f: Fight): Row[] {
  const sunk = (r: Row) => (r.out || allDead(r) ? 1 : 0)
  const by = (a: Row, b: Row) => sunk(a) - sunk(b) || (b.init ?? 0) - (a.init ?? 0) || a.added - b.added
  return [...f.rows.filter((r) => r.init !== null).sort(by), ...f.rows.filter((r) => r.init === null).sort(by)]
}

/** Where `n` moves the pointer, and whether it wraps to a new round. */
function nextRow(f: Fight): { row: Row; wraps: boolean } | null {
  const order = orderRows(f)
  const at = order.findIndex((r) => r.id === f.pointer)
  const after = f.pointer === null ? order.find(eligible) : order.slice(at + 1).find(eligible)
  if (after) return { row: after, wraps: false }
  const first = order.find(eligible)
  return first ? { row: first, wraps: true } : null
}

/** `▶ NUX then DIEGO · ROUND 2`, or `NO POINTER · type a name or n` before the first. */
export function statusText(f: Fight): string {
  const cur = f.rows.find((r) => r.id === f.pointer)
  if (!cur) return 'NO POINTER · type a name or n'
  const next = nextRow(f)
  const then = next && next.row !== cur ? ` then ${next.row.name.toUpperCase()}` : ''
  return `▶ ${cur.name.toUpperCase()}${then}` + (f.round ? ` · ROUND ${f.round}` : '')
}

/** A member's working as the DM writes it: `22 − 9 = 13 − 8 = 5`. */
export function working(m: Member): string {
  let hp = m.max
  let s = String(hp)
  for (const d of m.working) {
    hp += d
    s += ` ${d < 0 ? '−' : '+'} ${Math.abs(d)} = ${hp}`
  }
  return s
}

function pcRow(f: Fight, who: Who, added: number): Row {
  let r = f.rows.find((x) => x.id === who.id)
  if (!r) {
    r = { id: who.id, side: 'pc', name: who.name, init: null, ac: null, members: [], out: false, down: false, added }
    f.rows.push(r)
  }
  return r
}

/** Apply one line's operations to `f`, the event at index `i`; returns the HP working it produced, if any. */
function applyOps(f: Fight, ops: Op[], i: number, at: number): string | undefined {
  let result: string | undefined
  const row = (id: string) => f.rows.find((r) => r.id === id)!
  const target = (w: Who) => (w.pc ? pcRow(f, w, i) : row(w.id))
  for (const o of ops) {
    if (o.op === 'add') {
      const members = Array.from({ length: Math.max(1, o.count) }, () => ({ hp: o.hp, max: o.hp, working: [], dead: false, zero: false }))
      f.rows.push({ id: 'm' + i, side: 'monster', name: o.name, init: o.init, ac: o.ac, members, out: false, down: false, added: i })
    } else if (o.op === 'init') target(o.who).init = o.value
    else if (o.op === 'hp') {
      const m = row(o.row).members[o.member]!
      m.working.push(o.delta)
      m.hp += o.delta
      m.zero = m.hp <= 0 && !m.dead
      result = working(m)
    } else if (o.op === 'kill') Object.assign(row(o.row).members[o.member]!, { dead: true, zero: false })
    else if (o.op === 'out') row(o.row).out = true
    else if (o.op === 'setHp') row(o.row).members = row(o.row).members.map(() => ({ hp: o.value, max: o.value, working: [], dead: false, zero: false }))
    else if (o.op === 'setAc') target(o.who).ac = o.value
    else if (o.op === 'down') target(o.who).down = o.value
    else if (o.op === 'point') f.pointer = o.row
    else if (o.op === 'next') {
      const n = nextRow(f)
      if (n) {
        f.round = f.pointer === null ? Math.max(f.round, 1) : n.wraps ? f.round + 1 : f.round
        f.pointer = n.row.id
      }
    } else if (o.op === 'end') f.ended = at
  }
  return result
}

/** Does this line open a new fight when none is live? An add, or a PC's initiative or AC. */
const starts = (ops: Op[]) => ops.some((o) => o.op === 'add' || o.op === 'init' || o.op === 'setAc')

/**
 * Replay the events: undone lines are logged and skipped, a line that no
 * longer parses (a PC renamed) is logged as `? <line>`. A line that starts a
 * fight while none is live begins a new one, `F` + its time.
 */
export function fold(events: Event[], pcs: Ctx['pcs']): Fight | null {
  const undone = undoneOf(events)
  let f: Fight | null = null
  events.forEach((e, i) => {
    if ('undo' in e) return
    if (undone.has(i)) return void f?.log.push({ at: e.at, text: e.line, reverted: true })
    const ops = parseLine(e.line, { pcs, fight: f })
    if ('refused' in ops) return void f?.log.push({ at: e.at, text: '? ' + e.line })
    if (!live(f) && starts(ops)) f = { id: 'F' + e.at, startedAt: e.at, rows: [], pointer: null, round: 0, ended: null, log: [] }
    if (!f) return
    const result = applyOps(f, ops, i, e.at)
    f.log.push({ at: e.at, text: e.line, ...(result ? { working: result } : {}) })
  })
  return f
}
