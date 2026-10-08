// toa-sheet: a character sheet pane beside the transcript (handoff 17, step A),
// and the DM's party view in the same pane (`/party`, handoff 18 step one).
//
// It watches the rules connector's own sheet_read / sheet_write results and the
// vault's Table-log writes and session manifests, and draws what the servers
// sent. It calls a tool itself only on a press: `e: re-read` on the party view,
// or `n` or `t` when it starts a new round, to re-read; `f: end` on the party view, to
// log the fight; and the taps on the sheet view (`d`, `h` and their number
// field, a slot's digit, `u`), each a `sheet_write` at the pane's version. Each
// is `$.tool.call` with the press as `consent`, checked for permission like the
// model's own calls (README, "Re-read and permissions").
//
// It also draws the connector's rows in the transcript as receipts (receipt.ts),
// one line each, and flashes what a write changed in the pane.
//
// The party view's keys are the DM's fight (fight.ts): a digit picks a row, a
// letter acts on it, and each applied op is stored; the fight drawn is their fold.
//
// `c: packs` reads the DM's combat packs from Prep/Fights.md, the one file it reads.
//
// Mods API calls: $.ui, $.store, $.command, $.clock, $.tool, $.fs.read only. Every call
// lives in this file; sheet.ts, table.ts, look.ts, receipt.ts and view.ts are pure.

import type { EngineInterface, MatchedHook, On, RenderElement, ToolCallArgs } from 'claude-code'
import { fold, live, parsePacks, summary, undoTarget, type Event, type Fight, type Op, type Pack } from './fight.ts'
import { FLASH_MS } from './look.ts'
import { CONNECTOR, VAULT, receipt } from './receipt.ts'
import { asApplied, asCheck, asGet, entryAfterWrite, entryFromGet, matchEntry, payloadOf, type Entry } from './sheet.ts'
import { applyWrite, asManifest, asTableWrite, isSessionId, rosterRows, type TableLog } from './table.ts'
import { bandTree, detailTree, hpOf, paneTree, receiptTree, RULES_KEY, slotRows, TABS, tabKey, tabOf, type Adding, type Ask, type Reread, type TabId, type Tap } from './view.ts'

const PANE = 'toa-sheet'
const KEY = 'sheet:' // one $.store key per character, so sessions never overwrite each other's characters
const LAST = 'last'
const TABLE = 'table:' // one $.store key per session's log
const SESSION = 'session'
const FIGHT = 'party:fight' // the current fight's id; its ops are under FIGHT_LOG + id
const FIGHT_LOG = 'party:log:' // one DM, one session: the last writer wins
const VAULT_QUERY = 'mcp__vault__vault_query'
const FIGHTS = 'Prep/Fights.md' // the DM's combat packs, relative to the session's folder (the vault)
const DRAFT_WRITE: string = 'mcp__vault__draft_write' // typed wide: the vault is no tool the declarations know
/** The person's own words for the press that raises the mod's call; the engine strips it before any tool sees it. */
const consent = (label: string, pane: string) => `The user pressed "${label}" on the ${pane} pane`

// Module state. A reload clears it; session.start refills the sheets from $.store.
const sheets = new Map<string, Entry>()
let focus: string | null = null
let tab: TabId = 'actions'
// The pane's Buttons from each surface's last drawing, handed back unchanged so
// their press handles survive a redraw (view.ts, PaneView.memo).
const memos = new Map<string, Map<string, RenderElement>>()
let paneOpen = false
let dismissed = false // the user closed the pane: do not open it unasked again this session
let autoTried = false
let toasted = false
let seenHere = false // a sheet result arrived in this session (the band strip waits for one)
// The last applied write's paths, drawn inverse in the pane until `until` (never stored).
let flash: { id: string; paths: string[]; until: number } | null = null
let view: 'sheet' | 'party' = 'sheet'
let session: string | null = null // the session the party view follows: `/party S04`, or the Table operation's last write
const logs = new Map<string, TableLog>()
let reread: Reread | null = null // the last re-read's outcome, never stored
let rereading = false
let fightEvents: Event[] = [] // the current fight's ops and undos, as stored
let fightId: string | null = null
// The DM's hand on the party view, never stored: the picked row, the open number
// field or add form.
let sel: { row: string; member: number } | null = null
let ask: Ask | null = null
let adding: Adding | null = null
// The note line under the view on show; a view switch clears it.
let note: string | null = null
let packs: Pack[] | null = null // the pack list `c` opened, read fresh each time
// The sheet view's taps, never stored: the open number field, and the last tap
// written on this machine (the version it wrote over, `from`, and the one it wrote, `to`), for `u`.
let tap: Tap | null = null
let lastTap: { id: string; from: number; to: number } | null = null

