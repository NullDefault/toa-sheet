// toa-sheet: a character sheet pane beside the transcript (handoff 17, step A),
// and the DM's party view in the same pane (`/party`, handoff 18 step one).
//
// It watches the rules connector's own sheet_read / sheet_write results and the
// vault's Table-log writes and session manifests, and draws what the servers
// sent. It calls a tool itself on a press: `[ re-read ]` on the party view,
// or `[ next turn ]` or `[ turn ]` when it starts a new round, to re-read; `[ end fight ]`,
// to log the fight; and the taps on the sheet view (`[ dmg ]`, `[ heal ]`, `[ coins ]` and
// their number field, a slot, `[ undo ]`, a spell's `[ CONC ]`, a save's `[ lost ]`) and the
// party's `[ split gold ]`, each a `sheet_write` at the pane's version. Each is
// `$.tool.call` with the press as `consent`, checked for permission like the model's own
// calls (README, "Re-read and permissions").
//
// While the pane is open it also keeps itself current (T0086): `/sheet` and `/party`
// re-read on open, and on any open (the auto-open on a watched get too) every 20 s a tick lists the sheets and gets only those whose
// version moved. Neither is a press, so each first asks `$.tool.check` and calls only
// on `allow`: they never raise a dialog (T0049's reason for drawing `/party` from the
// cache alone was the dialogs). On `ask` the pane draws from the cache and says live
// sync is off. The ticks stop when the pane closes, on a refusal, and after 2 hours
// with no version change and no press.
//
// It also draws the connector's rows in the transcript as receipts (receipt.ts),
// one line each, and flashes what a write changed in the pane.
//
// The party view's buttons are the DM's fight (fight.ts): a click on a row targets
// it, a button under it acts on it, and each applied op is stored; the fight drawn
// is their fold.
//
// The pane is a stack of screens (`screens`): the top one is drawn, `[ ‹ back ]`
// pops one, and every open goes through `openPane`. `[ packs ]`, `[ packet ]`,
// `[ next ]`, `[ end fight ]` and `/party` read the DM's combat packs from
// Prep/Fights.md, the one file it reads, and the stored fights' logs, so
// `[ next ]` knows the last pack loaded; a draw reads nothing.
//
// `[ look up ]` (T0085 stage 1) pushes the look's field, and a match its card:
// drawn at once from the facts, then filled from the rules server's
// `spell_get`, `monster_get` or `condition_search`, called on the press. `[ ask
// Claude ]` submits the subject as a prompt of the person's own session.
//
// Live listening (T0085 stage 2): once `/party` opens in a session, a 1.5 s
// clock reads the listener's heard file (capture/live.py, /tmp/toa-live/heard.json)
// and draws its newest names as the HEARD row and the band's heard line. Its text
// leaves the Mac only in an ask from the party pane, on a press.
//
// Mods API calls: $.ui, $.store, $.command, $.clock, $.tool, $.fs.read, $.prompt.submit only.
// Every call lives in this file; sheet.ts, table.ts, look.ts, lookup.ts, receipt.ts and view.ts are pure.

import type { EngineInterface, MatchedHook, On, RenderElement, Timer, ToolCallArgs } from 'claude-code'
import { actionGroups } from './actions.ts'
import { fold, lastPack, live, nextPack, parsePacks, sessionPacks, summary, undoTarget, type Event, type Fight, type Op, type Pack } from './fight.ts'
import { detailOf, pressWord, type Detail } from './detail.ts'
import { FLASH_MS } from './look.ts'
import { askText, asHeard, candidates, cardOf, factsRow, HEARD_PATH, matches, norm, type Candidate, type Heard } from './lookup.ts'
import { CONNECTOR, VAULT, receipt } from './receipt.ts'
import { asApplied, asCheck, asGet, coinChange, entryAfterWrite, entryFromGet, matchEntry, moved, parseCoins, payloadOf, type Entry, type Save } from './sheet.ts'
import { applyWrite, asManifest, asTableWrite, isSessionId, rosterRows, type TableLog } from './table.ts'
import { bandTree, detailTree, heardBand, holding, hpOf, paneTree, receiptTree, RULES_KEY, slotRows, TABS, tabKey, tabOf, type Adding, type Ask, type LookView, type Reread, type Screen, type TabId, type Tap } from './view.ts'

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
// The pane's screens, the top one drawn; `[ ‹ back ]` pops one.
let screens: Screen[] = ['sheet']
let session: string | null = null // the session the party view follows: `/party S04`, or the Table operation's last write
const logs = new Map<string, TableLog>()
let logOpen: number | null = null // the log entry drawn whole, by its index; never stored
let reread: Reread | null = null // the last re-read's outcome, never stored
let rereading = false
// The live sync (T0086): the one ticking timer, the time of the last press or
// version change (the idle stop's clock), and whether the idle stop ended it (a press restarts it).
const TICK_MS = 20_000
const IDLE_MS = 2 * 60 * 60_000
let timer: { cancel: () => void } | null = null
let quiet = 0
let idled = false
let writing = false // a tap's sheet_write is in flight: a tick waits
let fightEvents: Event[] = [] // the current fight's ops and undos, as stored
let fightId: string | null = null
// The DM's hand on the party view, never stored: the picked row, the open number
// field or add form.
let sel: { row: string; member: number } | null = null
let ask: Ask | null = null
let adding: Adding | null = null
// The note line under the screen on show; a screen change clears it.
let note: string | null = null
let packs: Pack[] | null = null // the packs screen's list, read fresh each time it opens
// Prep/Fights.md as last read (null: no file) and every stored fight's log, by id: read on a press, never in a draw.
let packets: ReturnType<typeof parsePacks> | null = null
let pastLogs = new Map<string, Event[]>()
let packet: { name: string; page: number } | null = null // the packet screen's pack, by name, and its page
// The sheet view's taps, never stored: the open number field, and the last tap
// written on this machine (the version it wrote over, `from`, and the one it wrote, `to`), for `u`.
let tap: Tap | null = null
let lastTap: { id: string; from: number; to: number } | null = null
// The Concentration saves the server raised (patch 19) and nobody has answered, by sheet id: due now,
// so memory only. Only this session's writes pass the watcher, so a pane sees its own session's saves.
const saves = new Map<string, Save[]>()
let split: string | null = null // the party's open `[ split gold ]` field, its text so far
// The look (T0085), never stored: the pane it was opened from, the field's text
// (kept for Back from a card), the open card's candidate, its fetch and page.
type Look = { pane: 'Party' | 'Sheet'; text: string; cand: Candidate | null; loading: boolean; error: string | null; page: number }
let look: Look | null = null
/** The open detail box (T0093): one at a time; a screen or tab change closes it. */
let detail: Detail | null = null
// The rules server's answers, by kind and name, for the module's life: a second look draws at once and calls nothing.
const rules = new Map<string, unknown>()
const RULES_TOOL = /^mcp__(.+)__(spell_get|monster_get|condition_search)$/
const TOOL_OF = { spell: 'spell_get', monster: 'monster_get', condition: 'condition_search' } as const
// The heard file as last read, while fresh, and the clock that reads it: started by
// the session's first `/party`, so a player's pane never polls. Never stored.
let heard: Heard | null = null
let heardPoll: Timer | null = null

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
  return { ...e, drift: e.drift === true, fromStore: true }
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

