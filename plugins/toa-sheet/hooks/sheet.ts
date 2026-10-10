// The sheet the pane draws, built only from the rules connector's own results.
// `sheet_read get` gives the whole picture; a `sheet_write` result's diff is
// applied to the cached copy, which then waits for the next get. Nothing here
// computes a rule: the numbers are the server's `sheet` and `derived`.
// No mods API here (validation forbids passing `$` to an imported function).

export interface DiffItem {
  path: string
  from?: unknown
  to?: unknown
  rule?: unknown
}

export interface Change {
  version: number
  at: number
  reason: string
  diff: DiffItem[]
}

export interface Entry {
  id: string
  name: string
  owner: string | null
  version: number
  sheet: Record<string, any>
  derived: Record<string, any> | null
  unresolved: string[]
  /** When a get last confirmed this copy. */
  readAt: number
  /** When this copy last changed (a get or an applied diff). */
  seenAt: number
  /** The tool name's server part, for the record. */
  server: string
  /** A write's diff was applied and no get has confirmed it yet. */
  refreshing: boolean
  /** That diff touched something `derived` is computed from. */
  derivedPending: boolean
  /** Loaded from the store, written by an earlier session. */
  fromStore: boolean
  /** A write's diff disagreed with this copy (`applyDiff`'s `matched: false`): it missed a version. A get clears it. */
  drift: boolean
  last: Change | null
  /** The last `sheet_read check` of this sheet, counts only (the findings stay in the transcript). */
  check?: { at: number; version: number; warnings: number; infos: number }
}

type Payload = { data: unknown } | { error: string }

function parseText(text: string): Payload | null {
  try {
    return { data: JSON.parse(text) }
  } catch {
    return null
  }
}

/** A result's text as the model read it: a string, or content blocks joined. */
export function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textOf).join('')
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.type === 'text' && typeof o.text === 'string') return o.text
    if (typeof o.text === 'string') return o.text
    if ('content' in o) return textOf(o.content)
    if ('result' in o) return textOf(o.result)
  }
  return ''
}

/**
 * A tool result unwrapped to the server's JSON. From a tool.call hook's
 * `next(e)` Claude Code (2.1.288 types) gives `{ ref, result, text }`, `text`
 * being the result as the model reads it, with `isError` on a failure; from
 * `$.tool.call`, the same shape; MCP's own `{ content, isError }` also parses.
 * The shape checks below decide whether the JSON is ours.
 */