// The receipt hook for both tool families; the mods loader takes hooks only from the top level.
const rowHook: MatchedHook<'ui.render', { component: 'ToolUse' }> = ($, e, next) => {
  const r = receipt(e.props, (id) => sheets.get(id)?.sheet)
  return r ? receiptTree($.ui.resolve(e), r) : next(e)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const focused = () => (focus ? sheets.get(focus) ?? null : null)
const firstLine = (s: unknown) => String(s).split('\n')[0]!.slice(0, 120)

function storedEntry(v: unknown): Entry | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Entry
  if (typeof e.id !== 'string' || typeof e.name !== 'string' || !Number.isInteger(e.version) || !e.sheet || typeof e.sheet !== 'object') return null
  return { ...e, fromStore: true }
}

function storedLog(v: unknown): TableLog | null {
  if (!v || typeof v !== 'object') return null
  const l = v as TableLog
  if (typeof l.session !== 'string' || !Array.isArray(l.entries)) return null
  if (!l.entries.every((t) => t && typeof t.at === 'number' && typeof t.text === 'string')) return null
  if (l.closedAt !== null && typeof l.closedAt !== 'number') return null
  if (l.manifest !== null && (!l.manifest || typeof l.manifest !== 'object')) return null
  return l
}

const int = (v: unknown) => Number.isInteger(v)
const intOrNull = (v: unknown) => v === null || Number.isInteger(v)
const str = (v: unknown) => typeof v === 'string'

function storedOp(o: any): boolean {
  if (!o || typeof o !== 'object') return false
  switch (o.op) {
    case 'add': return str(o.name) && int(o.count) && intOrNull(o.hp) && intOrNull(o.ac) && intOrNull(o.init)
    case 'pack': return str(o.name) && Array.isArray(o.rows) && o.rows.every((r: any) => r?.op === 'add' && storedOp(r))
    case 'init': return str(o.row) && str(o.name) && int(o.value)
    case 'hp': return str(o.row) && int(o.member) && int(o.delta)
    case 'kill': return str(o.row) && int(o.member)
    case 'out': case 'point': return str(o.row)
    case 'down': return str(o.row) && str(o.name) && typeof o.value === 'boolean'
    case 'next': case 'end': return true
    default: return false
  }
}

/** A stored fight log, or null: anything else (T0055's lines among it) starts the fight empty. */
function storedEvents(v: unknown): Event[] | null {
  if (!Array.isArray(v)) return null
  const ok = v.every((e) => e && typeof e === 'object' && typeof e.at === 'number' && (int(e.undo) || storedOp(e.op)))
  return ok ? (v as Event[]) : null
}

async function loadStore($: EngineInterface) {
  const keys: string[] = (await $.store.keys()) ?? []
  for (const k of keys) {
    if (k.startsWith(KEY)) {
      const e = storedEntry(await $.store.get(k))
      if (e && !sheets.has(e.id)) sheets.set(e.id, e)
    } else if (k.startsWith(TABLE)) {
      const l = storedLog(await $.store.get(k))
      if (l && !logs.has(l.session)) logs.set(l.session, l)
    }
  }
  const last = await $.store.get(LAST)
  if (!focus && typeof last === 'string' && sheets.has(last)) focus = last
  const stored = await $.store.get(SESSION)
  if (!session && typeof stored === 'string') session = stored
  const id = await $.store.get(FIGHT)
  if (!fightId && typeof id === 'string') {
    const events = storedEvents(await $.store.get(FIGHT_LOG + id)) ?? []
    // Only a live fight comes back: `u` undoes an end within the sitting, never an old fight's.
    if (live(fold(events))) {
      fightId = id
      fightEvents = events
    }
  }
}

const fight = (): Fight | null => fold(fightEvents)
const nameOf = (id: string) => live(fight())?.rows.find((r) => r.id === id)?.name ?? sheets.get(id)?.name ?? id

/** Put the keyboard on `key`; an element never drawn (no Input on mobile, the pane closed) answers deny, and the hotkeys still work. */
async function focusOn($: EngineInterface, key: string) {
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {
    // not drawn here
  }
}

