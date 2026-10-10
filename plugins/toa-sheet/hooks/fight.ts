// The DM's fight (handoff 18, step A part 1). The store holds the DM's presses
// (ops); a Fight is their fold. Pure: no mods API. The only arithmetic is the
// DM's own HP sums and the round count.

export type Side = 'pc' | 'monster'
/** `working` is the signed changes in order (`22 − 9 = 13`); `zero` is `0?` pending, `dead` is confirmed by `x`. */
export type Member = { hp: number; max: number; working: number[]; dead: boolean; zero: boolean }
/** A row with no members has no HP tracked (a PC's is the sheet's); a single monster has one. `added` is its event index; `downs` the rounds `k` put it down in. */
export type Row = { id: string; side: Side; name: string; init: number | null; ac: number | null; members: Member[]; out: boolean; down: boolean; downs: number[]; added: number }
/** An op as `describe` renders it; `working` is an HP op's result (`22 − 9 = 13`). */
export type LogLine = { at: number; text: string; working?: string; reverted?: true }
/** `packs` names the packs loaded into it, in order (an undone one is not). */
export type Fight = { id: string; startedAt: number; rows: Row[]; pointer: string | null; round: number; ended: number | null; log: LogLine[]; packs: string[] }
export type AddOp = { op: 'add'; name: string; count: number; hp: number | null; ac: number | null; init: number | null }
/** One press. `name` on `init`/`down` is the PC's roster name: its row is made on first mention. A `pack` is a combat pack's adds as one press. */
export type Op =
  | AddOp
  | { op: 'pack'; name: string; rows: AddOp[] }
  | { op: 'init'; row: string; name: string; value: number }
  | { op: 'hp'; row: string; member: number; delta: number }
  | { op: 'kill'; row: string; member: number }
  | { op: 'out'; row: string }
  | { op: 'down'; row: string; name: string; value: boolean }
  | { op: 'point'; row: string }
  | { op: 'next' }
  | { op: 'end' }
/** `undo` names the index of the event it reverts. */
export type Event = { at: number; op: Op } | { at: number; undo: number }

export const live = (f: Fight | null) => (f && f.ended === null ? f : null)
const group = (r: Row | undefined) => !!r && r.members.length > 1
const allDead = (r: Row) => r.members.length > 0 && r.members.every((m) => m.dead)

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

/** The row on deck: where `n` would move the pointer, unless that is the current row. */
export function onDeck(f: Fight): string | null {
  const next = nextRow(f)
  return next && next.row.id !== f.pointer ? next.row.id : null
}

