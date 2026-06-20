import { CRON_SEARCH_CAP_YEARS } from './constants.ts'

// ── Schedule expressions: cron (5-field) and interval (@every <dur>) ────────
//
// Zero dependencies by design: a self-contained Vixie-cron
// parser plus a duration parser. cron resolves against LOCAL system time at
// minute granularity. interval is anchored and skip-to-next (missed fires
// during downtime are NOT caught up — the next future slot is taken).

export interface CronWhen {
  kind: 'cron'
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  // A field is "restricted" when it is not `*`. The day-of-month / day-of-week
  // match rule branches on these (standard Vixie OR-semantics — see matchesDay).
  domRestricted: boolean
  dowRestricted: boolean
}

export interface IntervalWhen {
  kind: 'interval'
  ms: number
}

export type ParsedWhen = CronWhen | IntervalWhen

interface FieldSpec {
  min: number
  max: number
  name: string
}

const MINUTE: FieldSpec = { min: 0, max: 59, name: 'minute' }
const HOUR: FieldSpec = { min: 0, max: 23, name: 'hour' }
const DOM: FieldSpec = { min: 1, max: 31, name: 'day-of-month' }
const MONTH: FieldSpec = { min: 1, max: 12, name: 'month' }
// dow accepts 0-7; 7 is folded to 0 (both = Sunday) before set construction.
const DOW: FieldSpec = { min: 0, max: 7, name: 'day-of-week' }

function parseIntStrict(token: string, field: string): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(`invalid ${field} value "${token}": expected an integer`)
  }
  return Number(token)
}

// Parse one cron field into the explicit set of matching numbers. Accepts a
// comma list of items; each item is `*`, `*/n`, `a`, `a-b`, or `a-b/n`. Bounds
// are validated against the field's [min,max]; anything else throws.
function parseField(raw: string, spec: FieldSpec): { set: Set<number>; restricted: boolean } {
  const restricted = raw !== '*'
  const set = new Set<number>()
  for (const item of raw.split(',')) {
    if (item.length === 0) {
      throw new Error(`invalid ${spec.name} field "${raw}": empty list item`)
    }
    parseItem(item, spec, set)
  }
  if (set.size === 0) {
    throw new Error(`invalid ${spec.name} field "${raw}": matched nothing`)
  }
  return { set, restricted }
}

function parseItem(item: string, spec: FieldSpec, set: Set<number>): void {
  // Split off an optional step (`/n`).
  const slash = item.indexOf('/')
  let rangePart = item
  let step = 1
  if (slash >= 0) {
    rangePart = item.slice(0, slash)
    const stepToken = item.slice(slash + 1)
    step = parseIntStrict(stepToken, `${spec.name} step`)
    if (step <= 0) {
      throw new Error(`invalid ${spec.name} step "${stepToken}": must be >= 1`)
    }
  }

  let lo: number
  let hi: number
  if (rangePart === '*') {
    // `*` or `*/n` spans the whole field range.
    lo = spec.min
    hi = spec.max
  } else {
    const dash = rangePart.indexOf('-')
    if (dash >= 0) {
      lo = parseIntStrict(rangePart.slice(0, dash), spec.name)
      hi = parseIntStrict(rangePart.slice(dash + 1), spec.name)
    } else {
      lo = parseIntStrict(rangePart, spec.name)
      hi = lo
      // A bare number with a step (`5/15`) means "from 5 to field-max step n",
      // matching Vixie cron. Without a step it is a single value.
      if (slash >= 0) hi = spec.max
    }
  }

  validateBound(lo, spec)
  validateBound(hi, spec)
  if (lo > hi) {
    throw new Error(`invalid ${spec.name} range "${rangePart}": start ${lo} > end ${hi}`)
  }
  for (let v = lo; v <= hi; v += step) {
    set.add(foldValue(v, spec))
  }
}

function validateBound(v: number, spec: FieldSpec): void {
  if (v < spec.min || v > spec.max) {
    throw new Error(`invalid ${spec.name} value ${v}: out of range [${spec.min},${spec.max}]`)
  }
}

// dow 7 → 0 (both = Sunday). Applied after bound validation so 7 is accepted.
function foldValue(v: number, spec: FieldSpec): number {
  if (spec === DOW && v === 7) return 0
  return v
}