/** Park the ring on `next`, a Button, so the hotkeys work again: the way back from a field. */
const park = ($: EngineInterface) => focusOn($, 'next')

/**
 * One op pressed (or `undo`): stored and drawn. An op that starts a new fight
 * starts a new log; the old one stays in the store.
 */
async function apply($: EngineInterface, op: Op | 'undo') {
  const at = await $.clock.now()
  let event: Event
  if (op === 'undo') {
    const target = undoTarget(fightEvents)
    if (target === null) {
      note = 'nothing to undo'
      return $.ui.invalidate('ui.render')
    }
    event = { at, undo: target }
  } else event = { at, op }
  fightEvents = [...fightEvents, event]
  const f = fight()
  if (f && f.id !== fightId) {
    fightEvents = [event]
    fightId = f.id
    await $.store.set(FIGHT, fightId)
  }
  if (fightId) await $.store.set(FIGHT_LOG + fightId, fightEvents)
  const row = sel && live(f)?.rows.find((r) => r.id === sel!.row)
  sel = row && sel ? { row: row.id, member: Math.max(0, Math.min(sel.member, row.members.length - 1)) } : null
  note = null
  ask = null
  $.ui.invalidate('ui.render')
  await park($)
}

/**
 * `n` or `t`: apply the op, and when it starts a new round re-read the sheets, so HP the
 * players wrote shows. Awaited, as `e`'s is: the mod's own watcher sees only the calls made
 * while the press is in flight.
 */
async function turn($: EngineInterface, op: Op, label: string) {
  const was = fight()?.round ?? 0
  await apply($, op)
  if ((fight()?.round ?? 0) > was) await refresh($, consent(label, 'Party') + ', which starts a new round and re-reads')
}

/** The note line under the party's order or the sheet's taps. */
const say = ($: EngineInterface, text: string) => {
  note = text
  $.ui.invalidate('ui.render')
}

/**
 * The ended fight `f` (its fold before the end) as one Table note, through
 * `draft_write`. Run after the end is applied and never awaited, so the press
 * never waits on a permission dialog; a line not logged says why in the note.
 */
async function logFight($: EngineInterface, f: Fight) {
  const not = (why: string) => say($, 'fight ended; not logged: ' + why)
  const text = summary(f)
  if (!text) return not('nothing tracked')
  const s = session
  if (!s) return not('no session (/party S04)')
  let why: string
  try {
    if (!(await $.tool.list()).some((t) => t.name === DRAFT_WRITE)) return not('no vault connector')
    // Top-level arguments, as draft_write takes them; the watcher sees the call and logs the line.
    const r = await $.tool.call({ tool: DRAFT_WRITE, kind: 'table-note', session: s, text, consent: consent('f: end fight', 'Party') } as ToolCallArgs)
    if (!('deny' in r) && !r.isError) return
    why = firstLine('deny' in r ? r.deny : r.text)
  } catch (err) {
    why = firstLine(message(err))
  }
  $.ui.log('fight: draft_write refused: ' + why)
  not(why)
}