const top = () => screens[screens.length - 1]!

/** Leave the screen on show: its open field or form and its note go; `sel` stays (a row id, re-checked against the fold). */
function leave() {
  ask = null
  tap = null
  adding = null
  split = null
  note = null
}

/** Back, or Esc on a pushed screen: pop one; back on the look's field, the keys go into it. */
async function back($: EngineInterface) {
  popScreen()
  $.ui.invalidate('ui.render')
  await openPane($)
  if (top() === 'look') await focusOn($, 'look-field')
}

/** Show `s`: pushed, or, when it is already on the stack, the stack cut back to it. */
function pushScreen(s: Screen) {
  leave()
  detail = null
  const at = screens.indexOf(s)
  screens = at >= 0 ? screens.slice(0, at + 1) : [...screens, s]
}

function popScreen() {
  leave()
  detail = null
  if (screens.length > 1) screens = screens.slice(0, -1)
}

/** The stack `/sheet` and the unasked open start from: Back to Party when the party view has something to show. */
const sheetStack = (): Screen[] =>
  rosterRows([...sheets.values()]).length > 1 || (session && logs.has(session)) ? ['party', 'sheet'] : ['sheet']

/**
 * Where Esc (and its closing at an idle, empty prompt) has somewhere to go: an
 * open field or form closes, an open box closes, a pushed screen steps back, a lone sheet closes.
 * Elsewhere on `[party]` Esc hands the keys to the chat and the pane stays (T0055, T0065).
 */
const wantsEsc = () => !!(ask || tap || adding) || split !== null || !!detail || screens.length > 1 || top() === 'sheet'
/** What the pane's last open asked of Esc. */
let escOn = false

/**
 * Open the pane on the stack's top, or re-open it after a push or a pop: each
 * open sets its arguments anew. A Party-rooted stack opens at 60 columns; Esc
 * is set by `wantsEsc`.
 */
function openPane($: EngineInterface, take = false) {
  const t = top()
  escOn = wantsEsc()
  return $.ui.open({
    id: PANE,
    title: t === 'sheet' ? focused()?.name ?? 'Sheet' : t === 'look' || t === 'card' ? 'Look up' : 'Party',
    ...(screens[0] === 'party' ? { columns: 60 } : {}),
    ...(escOn ? { closeOnEscape: true as const } : {}),
    ...(take ? { focus: true as const } : {}),
  })
}

/** Re-open the pane when a field opening or closing on `[party]` changed what Esc should do, so Esc closes the field, not hands its key to the chat. */
async function syncEsc($: EngineInterface) {
  if (paneOpen && escOn !== wantsEsc()) await openPane($)
}

/** Show a PC's sheet over the screen on show. */
async function openSheet($: EngineInterface, id: string) {
  focus = id
  pushScreen('sheet')
  $.ui.invalidate('ui.render')
  await openPane($)
}

/** Esc in a field, or its `[ cancel ]`: the field or form closes and the keys go back to a Button. */
function cancel($: EngineInterface) {
  const was = tap
  leave()
  $.ui.invalidate('ui.render')
  return was ? focusOn($, 'tap-d') : park($)
}

/** A field's `[ apply ]`, or the form's `[ add ]`: the path Enter takes, with the text its change events kept. */
function submit($: EngineInterface, id: string) {
  if (id === 'amount-go') return input($, 'amount', 'submit', ask?.text ?? '')
  if (id === 'tap-go') return input($, 'tap-amount', 'submit', tap?.text ?? '')
  if (id === 'split-go') return input($, 'split-amount', 'submit', split ?? '')
  return input($, 'add-init', 'submit', adding?.init ?? '')
}

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
 * `[ next turn ]` or `[ turn ]`: apply the op, and when it starts a new round re-read the sheets, so HP the
 * players wrote shows. Awaited, as `[ re-read ]`'s is: the mod's own watcher sees only the calls made
 * while the press is in flight.
 */