function parseCron(when: string): CronWhen {
  const fields = when.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`invalid cron "${when}": expected 5 whitespace-separated fields, got ${fields.length}`)
  }
  const minute = parseField(fields[0], MINUTE)
  const hour = parseField(fields[1], HOUR)
  const dom = parseField(fields[2], DOM)
  const month = parseField(fields[3], MONTH)
  const dow = parseField(fields[4], DOW)
  return {
    kind: 'cron',
    minute: minute.set,
    hour: hour.set,
    dom: dom.set,
    month: month.set,
    dow: dow.set,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  }
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

// `@every <dur>` where dur is a run of <num><unit> chunks, unit ∈ {s,m,h,d}.
// Composite forms (`1h30m`, `90s`, `2d`) sum. Zero / negative / unknown-unit /
// empty all throw; the minimum is 1s.
function parseInterval(when: string): IntervalWhen {
  const raw = when.trim()
  const body = raw.slice('@every'.length).trim()
  if (body.length === 0) {
    throw new Error(`invalid interval "${when}": missing duration after @every`)
  }
  // Full-string match guarantees no stray characters between/around chunks.
  const chunkRe = /(\d+)([smhd])/g
  let total = 0
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = chunkRe.exec(body)) !== null) {
    if (match.index !== consumed) {
      throw new Error(`invalid interval "${when}": unexpected token near "${body.slice(consumed)}"`)
    }
    const value = Number(match[1])
    total += value * UNIT_MS[match[2]]
    consumed = chunkRe.lastIndex
  }
  if (consumed !== body.length) {
    throw new Error(`invalid interval "${when}": unexpected token near "${body.slice(consumed)}"`)
  }
  if (total <= 0) {
    throw new Error(`invalid interval "${when}": duration must be positive`)
  }
  if (total < UNIT_MS.s) {
    throw new Error(`invalid interval "${when}": minimum duration is 1s`)
  }
  return { kind: 'interval', ms: total }
}

export function parseWhen(when: string): ParsedWhen {
  if (typeof when !== 'string' || when.trim().length === 0) {
    throw new Error('invalid when: empty expression')
  }
  const trimmed = when.trim()
  if (trimmed.startsWith('@every')) return parseInterval(trimmed)
  if (trimmed.startsWith('@')) {
    throw new Error(`invalid when "${when}": unknown macro (only @every is supported)`)
  }
  return parseCron(trimmed)
}

// Standard Vixie day matching: when BOTH dom and dow are restricted the day
// matches if EITHER does (OR-semantics — `0 0 13 * 5` = the 13th OR any Friday).
// When only one is restricted, only that one constrains the day. When neither
// is restricted (`* *`) every day matches.
function matchesDay(parsed: CronWhen, d: Date): boolean {
  const domOk = parsed.dom.has(d.getDate())
  const dowOk = parsed.dow.has(d.getDay())
  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk
  if (parsed.domRestricted) return domOk
  if (parsed.dowRestricted) return dowOk
  return true
}

function cronNextFire(parsed: CronWhen, after: Date): Date {
  // Start strictly after `after`: round up to the next whole minute (seconds /
  // ms zeroed) so the candidate is always > after at minute granularity.
  const cursor = new Date(after.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  // Local-time fields. getMonth() is 0-based → +1 to compare against the
  // 1-based month set.
  const capMs = after.getTime() + CRON_SEARCH_CAP_YEARS * 366 * 86_400_000
  while (cursor.getTime() <= capMs) {
    if (
      parsed.month.has(cursor.getMonth() + 1) &&
      matchesDay(parsed, cursor) &&
      parsed.hour.has(cursor.getHours()) &&
      parsed.minute.has(cursor.getMinutes())
    ) {
      return cursor
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw new Error('cron expression has no fire time within the search horizon (impossible expression?)')
}

function intervalNextFire(parsed: IntervalWhen, after: Date, anchor: Date): Date {
  // Skip-to-next: the next slot strictly after `after`, computed off the anchor
  // grid. floor((after-anchor)/ms)+1 jumps directly to the next future slot, so
  // a long downtime collapses to a single upcoming fire (no catch-up).
  const a = anchor.getTime()
  const t = after.getTime()
  if (t < a) return new Date(a + parsed.ms)
  const elapsed = t - a
  const nextIndex = Math.floor(elapsed / parsed.ms) + 1
  return new Date(a + nextIndex * parsed.ms)
}

// Strictly-after next fire. For interval, `anchor` (run start / last fire) is
// required and defaults to `after` when omitted (treats `after` as the grid
// origin → first fire at after+ms).
export function nextFire(parsed: ParsedWhen, after: Date, anchor?: Date): Date {
  if (parsed.kind === 'cron') return cronNextFire(parsed, after)
  return intervalNextFire(parsed, after, anchor ?? after)
}