/** `▶ NUX then DIEGO · ROUND 2`, or `NO POINTER · next turn, or a row's turn` before the first. */
export function statusText(f: Fight): string {
  const cur = f.rows.find((r) => r.id === f.pointer)
  if (!cur) return "NO POINTER · next turn, or a row's turn"
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

/** A row and member as the log names them: the member's number only in a group. */
function named(f: Fight | null, id: string, member?: number): string {
  const r = f?.rows.find((x) => x.id === id)
  const name = r?.name ?? id
  return member !== undefined && group(r) ? `${name} ${member + 1}` : name
}

/** An op as the log shows it: `Goblin ×2 · hp 7 · ac 15 · init 14`, `Goblin 2 −9`, `▶ Bati`. */
export function describe(o: Op, f: Fight | null): string {
  if (o.op === 'add') {
    const parts = [o.count > 1 ? `${o.name} ×${o.count}` : o.name]
    if (o.hp !== null) parts.push(`hp ${o.hp}`)
    if (o.ac !== null) parts.push(`ac ${o.ac}`)
    if (o.init !== null) parts.push(`init ${o.init}`)
    return parts.join(' · ')
  }
  if (o.op === 'pack') return `pack ${o.name}: ${o.rows.length} group${o.rows.length === 1 ? '' : 's'}`
  if (o.op === 'init') return `${o.name} · init ${o.value}`
  if (o.op === 'hp') return `${named(f, o.row, o.member)} ${o.delta < 0 ? '−' : '+'}${Math.abs(o.delta)}`
  if (o.op === 'kill') return `${named(f, o.row, o.member)} ✕`
  if (o.op === 'out') return `${named(f, o.row)} out`
  if (o.op === 'down') return `${o.name} ${o.value ? 'down' : 'up'}`
  if (o.op === 'point') return `▶ ${named(f, o.row)}`
  return o.op === 'next' ? 'next turn' : 'end'
}

/**
 * The fight as one Table-note line, for Ingest: what was tracked, in the DM's
 * words (`out`, never "fled"). Null when no row was tracked. For example
 * `fight: Smoke mephit ×6, 5 dead, 1 standing · Gout · Slaad out · 9 rounds · Gout down r2, r5`.
 * Standing counts `0?` members too: only `x` confirms a death.
 */
export function summary(f: Fight): string | null {
  const order = orderRows(f)
  if (!order.length) return null
  const rows = order.map((r) => {
    const n = r.members.length
    const dead = r.members.filter((m) => m.dead).length
    const s = (n > 1 ? `${r.name} ×${n}` : r.name) + (dead ? `, ${dead} dead` : '') + (n - dead ? `, ${n - dead} standing` : '')
    return r.out ? s + ' out' : s
  })
  const rounds = f.round ? [f.round === 1 ? '1 round' : `${f.round} rounds`] : []
  const downs = order.filter((r) => r.downs.length).map((r) => `${r.name} down ${r.downs.map((d) => 'r' + d).join(', ')}`)
  return 'fight: ' + [...rows, ...rounds, ...downs].join(' · ')
}

/** An add's row, `id`, from the event at index `i`. */
function addRow(f: Fight, o: AddOp, id: string, i: number) {
  const hp = o.hp
  const members = hp === null ? [] : Array.from({ length: Math.max(1, o.count) }, () => ({ hp, max: hp, working: [], dead: false, zero: false }))
  f.rows.push({ id, side: 'monster', name: o.name, init: o.init, ac: o.ac, members, out: false, down: false, downs: [], added: i })
}

/** Apply one op to `f`, the event at index `i`: false when its row or member is not there. Returns the HP working an `hp` op produced. */
function applyOp(f: Fight, o: Op, i: number, at: number): { working?: string } | false {
  const r = 'row' in o ? f.rows.find((x) => x.id === o.row) : undefined
  if (o.op === 'add') addRow(f, o, 'm' + i, i)
  // A pack's rows share its event index, so one undo takes them all; they order as listed.
  else if (o.op === 'pack') {
    o.rows.forEach((a, k) => addRow(f, a, `m${i}.${k}`, i))
    f.packs.push(o.name)
  }
  else if (o.op === 'init' || o.op === 'down') {
    const row = r ?? { id: o.row, side: 'pc' as const, name: o.name, init: null, ac: null, members: [], out: false, down: false, downs: [], added: i }
    if (!r) f.rows.push(row)
    if (o.op === 'init') row.init = o.value
    else {
      row.down = o.value
      if (o.value) row.downs.push(f.round)
    }
  } else if (o.op === 'next') {
    const n = nextRow(f)
    if (n) {
      f.round = f.pointer === null ? Math.max(f.round, 1) : n.wraps ? f.round + 1 : f.round
      f.pointer = n.row.id
    }
  } else if (o.op === 'end') f.ended = at
  else if (!r) return false
  else if (o.op === 'out') r.out = true
  else if (o.op === 'point') {
    // The round stays, except that a fight's first `t` starts round 1, as its first `n` does.
    f.pointer = r.id
    f.round = Math.max(f.round, 1)
  } else {
    const m = r.members[o.member]
    if (!m) return false
    if (o.op === 'kill') Object.assign(m, { dead: true, zero: false })
    else {
      m.working.push(o.delta)
      m.hp += o.delta
      m.zero = m.hp <= 0 && !m.dead
      return { working: working(m) }
    }
  }
  return {}
}

/** Does this op open a new fight when none is live? An add, a pack, or a PC's initiative. */
const starts = (o: Op) => o.op === 'add' || o.op === 'pack' || o.op === 'init'

/**
 * Replay the events: undone ops are logged and skipped, an op that has nothing
 * to act on (no live fight, its row gone) is logged as `? <op>`. An op that
 * starts a fight while none is live begins a new one, `F` + its time.
 */
export function fold(events: Event[]): Fight | null {
  const undone = undoneOf(events)
  let f: Fight | null = null
  events.forEach((e, i) => {
    if ('undo' in e) return
    const text = describe(e.op, f)
    if (undone.has(i)) return void f?.log.push({ at: e.at, text, reverted: true })
    if (!live(f) && starts(e.op)) f = { id: 'F' + e.at, startedAt: e.at, rows: [], pointer: null, round: 0, ended: null, log: [], packs: [] }
    const result = live(f) ? applyOp(f!, e.op, i, e.at) : false
    if (!result) return void f?.log.push({ at: e.at, text: '? ' + text })
    f!.log.push({ at: e.at, text, ...result })
  })
  return f
}

/** A packet's notes section: its `### ` heading, that line's number, and its lines as written. */
export type Section = { heading: string; line: number; lines: string[] }
/** A pack: its `## ` heading and line, the `# ` section it sits under (`S05`, or null), its groups and its notes. */
export type Pack = { name: string; line: number; section: string | null; rows: AddOp[]; notes: Section[] }

/**
 * The combat packs in `Prep/Fights.md`. A `# ` heading (`# S05`) opens a
 * session's section and closes the pack before it. Each `## ` heading is a
 * pack; each non-blank line under it a group, `<name> [xN|×N] [hp N] [ac N]
 * [init N]`, with at least one field. From the pack's first `### ` heading on,
 * its lines are notes, kept as written, never read as groups. Lines outside a
 * pack are ignored. A pack with a line that does not read is refused whole;
 * `errors` names the line, `Fights.md L7: …`.
 */
export function parsePacks(text: string): { packs: Pack[]; errors: string[] } {
  const packs: Pack[] = []
  const errors: string[] = []
  let section: string | null = null
  let cur: (Pack & { error: string | null }) | null = null
  const trimNote = () => {
    const open = cur?.notes[cur.notes.length - 1]
    while (open && open.lines.length && !open.lines[open.lines.length - 1]!.trim()) open.lines.pop()
  }
  const close = () => {
    if (!cur) return
    trimNote()
    if (!cur.error && !cur.rows.length) cur.error = `Fights.md L${cur.line}: "${cur.name}" has no groups`
    if (cur.error) errors.push(cur.error)
    else packs.push({ name: cur.name, line: cur.line, section: cur.section, rows: cur.rows, notes: cur.notes })
    cur = null
  }
  // An HTML comment is not the pack's, however many lines it runs (a pasted
  // Templates/Fights.md carries its example in one); an unclosed one runs to the
  // end. Its newlines stay, so line numbers still match the file.
  const shown = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (c) => c.replace(/[^\n]/g, ''))
  shown.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim()
    const head = /^(#{1,3})(?:\s+(.*))?$/.exec(line)
    const title = (head?.[2] ?? '').trim()
    if (head?.[1] === '#') {
      close()
      section = title || null
      return
    }
    if (head?.[1] === '##') {
      close()
      cur = { name: title, line: n + 1, section, rows: [], notes: [], error: null }
      if (!cur.name) cur.error = `Fights.md L${n + 1}: a pack needs a name`
      return
    }
    if (!cur || cur.error) return
    if (head?.[1] === '###') {
      trimNote()
      cur.notes.push({ heading: title, line: n + 1, lines: [] })
      return
    }
    const note = cur.notes[cur.notes.length - 1]
    if (note) {
      if (line || note.lines.length) note.lines.push(raw)
      return
    }
    if (!line) return
    const read = line.startsWith('#') ? `can't read "${line}"` : readGroup(line)
    if (typeof read === 'string') cur.error = `Fights.md L${n + 1}: ${read}`
    else cur.rows.push(read)
  })
  close()
  return { packs, errors }
}