export function payloadOf(result: unknown): Payload | null {
  if (result === null || result === undefined) return null
  if (typeof result === 'string') return parseText(result)
  if (Array.isArray(result)) return parseText(textOf(result))
  if (typeof result !== 'object') return null
  const o = result as Record<string, unknown>
  if ('deny' in o) return null
  if (o.isError === true) return { error: textOf(o) }
  if (typeof o.text === 'string') {
    const p = parseText(o.text)
    if (p) return p
  }
  if (o.structuredContent && typeof o.structuredContent === 'object') return { data: o.structuredContent }
  if ('content' in o) return payloadOf(o.content)
  if ('result' in o) return payloadOf(o.result)
  return null
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface GetPayload {
  character: { id: string; owner?: string; version: number; updated_at?: string }
  sheet: Record<string, any>
  derived: Record<string, any> | null
  unresolved: string[]
}

/**
 * A `sheet_read get` answer of the head, or null when the payload is anything
 * else. A get of an old version (`character.showing_version` set) is null too:
 * its sheet is the old one but `character.version` is the head, so caching it
 * would draw history as current, confirmed by every list after.
 */
export function asGet(d: unknown): GetPayload | null {
  if (!isObj(d) || !isObj(d.character) || !isObj(d.sheet)) return null
  const c = d.character
  if (c.showing_version !== undefined) return null
  if (typeof c.id !== 'string' || !Number.isInteger(c.version) || c.version < 1) return null
  if (d.sheet.schema !== 1 || typeof d.sheet.name !== 'string') return null
  if (d.derived !== null && !isObj(d.derived)) return null
  const unresolved = Array.isArray(d.unresolved) ? d.unresolved.filter((u: unknown) => typeof u === 'string') : []
  return { character: c as GetPayload['character'], sheet: d.sheet, derived: d.derived ?? null, unresolved }
}

/** A Constitution save the server raised for damage to a concentrating sheet (patch 19): drawn as sent, never computed here. */
export interface Save {
  spell: string
  dc: number
  bonus: number
  damage?: number
}

export interface AppliedPayload {
  character: string
  name?: string
  version: number
  diff: DiffItem[]
  save?: Save
}

function asSave(v: unknown): Save | undefined {
  if (!isObj(v) || typeof v.spell !== 'string' || !Number.isInteger(v.dc) || !Number.isInteger(v.bonus)) return undefined
  return { spell: v.spell, dc: v.dc, bonus: v.bonus, ...(Number.isInteger(v.damage) ? { damage: v.damage } : {}) }
}

/** A `sheet_write apply=true` answer that wrote a version, or null. */
export function asApplied(d: unknown): AppliedPayload | null {
  if (!isObj(d) || d.applied !== true || typeof d.character !== 'string' || !Number.isInteger(d.version)) return null
  if (!Array.isArray(d.diff) || !d.diff.every((x: unknown) => isObj(x) && typeof x.path === 'string' && x.path.startsWith('/'))) return null
  const save = asSave(d.concentration_save)
  return { character: d.character, name: typeof d.name === 'string' ? d.name : undefined, version: d.version, diff: d.diff, ...(save ? { save } : {}) }
}

export interface Finding {
  severity: string
  message: string
  citation?: unknown
}

export interface CheckPayload {
  character: { id: string; version: number }
  findings: Finding[]
}

/** A `sheet_read check` answer, or null when the payload is anything else. */
export function asCheck(d: unknown): CheckPayload | null {
  if (!isObj(d) || !isObj(d.character) || typeof d.character.id !== 'string' || !Number.isInteger(d.character.version)) return null
  if (!Array.isArray(d.findings) || !d.findings.every((f: unknown) => isObj(f) && typeof f.severity === 'string' && typeof f.message === 'string')) return null
  return { character: d.character as CheckPayload['character'], findings: d.findings }
}

/** `check` is the cached entry's, carried over: a get does not re-check. */
export function entryFromGet(g: GetPayload, server: string, now: number, check?: Entry['check']): Entry {
  return {
    id: g.character.id,
    name: g.sheet.name,
    owner: typeof g.character.owner === 'string' ? g.character.owner : null,
    version: g.character.version,
    sheet: g.sheet,
    derived: g.derived,
    unresolved: g.unresolved,
    readAt: now,
    seenAt: now,
    server,
    refreshing: false,
    derivedPending: false,
    fromStore: false,
    drift: false,
    last: null,
    ...(check ? { check } : {}),
  }
}

/** Paths `derived` is not computed from (checked against the server's derive()). Anything else marks it pending. */
const OUTSIDE_DERIVED = [
  /^\/hp(\/|$)/,
  /^\/hit_dice_spent(\/|$)/,
  /^\/ac(\/|$)/,
  /^\/speed(\/|$)/,
  /^\/spellcasting\/(slots_used|pact_slots_used)(\/|$)/,
  /^\/resources(\/|$)/,
  /^\/currency(\/|$)/,
  /^\/conditions(\/|$)/,
  /^\/concentration(\/|$)/,
  /^\/exhaustion$/,
  /^\/house_rules(\/|$)/,
  /^\/notes$/,
  /^\/details(\/|$)/,
  /^\/requests(\/|$)/,
]

export const touchesDerived = (path: string) => !OUTSIDE_DERIVED.some((re) => re.test(path))

const tokens = (path: string) => path.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The server's diff (store/sheets.ts `diff`, rest changes): `{path, from, to}`
 * replaces, `{path, to}` adds, `{path, from}` removes. Applied to a copy.
 * `matched` is false when a `from` disagrees with the cache, i.e. the cache
 * missed a version.
 */
export function applyDiff(sheet: Record<string, any>, diff: DiffItem[]): { sheet: Record<string, any>; matched: boolean } {
  const out = JSON.parse(JSON.stringify(sheet))
  let matched = true
  const removals: { parent: any; key: string }[] = []
  for (const item of diff) {
    const keys = tokens(item.path)
    if (!keys.length) continue
    let parent: any = out
    for (const k of keys.slice(0, -1)) {
      if (!parent[k] || typeof parent[k] !== 'object') parent[k] = {}
      parent = parent[k]
    }
    const key = keys[keys.length - 1] ?? ''
    if ('from' in item && !same(parent[key], item.from)) matched = false
    if ('to' in item) parent[key] = JSON.parse(JSON.stringify(item.to))
    else removals.push({ parent, key })
  }
  // Array removals last and highest index first, so earlier indexes stay put.
  removals.sort((a, b) => Number(b.key) - Number(a.key))
  for (const { parent, key } of removals) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1)
    else delete parent[key]
  }
  return { sheet: out, matched }
}

