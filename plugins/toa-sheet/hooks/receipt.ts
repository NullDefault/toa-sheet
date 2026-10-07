// A connector call's row in the transcript, as one line of words: a verb
// readout (`WRITE`, `CHECK`, `SPELL`) and the answer, the citation inline as
// the server gave it. The verb and shape come from the output, never the
// input, so a mismatched answer passes; words may come from the input (a
// preview's reason, a create's action). Anything the shapes below do not
// match is `null`: the row stays Claude Code's own.
// Vault receipts describe the request; LOGGED/CLOSED alone are confirmed by
// the answer. The engine's result block is their detail. Interrupted rows pass.
//
// Pure and synchronous: every pane invalidate redraws every connector row
// (`$.ui.invalidate('ui.render')` is plugin-wide). No mods API here.

import { asApplied, asCheck, asGet, describeChange, payloadOf, textOf, type DiffItem, type Finding } from './sheet.ts'

/** The rules connector's tools that draw a receipt; each has a fixture in tests/fixtures/bati. */
export const CONNECTOR =
  /^mcp__.+__(sheet_read|sheet_write|level_up|spell_get|monster_get|character_option_get|condition_search|variantrule_search|book_content_get)$/

/** The vault's tools whose rows draw a receipt during play; `receipt()` draws the Table kinds and the reads. */
export const VAULT = /^mcp__vault__(vault_query|canon_query|draft_write)$/

export interface Receipt {
  verb: string
  body: string
  state: 'running' | 'done' | 'error'
  /** Lines the row cannot hold (findings in words), drawn over the result block in ctrl+o. */
  detail: string[]
}

/** A `ToolUse` row's props, or a `ToolResult`'s with `isRunning: false` and no input. */
export interface Row {
  tool: string
  input?: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted?: boolean
  output?: unknown
}

type Sheets = (id: string) => Record<string, any> | undefined

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const KIND: Record<string, string> = {
  class: 'CLASS',
  subclass: 'SUBCLASS',
  feat: 'FEAT',
  species: 'SPECIES',
  background: 'BACKGROUND',
  item: 'ITEM',
  optional_feature: 'FEATURE',
  class_spells: 'SPELLS',
}

const FIXED: Record<string, string> = {
  level_up: 'LEVEL UP',
  spell_get: 'SPELL',
  monster_get: 'MONSTER',
  condition_search: 'CONDITION',
  variantrule_search: 'RULE',
  book_content_get: 'BOOK',
}

const READS: Record<string, string> = { get: 'READ', list: 'LIST', history: 'HISTORY', check: 'CHECK', schema: 'SCHEMA' }

const suffix = (tool: string) => tool.match(CONNECTOR)?.[1] ?? tool
const request = (input: unknown): Record<string, any> => (isObj(input) && isObj(input.request) ? input.request : {})
const kindVerb = (input: unknown) => (isObj(input) && KIND[input.kind]) || 'OPTION'

/** The verb a call draws while it runs, from its input alone. */
export function runningVerb(tool: string, input: unknown): string {
  const t = suffix(tool)
  const action = request(input).action
  if (t === 'sheet_read') return READS[action] ?? 'READ'
  if (t === 'sheet_write') return isObj(input) && input.apply === true ? (action === 'create' ? 'CREATE' : 'WRITE') : 'PREVIEW'
  if (t === 'character_option_get') return kindVerb(input)
  return FIXED[t] ?? t.toUpperCase()
}

/** ` · PHB p.186`: the source, and the page unless its evidence is absent; `''` without a source. */
export function cite(c: unknown): string {
  if (!isObj(c) || typeof c.source !== 'string') return ''
  return ` · ${c.source}` + (typeof c.page === 'number' && c.page_evidence !== 'absent' ? ` p.${c.page}` : '')
}

/** `PHB p.186 · Resting > Long Rest`: a citation on its own line, with its section. */
export function citeLine(c: unknown): string {
  const head = cite(c).slice(3)
  return head && isObj(c) && typeof c.section === 'string' ? `${head} · ${c.section}` : head
}

/** Findings in words, warnings first: `⚠ message · PHB p.174 · section`, `· message` for the rest. */
export function findingLines(findings: Finding[]): string[] {
  const line = (f: Finding, mark: string) => {
    const c = citeLine(f.citation)
    return `${mark} ${f.message}` + (c ? ` · ${c}` : '')
  }
  const warn = findings.filter((f) => f.severity === 'warning')
  return [...warn.map((f) => line(f, '⚠')), ...findings.filter((f) => f.severity !== 'warning').map((f) => line(f, '·'))]
}