/** One group line as an add, or why it does not read: a line with no field is no group. */
function readGroup(line: string): AddOp | string {
  const bad = `can't read "${line}"`
  const words = line.replace(/^-\s+/, '').split(/\s+/)
  const name: string[] = []
  const got: { count?: number; hp?: number; ac?: number; init?: number } = {}
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    const times = /^[x×](\d+)$/i.exec(w)
    const key = w.toLowerCase()
    const field = key === 'hp' || key === 'ac' || key === 'init' ? key : null
    if (!times && !field) {
      if (Object.keys(got).length) return bad
      name.push(w)
      continue
    }
    const value = times ? times[1]! : words[++k]
    if (value === undefined || !/^\d+$/.test(value)) return bad
    const slot = times ? 'count' : field!
    if (slot in got) return bad
    got[slot] = Number(value)
  }
  const text = name.join(' ')
  if (!text || !Object.keys(got).length || got.count === 0) return bad
  const count = got.count ?? 1
  if (count > 1 && got.hp === undefined) return 'a group needs HP'
  return { op: 'add', name: text.charAt(0).toUpperCase() + text.slice(1), count, hp: got.hp ?? null, ac: got.ac ?? null, init: got.init ?? null }
}

/** The last pack loaded and not undone, over fight logs newest first, or null. */
export function lastPack(logs: Event[][]): string | null {
  for (const events of logs) {
    const undone = undoneOf(events)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if ('op' in e && e.op.op === 'pack' && !undone.has(i)) return e.op.name
    }
  }
  return null
}

/** The packs `[ next ]` walks: the `# ` section named `session`, or the whole file when there is none. */
export function sessionPacks(packs: Pack[], session: string | null): Pack[] {
  const s = session?.trim().toUpperCase()
  const own = s ? packs.filter((p) => p.section?.toUpperCase() === s) : []
  return own.length ? own : packs
}

/** The pack `[ next ]` loads: the one after `last` in the session's packs, else their first. */
export function nextPack(packs: Pack[], session: string | null, last: string | null): Pack | null {
  const scope = sessionPacks(packs, session)
  const at = last === null ? -1 : scope.findIndex((p) => p.name === last)
  return (at >= 0 ? scope[at + 1] : undefined) ?? scope[0] ?? null
}
