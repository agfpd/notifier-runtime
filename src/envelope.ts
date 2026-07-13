// IAP envelope parsing — PORTED from the iapeer core codec (src/codec/index.ts,
// 0.4.86+), the canon for the shared envelope wire format. The notifier's router
// role reads its own pane (pty) stdin and slices the raw byte stream on
// <iap>…</iap> markers exactly as the core's extractEnvelopes does. Porting the
// core functions near-verbatim (rather than re-deriving) is the whole point:
// same CDATA-aware scanning, same anchored attribute extraction, same
// missing→throw behavior, same false-start resync.
//
// This port superseded the older telegram-runtime copy of the parser, which
// carried three inherited bug classes fixed here (core В37/В38 lineage):
//   1. extractIapEnvelopes used a naive indexOf('</iap>') — an envelope whose
//      CDATA body QUOTES `</iap>` was silently truncated.
//   2. tagContent used a lazy regex — a quoted `</message>` truncated the body,
//      and a quoted `<attachments>…</attachments>` minted phantom attachments.
//   3. attrValue was unanchored — `runtime="` matched the TAIL of
//      `from-runtime="…"` (coincidentally right, structurally a mine).
// Plus В38 (a false `<iap ` start in prose must not swallow or park a real
// envelope) and read-both decode (compact names from/runtime/intelligence,
// <msg>, ts→sentAt) so a future wire flip to short names costs notifier nothing.

// Intelligence is part of the IAP identity contract — current vocabulary is
// natural / artificial / absent. Mirrored here so the envelope can carry
// from-intelligence without importing core types. Deliberate divergence from the
// core decoder: the core still normalizes legacy values (human→natural,
// scripted→absent) as READ-COMPAT for a live legacy peer; notifier dropped that
// in 0.3.4 (sanctioned: the foundation normalizes any legacy value at its
// boundary before an envelope reaches a runtime), so an unknown value is simply
// dropped to undefined here.
export type Intelligence = 'natural' | 'artificial' | 'absent'

function isIntelligence(value: unknown): value is Intelligence {
  return value === 'natural' || value === 'artificial' || value === 'absent'
}

export interface IapEnvelope {
  fromPersonality: string
  fromRuntime: string
  fromIntelligence?: Intelligence
  /** The sender's dispatch instant (`ts` attribute, envelope-compaction F) —
   *  full local ISO on the wire; absent on legacy envelopes. */
  sentAt?: string
  topic?: string
  attachments: string[]
  message: string
}

// Thrown on a malformed envelope (missing <iap …> open tag, missing required
// from/from-personality + runtime/from-runtime attributes, or missing
// <message>/<msg>). Matches the core contract: a bad envelope is a hard parse
// error, never a silently-empty result.
export class EnvelopeError extends Error {}

/** NAME-ANCHORED attribute lookup. The anchor `(^|\s)` is load-bearing: an
 *  unanchored regex makes `runtime="` match the TAIL of `from-runtime="…"` (and
 *  `intelligence="` the tail of `from-intelligence="…"`) — the read-both decode
 *  below would step on that mine (the short-name lookup must NOT be satisfied
 *  by a legacy long-name attribute). */
