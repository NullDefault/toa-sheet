// toa-sheet: a character sheet pane beside the transcript (handoff 17, step A).
//
// Read-only. It watches the rules connector's own sheet_read / sheet_write
// results, draws the sheet the server sent, and never calls the connector
// itself: whether a mod can (step 0) is recorded in the README.
//
// Mods API calls: $.ui, $.store, $.command, $.clock only. Every call lives in
// this file; sheet.ts, art.ts and view.ts are pure.

import type { EngineInterface, On, RenderElement } from 'claude-code'
import { asApplied, asGet, entryAfterWrite, entryFromGet, matchEntry, payloadOf, type Entry } from './sheet.ts'
import { bandTree, paneTree, RULES_KEY, TABS, tabKey, tabOf, type TabId } from './view.ts'

const PANE = 'toa-sheet'
const KEY = 'sheet:' // one $.store key per character, so sessions never overwrite each other's characters
const LAST = 'last'

// Module state. A reload clears it; session.start refills the sheets from $.store.
const sheets = new Map<string, Entry>()
let focus: string | null = null
let tab: TabId = 'actions'
// The pane's Buttons from each surface's last drawing, handed back unchanged so
// their press handles survive a redraw (view.ts, PaneView.memo).
const memos = new Map<string, Map<string, RenderElement>>()
let probed = '' // the last pane geometry written to the store, so it is written only when it changes
let paneOpen = false
let dismissed = false // the user closed the pane: do not open it unasked again this session
let autoTried = false
let toasted = false
let seenHere = false // a sheet result arrived in this session (the band strip waits for one)

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const focused = () => (focus ? sheets.get(focus) ?? null : null)

function storedEntry(v: unknown): Entry | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Entry
  if (typeof e.id !== 'string' || typeof e.name !== 'string' || !Number.isInteger(e.version) || !e.sheet || typeof e.sheet !== 'object') return null
  return { ...e, fromStore: true }
}

async function loadSheets($: EngineInterface) {
  const keys: string[] = (await $.store.keys()) ?? []
  for (const k of keys) {
    if (!k.startsWith(KEY)) continue
    const e = storedEntry(await $.store.get(k))
    if (e && !sheets.has(e.id)) sheets.set(e.id, e)
  }
  const last = await $.store.get(LAST)
  if (!focus && typeof last === 'string' && sheets.has(last)) focus = last
}

/** Keep `entry`, show it, and save it unless another session already saved a newer version. */
async function remember($: EngineInterface, entry: Entry) {
  sheets.set(entry.id, entry)
  focus = entry.id
  seenHere = true
  $.ui.invalidate('ui.render')
  const stored = storedEntry(await $.store.get(KEY + entry.id))
  if (!stored || stored.version <= entry.version) await $.store.set(KEY + entry.id, { ...entry, fromStore: false })
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

/** A watched result: a get replaces the cached sheet; an applied write's diff updates it. */
async function watch($: EngineInterface, e: any, result: unknown) {
  const m = /^mcp__(.+)__sheet_(read|write)$/.exec(String(e.tool))
  const p = payloadOf(result)
  if (!m || !p || !('data' in p)) return
  const now = await $.clock.now()
  if (m[2] === 'read') {
    const got = asGet(p.data)
    if (got) await remember($, entryFromGet(got, m[1] ?? '', now))
    return
  }
  const wrote = asApplied(p.data)
  const old = wrote ? sheets.get(wrote.character) : undefined
  if (!wrote || !old) return
  const request = e.request ?? e.input?.request ?? {}
  await remember($, entryAfterWrite(old, wrote, typeof request.reason === 'string' ? request.reason : '', now))
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    await loadSheets($)
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
    dismissed = false
    await $.ui.open({ id: PANE, title: focused()?.name ?? 'Sheet', focus: true, closeOnEscape: true })
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
    // Probe: what each surface reports about the pane, kept in the store as `probe:pane:<surface>`
    // to size the art from (README, Design). Fire and forget: a refusal must not cost the drawing.
    const probe = { bodyColumns: e.props?.bodyColumns, viewport: e.viewport, scroll: e.props?.scroll, placement: e.props?.placement, surface: e.surface }
    const seen = JSON.stringify(probe)
    if (seen !== probed) {
      probed = seen
      const record = { ...probe, at: now }
      try {
        $.store.set('probe:pane:' + e.surface, record).catch(() => {
          // Refused while drawing: write it just after instead.
          try {
            $.clock.after(0, () => {
              $.store.set('probe:pane:' + e.surface, record).catch(() => {})
            })
          } catch {}
        })
      } catch {}
    }
    return paneTree(el, { entry: focused(), surface: e.surface, columns: e.props?.bodyColumns ?? 40, tab, memo, now })
  })

  // The pane's presses: a tab, or the DM-rules badge (which opens Notes). The
  // Buttons' own closures do nothing, so a kept Button never acts on stale state.
  on('ui.press', { plugin: 'toa-sheet' }, async ($, e, next) => {
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
    return el.Box({ flexDirection: 'column', children: [bandTree(el, entry), await next(e)] })
  })
}