/** A key on the party view: a digit picks a row, a letter acts on the picked one. */
async function act($: EngineInterface, key: string) {
  ask = null
  const f = live(fight())
  const row = sel ? f?.rows.find((r) => r.id === sel!.row) : undefined
  if (key.startsWith('row-')) {
    const id = key.slice(4)
    sel = sel?.row === id && row && row.members.length > 1 ? { row: id, member: (sel.member + 1) % row.members.length } : { row: id, member: 0 }
    return $.ui.invalidate('ui.render')
  }
  if (key === 'act-c') return openPacks($)
  if (key.startsWith('pack-')) {
    const p = packs?.[Number(key.slice(5)) - 1]
    if (!p) return
    packs = null
    return apply($, { op: 'pack', name: p.name, rows: p.rows })
  }
  if (key === 'act-a') {
    adding = adding ? null : { name: '', count: '', hp: '', ac: '', init: '' }
    $.ui.invalidate('ui.render')
    return adding ? focusOn($, 'add-name') : undefined
  }
  if (key === 'act-f') {
    if (!f) return
    await apply($, { op: 'end' })
    return void logFight($, f)
  }
  if (key === 'act-s') {
    if (!sel) return say($, 'pick a row: 1–9')
    if (!sheets.has(sel.row)) return say($, 'no sheet')
    focus = sel.row
    view = 'sheet'
    note = null
    $.ui.invalidate('ui.render')
    return void (await $.ui.open({ id: PANE, title: focused()!.name }))
  }
  if (!sel) return say($, 'pick a row: 1–9')
  const { row: id, member } = sel
  if (key === 'act-i') {
    ask = { kind: 'init', row: id, member, text: '' }
    $.ui.invalidate('ui.render')
    return focusOn($, 'amount')
  }
  if (!f) return
  const tracked = !!row && row.members.length > 0
  if (key === 'act-d' || key === 'act-h') {
    if (!tracked) return say($, 'no HP tracked here')
    ask = { kind: key === 'act-d' ? 'damage' : 'heal', row: id, member, text: '' }
    $.ui.invalidate('ui.render')
    return focusOn($, 'amount')
  }
  if (key === 'act-x') return tracked ? apply($, { op: 'kill', row: id, member }) : say($, 'no HP tracked here')
  if (key === 'act-o') return row ? apply($, { op: 'out', row: id }) : say($, 'not in the fight')
  if (key === 'act-k') return apply($, { op: 'down', row: id, name: nameOf(id), value: !row?.down })
  if (key === 'act-t') return row ? turn($, { op: 'point', row: id }, 't: turn') : say($, 'not in the fight')
}

/** `c`: the packs in Prep/Fights.md, read fresh, as a list a digit loads from; `c` again closes it. */
async function openPacks($: EngineInterface) {
  if (packs) {
    packs = null
    return $.ui.invalidate('ui.render')
  }
  let text: string
  try {
    text = await $.fs.read(FIGHTS)
  } catch {
    return say($, 'no ' + FIGHTS)
  }
  const read = parsePacks(text)
  packs = read.packs.length ? read.packs : null
  // A pack that does not read is left out of the list; the note names its line.
  note = read.errors[0] ?? (packs ? null : 'no packs in ' + FIGHTS)
  $.ui.invalidate('ui.render')
}

const ADD_FIELDS = ['name', 'count', 'hp', 'ac', 'init'] as const
/** A numeric add field: an integer, or null when blank (or not a number). */
const num = (t: string) => (/^\d+$/.test(t.trim()) ? Number(t.trim()) : null)

/** The number field and the add form: a change is kept for the redraw; a submit applies or moves on. */
async function input($: EngineInterface, element: string, kind: 'change' | 'submit', value: string) {
  if (element === 'tap-amount' && tap) {
    if (kind === 'change') return void (tap = { ...tap, text: value })
    const t = value.trim()
    if (!t) {
      tap = null
      $.ui.invalidate('ui.render')
      return focusOn($, 'tap-d')
    }
    const n = num(t)
    tap = { ...tap, text: value }
    if (n === null) {
      note = 'a number'
      return $.ui.invalidate('ui.render')
    }
    return hp($, n, value)
  }
  if (element === 'amount' && ask) {
    if (kind === 'change') return void (ask = { ...ask, text: value })
    const t = value.trim()
    if (!t) {
      ask = null
      $.ui.invalidate('ui.render')
      return park($)
    }
    const n = num(t)
    if (n === null) {
      ask = { ...ask, text: value }
      note = 'a number'
      return $.ui.invalidate('ui.render')
    }
    const { kind: what, row, member } = ask
    return apply($, what === 'init' ? { op: 'init', row, name: nameOf(row), value: n } : { op: 'hp', row, member, delta: what === 'damage' ? -n : n })
  }
  const field = ADD_FIELDS.find((k) => element === 'add-' + k)
  if (!field || !adding) return
  adding = { ...adding, [field]: value }
  if (kind === 'change') return
  if (field !== 'init') return focusOn($, 'add-' + ADD_FIELDS[ADD_FIELDS.indexOf(field) + 1])
  const name = adding.name.trim()
  if (!name) {
    note = 'a name'
    $.ui.invalidate('ui.render')
    return focusOn($, 'add-name')
  }
  const op: Op = { op: 'add', name: name.charAt(0).toUpperCase() + name.slice(1), count: Math.max(1, num(adding.count) ?? 1), hp: num(adding.hp), ac: num(adding.ac), init: num(adding.init) }
  adding = null
  await apply($, op)
  const added = fight()?.rows.find((r) => r.added === fightEvents.length - 1)
  if (added) sel = { row: added.id, member: 0 }
  $.ui.invalidate('ui.render')
}