function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`)
  const m = re.exec(attrs)
  return m ? unescapeAttr(m[1]) : undefined
}

function unescapeAttr(value: string): string {
  // Reverse of the encoder's escapeAttr. Order matters: &amp; LAST so an
  // escaped "&amp;lt;" in the source does not get double-decoded.
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// ─────────────────────────────────────────────────────────────────────────────
// CDATA-aware low-level scan (core canon)
// ─────────────────────────────────────────────────────────────────────────────

const CDATA_OPEN = '<![CDATA['
const CDATA_CLOSE = ']]>'

/**
 * Scan from `start` and return the index of the first occurrence of `needle`
 * that lies OUTSIDE any CDATA section, or -1 if none (or if an unterminated
 * CDATA section is hit — meaning the buffer is incomplete and the caller should
 * wait for more input). CDATA sections are skipped wholesale: `]]>` inside them
 * is the section terminator, never a match for `needle`.
 */
function indexOfOutsideCdata(buffer: string, needle: string, start: number): number {
  let i = start
  while (i < buffer.length) {
    if (buffer.startsWith(CDATA_OPEN, i)) {
      const term = buffer.indexOf(CDATA_CLOSE, i + CDATA_OPEN.length)
      if (term < 0) return -1 // unterminated CDATA → incomplete buffer
      i = term + CDATA_CLOSE.length
      continue
    }
    if (buffer.startsWith(needle, i)) return i
    i++
  }
  return -1
}

/**
 * Extract and decode the content of `<tag>…</tag>`, treating the body as a
 * sequence of CDATA sections (and any stray raw text) and concatenating them.
 * Concatenating adjacent CDATA sections is exactly what reverses the
 * `]]>` → `]]]]><![CDATA[>` split the encoder performs, so this both
 * (a) ignores `</tag>` / `</iap>` that appear inside CDATA, and
 * (b) reconstructs a literal `]]>` in the original payload.
 * В37 — the OPEN tag is located CDATA-aware too: a message whose CDATA body
 * QUOTES `<attachments>…</attachments>` otherwise minted phantom attachments,
 * and a quoted `<message>` corrupted the decoded message.
 * Returns undefined when the open tag is absent or the close tag is never
 * reached outside CDATA.
 */
function readTagContent(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const openIdx = indexOfOutsideCdata(xml, open, 0)
  if (openIdx < 0) return undefined
  let i = openIdx + open.length
  let out = ''
  while (i < xml.length) {
    if (xml.startsWith(CDATA_OPEN, i)) {
      const term = xml.indexOf(CDATA_CLOSE, i + CDATA_OPEN.length)
      if (term < 0) {
        // Unterminated CDATA — malformed; treat the remainder as raw content.
        out += xml.slice(i + CDATA_OPEN.length)
        return out
      }
      out += xml.slice(i + CDATA_OPEN.length, term)
      i = term + CDATA_CLOSE.length
      continue
    }
    if (xml.startsWith(close, i)) return out
    out += xml[i]
    i++
  }
  return undefined // close tag never found
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoder
// ─────────────────────────────────────────────────────────────────────────────

/** READ-BOTH decoder: accepts the legacy wire names (`from-personality` /
 *  `from-runtime` / `from-intelligence`, `<message>`) AND the compact
 *  presentation names (`from` / `runtime` / `intelligence`, `<msg>`) — so any
 *  envelope form ever emitted on this host decodes, and a future wire flip to
 *  the short names costs nothing here. Short names win when both are present.
 *
 *  No line-ending normalization: production delivery onto the pane is the pty
 *  supervisor (iapeer ≥0.4.9, pty-only), which bracketed-pastes the envelope —
 *  the body's LF newlines arrive verbatim and the bare \r submit keystroke
 *  lands AFTER the </iap> close tag (outside the sliced envelope). */
export function parseIapEnvelope(xml: string): IapEnvelope {
  const open = /^<iap\s+([^>]*)>/.exec(xml.trim())
  if (!open) throw new EnvelopeError('invalid IAP envelope: missing <iap ...>')
  const fromPersonality = attrValue(open[1], 'from') ?? attrValue(open[1], 'from-personality')
  const fromRuntime = attrValue(open[1], 'runtime') ?? attrValue(open[1], 'from-runtime')
  if (!fromPersonality || !fromRuntime) {
    throw new EnvelopeError('invalid IAP envelope: missing from-personality/from-runtime')
  }
  const fromIntelligenceRaw =
    attrValue(open[1], 'intelligence') ?? attrValue(open[1], 'from-intelligence')
  const fromIntelligence = isIntelligence(fromIntelligenceRaw) ? fromIntelligenceRaw : undefined
  const message = readTagContent(xml, 'message') ?? readTagContent(xml, 'msg')
  if (message === undefined) throw new EnvelopeError('invalid IAP envelope: missing message')
  const attachmentsRaw = readTagContent(xml, 'attachments')
  const topic = attrValue(open[1], 'topic')
  const sentAt = attrValue(open[1], 'ts')
  return {
    fromPersonality,
    fromRuntime,
    ...(fromIntelligence ? { fromIntelligence } : {}),
    ...(sentAt ? { sentAt } : {}),
    ...(topic ? { topic } : {}),
    attachments: attachmentsRaw
      ? attachmentsRaw.split('\n').map(item => item.trim()).filter(Boolean)
      : [],
    message,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming extractor
// ─────────────────────────────────────────────────────────────────────────────

// В38 — a real envelope's open tag is bounded: personality/runtime ≤32 chars each,
// topic ≤200, intelligence one word, plus attr names and escaping. 1 KiB is far above
// any legitimate open tag; a longer '>'-less run after `<iap ` is prose, not a tag.
const MAX_OPEN_TAG_LEN = 1024

/** Classify the text at a `<iap ` occurrence: a complete VALID open tag (required attrs
 *  present), a complete-but-INVALID one / overlong tagless run (prose that merely contains
 *  the marker), or INCOMPLETE (no '>' yet within bounds — wait for the next chunk). */
function openTagVerdict(candidate: string): 'valid' | 'invalid' | 'incomplete' {
  const m = /^<iap\s+([^>]*)>/.exec(candidate)
  if (!m) {
    const unclosed = candidate.indexOf('>') < 0
    return unclosed && candidate.length <= MAX_OPEN_TAG_LEN ? 'incomplete' : 'invalid'
  }
  if (m[0].length > MAX_OPEN_TAG_LEN) return 'invalid'
  // Read-both: a real open tag carries the required pair under EITHER naming —
  // legacy wire (from-personality/from-runtime) or compact presentation
  // (from/runtime, name-anchored so a legacy tail never satisfies it).
  const hasPersonality = m[1].includes('from-personality="') || /(?:^|\s)from="/.test(m[1])
  const hasRuntime = m[1].includes('from-runtime="') || /(?:^|\s)runtime="/.test(m[1])
  return hasPersonality && hasRuntime ? 'valid' : 'invalid'
}

/**
 * Pull complete `<iap …>…</iap>` envelopes out of a streaming buffer.
 * The closing `</iap>` is located CDATA-aware, so an envelope whose message
 * body contains the literal text `</iap>` is not truncated. `rest` holds the
 * trailing bytes that do not yet form a complete envelope (incl. an envelope
 * still mid-CDATA), to be prepended to the next chunk.
 *
 * В38 — a FALSE start (prose that merely contains `<iap `, e.g. a quoted tool
 * description) is never committed to: the open tag is validated first, and a
 * candidate whose decode fails RESYNCS one char forward instead of being kept
 * (which used to either swallow the NEXT real envelope into a mis-attributed
 * blob, or park the buffer forever waiting for a close that never comes).
 */
export function extractIapEnvelopes(buffer: string): { envelopes: string[]; rest: string } {
  const envelopes: string[] = []
  let rest = buffer
  while (true) {
    const start = rest.indexOf('<iap ')
    if (start < 0) {
      // Keep a small tail in case `<iap ` is split across chunk boundaries.
      return { envelopes, rest: rest.slice(Math.max(0, rest.length - '<iap '.length)) }
    }
    if (start > 0) rest = rest.slice(start)
    const verdict = openTagVerdict(rest)
    if (verdict === 'incomplete') return { envelopes, rest } // open tag split across chunks → wait
    if (verdict === 'invalid') {
      rest = rest.slice(1) // false start: skip past this '<' and rescan for the next '<iap '
      continue
    }
    const close = indexOfOutsideCdata(rest, '</iap>', '<iap '.length)
    if (close < 0) return { envelopes, rest } // incomplete (or mid-CDATA) → wait
    const envelopeEnd = close + '</iap>'.length
    const candidate = rest.slice(0, envelopeEnd)
    try {
      parseIapEnvelope(candidate)
    } catch {
      // Structurally envelope-shaped but undecodable → a false start after all;
      // resync so a REAL envelope inside/behind the candidate is still found.
      rest = rest.slice(1)
      continue
    }
    envelopes.push(candidate)
    rest = rest.slice(envelopeEnd)
  }
}
