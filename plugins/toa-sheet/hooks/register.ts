// toa-sheet: a character sheet pane beside the transcript (handoff 17, step A),
// and the DM's party view in the same pane (`/party`, handoff 18 step one).
//
// It watches the rules connector's own sheet_read / sheet_write results and the
// vault's Table-log writes and session manifests, and draws what the servers
// sent. It calls a tool itself only when the person presses `e: re-read` on the
// party view: `$.tool.call` with the press as `consent`, checked for permission
// like the model's own calls (README, "Re-read and permissions").
//
// It also draws the connector's rows in the transcript as receipts (receipt.ts),
// one line each, and flashes what a write changed in the pane.
//
// The party view's entry line is the DM's fight (fight.ts): each applied line
// is stored as typed, and the fight drawn is their fold.
//
// Mods API calls: $.ui, $.store, $.command, $.clock, $.tool only. Every call
// lives in this file; sheet.ts, table.ts, look.ts, receipt.ts and view.ts are pure.

import type { EngineInterface, On, RenderElement, ToolCallArgs } from 'claude-code'
import { fold, parseLine, undoTarget, type Event, type Fight } from './fight.ts'
import { FLASH_MS } from './look.ts'
import { CONNECTOR, receipt } from './receipt.ts'
import { asApplied, asCheck, asGet, entryAfterWrite, entryFromGet, matchEntry, payloadOf, type Entry } from './sheet.ts'
import { applyWrite, asManifest, asTableWrite, isSessionId, rosterRows, type TableLog } from './table.ts'
import { bandTree, detailTree, paneTree, receiptTree, RULES_KEY, TABS, tabKey, tabOf, type Reread, type TabId } from './view.ts'

const PANE = 'toa-sheet'
const KEY = 'sheet:' // one $.store key per character, so sessions never overwrite each other's characters
const LAST = 'last'
const TABLE = 'table:' // one $.store key per session's log
const SESSION = 'session'
const FIGHT = 'party:fight' // the current fight's id; its typed lines are under FIGHT_LOG + id
const FIGHT_LOG = 'party:log:' // one DM, one session: the last writer wins
const VAULT_QUERY = 'mcp__vault__vault_query'
/** The person's own words for the press that raises the mod's calls; the engine strips it before any tool sees it. */
const CONSENT = 'The user pressed "e: re-read" on the Party pane'

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
let fightEvents: Event[] = [] // the current fight's typed lines and undos, as stored
let fightId: string | null = null
let typed = '' // the entry line's text, kept across redraws
let refused: string | null = null // why the last line was refused, until one applies

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

function storedEvents(v: unknown): Event[] | null {
  if (!Array.isArray(v)) return null
  const ok = v.every((e) => e && typeof e === 'object' && typeof e.at === 'number' && (typeof e.line === 'string' || typeof e.undo === 'number'))
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
    fightId = id
    fightEvents = storedEvents(await $.store.get(FIGHT_LOG + id)) ?? []
  }
}

const pcs = () => rosterRows([...sheets.values()]).map((e) => ({ id: e.id, name: e.name }))
const fight = (): Fight | null => fold(fightEvents, pcs())

/**
 * One line from the entry field (or `n`/`u` pressed): refused and nothing
 * changes, or stored and drawn. A line that starts a new fight starts a new
 * log; the old one stays in the store.
 */