/** The cached entry after a write: diff applied, waiting for a get. */
export function entryAfterWrite(entry: Entry, w: AppliedPayload, reason: string, now: number): Entry {
  const { sheet, matched } = applyDiff(entry.sheet, w.diff)
  return {
    ...entry,
    sheet,
    drift: entry.drift || !matched,
    name: typeof sheet.name === 'string' ? sheet.name : entry.name,
    version: w.version,
    seenAt: now,
    refreshing: true,
    derivedPending: entry.derivedPending || w.diff.some((d) => touchesDerived(d.path)),
    last: { version: w.version, at: now, reason, diff: w.diff },
  }
}

/** The character a `/sheet <name>` means, by id or name, ignoring case. */
export function matchEntry(entries: Entry[], query: string): Entry | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  return entries.find((e) => e.id === q || e.name.toLowerCase() === q) ?? entries.find((e) => e.name.toLowerCase().startsWith(q)) ?? null
}

/** A diff path in words: `/hp/current` → `HP`, `/resources/0/used` → `Wrath of the Storm used`. */
export function pathLabel(path: string, sheet: Record<string, any>): string {
  const [a = '', b, c] = tokens(path)
  const t = [a, b, c]
  if (t[0] === 'hp') return t[1] === 'current' || !t[1] ? 'HP' : 'HP ' + t[1]
  if (t[0] === 'resources' && t[1] !== undefined) {
    const r = sheet.resources?.[Number(t[1])]
    return (r?.name ?? 'resource ' + t[1]) + (t[2] ? ' ' + t[2] : '')
  }
  if (t[0] === 'spellcasting' && t[1] === 'slots_used') return 'slot ' + (t[2] ?? '') + ' used'
  if (t[0] === 'hit_dice_spent') return (t[1] ?? '') + ' spent'
  return t.join(' ').replace(/_/g, ' ')
}

/** One line for the last change: `HP 12 → 15 · long rest`. */
export function describeChange(c: Change, sheet: Record<string, any>): string {
  const v = (x: unknown) => (x === undefined ? '∅' : x !== null && typeof x === 'object' ? '…' : String(x))
  // A key the write created has no `from`: `slot 1 used → 1`, not `∅ → 1`.
  const parts = c.diff.slice(0, 3).map((d) => pathLabel(d.path, sheet) + (d.from === undefined ? '' : ' ' + v(d.from)) + ' → ' + v(d.to))
  if (c.diff.length > 3) parts.push('+' + (c.diff.length - 3) + ' more')
  return parts.join(', ') + (c.reason ? ' · ' + c.reason : '')
}

/**
 * What a `sheet_read list` means for the cache: `fetch` the ids whose version
 * moved or that were never got, `confirm` the ids it already holds at that
 * version. A copy known wrong (`drift`) or missing its `derived` is fetched
 * even at the same version. An id cached but not listed is left alone: a
 * player's list holds only their own sheet.
 */
export function moved(entries: Entry[], listed: { id: string; version: number }[]): { fetch: string[]; confirm: string[] } {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const fetch: string[] = []
  const confirm: string[] = []
  for (const { id, version } of listed) {
    const e = byId.get(id)
    if (!e || e.version !== version || e.drift || e.derivedPending) fetch.push(id)
    else confirm.push(id)
  }
  return { fetch, confirm }
}

export type Coin = 'cp' | 'sp' | 'ep' | 'gp' | 'pp'

/** `+50`, `-12`, `+5 sp`, `-3PP`: a signed amount of one coin, gp when unnamed. Unsigned is refused: a guessed direction moves money silently. */
export function parseCoins(text: string): { coin: Coin; delta: number } | { refused: string } {
  const t = text.trim()
  const m = /^([+-])\s*(\d+)\s*(cp|sp|ep|gp|pp)?$/i.exec(t)
  if (!m) return { refused: /^\d+\s*(cp|sp|ep|gp|pp)?$/i.test(t) ? '+ or −?' : 'an amount like +50 or -5 sp' }
  const n = Number(m[2])
  return { coin: (m[3]?.toLowerCase() ?? 'gp') as Coin, delta: m[1] === '-' ? -n : n }
}

/** A coin's amount on a sheet, 0 when the sheet has none. */
export const coinsOf = (sheet: Record<string, any>, coin: Coin): number => {
  const n = sheet.currency?.[coin]
  return typeof n === 'number' ? n : 0
}

/**
 * One coin moved by `delta`, as a JSON Patch compare-and-set on the cached
 * amount: the server refuses it if anyone moved that coin since. Never makes
 * change between coins; below zero is refused.
 */
export function coinChange(sheet: Record<string, any>, name: string, coin: Coin, delta: number): { changes: Record<string, unknown>[] } | { refused: string } {
  const old = coinsOf(sheet, coin)
  if (old + delta < 0) return { refused: `${name} has ${old} ${coin}` }
  const path = '/currency/' + coin
  return { changes: [{ op: 'test', path, value: old }, { op: 'replace', path, value: old + delta }] }
}