/** A tap key on the sheet view: `d`/`h` open the number field, `u` undoes the last tap, a slot's digit spends one. */
async function tapKey($: EngineInterface, key: string) {
  const entry = focused()
  if (!entry) return
  if (key === 'tap-d' || key === 'tap-h') {
    tap = { kind: key === 'tap-d' ? 'damage' : 'heal', text: '' }
    $.ui.invalidate('ui.render')
    return focusOn($, 'tap-amount')
  }
  if (key === 'tap-u') {
    if (!lastTap || lastTap.id !== entry.id) return say($, 'nothing to undo')
    if (entry.version !== lastTap.to) return say($, 'the sheet changed since: undo in the chat')
    return write($, entry, { action: 'revert', changes: { version: lastTap.from } }, 'sheet pane: undo', consent('u: undo', 'Sheet'))
  }
  const slot = slotRows(entry).find((s) => s.key === key)
  if (!slot) return
  const pact = key === 'slot-pact'
  const name = pact ? 'pact' : slot.label
  if (slot.left <= 0) return say($, `no ${name} slots left`)
  const spell = entry.sheet.spellcasting ?? {}
  const used = Number(pact ? spell.pact_slots_used ?? 0 : spell.slots_used?.[String(slot.level)] ?? 0)
  const changes = pact ? { spellcasting: { pact_slots_used: used + 1 } } : { spellcasting: { slots_used: { [String(slot.level)]: used + 1 } } }
  return write($, entry, { action: 'update', changes }, `sheet pane: ${name} slot`, consent(`${slot.hotkey}: ${slot.label}`, 'Sheet'))
}

/** The number field's `n`: damage spends temp HP first, then HP down to 0; healing raises HP up to the max the pane draws. */
async function hp($: EngineInterface, n: number, typed: string) {
  const entry = focused()
  if (!entry || !tap) return
  const { current, max, temp } = hpOf(entry)
  const damage = tap.kind === 'damage'
  if (n === 0 || (damage && current <= 0 && temp <= 0) || (!damage && current >= max)) return say($, 'nothing to change')
  const t = damage ? Math.min(temp, n) : 0
  const changes = damage
    ? { hp: { current: Math.max(0, current - (n - t)), ...(t ? { temp: temp - t } : {}) } }
    : { hp: { current: Math.min(max, current + n) } }
  const said = `The user entered "${typed.trim()}" in "${tap.kind} · ${entry.name}" on the Sheet pane and pressed apply`
  return write($, entry, { action: 'update', changes }, `sheet pane: ${damage ? '−' : '+'}${n} HP`, said)
}

/**
 * One tap's `sheet_write`, applied at once at the pane's version: the
 * connector's `base_version` guard is the stale check. The watcher caches and
 * flashes the result; a refusal or an error is the note, and the field stays.
 */
async function write($: EngineInterface, entry: Entry, body: Record<string, unknown>, reason: string, said: string) {
  const tool = 'mcp__' + entry.server + '__sheet_write'
  const from = entry.version
  try {
    if (!(await $.tool.list()).some((t) => t.name === tool)) return say($, 'no sheet_write tool in this session')
    // The name is built at run time, so it is no literal the declarations know.
    const r = await $.tool.call({ tool, request: { ...body, character: entry.id, base_version: from, reason }, apply: true, consent: said } as ToolCallArgs)
    if ('deny' in r) {
      $.ui.log(`tap: ${tool} refused: ` + firstLine(r.deny))
      return say($, `refused: allow ${tool} (/permissions)`)
    }
    if (r.isError) {
      if (!/sheet changed/i.test(String(r.text))) return say($, firstLine(r.text))
      // The watcher re-caches the sheet, so the next Enter recomputes at its version.
      const read = 'mcp__' + entry.server + '__sheet_read'
      await $.tool.call({ tool: read, request: { action: 'get', character: entry.id }, consent: said } as ToolCallArgs)
      return say($, 'the sheet changed · try again')
    }
    const p = payloadOf(r)
    const wrote = p && 'data' in p ? asApplied(p.data) : null
    lastTap = body.action !== 'revert' && wrote ? { id: entry.id, from, to: wrote.version } : null
  } catch (err) {
    return say($, firstLine(message(err)))
  }
  tap = null
  note = null
  $.ui.invalidate('ui.render')
  await focusOn($, 'tap-d')
}

