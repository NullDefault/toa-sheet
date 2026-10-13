// Tonight's group for the party view: who is at the table for one session, and
// which cached sheets they are. Read from the vault (register.ts does the
// reading): the session note's `present:` (Sessions/Sxx.md), else the prep doc
// whose `sessions:` lists Sxx, its `party:`, else the names typed after
// `/party Sxx`, else nobody, which shows every sheet as before.
// No mods API here (validation forbids passing `$` to an imported function).

import type { Entry } from './sheet.ts'

/** Where the group came from: `note` and `prep` name the file in `from`. */
export type Source = 'note' | 'prep' | 'args'

export interface Roster {
  source: Source
  /** The file the names came from (`Sessions/S05.md`), or null for typed names. */
  from: string | null
  /** The names as written: `Billy (Bati)`, `Diego Valmorra`, `nux`. */
  names: string[]
  /** Why the roster is not the whole story (prep docs that disagree), or null. */
  warning: string | null
}

/** A PC's note in the vault (Lore/Party/<name>.md): its name and `aliases:`. */
export interface PcNote {
  name: string
  aliases: string[]
}

export interface Group {
  /** The sheets the group names, by id. */
  ids: Set<string>
  /** The names no sheet answers to, or more than one does, each with why. */
  unmatched: string[]
}

/** The frontmatter's `key: value` lines, comments cut. A `[a, b]` value is a list; any other value is its text. */
export function frontmatter(md: string): Record<string, string | string[]> {
  const lines = md.replace(/^﻿/, '').split(/\r?\n/)
  const out: Record<string, string | string[]> = {}
  if (lines[0]?.trim() !== '---') return out
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return out
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line)
    if (!m) continue
    const raw = m[2]!.replace(/\s+#.*$/, '').trim()
    const bare = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
    out[m[1]!] = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).split(',').map(bare).filter(Boolean) : bare(raw)
  }
  return {} // no closing `---`: not frontmatter
}

/** A frontmatter value as a list: a list as is, a text split at commas, absent as empty. */
export const listOf = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v : v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []

/** A `present:` item that says the PC was not there (`Almuth (Cubbas), absent`): not tonight's group. */
const ABSENT = /\b(not present|absent)\b/i

/** The session note's `present:` names, the absent ones left out; empty when the note lists nobody. */
export const presentOf = (md: string) => listOf(frontmatter(md).present).filter((n) => !ABSENT.test(n))

/** A prep doc's `party:` when its `sessions:` lists `session`; else null. */
export function prepParty(md: string, session: string): string[] | null {
  const fm = frontmatter(md)
  if (!listOf(fm.sessions).some((s) => s.toUpperCase() === session)) return null
  const party = listOf(fm.party)
  return party.length ? party : null
}

/**
 * The roster, in the order the sources are tried: the note's `present:`, the
 * prep docs' `party:` (the first by path; a second that names others is a
 * warning, never merged), the typed names. Null when none names anyone.
 */
export function pickRoster(note: { path: string; md: string } | null, preps: { path: string; md: string }[], typed: string[], session: string): Roster | null {
  const present = note ? presentOf(note.md) : []
  if (note && present.length) return { source: 'note', from: note.path, names: present, warning: null }
  const found = [...preps]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((p) => ({ path: p.path, party: prepParty(p.md, session) }))
    .filter((p): p is { path: string; party: string[] } => p.party !== null)
  const first = found[0]
  if (first) {
    const key = (ns: string[]) => ns.map(fold).sort().join('|')
    const other = found.find((p) => key(p.party) !== key(first.party))
    return { source: 'prep', from: first.path, names: first.party, warning: other ? `${other.path} names others` : null }
  }
  if (typed.length) return { source: 'args', from: null, names: typed, warning: null }
  return null
}

/** Lower case, accents off, anything but letters and digits a space, single-spaced. */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const firstWord = (s: string) => fold(s).split(' ')[0] ?? ''

/**
 * What a sheet answers to, folded: its id, its name, its first name, and, when
 * a PC note is that sheet (the same name or first name), the note's name and
 * its aliases.
 */
export function keysOf(e: Entry, notes: PcNote[]): Set<string> {
  const keys = new Set([fold(e.id), fold(e.name), firstWord(e.name)])
  for (const n of notes) {
    if (fold(n.name) === fold(e.name) || firstWord(n.name) === firstWord(e.name)) {
      keys.add(fold(n.name))
      for (const a of n.aliases) keys.add(fold(a))
    }
  }
  keys.delete('')
  return keys
}

/**
 * The sheets the roster names. A name is matched as whole words: `Billy (Bati)`
 * is Bati, and only the part in brackets is read when there is one (the
 * player's name stays out of it). A name no sheet answers to, or two do, is
 * unmatched, never guessed.
 */
export function matchGroup(entries: Entry[], names: string[], notes: PcNote[]): Group {
  const keyed = entries.map((e) => ({ e, keys: keysOf(e, notes) }))
  const ids = new Set<string>()
  const unmatched: string[] = []
  for (const name of names) {
    const inner = /\(([^)]+)\)/.exec(name)?.[1]
    const words = ` ${fold(inner ?? name)} `
    const hits = keyed.filter(({ keys }) => [...keys].some((k) => words.includes(` ${k} `)))
    if (hits.length === 1) ids.add(hits[0]!.e.id)
    else unmatched.push(hits.length ? `${name} (${hits.map((h) => h.e.name).join(' or ')}?)` : name)
  }
  return { ids, unmatched }
}

/** The rows the party view draws: the group's, or all of them when `all` or there is no roster. */
export const shownRows = (rows: Entry[], group: Group | null, all: boolean) => (group && !all ? rows.filter((e) => group.ids.has(e.id)) : rows)
