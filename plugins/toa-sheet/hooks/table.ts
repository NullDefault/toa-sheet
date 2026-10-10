// The DM's party view's data, from the vault server's own answers: the session
// manifest (`vault_query session`) and the Table operation's log as this mod saw
// it written (`draft_write table-note | table-close`). The log is what was seen
// here, not the vault's file: the mod never reads the vault's files.
// No mods API here (validation forbids passing `$` to an imported function).

import type { Entry } from './sheet.ts'
import { isObj } from './receipt.ts'

export interface Manifest {
  session: string
  status: string
  title: string | null
  tableExists: boolean
}

export interface TableEntry {
  at: number
  text: string
}

export interface TableLog {
  session: string
  entries: TableEntry[]
  closedAt: number | null
  manifest: Manifest | null
}

export interface TableWrite {
  kind: 'note' | 'close'
  session: string
  text: string
}

/**
 * A `vault_query {action: 'session'}` answer, or null. `registry` is the
 * registry row (or null), its `title` `""` when the note has none.
 */
export function asManifest(d: unknown): Manifest | null {
  if (!isObj(d) || typeof d.session !== 'string' || typeof d.status !== 'string') return null
  if (d.registry !== null && d.registry !== undefined && !isObj(d.registry)) return null
  const title = d.registry?.title
  return {
    session: d.session,
    status: d.status,
    title: typeof title === 'string' && title ? title : null,
    tableExists: Array.isArray(d.sources) && d.sources.some((s: any) => isObj(s) && s.kind === 'table' && s.exists === true),
  }
}

/** A `draft_write` call `e` (its arguments) that wrote a table note or the close, or null. A dry run answers `wrote: false`. */
export function asTableWrite(e: any, d: unknown): TableWrite | null {
  if (!e || (e.kind !== 'table-note' && e.kind !== 'table-close')) return null
  if (typeof e.session !== 'string' || typeof e.text !== 'string') return null
  if (!isObj(d) || d.wrote !== true) return null
  return { kind: e.kind === 'table-note' ? 'note' : 'close', session: e.session, text: e.text }
}

/** The log after a seen write: a note appends, a close sets `closedAt`. */
export function applyWrite(log: TableLog | null, w: TableWrite, now: number): TableLog {
  const base: TableLog = log ?? { session: w.session, entries: [], closedAt: null, manifest: null }
  return w.kind === 'note' ? { ...base, entries: [...base.entries, { at: now, text: w.text }] } : { ...base, closedAt: now }
}

export const isSessionId = (s: string) => /^S\d\d$/.test(s)

/** The party's rows, by name. (The DM's own roster order arrives with `party:roster`, handoff 18 step A.) */
export const rosterRows = (entries: Entry[]): Entry[] => [...entries].sort((a, b) => a.name.localeCompare(b.name))