async function saveLog($: EngineInterface, log: TableLog) {
  logs.set(log.session, log)
  $.ui.invalidate('ui.render')
  await $.store.set(TABLE + log.session, log)
}

/** Keep `entry`, redraw, and save it unless another session already saved a newer version. */
async function update($: EngineInterface, entry: Entry) {
  sheets.set(entry.id, entry)
  $.ui.invalidate('ui.render')
  const stored = storedEntry(await $.store.get(KEY + entry.id))
  if (!stored || stored.version <= entry.version) await $.store.set(KEY + entry.id, { ...entry, fromStore: false })
}

/** Keep `entry` and show it: focus it, and open the pane (or toast) the first time. */
async function remember($: EngineInterface, entry: Entry) {
  // A re-read refreshes the cache only: the sheet on show stays the one the DM picked, even mid-sweep.
  const move = !rereading || !focus
  if (move) focus = entry.id
  seenHere = true
  await update($, entry)
  if (move) await $.store.set(LAST, entry.id)
  if (!paneOpen && !dismissed && !autoTried) {
    autoTried = true
    // Unasked, so Claude Code places it only where it fits (144 columns, 110 once opened).
    // Esc closes it, as `/sheet`'s does: a player who never typed `/sheet` needs a way out.
    const placed = await $.ui.open({ id: PANE, title: entry.name, closeOnEscape: true })
    if (placed && placed.isPlaced) paneOpen = true
  }
  if (!paneOpen && !toasted) {
    toasted = true
    await $.ui.toast(`${entry.name}'s sheet is ready: /sheet`)
  }
}

/**
 * A watched result: a get replaces the cached sheet; a check sets its counts
 * on a sheet already known (a check carries no sheet); an applied write's diff
 * updates it and flashes what it changed.
 */
async function watch($: EngineInterface, e: any, result: unknown) {
  const m = /^mcp__(.+)__sheet_(read|write)$/.exec(String(e.tool))
  const p = payloadOf(result)
  if (!m || !p || !('data' in p)) return
  const now = await $.clock.now()
  if (m[2] === 'read') {
    const got = asGet(p.data)
    if (got) return remember($, entryFromGet(got, m[1] ?? '', now, sheets.get(got.character.id)?.check))
    const check = asCheck(p.data)
    const known = check ? sheets.get(check.character.id) : undefined
    if (!check || !known) return
    const warnings = check.findings.filter((f) => f.severity === 'warning').length
    const counts = { at: now, version: check.character.version, warnings, infos: check.findings.length - warnings }
    return update($, { ...known, check: counts })
  }
  const wrote = asApplied(p.data)
  const old = wrote ? sheets.get(wrote.character) : undefined
  if (!wrote || !old) return
  const request = e.request ?? e.input?.request ?? {}
  flash = { id: old.id, paths: wrote.diff.map((d) => d.path), until: now + FLASH_MS }
  $.clock.after(FLASH_MS, () => $.ui.invalidate('ui.render'))
  await remember($, entryAfterWrite(old, wrote, typeof request.reason === 'string' ? request.reason : '', now))
}

/**
 * A watched vault result. A manifest is attached to its own session's log and
 * never moves `session` (Ingest and Query read other sessions); a Table write
 * is applied to its session's log, and that session is the one followed.
 */
async function watchVault($: EngineInterface, e: any, result: unknown) {
  const p = payloadOf(result)
  if (!p || !('data' in p)) return
  if (e.tool === VAULT_QUERY) {
    const m = (e.request ?? {}).action === 'session' ? asManifest(p.data) : null
    if (m) await saveLog($, { ...(logs.get(m.session) ?? { session: m.session, entries: [], closedAt: null }), manifest: m })
    return
  }
  const w = asTableWrite(e, p.data)
  if (!w) return
  await saveLog($, applyWrite(logs.get(w.session) ?? null, w, await $.clock.now()))
  session = w.session
  await $.store.set(SESSION, session)
}

/**
 * The re-read, on `e` and on `n` or `t` into a new round, one sweep at a time: the
 * connector's `list`, then a `get` per id, one at a time (a dialog each in
 * default mode, never several at once), then the session's manifest. The
 * watchers cache the answers; this reads only whether each call answered.
 */
