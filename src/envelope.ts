// IAP envelope parsing — PORTED byte-for-byte from telegram-runtime/src/cli.ts
// (parseIapEnvelope / extractIapEnvelopes + their attr/CDATA helpers). The
// notifier's router role reads its own pane (pty) stdin and slices the raw
// byte stream on <iap>…</iap> markers EXACTLY as telegram-runtime does — the
// envelope wire format is shared across runtimes (`iap send` writes the same
// XML), and that parser is validated in production. Porting verbatim (rather
// than re-deriving) is the whole point: same CDATA handling, same attribute
// extraction, same missing→throw behavior. (The old tmux-paste \r-fold was
// retired with the fleet-wide pty-only migration — see parseIapEnvelope.)

// Intelligence is part of the IAP identity contract (human/artificial/scripted).
// Mirrored here so the envelope can carry from-intelligence without importing
// telegram-runtime types.
export type Intelligence = 'human' | 'artificial' | 'scripted'

function isIntelligence(value: unknown): value is Intelligence {
  return value === 'human' || value === 'artificial' || value === 'scripted'
}

export interface IapEnvelope {
  fromPersonality: string
  fromRuntime: string
  fromIntelligence?: Intelligence
  topic?: string
  attachments: string[]
  message: string
}

// Thrown on a malformed envelope (missing <iap …> open tag, missing required
// from-personality/from-runtime attributes, or missing <message>). Matches the
// telegram-runtime contract: a bad envelope is a hard parse error, never a
// silently-empty result.
export class EnvelopeError extends Error {}

function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`)
  const m = re.exec(attrs)
  return m ? unescapeAttr(m[1]) : undefined
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function decodeCdata(inner: string): string {
  if (!inner.startsWith('<![CDATA[') || !inner.endsWith(']]>')) return inner
  return inner.slice('<![CDATA['.length, -']]>'.length).replaceAll(']]]]><![CDATA[>', ']]>')
}

function tagContent(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  const m = re.exec(xml)
  return m ? decodeCdata(m[1]) : undefined
}

export function parseIapEnvelope(xml: string): IapEnvelope {
  // No line-ending normalization. Production delivery onto the pane is the pty
  // supervisor (iapeer ≥0.4.9, pty-only), which bracketed-pastes the envelope —
  // the body's LF newlines arrive verbatim and the bare \r submit keystroke lands
  // AFTER the </iap> close tag (outside the sliced envelope). The old tmux-paste
  // path that rewrote every LF→CR (and required folding bare CRs back to \n) has
  // been physically removed fleet-wide, so there is no bare-CR source left to
  // defend against. The attachments split below still tolerates an optional CR
  // before \n (a Windows-formatted attachment list) — independent of the retired
  // tmux fold.
  const open = /^<iap\s+([^>]*)>/.exec(xml.trim())
  if (!open) throw new EnvelopeError('invalid IAP envelope: missing <iap ...>')
  const fromPersonality = attrValue(open[1], 'from-personality')
  const fromRuntime = attrValue(open[1], 'from-runtime')
  if (!fromPersonality || !fromRuntime) {
    throw new EnvelopeError('invalid IAP envelope: missing from-personality/from-runtime')
  }
  const fromIntelligenceRaw = attrValue(open[1], 'from-intelligence')
  const fromIntelligence = isIntelligence(fromIntelligenceRaw) ? fromIntelligenceRaw : undefined
  const message = tagContent(xml, 'message')
  if (message === undefined) throw new EnvelopeError('invalid IAP envelope: missing message')
  const attachmentsRaw = tagContent(xml, 'attachments')
  return {
    fromPersonality,
    fromRuntime,
    ...(fromIntelligence ? { fromIntelligence } : {}),
    topic: attrValue(open[1], 'topic'),
    attachments: attachmentsRaw
      ? attachmentsRaw.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      : [],
    message,
  }
}

export function extractIapEnvelopes(buffer: string): { envelopes: string[]; rest: string } {
  const envelopes: string[] = []
  let rest = buffer
  while (true) {
    const start = rest.indexOf('<iap ')
    if (start < 0) {
      return { envelopes, rest: rest.slice(Math.max(0, rest.length - 8)) }
    }
    if (start > 0) rest = rest.slice(start)
    const end = rest.indexOf('</iap>')
    if (end < 0) return { envelopes, rest }
    const envelopeEnd = end + '</iap>'.length
    envelopes.push(rest.slice(0, envelopeEnd))
    rest = rest.slice(envelopeEnd)
  }
}