const done = (verb: string, body: string, detail: string[] = []): Receipt => ({ verb, body, state: 'done', detail })

function firstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?\.(?=\s|$)/)
  return (m ? m[0] : text).slice(0, 200)
}

const validDiff = (v: unknown): v is DiffItem[] => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.path === 'string')

/** The change in words plus the first diff item's rule: `HP 12 → 15 · long rest · PHB p.186`. */
function change(character: string, reason: unknown, diff: DiffItem[], sheetOf: Sheets): string {
  const body = describeChange({ version: 0, at: 0, reason: str(reason) ?? '', diff }, sheetOf(character) ?? {})
  return body + cite(diff[0]?.rule)
}

function sheetRead(d: unknown, sheetOf: Sheets): Receipt | null {
  const got = asGet(d)
  if (got) return done('READ', got.sheet.name)
  const check = asCheck(d)
  if (check) {
    const name = sheetOf(check.character.id)?.name ?? check.character.id
    const w = check.findings.filter((f) => f.severity === 'warning').length
    const i = check.findings.length - w
    const counts = check.findings.length ? `${plural(w, 'warning', 'warnings')} · ${plural(i, 'note', 'notes')}` : 'clean'
    return done('CHECK', `${name} · ${counts}`, findingLines(check.findings))
  }
  if (Array.isArray(d) && d.every((x) => isObj(x) && typeof x.id === 'string' && typeof x.name === 'string'))
    return done('LIST', d.length ? d.map((x) => x.name).join(', ') : 'no sheets')
  if (isObj(d) && isObj(d.character) && typeof d.character.id === 'string' && Array.isArray(d.versions)) {
    const name = sheetOf(d.character.id)?.name ?? d.character.id
    return done('HISTORY', `${name} · ${plural(d.versions.length, 'version', 'versions')}`)
  }
  if (isObj(d) && isObj(d.schema) && (d.schema.$schema || d.schema.properties)) return done('SCHEMA', 'sheet')
  return null
}

function sheetWrite(d: unknown, input: unknown, sheetOf: Sheets): Receipt | null {
  const req = request(input)
  const w = asApplied(d)
  if (w) {
    const allAdds = w.diff.every((x) => !('from' in x))
    if ((allAdds && !sheetOf(w.character)) || req.action === 'create') {
      const parts = [w.name ?? w.character, str(req.reason), plural(w.diff.length, 'field', 'fields')]
      return done('CREATE', parts.filter((p) => p !== undefined).join(' · '))
    }
    const rules = [...new Set(w.diff.map((x) => citeLine(x.rule)).filter((l) => l))]
    return done('WRITE', change(w.character, req.reason, w.diff, sheetOf), rules.length > 1 ? rules : [])
  }
  if (isObj(d) && d.preview === true && typeof d.character === 'string' && validDiff(d.diff)) {
    const findings: Finding[] = Array.isArray(d.findings) ? d.findings.filter((f: unknown) => isObj(f) && typeof f.message === 'string') : []
    const warnings = findings.filter((f) => f.severity === 'warning')
    const body = change(d.character, req.reason, d.diff, sheetOf)
    return done('PREVIEW', body + (warnings.length ? ' · ' + plural(warnings.length, 'warning', 'warnings') : ''), findingLines(warnings))
  }
  return null
}