async function turn($: EngineInterface, op: Op, label: string) {
  const was = fight()?.round ?? 0
  await apply($, op)
  if ((fight()?.round ?? 0) > was && (await refresh($, consent(label, 'Party') + ', which starts a new round and re-reads', true))) await startSync($)
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
    const r = await $.tool.call({ tool: DRAFT_WRITE, kind: 'table-note', session: s, text, consent: consent('end fight', 'Party') } as ToolCallArgs)
    if (!('deny' in r) && !r.isError) return
    why = firstLine('deny' in r ? r.deny : r.text)
  } catch (err) {
    why = firstLine(message(err))
  }
  $.ui.log('fight: draft_write refused: ' + why)
  not(why)
}

/**
 * A press on the party view: a row's name targets it, or opens a Party PC's
 * sheet; a member's HP targets that member; `[ init ]` beside a PC asks its
 * initiative; a button under the row acts on the targeted one.
 */
async function act($: EngineInterface, key: string) {
  ask = null
  const f = live(fight())
  if (key.startsWith('row-')) {
    const id = key.slice(4)
    if (!f?.rows.some((r) => r.id === id) && sheets.has(id)) return openSheet($, id)
    sel = { row: id, member: 0 }
    return $.ui.invalidate('ui.render')
  }
  if (key.startsWith('mem-')) {
    const m = /^mem-(.+)-(\d+)$/.exec(key)
    if (m) sel = { row: m[1]!, member: Number(m[2]) }
    return $.ui.invalidate('ui.render')
  }
  if (key.startsWith('init-')) sel = { row: key.slice(5), member: 0 }
  if (key === 'act-stats') {
    // `sel` stays: Back returns to the row targeted.
    const r = sel && f?.rows.find((x) => x.id === sel!.row)
    if (!r || r.side === 'pc') return say($, 'no stats for this row')
    const name = monsterName(r.name)
    look = null
    return openCard($, { name, kind: 'monster', key: norm(name) }, consent('stats: ' + name, 'Party'), 'Party')
  }
  if (key === 'act-c') return openPacks($)
  if (key === 'act-packet') return openPacket($)
  if (key === 'act-nextpack') {
    await readPackets($)
    const p = packets && nextPack(packets.packs, session, lastPack(fightLogs()))
    return p ? apply($, { op: 'pack', name: p.name, rows: p.rows }) : openPacks($)
  }
  if (key.startsWith('pack-')) {
    const p = packs?.[Number(key.slice(5)) - 1]
    if (!p) return
    packs = null
    pushScreen('party')
    await openPane($)
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
    void logFight($, f)
    await readPackets($)
    return $.ui.invalidate('ui.render')
  }
  if (!sel) return say($, 'pick a row first')
  if (key === 'act-s') return sheets.has(sel.row) ? openSheet($, sel.row) : say($, 'no sheet')
  const { row: id, member } = sel
  const row = f?.rows.find((r) => r.id === id)
  if (key === 'act-i' || key.startsWith('init-')) {
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
  if (key === 'act-t') return row ? turn($, { op: 'point', row: id }, 'turn') : say($, 'not in the fight')
}

/** Read Prep/Fights.md fresh, and every stored fight's log, for `[ next ]`. */
async function readPackets($: EngineInterface) {
  try {
    packets = parsePacks(await $.fs.read(FIGHTS))
  } catch {
    packets = null // no file
  }
  const keys: string[] = (await $.store.keys()) ?? []
  pastLogs = new Map()
  for (const k of keys) {
    if (!k.startsWith(FIGHT_LOG)) continue
    const events = storedEvents(await $.store.get(k))
    if (events) pastLogs.set(k.slice(FIGHT_LOG.length), events)
  }
}

/** The fights' logs, newest first: the stored ones as last read, the current one as it is now. */
function fightLogs(): Event[][] {
  const all = new Map(pastLogs)
  if (fightId) all.set(fightId, fightEvents)
  const num = (id: string) => Number(id.slice(1)) || 0
  return [...all.keys()].sort((a, b) => num(b) - num(a)).map((id) => all.get(id)!)
}

/** A pack by name: the session's first, then the whole file's. */
const packNamed = (name: string) => {
  const all = packets?.packs ?? []
  return sessionPacks(all, session).find((p) => p.name === name) ?? all.find((p) => p.name === name) ?? null
}

/** `[ packs ]`: the packs screen, from Prep/Fights.md read fresh; with none, the screen says why. */
async function openPacks($: EngineInterface) {
  await readPackets($)
  const read = packets
  pushScreen('packs')
  packs = read?.packs.length ? read.packs : null
  // A pack that does not read is left out of the list; the note names its line.
  note = !read ? 'no ' + FIGHTS : read.errors[0] ?? (packs ? null : 'no packs in ' + FIGHTS)
  $.ui.invalidate('ui.render')
  await openPane($)
}

/** `[ packet ]`: the notes of the pack loaded last into the fight on show, from Prep/Fights.md read fresh. */
async function openPacket($: EngineInterface) {
  await readPackets($)
  const name = fight()?.packs.at(-1)
  if (!name) return
  if (!packNamed(name)) return say($, `no pack "${name}" in ${FIGHTS}`)
  packet = { name, page: 0 }
  pushScreen('packet')
  $.ui.invalidate('ui.render')
  await openPane($)
}

/** A row's monster: its name, a typed ` 2` dropped. */
const monsterName = (name: string) => name.replace(/ \d+$/, '')
/** The monsters a look can open: the fight's rows and the packs read, if any. */
const monsterNames = () => [
  ...(fight()?.rows ?? []).filter((r) => r.side !== 'pc').map((r) => monsterName(r.name)),
  ...(packs ?? []).flatMap((p) => p.rows.map((r) => r.name)),
]
const lookMatches = () => (look ? matches(look.text, candidates(monsterNames())) : [])
const cacheKey = (c: Candidate) => c.kind + '|' + norm(c.name)

/** The look as drawn, while its screens show. */
function lookView(): LookView | null {
  const t = top()
  if (!look || (t !== 'look' && t !== 'card')) return null
  const card = look.cand ? cardOf(look.cand, rules.get(cacheKey(look.cand)) ?? null, factsRow(look.cand)) : null
  return { text: look.text, matches: t === 'look' ? lookMatches() : [], card, loading: look.loading, error: look.error, page: look.page }
}

/** `[ look up ]`: the field, empty, over the screen on show, with the keys in it. */
async function openLook($: EngineInterface) {
  look = { pane: top() === 'sheet' ? 'Sheet' : 'Party', text: '', cand: null, loading: false, error: null, page: 0 }
  pushScreen('look')
  $.ui.invalidate('ui.render')
  await openPane($)
  await focusOn($, 'look-field')
}

/**
 * A match, Enter's top match or `[ stats ]`: the card, drawn at once from what
 * is known (a spell's facts row, a cached answer), then fetched once, on this
 * press, never ahead of it.
 */
async function openCard($: EngineInterface, cand: Candidate, said: string, pane: Look['pane']) {
  look = { pane, text: look?.text ?? '', cand, loading: false, error: null, page: 0 }
  pushScreen('card')
  $.ui.invalidate('ui.render')
  await openPane($)
  const k = cacheKey(cand)
  if (rules.has(k) || look?.cand !== cand) return
  look = { ...look, loading: true }
  $.ui.invalidate('ui.render')
  const got = await fetchRules($, cand, said)
  if ('payload' in got) rules.set(k, got.payload)
  if (look?.cand !== cand) return // the person moved on; the answer is kept for next time
  look = { ...look, loading: false, error: 'error' in got ? got.error : null }
  $.ui.invalidate('ui.render')
}

/**
 * The rules server's answer for `cand`: the tool found as the re-read finds
 * `sheet_read` (a cached sheet's server first), its arguments top level.
 * A condition is searched and the result named exactly is taken.
 */
async function fetchRules($: EngineInterface, cand: Candidate, said: string): Promise<{ payload: unknown } | { error: string }> {
  try {
    const names = (await $.tool.list()).map((t) => t.name)
    const want = TOOL_OF[cand.kind]
    const known = [...sheets.values()].map((e) => `mcp__${e.server}__${want}`).find((n) => names.includes(n))
    const tool = known ?? names.find((n) => RULES_TOOL.exec(n)?.[2] === want)
    if (!tool) return { error: 'no rules tool in this session: add the rules connector' }
    const args = cand.kind === 'condition' ? { tool, query: cand.name, limit: 5, consent: said } : { tool, name: cand.name, consent: said }
    // The name is found at run time, so it is no literal the declarations know.
    const r = await $.tool.call(args as ToolCallArgs)
    if ('deny' in r) return { error: firstLine(r.deny) }
    if (r.isError) return { error: firstLine(r.text) }
    const p = payloadOf(r)
    if (!p || !('data' in p) || !p.data || typeof p.data !== 'object') return { error: 'unexpected answer from ' + tool }
    if (cand.kind !== 'condition') return { payload: p.data }
    const hit = ((p.data as { results?: unknown[] }).results ?? []).find((x: any) => norm(String(x?.name ?? '')) === norm(cand.name))
    return hit ? { payload: hit } : { error: 'no ' + cand.name + ' on the rules server' }
  } catch (err) {
    return { error: firstLine(message(err)) }
  }
}

/**
 * `[ ask Claude ]`: the subject (the card's title and cite, or the field's
 * text) as a prompt of this session, fired and not awaited (it runs once the
 * session is idle). The look closes and the note says so at once.
 */
async function askClaude($: EngineInterface) {
  if (!look) return
  const card = top() === 'card' ? lookView()?.card ?? null : null
  const subject = card ? { title: card.title, cite: card.cite } : look.text.trim()
  if (!subject) return
  void $.prompt.submit({ text: askText({ subject, pane: look.pane, session, tail: look.pane === 'Party' ? heard?.tail : null }) }).catch(() => {})
  const at = screens.findIndex((s) => s === 'look' || s === 'card')
  leave()
  detail = null
  screens = screens.slice(0, Math.max(1, at))
  look = null
  await openPane($)
  say($, 'asked Claude')
}

/** `[ ask Claude about what was just said ]`: the party pane's question, with the heard file's last minute. */
function askHeard($: EngineInterface) {
  void $.prompt.submit({ text: askText({ subject: 'rule on what was just said', pane: 'Party', session, tail: heard?.tail }) }).catch(() => {})
  say($, 'asked Claude')
}

/** One tick of the heard poll: the file read (missing is none), redrawn only when its `updated` changed. */
async function readHeard($: EngineInterface) {
  let raw: string | null = null
  try {
    raw = await $.fs.read(HEARD_PATH)
  } catch {}
  const got = asHeard(raw, await $.clock.now())
  if ((got?.updated ?? null) === (heard?.updated ?? null)) return
  heard = got
  $.ui.invalidate('ui.render')
}

const ADD_FIELDS = ['name', 'count', 'hp', 'ac', 'init'] as const
/** A numeric add field: an integer, or null when blank (or not a number). */
const num = (t: string) => (/^\d+$/.test(t.trim()) ? Number(t.trim()) : null)

/** The number field and the add form: a change is drawn back; a submit applies or moves on. */
async function input($: EngineInterface, element: string, kind: 'change' | 'submit', value: string) {
  if (element === 'look-field' && look) {
    look = { ...look, text: value }
    // A change narrows the matches; Enter opens the top one, and with none does nothing more (never asks).
    const hit = kind === 'submit' ? lookMatches()[0] : undefined
    if (hit) return openCard($, hit, consent('look up: ' + hit.name, look.pane), look.pane)
    return $.ui.invalidate('ui.render')
  }
  if (element === 'tap-amount' && tap) {
    // Drawn back on every change: the host keeps a field's typing until the hook draws a different value.
    if (kind === 'change') {
      tap = { ...tap, text: value }
      return $.ui.invalidate('ui.render')
    }
    const t = value.trim()
    if (!t) {
      tap = null
      $.ui.invalidate('ui.render')
      return focusOn($, 'tap-d')
    }
    tap = { ...tap, text: value }
    if (tap.kind === 'coins') return coins($, t)
    const n = num(t)
    if (n === null) {
      note = 'a number'
      return $.ui.invalidate('ui.render')
    }
    return hp($, n, value)
  }
  if (element === 'amount' && ask) {
    if (kind === 'change') {
      ask = { ...ask, text: value }
      return $.ui.invalidate('ui.render')
    }
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
  if (element === 'split-amount' && split !== null) {
    split = value
    if (kind === 'change') return $.ui.invalidate('ui.render')
    if (!value.trim()) {
      split = null
      $.ui.invalidate('ui.render')
      return park($)
    }
    return splitGold($, value.trim())
  }
  const field = ADD_FIELDS.find((k) => element === 'add-' + k)
  if (!field || !adding) return
  adding = { ...adding, [field]: value }
  if (kind === 'change') return $.ui.invalidate('ui.render')
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
  if (key === 'tap-c') {
    tap = { kind: 'coins', text: '' }
    $.ui.invalidate('ui.render')
    return focusOn($, 'tap-amount')
  }
  if (key === 'tap-u') {
    if (!lastTap || lastTap.id !== entry.id) return say($, 'nothing to undo')
    if (entry.version !== lastTap.to) return say($, 'the sheet changed since: undo in the chat')
    return write($, entry, { action: 'revert', changes: { version: lastTap.from } }, 'sheet pane: undo', consent('undo', 'Sheet'))
  }
  const slot = slotRows(entry).find((s) => s.key === key)
  if (!slot) return
  const pact = key === 'slot-pact'
  const name = pact ? 'pact' : slot.label
  if (slot.left <= 0) return say($, `no ${name} slots left`)
  const spell = entry.sheet.spellcasting ?? {}
  const used = Number(pact ? spell.pact_slots_used ?? 0 : spell.slots_used?.[String(slot.level)] ?? 0)
  const changes = pact ? { spellcasting: { pact_slots_used: used + 1 } } : { spellcasting: { slots_used: { [String(slot.level)]: used + 1 } } }
  return write($, entry, { action: 'update', changes }, `sheet pane: ${name} slot`, consent(slot.label, 'Sheet'))
}

/**
 * A Concentration spell's `CONC` (`conc-<i>`, the row's index on the actions tab): it writes
 * the field, spell and source both (a merge patch keeps what it does not name); on the held
 * spell, `HOLDING`, it writes null, which ends it.
 */
async function concentrate($: EngineInterface, key: string) {
  const entry = focused()
  const row = entry ? actionGroups(entry, new Map(), () => false).flatMap((g) => g.rows)[Number(key.slice(5))] : undefined
  if (!entry || !row) return
  const changes = holding(entry, row) ? { concentration: null } : { concentration: { spell: row.name, source: row.source || null } }
  return write($, entry, { action: 'update', changes }, 'sheet pane: concentrate', consent('concentrate · ' + row.name, 'Sheet'))
}

/** A save line's `[ held ]` (`held-<id>-<k>`) drops it here; `[ lost ]` (`lost-<id>-<k>`) ends the sheet's Concentration. */
async function answerSave($: EngineInterface, key: string) {
  const [, verb, id = '', k] = /^(held|lost)-(.+)-(\d+)$/.exec(key) ?? []
  const entry = sheets.get(id)
  if (!entry) return
  if (verb === 'held') {
    const left = (saves.get(id) ?? []).filter((_, i) => i !== Number(k))
    if (left.length) saves.set(id, left)
    else saves.delete(id)
    $.ui.invalidate('ui.render')
    return
  }
  const pane = top() === 'sheet' ? 'Sheet' : 'Party'
  return write($, entry, { action: 'update', changes: { concentration: null } }, 'sheet pane: lost concentration', consent('lost · ' + entry.name, pane))
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

/** The coins field's `+50` or `-5 sp`: one coin of the sheet on show, compare-and-set (sheet.ts `coinChange`). */
async function coins($: EngineInterface, typed: string) {
  const entry = focused()
  if (!entry || !tap) return
  const c = parseCoins(typed)
  if ('refused' in c) return say($, c.refused)
  if (c.delta === 0) return say($, 'nothing to change')
  const change = coinChange(entry.sheet, entry.name, c.coin, c.delta)
  if ('refused' in change) return say($, change.refused)
  const said = `The user entered "${typed}" in "coins · ${entry.name}" on the Sheet pane and pressed apply`
  return write($, entry, { action: 'update', changes: change.changes }, `sheet pane: ${c.delta < 0 ? '−' : '+'}${Math.abs(c.delta)} ${c.coin}`, said)
}

/**
 * `[ split gold ]`'s amount: paid out evenly to every cached PC, one write at a
 * time, the remainder named. A refusal stops it, naming who was paid; each
 * write is its own, so `[ undo ]` on a sheet undoes only the last.
 */
async function splitGold($: EngineInterface, typed: string) {
  if (typed.startsWith('-')) return say($, 'split pays out; spend per row')
  const c = parseCoins(typed.startsWith('+') ? typed : '+' + typed)
  if ('refused' in c) return say($, c.refused)
  const pcs = rosterRows([...sheets.values()])
  const each = Math.floor(c.delta / Math.max(1, pcs.length))
  if (each < 1) return say($, pcs.length ? `${c.delta} ${c.coin} is less than 1 each` : 'no sheets to pay')
  const said = `The user entered "${typed}" in "split gold · party" on the Party pane and pressed apply`
  const paid: string[] = []
  for (const pc of pcs) {
    const change = coinChange(pc.sheet, pc.name, c.coin, each)
    if ('refused' in change) return say($, change.refused)
    // write() leaves the note empty when it applied, and says why when it did not.
    await write($, pc, { action: 'update', changes: change.changes }, `sheet pane: split +${each} ${c.coin}`, said)
    if (note) return say($, `paid ${paid.join(', ') || 'nobody'}; stopped at ${pc.name}: ${note}`)
    paid.push(pc.name)
  }
  split = null
  say($, `${each} ${c.coin} each · ${c.delta - each * pcs.length} ${c.coin} left over`)
  await syncEsc($)
  return park($)
}

/**
 * One tap's `sheet_write`, applied at once at the pane's version: the
 * connector's `base_version` guard is the stale check. The watcher caches and
 * flashes the result; a refusal or an error is the note, and the field stays.
 */
async function write($: EngineInterface, entry: Entry, body: Record<string, unknown>, reason: string, said: string) {
  const tool = 'mcp__' + entry.server + '__sheet_write'
  const from = entry.version
  writing = true
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
  } finally {
    writing = false
  }
  tap = null
  note = null
  $.ui.invalidate('ui.render')
  // A split's writes are on the party view, which parks once they are done.
  if (split === null) await focusOn($, 'tap-d')
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
    // Esc closes it (or steps back to Party), as `/sheet`'s does: a player who never typed `/sheet` needs a way out.
    screens = sheetStack()
    leave()
    detail = null
    const placed = await openPane($)
    if (placed && placed.isPlaced) {
      paneOpen = true
      await startSync($)
    }
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
    if (got && !got.sheet.concentration) saves.delete(got.character.id)
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
  // A write that touches the field answers its saves; one that raises a save adds it.
  if (wrote.diff.some((d) => /^\/concentration(\/|$)/.test(d.path))) saves.delete(old.id)
  if (wrote.save) saves.set(old.id, [...(saves.get(old.id) ?? []), wrote.save])
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
 * The re-read, one sweep at a time: the connector's `list`, then a `get` per id
 * whose version moved (every id when `all`), one at a time (a dialog each in
 * default mode, never several at once), then, on a press, the session's
 * manifest. An id listed at the version cached is confirmed: read now, nothing
 * stored. The watchers cache the answers; this reads only whether each call
 * answered. It returns false only when a refusal or a bad list stopped the
 * ticks (or a sweep was already running): an `ask` or no tool yet still lets them run.
 *
 * `said` is the person's own words, given as `consent` (none on a tick). A
 * `press` may ask; anything else (an open, a tick) first asks `$.tool.check`
 * and calls only on `allow`, so it never raises a dialog. A refusal or a bad
 * list stops the ticks, with the readout naming the tool.
 */
async function refresh($: EngineInterface, said: string | null, press: boolean, all = false): Promise<boolean> {
  if (rereading) return false
  rereading = true
  const stop = (r: Reread) => {
    reread = r
    stopSync()
    return false
  }
  const call = async (tool: string, request: Record<string, unknown>) => {
    // The name is found at run time, so it is no literal the declarations know.
    const r = await $.tool.call({ tool, request, ...(said ? { consent: said } : {}) } as ToolCallArgs)
    if ('deny' in r || r.isError) {
      $.ui.log(`re-read: ${tool} refused: ` + firstLine('deny' in r ? r.deny : r.text))
      stop({ refused: tool })
      return null
    }
    return r
  }
  try {
    const names = (await $.tool.list()).map((t) => t.name)
    const known = [...sheets.values()].map((e) => `mcp__${e.server}__sheet_read`).find((n) => names.includes(n))
    const tool = known ?? names.find((n) => /^mcp__(.+)__sheet_read$/.test(n))
    if (!tool) {
      // Only a press says so: an open or a tick before the servers connect waits quietly.
      if (press) await $.ui.toast(names.length ? 'No sheet tool in this session: add the rules connector' : 'No tools yet: the servers connect after the first turn; press re-read then')
      return true
    }
    if (!press) {
      const { decision } = await $.tool.check({ tool, input: { request: { action: 'list' } } })
      if (decision === 'deny') return stop({ refused: tool })
      if (decision !== 'allow') {
        reread = { off: tool }
        return true
      }
    }
    const r = await call(tool, { action: 'list' })
    if (!r) return false
    const p = payloadOf(r)
    if (!p || !('data' in p) || !Array.isArray(p.data)) return stop({ failed: 'list: unexpected answer' })
    const listed = p.data.filter((c): c is { id: string; version: number } => typeof c?.id === 'string')
    const plan = all ? { fetch: listed.map((c) => c.id), confirm: [] } : moved([...sheets.values()], listed)
    let n = 0
    for (const id of plan.fetch) {
      const before = sheets.get(id)
      const request = { action: 'get', character: id }
      const got = await call(tool, request)
      if (!got) return false
      // A timer's call can pass beneath the mod's own watcher (the test kit's does): then the sweep caches it.
      if (sheets.get(id) === before) await watch($, { tool, request }, got)
      n++
    }
    const now = await $.clock.now()
    for (const id of plan.confirm) {
      const e = sheets.get(id)
      if (e) sheets.set(id, { ...e, readAt: now, fromStore: false })
    }
    if (plan.fetch.length) quiet = now
    if (press && session && names.includes(VAULT_QUERY) && !(await call(VAULT_QUERY, { action: 'session', id: session }))) return false
    reread = { at: now, sheets: n + plan.confirm.length, listed: p.data.length }
    return true
  } catch (err) {
    return stop({ failed: firstLine(message(err)) })
  } finally {
    rereading = false
    $.ui.invalidate('ui.render')
  }
}

/** A tick of the live sync: nothing while a sweep or a tap is in flight; stopped once the pane is closed or 2 hours went quiet. */
async function tick($: EngineInterface) {
  if (rereading || writing) return
  if (!paneOpen) return stopSync()
  if ((await $.clock.now()) - quiet >= IDLE_MS) {
    stopSync()
    idled = true
    return
  }
  await refresh($, null, false)
}

/** Start the ticks, one timer per mod instance; the idle stop's clock starts now. */
async function startSync($: EngineInterface) {
  quiet = await $.clock.now()
  idled = false
  timer ??= $.clock.every(TICK_MS, () => void tick($))
}

function stopSync() {
  timer?.cancel()
  timer = null
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    heardPoll?.cancel()
    heardPoll = null
    heard = null
    await loadStore($)
    try {
      await $.command.register({
        name: 'sheet',
        description: 'Show a character sheet beside the transcript',
        argumentHint: '[name] [act|skills|feats|gear|notes]',
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
    detail = null
    const query = words.filter((w) => tabOf(w) === null).join(' ')
    if (query) {
      const hit = matchEntry([...sheets.values()], query)
      if (!hit) {
        await $.ui.toast(`No sheet for "${query}" on this machine yet. Ask Claude to read it.`)
        return {}
      }
      focus = hit.id
    }
    screens = sheetStack()
    leave()
    dismissed = false
    await openPane($, true)
    paneOpen = true
    $.ui.invalidate('ui.render')
    if (await refresh($, 'The user typed "/sheet"', false)) await startSync($)
    return {}
  })

  // `/party [S04]`: the party view, drawn from the cache at once, then re-read and kept current while it is open
  // where sheet_read is allowed (refresh's `$.tool.check`); elsewhere only `[ re-read ]`, or a turn into a new round, re-reads.
  on('command.run', { command: 'party' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toUpperCase()
    if (isSessionId(arg)) {
      session = arg
      await $.store.set(SESSION, session)
    }
    await readPackets($)
    screens = ['party']
    leave()
    detail = null
    dismissed = false
    heardPoll ??= $.clock.every(1500, () => void readHeard($))
    await openPane($, true)
    paneOpen = true
    $.ui.invalidate('ui.render')
    if (await refresh($, 'The user typed "/party"', false)) await startSync($)
    return {}
  })

  // Esc, or the close mark (one origin for both). The order: an open field or form
  // closes first, then an open box (T0093), then a pushed screen pops, and the pane
  // stays; on the stack's root the pane closes (a lone sheet), or, on `[party]`, Esc
  // is not asked for (`wantsEsc`) and goes to the chat.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    if (e.origin?.kind === 'person') {
      if (ask || tap || adding || split !== null) {
        await cancel($)
        await syncEsc($)
        return { value: undefined }
      }
      if (detail) {
        detail = null
        $.ui.invalidate('ui.render')
        await syncEsc($)
        return { value: undefined }
      }
      // The look's field is a screen, not a field: Esc there pops.
      if (screens.length > 1) {
        await back($)
        return { value: undefined }
      }
      dismissed = true
    }
    paneOpen = false
    stopSync()
    $.ui.invalidate('ui.render')
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
    const entry = focused()
    return paneTree(el, {
      screen: top(),
      canBack: screens.length > 1,
      entry,
      rows: rosterRows([...sheets.values()]),
      log: session ? logs.get(session) ?? null : null,
      logOpen,
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
      canPacket: !!fight()?.packs.length,
      nextPack: !live(fight()) && packets ? nextPack(packets.packs, session, lastPack(fightLogs()))?.name ?? null : null,
      packet: packet && { pack: packNamed(packet.name), page: packet.page },
      tap,
      undo: !!entry && !!lastTap && lastTap.id === entry.id && entry.version === lastTap.to,
      look: lookView(),
      saves,
      heard,
      split,
      detail,
    })
  })

  // A word's press (word.tsx posts `{press: key}`): its box opens, or closes when it is the open one.
  on('ui.message', async ($, e, next) => {
    const press = (e.data as { press?: unknown } | null)?.press
    if (e.requestId !== PANE || typeof press !== 'string' || !press.startsWith('w:') || press !== e.element) return next(e)
    detail = pressWord(detail, press)
    $.ui.invalidate('ui.render')
    await syncEsc($)
    return {}
  })

  // The party view's number field (`amount`) and add form (`add-*`); the sheet view's (`tap-amount`).
  on('ui.input', { plugin: 'toa-sheet' }, async ($, e, next) => {
    await input($, String(e.element), e.kind, e.value)
    await syncEsc($)
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

  // The pane's presses: back, a tab, the DM-rules badge (which opens Notes), the sheet's
  // taps, the fight's (a row, a member, an action, next turn, undo), a field's apply and
  // cancel, the re-read. The Buttons' own closures do nothing, so a kept Button never acts
  // on stale state. A press that changes the screen or closes its field, and re-read, next
  // turn and turn, take their press rather than pass it to core: a sweep may outlive its
  // Button's drawing (`[ sheet ]` mid-sweep shows a sheet without them), a retired Button's
  // handle is gone, and core's look-up of a retired handle throws.
  // Other presses still pass: `[ end fight ]`'s unawaited log write must start while the press is in flight.
  // Every press ends by re-opening the pane if a field opened or closed and Esc should now act otherwise.
  on('ui.press', { plugin: 'toa-sheet' }, async ($, e, next) => {
    try {
      // Any press holds off the live sync's idle stop, and restarts it once that stop ended it.
      quiet = await $.clock.now()
      if (idled && paneOpen) await startSync($)
      const id = String(e.element)
      if (id === 'back') {
        await back($)
        return { element: id }
      } else if (id === 'look') {
        await openLook($)
        return { element: id }
      } else if (/^look-\d$/.test(id)) {
        const hit = lookMatches()[Number(id.slice(5)) - 1]
        if (hit && look) await openCard($, hit, consent('look up: ' + hit.name, look.pane), look.pane)
        return { element: id }
      } else if (id === 'pkt-more') {
        if (packet) packet = { ...packet, page: packet.page + 1 }
        $.ui.invalidate('ui.render')
        return { element: id }
      } else if (id === 'heard-ask') {
        askHeard($)
        return { element: id }
      } else if (/^heard-\d$/.test(id)) {
        const x = heard?.items[Number(id.slice(6)) - 1]
        const hit = x && candidates([]).find((c) => c.kind === x.kind && norm(c.name) === norm(x.name))
        if (hit) await openCard($, hit, consent('heard: ' + hit.name, 'Party'), 'Party')
        return { element: id }
      } else if (id === 'look-more') {
        if (look) look = { ...look, page: look.page + 1 }
        $.ui.invalidate('ui.render')
        return { element: id }
      } else if (id === 'log-all') {
        pushScreen('log')
        $.ui.invalidate('ui.render')
        await openPane($)
        return { element: id }
      } else if (/^log-\d+$/.test(id)) {
        // An entry's press draws it whole, or one line again; its label changes, so its handle retires.
        const i = Number(id.slice(4))
        logOpen = logOpen === i ? null : i
        $.ui.invalidate('ui.render')
        return { element: id }
      } else if (id === 'look-ask') {
        await askClaude($)
        return { element: id }
      } else if (id === 'amount-go' || id === 'tap-go' || id === 'add-go' || id === 'split-go') {
        await submit($, id)
        return { element: id }
      } else if (id === 'amount-cancel' || id === 'tap-cancel' || id === 'add-cancel' || id === 'split-cancel') {
        await cancel($)
        return { element: id }
      } else if (id === 'act-t' || id === 'act-s' || id === 'act-c' || id === 'act-stats' || id === 'act-packet' || id === 'act-nextpack' || id.startsWith('pack-') || id.startsWith('row-')) {
        await act($, id)
        return { element: id }
      } else if (id.startsWith('act-') || id.startsWith('mem-') || id.startsWith('init-')) {
        await act($, id)
      } else if (id.startsWith('tap-') || id.startsWith('slot-')) {
        await tapKey($, id)
      } else if (/^conc-\d+$/.test(id)) {
        // Its label changes (CONC, HOLDING), so its handle retires: the press is taken.
        await concentrate($, id)
        return { element: id }
      } else if (/^(held|lost)-/.test(id)) {
        // The line goes with its Buttons.
        await answerSave($, id)
        return { element: id }
      } else if (id === 'next' && live(fight())) {
        await turn($, { op: 'next' }, 'next turn')
        return { element: id }
      } else if (id === 'undo') {
        // Also after `f`: undoing the end brings the fight back.
        await apply($, 'undo')
      } else if (id === 'reread') {
        if (await refresh($, consent('re-read', top() === 'sheet' ? 'Sheet' : 'Party'), true, true)) await startSync($)
        return { element: id }
      } else if (id === 'split') {
        split = split === null ? '' : null
        $.ui.invalidate('ui.render')
        if (split !== null) await focusOn($, 'split-amount')
      } else if (id.startsWith('w:')) {
        // A word where no Client draws it: a plain Button that opens and closes its box.
        detail = pressWord(detail, id)
        $.ui.invalidate('ui.render')
        return { element: id }
      } else if (id === 'detail-x') {
        detail = null
        $.ui.invalidate('ui.render')
        return { element: id }
      } else if (id === 'detail-reread') {
        await refresh($, consent('re-read', top() === 'sheet' ? 'Sheet' : 'Party'))
        return { element: id }
      } else if (id === 'detail-more') {
        const pane = top() === 'sheet' ? 'Sheet' : 'Party'
        const c = detail && detailOf(detail.anchor, rosterRows([...sheets.values()]), focused(), await $.clock.now())
        if (c?.more) await openCard($, c.more, consent('look up: ' + c.more.name, pane), pane)
        return { element: id }
      }
      const hit = TABS.find((t) => tabKey(t.id) === e.element)?.id ?? (e.element === RULES_KEY ? 'notes' : null)
      if (hit && hit !== tab) {
        tab = hit
        detail = null
        $.ui.invalidate('ui.render')
      }
      return await next(e)
    } finally {
      await syncEsc($)
    }
  })

  // The band strip while the pane is closed, and the heard line while the newest
  // heard name is under a minute old, kept above other mods' band content.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const entry = !paneOpen && seenHere ? focused() : null
    const now = heard ? await $.clock.now() : 0
    const newest = heard?.items[0]
    const ear = newest && now - newest.at < 60_000 ? newest : null
    if (!entry && !ear) return next(e)
    const el = $.ui.resolve(e)
    return el.Box({ flexDirection: 'column', children: [...(ear ? [heardBand(el, ear, now)] : []), ...(entry ? [bandTree(el, entry, e.surface)] : []), await next(e)] })
  })
}