async function refresh($: EngineInterface, pressed: string) {
  if (rereading) return
  rereading = true
  const call = async (tool: string, request: Record<string, unknown>) => {
    // The name is found at run time, so it is no literal the declarations know.
    const r = await $.tool.call({ tool, request, consent: pressed } as ToolCallArgs)
    if ('deny' in r || r.isError) {
      $.ui.log(`re-read: ${tool} refused: ` + firstLine('deny' in r ? r.deny : r.text))
      reread = { refused: tool }
      return null
    }
    return r
  }
  try {
    const names = (await $.tool.list()).map((t) => t.name)
    if (!names.length) return void (await $.ui.toast('No tools yet: the servers connect after the first turn; press e then'))
    const known = [...sheets.values()].map((e) => `mcp__${e.server}__sheet_read`).find((n) => names.includes(n))
    const tool = known ?? names.find((n) => /^mcp__(.+)__sheet_read$/.test(n))
    if (!tool) return void (await $.ui.toast('No sheet tool in this session: add the rules connector'))
    const r = await call(tool, { action: 'list' })
    if (!r) return
    const p = payloadOf(r)
    if (!p || !('data' in p) || !Array.isArray(p.data)) return void (reread = { failed: 'list: unexpected answer' })
    let n = 0
    for (const c of p.data) {
      if (!(await call(tool, { action: 'get', character: c?.id }))) return
      n++
    }
    if (session && names.includes(VAULT_QUERY) && !(await call(VAULT_QUERY, { action: 'session', id: session }))) return
    reread = { at: await $.clock.now(), sheets: n, listed: p.data.length }
  } catch (err) {
    reread = { failed: firstLine(message(err)) }
  } finally {
    rereading = false
    $.ui.invalidate('ui.render')
  }
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    await loadStore($)
    try {
      await $.command.register({
        name: 'sheet',
        description: 'Show a character sheet beside the transcript',
        argumentHint: '[name] [actions|saves|features|gear|notes]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/sheet was not added: ' + message(err))
    }
    try {
      await $.command.register({
        name: 'party',
        description: "The DM's party view: every sheet, the table log, the session",
        argumentHint: '[S04]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/party was not added: ' + message(err))
    }
    return next(e)
  })

  // The connector's sheet tools under any server name (a claude.ai uuid, or the name it was added with).
  on('tool.call', { tool: /^mcp__.+__sheet_(read|write)$/ }, async ($, e, next) => {
    const result = await next(e)
    try {
      await watch($, e, result)
    } catch (err) {
      $.ui.log('a sheet result was not shown: ' + message(err))
    }
    return result
  })

  // The vault's session manifests and the Table operation's writes, for the party view.
  on('tool.call', { tool: /^mcp__vault__(vault_query|draft_write)$/ }, async ($, e, next) => {
    const result = await next(e)
    try {
      await watchVault($, e, result)
    } catch (err) {
      $.ui.log('a vault result was not shown: ' + message(err))
    }
    return result
  })

  // `/sheet [name] [tab]`: a tab word (`saves`, `spells`, `gear`) opens that tab, the rest names a character.
  on('command.run', { command: 'sheet' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const named = words.map(tabOf).find((t) => t !== null)
    if (named) tab = named
    const query = words.filter((w) => tabOf(w) === null).join(' ')
    if (query) {
      const hit = matchEntry([...sheets.values()], query)
      if (!hit) {
        await $.ui.toast(`No sheet for "${query}" on this machine yet. Ask Claude to read it.`)
        return {}
      }
      focus = hit.id
    }
    view = 'sheet'
    note = null
    dismissed = false
    await $.ui.open({ id: PANE, title: focused()?.name ?? 'Sheet', focus: true, closeOnEscape: true })
    paneOpen = true
    $.ui.invalidate('ui.render')
    return {}
  })

  // `/party [S04]`: the party view, drawn from the cache. It calls no tool: only `e`, or `n` or `t` into a new round, re-reads.
  on('command.run', { command: 'party' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toUpperCase()
    if (isSessionId(arg)) {
      session = arg
      await $.store.set(SESSION, session)
    }
    view = 'party'
    note = null
    dismissed = false
    await $.ui.open({ id: PANE, title: 'Party', focus: true, columns: 60 })
    paneOpen = true
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      paneOpen = false
      if (e.origin?.kind === 'person') dismissed = true
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    paneOpen = true // drawn, so open (a waiting pane appears when the terminal widens)
    const el = $.ui.resolve(e)
    const memo = memos.get(e.surface) ?? new Map<string, RenderElement>()
    memos.set(e.surface, memo)
    const now = await $.clock.now()
    const flashing = flash && flash.id === focus && now < flash.until ? flash.paths : null
    return paneTree(el, {
      view,
      entry: focused(),
      rows: rosterRows([...sheets.values()]),
      log: session ? logs.get(session) ?? null : null,
      session,
      reread,
      surface: e.surface,
      columns: e.props?.bodyColumns ?? 40,
      tab,
      memo,
      now,
      flash: flashing,
      fight: fight(),
      sel,
      ask: ask && { ...ask, name: nameOf(ask.row) },
      adding,
      note,
      packs,
      tap,
    })
  })

  // The party view's number field (`amount`) and add form (`add-*`); the sheet view's (`tap-amount`).
  on('ui.input', { plugin: 'toa-sheet' }, async ($, e, next) => {
    await input($, String(e.element), e.kind, e.value)
    return next(e)
  })

  // Connector and vault calls fold into one "Called … n times" line. The matcher selects only
  // the groups holding either call (a pattern against an array holds when some element
  // matches); the rewrite unfolds them, and each call is then a ToolUse row the receipt hook draws.
  on('ui.render', { component: 'ToolGroup', props: { calls: { tool: CONNECTOR } } }, ($, e, next) =>
    next({ ...e, props: { ...e.props, isExpanded: true } }))
  on('ui.render', { component: 'ToolGroup', props: { calls: { tool: VAULT } } }, ($, e, next) =>
    next({ ...e, props: { ...e.props, isExpanded: true } }))
  on('ui.render', { component: 'ToolUse', props: { tool: CONNECTOR } }, rowHook)
  on('ui.render', { component: 'ToolUse', props: { tool: VAULT } }, rowHook)
  // The result block is drawn in the ctrl+o transcript only (probe finding 8): the findings
  // in words, then Claude Code's own block, never hidden.
  on('ui.render', { component: 'ToolResult', props: { tool: CONNECTOR } }, async ($, e, next) => {
    const r = receipt({ ...e.props, isRunning: false }, (id) => sheets.get(id)?.sheet)
    return r && r.detail.length ? detailTree($.ui.resolve(e), r, await next(e)) : next(e)
  })

  // The pane's presses: a tab, the DM-rules badge (which opens Notes), the party
  // button, the sheet's taps, the fight's keys (a row, an action, next, undo), the re-read. The
  // Buttons' own closures do nothing, so a kept Button never acts on stale state. `e`, `n`, `t`
  // and a pack's digit take their press rather than pass it to core: a sweep may outlive its
  // Button's drawing (`s` mid-sweep shows a sheet without them), a pack's load retires its own
  // Button, and core's look-up of a retired handle throws.
  // Other presses still pass: `f`'s unawaited log write must start while the press is in flight.
  on('ui.press', { plugin: 'toa-sheet' }, async ($, e, next) => {
    const id = String(e.element)
    if (id === 'view-party') {
      view = 'party'
      note = null
      $.ui.invalidate('ui.render')
      await $.ui.open({ id: PANE, title: 'Party', columns: 60 })
    } else if (id === 'act-t' || id.startsWith('pack-')) {
      await act($, id)
      return { element: id }
    } else if (id.startsWith('row-') || id.startsWith('act-')) {
      await act($, id)
    } else if (id.startsWith('tap-') || id.startsWith('slot-')) {
      await tapKey($, id)
    } else if (id === 'next' && live(fight())) {
      await turn($, { op: 'next' }, 'n: next')
      return { element: id }
    } else if (id === 'undo') {
      // Also after `f`: undoing the end brings the fight back.
      await apply($, 'undo')
    } else if (id === 'reread') {
      await refresh($, consent('e: re-read', 'Party'))
      return { element: id }
    }
    const hit = TABS.find((t) => tabKey(t.id) === e.element)?.id ?? (e.element === RULES_KEY ? 'notes' : null)
    if (hit && hit !== tab) {
      tab = hit
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // The band strip while the pane is closed, kept above other mods' band content.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const entry = focused()
    if (paneOpen || !seenHere || !entry) return next(e)
    const el = $.ui.resolve(e)
    return el.Box({ flexDirection: 'column', children: [bandTree(el, entry, e.surface), await next(e)] })
  })
}