async function apply($: EngineInterface, typedLine: string) {
  const line = typedLine.trim().slice(0, 160)
  const at = await $.clock.now()
  let event: Event
  if (/^(u|undo)$/i.test(line)) {
    const target = undoTarget(fightEvents)
    if (target === null) {
      refused = 'nothing to undo'
      return $.ui.invalidate('ui.render')
    }
    event = { at, undo: target }
  } else {
    const ops = parseLine(line, { pcs: pcs(), fight: fight() })
    if ('refused' in ops) {
      refused = ops.refused
      return $.ui.invalidate('ui.render')
    }
    event = { at, line, source: 'dm' }
  }
  fightEvents = [...fightEvents, event]
  const f = fight()
  if (f && f.id !== fightId) {
    fightEvents = [event]
    fightId = f.id
    await $.store.set(FIGHT, fightId)
  }
  if (fightId) await $.store.set(FIGHT_LOG + fightId, fightEvents)
  refused = null
  $.ui.invalidate('ui.render')
  try {
    await $.ui.focus({ requestId: PANE, key: 'entry' })
  } catch {
    // The field is not drawn here (no Input, or the pane is closed): the hotkeys still work.
  }
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
  focus = entry.id
  seenHere = true
  await update($, entry)
  await $.store.set(LAST, entry.id)
  if (!paneOpen && !dismissed && !autoTried) {
    autoTried = true
    // Unasked, so Claude Code places it only where it fits (144 columns, 110 once opened).
    const placed = await $.ui.open({ id: PANE, title: entry.name })
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
 * The re-read, on the `e` press only: the connector's `list`, then a `get` per
 * id, one at a time (a dialog each in default mode, never several at once), then
 * the session's manifest. The watchers cache the answers; this reads only
 * whether each call answered.
 */
async function refresh($: EngineInterface) {
  const was = focus
  const call = async (tool: string, request: Record<string, unknown>) => {
    // The name is found at run time, so it is no literal the declarations know.
    const r = await $.tool.call({ tool, request, consent: CONSENT } as ToolCallArgs)
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
    if (was && sheets.has(was) && focus !== was) {
      focus = was
      await $.store.set(LAST, was)
    }
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
    dismissed = false
    await $.ui.open({ id: PANE, title: focused()?.name ?? 'Sheet', focus: true, closeOnEscape: true })
    paneOpen = true
    $.ui.invalidate('ui.render')
    return {}
  })

  // `/party [S04]`: the party view, drawn from the cache. It calls no tool: only `e` re-reads.
  on('command.run', { command: 'party' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toUpperCase()
    if (isSessionId(arg)) {
      session = arg
      await $.store.set(SESSION, session)
    }
    view = 'party'
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
      typed,
      refused,
    })
  })

  // The party view's entry line: a change is kept so a redraw keeps it; a submit is applied and clears it.
  on('ui.input', { plugin: 'toa-sheet', element: 'entry' }, async ($, e, next) => {
    if (e.kind === 'change') {
      typed = e.value
      return next(e)
    }
    await apply($, e.value)
    // A refused line stays in the field to be fixed, not retyped.
    typed = refused ? e.value : ''
    return next({ ...e, value: typed })
  })

  // Connector calls fold into one "Called CCC MCP n times" line. The matcher selects only
  // the groups holding a connector call (a pattern against an array holds when some element
  // matches); the rewrite unfolds them, and each call is then a ToolUse row the receipt hook draws.
  on('ui.render', { component: 'ToolGroup', props: { calls: { tool: CONNECTOR } } }, ($, e, next) =>
    next({ ...e, props: { ...e.props, isExpanded: true } }))
  on('ui.render', { component: 'ToolUse', props: { tool: CONNECTOR } }, ($, e, next) => {
    const r = receipt(e.props, (id) => sheets.get(id)?.sheet)
    return r ? receiptTree($.ui.resolve(e), r) : next(e)
  })
  // The result block is drawn in the ctrl+o transcript only (probe finding 8): the findings
  // in words, then Claude Code's own block, never hidden.
  on('ui.render', { component: 'ToolResult', props: { tool: CONNECTOR } }, async ($, e, next) => {
    const r = receipt({ ...e.props, isRunning: false }, (id) => sheets.get(id)?.sheet)
    return r && r.detail.length ? detailTree($.ui.resolve(e), r, await next(e)) : next(e)
  })

  // The pane's presses: a tab, the DM-rules badge (which opens Notes), the party
  // button, a party row (its sheet), the re-read. The Buttons' own closures do
  // nothing, so a kept Button never acts on stale state.
  on('ui.press', { plugin: 'toa-sheet' }, async ($, e, next) => {
    const id = String(e.element)
    if (id === 'view-party') {
      view = 'party'
      $.ui.invalidate('ui.render')
      await $.ui.open({ id: PANE, title: 'Party', columns: 60 })
    } else if (id.startsWith('pc-') && sheets.has(id.slice(3))) {
      focus = id.slice(3)
      view = 'sheet'
      $.ui.invalidate('ui.render')
      await $.ui.open({ id: PANE, title: focused()!.name })
    } else if (id === 'next' || id === 'undo') {
      await apply($, id === 'next' ? 'n' : 'u')
    } else if (id === 'reread' && !rereading) {
      rereading = true
      try {
        await refresh($)
      } finally {
        rereading = false
      }
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
