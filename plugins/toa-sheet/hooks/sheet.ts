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
  last: Change | null
}

type Payload = { data: unknown } | { error: string }

function parseText(text: string): Payload | null {
  try {
    return { data: JSON.parse(text) }
  } catch {
    return null
  }
}

function textOf(v: unknown): string {
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
 * `$.mcp.call`, MCP's own `{ content, isError }`. The shape checks below decide
 * whether the JSON is ours.
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

/** A `sheet_read get` answer, or null when the payload is anything else. */
export function asGet(d: unknown): GetPayload | null {
  if (!isObj(d) || !isObj(d.character) || !isObj(d.sheet)) return null
  const c = d.character
  if (typeof c.id !== 'string' || !Number.isInteger(c.version) || c.version < 1) return null
  if (d.sheet.schema !== 1 || typeof d.sheet.name !== 'string') return null
  if (d.derived !== null && !isObj(d.derived)) return null
  const unresolved = Array.isArray(d.unresolved) ? d.unresolved.filter((u: unknown) => typeof u === 'string') : []
  return { character: c as GetPayload['character'], sheet: d.sheet, derived: d.derived ?? null, unresolved }
}

export interface AppliedPayload {
  character: string
  name?: string
  version: number
  diff: DiffItem[]
}

/** A `sheet_write apply=true` answer that wrote a version, or null. */
export function asApplied(d: unknown): AppliedPayload | null {
  if (!isObj(d) || d.applied !== true || typeof d.character !== 'string' || !Number.isInteger(d.version)) return null
  if (!Array.isArray(d.diff) || !d.diff.every((x: unknown) => isObj(x) && typeof x.path === 'string' && x.path.startsWith('/'))) return null
  return { character: d.character, name: typeof d.name === 'string' ? d.name : undefined, version: d.version, diff: d.diff }
}

export function entryFromGet(g: GetPayload, server: string, now: number): Entry {
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
    last: null,
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
  /^\/inventory(\/|$)/,
  /^\/currency(\/|$)/,
  /^\/conditions(\/|$)/,
  /^\/exhaustion$/,
  /^\/house_rules(\/|$)/,
  /^\/notes$/,
  /^\/details(\/|$)/,
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
  const { sheet } = applyDiff(entry.sheet, w.diff)
  return {
    ...entry,
    sheet,
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
  const parts = c.diff.slice(0, 3).map((d) => pathLabel(d.path, sheet) + ' ' + v(d.from) + ' → ' + v(d.to))
  if (c.diff.length > 3) parts.push('+' + (c.diff.length - 3) + ' more')
  return parts.join(', ') + (c.reason ? ' · ' + c.reason : '')
}