function lookup(t: string, d: unknown, input: unknown): Receipt | null {
  if (!isObj(d)) return null
  if (t === 'level_up') {
    const l = d.level
    if (!isObj(l) || typeof l.class !== 'string' || typeof l.from !== 'number' || typeof l.to !== 'number') return null
    const names = Array.isArray(d.features) ? d.features.map((f: any) => str(f?.name)).filter((n: unknown) => n) : []
    return done(FIXED[t]!, `${l.class} ${l.from} → ${l.to}` + (names.length ? ' · ' + names.join(', ') : '') + cite(d.citation))
  }
  if (t === 'condition_search' || t === 'variantrule_search') {
    const results = Array.isArray(d.results) ? d.results.filter((r: unknown) => isObj(r) && typeof r.name === 'string') : []
    if (!results.length) return null
    if (results.length === 1) return done(FIXED[t]!, results[0].name + cite(results[0].citation))
    return done(FIXED[t]!, results.slice(0, 3).map((r: any) => r.name).join(', ') + ` · ${results.length} results`)
  }
  if (t === 'book_content_get') {
    const c = d.citation
    if (!isObj(c) || typeof c.source !== 'string') return null
    if (typeof c.section === 'string') return done('BOOK', c.section + cite(c))
    return Array.isArray(d.sections) ? done('BOOK', `${c.source} · ${plural(d.sections.length, 'section', 'sections')}`) : null
  }
  if (!isObj(d.citation) || typeof d.citation.name !== 'string') return null
  if (t === 'character_option_get') return done(kindVerb(input), d.citation.name + cite(d.citation))
  if (t === 'spell_get' || t === 'monster_get') return done(FIXED[t]!, d.citation.name + cite(d.citation))
  return null
}

/** Vault reads say what was asked; only a confirmed Table write says LOGGED/CLOSED. */
function vaultReceipt(t: string, row: Row): Receipt | null {
  const input = isObj(row.input) ? row.input : {}
  const req = request(row.input)
  const write = t === 'draft_write'
  const note = input.kind === 'table-note'
  let verb: string
  let body: string
  if (write) {
    if (!note && input.kind !== 'table-close') return null
    if (typeof input.text !== 'string' || typeof input.session !== 'string') return null
    verb = note ? 'LOGGED' : 'CLOSED'
    body = note ? input.text : `${input.session} · ${input.text}`
  } else if (t === 'vault_query') {
    if (typeof req.action !== 'string') return null
    verb = 'VAULT'
    const arg = [req.id, req.name, req.npc, req.query, req.text, req.since, req.session].find((v) => typeof v === 'string')
    body = req.action + (arg === undefined ? '' : ` ${arg}`)
  } else {
    verb = 'CANON'
    if (req.action === 'search' && typeof req.query === 'string')
      body = `search "${req.query}"` + (typeof req.book === 'string' ? ` · ${req.book}` : '')
    else if (req.action === 'page' && typeof req.book === 'string' && typeof req.printed_page === 'number')
      body = `${req.book} p.${req.printed_page}`
    else return null
  }
  if (row.isRunning && row.output === undefined)
    return { verb: write ? (note ? 'LOG' : 'CLOSE') : verb, body: (write ? input.text : body) + ' …', state: 'running', detail: [] }
  if (row.isErrored) {
    const text = textOf(row.output)
    return text ? { verb: write ? 'REFUSED' : 'ERROR', body: firstSentence(text), state: 'error', detail: [] } : null
  }
  const p = payloadOf(row.output)
  if (!p || !('data' in p)) return null
  if (write && (!isObj(p.data) || p.data.wrote !== true)) return null
  if (t === 'canon_query' && req.action === 'search' && isObj(p.data) && p.data.total === 0) body += ' · NO HIT'
  return done(verb, body)
}

/** The receipt for a connector row, or null when the row should stay Claude Code's. */
export function receipt(row: Row, sheetOf: Sheets): Receipt | null {
  const v = row.tool.match(VAULT)
  if (v && !row.isInterrupted) return vaultReceipt(v[1]!, row)
  const m = row.tool.match(CONNECTOR)
  if (!m || row.isInterrupted) return null
  const t = m[1]!
  const sheetTool = t === 'sheet_read' || t === 'sheet_write'
  if (row.isRunning && row.output === undefined) {
    const req = request(row.input)
    const i = isObj(row.input) ? row.input : {}
    const words = [req.reason, req.action, i.name, i.query, i.section, i.source, i.class].find((w) => typeof w === 'string') ?? t
    return { verb: runningVerb(row.tool, row.input), body: words + ' …', state: 'running', detail: [] }
  }
  if (row.isErrored) {
    const text = textOf(row.output)
    if (!text) return null
    const body = firstSentence(text)
    return { verb: sheetTool ? 'REFUSED' : 'ERROR', body, state: 'error', detail: text.length > body.length ? [text] : [] }
  }
  const p = payloadOf(row.output)
  if (!p || !('data' in p)) return null
  if (t === 'sheet_read') return sheetRead(p.data, sheetOf)
  if (t === 'sheet_write') return sheetWrite(p.data, row.input, sheetOf)
  return lookup(t, p.data, row.input)
}
