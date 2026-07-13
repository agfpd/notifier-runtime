import { describe, expect, test } from 'bun:test'
import { EnvelopeError, extractIapEnvelopes, parseIapEnvelope } from '../src/envelope.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Test-side wire encoder — mirrors the core codec's buildEnvelope (the single
// producer of the wire format), so adversarial bodies below are encoded exactly
// as `iap send` encodes them: escaped attrs + always-CDATA body with the
// `]]>` → `]]]]><![CDATA[>` split.
// ─────────────────────────────────────────────────────────────────────────────

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

function buildWire(opts: {
  fromPersonality?: string
  fromRuntime?: string
  fromIntelligence?: string
  sentAt?: string
  topic?: string
  attachments?: string[]
  message: string
}): string {
  const attrs = [
    `from-personality="${escapeAttr(opts.fromPersonality ?? 'boris')}"`,
    `from-runtime="${escapeAttr(opts.fromRuntime ?? 'claude')}"`,
    `from-intelligence="${escapeAttr(opts.fromIntelligence ?? 'artificial')}"`,
  ]
  if (opts.sentAt) attrs.push(`ts="${escapeAttr(opts.sentAt)}"`)
  if (opts.topic) attrs.push(`topic="${escapeAttr(opts.topic)}"`)
  return [
    `<iap ${attrs.join(' ')}>`,
    'IAP message from known peers. Reply via send_to_peer.',
    ...(opts.attachments?.length
      ? [`<attachments>${cdata(opts.attachments.join('\n'))}</attachments>`]
      : []),
    `<message>${cdata(opts.message)}</message>`,
    '</iap>',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// WITNESS: faithful copies of the OLD notifier parser (pre core-codec port) —
// naive indexOf extractor, lazy-regex tag content, unanchored attr lookup.
// Each adversarial test shows a real delta: the witness FAILS the assertion the
// new parser PASSES ("падает до фикса, проходит после").
// ─────────────────────────────────────────────────────────────────────────────

function oldDecodeCdata(inner: string): string {
  if (!inner.startsWith('<![CDATA[') || !inner.endsWith(']]>')) return inner
  return inner.slice('<![CDATA['.length, -']]>'.length).replaceAll(']]]]><![CDATA[>', ']]>')
}
function oldTagContent(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? oldDecodeCdata(m[1]) : undefined
}
function oldAttrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs)
  return m ? m[1] : undefined
}
function oldExtractIapEnvelopes(buffer: string): { envelopes: string[]; rest: string } {
  const envelopes: string[] = []
  let rest = buffer
  while (true) {
    const start = rest.indexOf('<iap ')
    if (start < 0) return { envelopes, rest: rest.slice(Math.max(0, rest.length - 8)) }
    if (start > 0) rest = rest.slice(start)
    const end = rest.indexOf('</iap>') // naive: not CDATA-aware
    if (end < 0) return { envelopes, rest }
    const envelopeEnd = end + '</iap>'.length
    envelopes.push(rest.slice(0, envelopeEnd))
    rest = rest.slice(envelopeEnd)
  }
}

describe('parseIapEnvelope', () => {
  test('golden: a REAL @agfpd/inter-agent-protocol envelope (verbatim from buildEnvelope)', () => {
    // This is byte-for-byte what `iap send` writes into a recipient pane: the
    // multi-line block joined with \n, an IAP_INSTRUCTION line between the open
    // tag and the body, and CDATA-wrapped attachments + message. Captured live
    // from buildEnvelope() in @agfpd/inter-agent-protocol/src/lib/preamble.ts
    // (the single producer of this wire format) so the golden cannot drift from
    // a hand-written approximation.
    const xml = [
      '<iap from-personality="boris" from-runtime="claude" from-intelligence="artificial" topic="register">',
      'IAP message from known peers. Reply via send_to_peer.',
      '<attachments><![CDATA[/tmp/a.png',
      '/tmp/b.txt]]></attachments>',
      '<message><![CDATA[{"id":"heartbeat","when":"@every 30m","message":"alive","target":"self"}]]></message>',
      '</iap>',
    ].join('\n')
    const env = parseIapEnvelope(xml)
    expect(env.fromPersonality).toBe('boris')
    expect(env.fromRuntime).toBe('claude')
    expect(env.fromIntelligence).toBe('artificial')
    expect(env.topic).toBe('register')
    expect(env.attachments).toEqual(['/tmp/a.png', '/tmp/b.txt'])
    expect(JSON.parse(env.message)).toEqual({
      id: 'heartbeat',
      when: '@every 30m',
      message: 'alive',
      target: 'self',
    })
  })

  test('plain (non-CDATA) message body is returned verbatim', () => {
    const xml = '<iap from-personality="arthur" from-runtime="telegram"><message>hello there</message></iap>'
    expect(parseIapEnvelope(xml).message).toBe('hello there')
  })

  test('multi-line LF message body parses verbatim (pty bracketed-paste contract)', () => {
    // Production is pty-only (iapeer ≥0.4.9): the supervisor bracketed-pastes the
    // envelope, so the body's LF newlines arrive verbatim. The parser does NO
    // line-ending normalization — the old tmux-paste LF→CR rewrite (and the
    // bare-CR fold that compensated for it) was removed fleet-wide, leaving no
    // bare-CR source. LF in → LF out, unchanged.
    const xml =
      '<iap from-personality="boris" from-runtime="claude">' +
      '<message><![CDATA[line1\nline2\nline3]]></message></iap>'
    expect(parseIapEnvelope(xml).message).toBe('line1\nline2\nline3')
  })

  test('attributes are HTML-unescaped (&quot; &lt; &gt; &amp;)', () => {
    const xml =
      '<iap from-personality="boris" from-runtime="claude" topic="a&amp;b&lt;c&gt;d&quot;e">' +
      '<message>x</message></iap>'
    expect(parseIapEnvelope(xml).topic).toBe('a&b<c>d"e')
  })

  test('attachments: newline-separated list, trimmed and blank-filtered', () => {
    const xml =
      '<iap from-personality="boris" from-runtime="claude">' +
      '<message>m</message>' +
      '<attachments>/tmp/a.png\n  /tmp/b.txt  \n\n</attachments></iap>'
    expect(parseIapEnvelope(xml).attachments).toEqual(['/tmp/a.png', '/tmp/b.txt'])
  })

  test('from-intelligence: current vocab (natural/artificial/absent) kept; legacy + unknown dropped', () => {
    const intel = (v: string) =>
      parseIapEnvelope(
        `<iap from-personality="boris" from-runtime="claude" from-intelligence="${v}"><message>m</message></iap>`,
      ).fromIntelligence
    // Current contract vocabulary is kept verbatim.
    expect(intel('natural')).toBe('natural')
    expect(intel('artificial')).toBe('artificial')
    expect(intel('absent')).toBe('absent')
    // Legacy values (human/scripted) are no longer accepted — the foundation
    // normalizes them upstream, so raw legacy never reaches the parser; an unknown
    // value is dropped to undefined.
    expect(intel('human')).toBeUndefined()
    expect(intel('scripted')).toBeUndefined()
    expect(intel('bogus')).toBeUndefined()
  })

  test('CDATA with an embedded ]]> (split-and-rejoin) round-trips', () => {
    // `iap` escapes a literal ]]> by splitting the CDATA; decodeCdata rejoins it.
    const xml =
      '<iap from-personality="boris" from-runtime="claude">' +
      '<message><![CDATA[before]]]]><![CDATA[>after]]></message></iap>'
    expect(parseIapEnvelope(xml).message).toBe('before]]>after')
  })

  test('missing <iap …> open tag → throws', () => {
    expect(() => parseIapEnvelope('<notiap><message>x</message></notiap>')).toThrow(EnvelopeError)
  })

  test('missing from-personality/from-runtime → throws', () => {
    expect(() => parseIapEnvelope('<iap topic="t"><message>x</message></iap>')).toThrow(
      /missing from-personality/,
    )
  })

  test('missing <message> → throws', () => {
    expect(() => parseIapEnvelope('<iap from-personality="b" from-runtime="claude"></iap>')).toThrow(
      /missing message/,
    )
  })
})

describe('extractIapEnvelopes', () => {
  test('extracts multiple complete envelopes and leaves a short tail in rest', () => {
    const a = '<iap from-personality="b" from-runtime="claude"><message>1</message></iap>'
    const c = '<iap from-personality="b" from-runtime="claude"><message>2</message></iap>'
    const { envelopes, rest } = extractIapEnvelopes(`noise${a}between${c}`)
    expect(envelopes.length).toBe(2)
    expect(parseIapEnvelope(envelopes[0]!).message).toBe('1')
    expect(parseIapEnvelope(envelopes[1]!).message).toBe('2')
    // No open marker after the last </iap> → only a short trailing window kept.
    expect(rest.length).toBeLessThanOrEqual(8)
  })

  test('a partial envelope (no </iap> yet) is held in rest, not emitted', () => {
    const partial = '<iap from-personality="b" from-runtime="claude"><message>incomp'
    const { envelopes, rest } = extractIapEnvelopes(partial)
    expect(envelopes).toEqual([])
    expect(rest).toContain('<iap ')
  })

  test('a partial completed by a later chunk is emitted on the join', () => {
    const head = '<iap from-personality="b" from-runtime="claude"><message>spl'
    const r1 = extractIapEnvelopes(head)
    expect(r1.envelopes).toEqual([])
    const r2 = extractIapEnvelopes(r1.rest + 'it</message></iap>')
    expect(r2.envelopes.length).toBe(1)
    expect(parseIapEnvelope(r2.envelopes[0]!).message).toBe('split')
  })

  test('no envelope marker at all → empty, rest is the trailing window', () => {
    const { envelopes, rest } = extractIapEnvelopes('just some plain text with no markers')
    expect(envelopes).toEqual([])
    expect(rest.length).toBeLessThanOrEqual(8)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: message contains </iap> → extractor must not truncate
// (a timer message / watcher script that quotes an envelope example is the
// realistic notifier-side trigger for this class)
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: </iap> in message', () => {
  const message = 'пример конверта: …</iap> — вот такой формат'

  test('NEW: single envelope, message intact', () => {
    const xml = buildWire({ message })
    const { envelopes, rest } = extractIapEnvelopes(xml)
    expect(envelopes).toHaveLength(1)
    expect(rest).toBe('')
    expect(parseIapEnvelope(envelopes[0]!).message).toBe(message)
  })

  test('WITNESS: old naive indexOf truncates the envelope', () => {
    const xml = buildWire({ message })
    const oldFirst = oldExtractIapEnvelopes(xml).envelopes[0]!
    expect(oldFirst.length).toBeLessThan(xml.length) // old splits at the inner </iap>
    expect(extractIapEnvelopes(xml).envelopes[0]).toBe(xml) // new keeps it whole
  })

  test('NEW: two real envelopes, first message holds a fake </iap>', () => {
    const e1 = buildWire({ message: 'fake </iap> inside' })
    const e2 = buildWire({ fromPersonality: 'darwin', message: 'second' })
    const { envelopes, rest } = extractIapEnvelopes(e1 + '\n' + e2)
    expect(envelopes).toHaveLength(2)
    expect(rest).toBe('')
    expect(parseIapEnvelope(envelopes[0]!).message).toBe('fake </iap> inside')
    expect(parseIapEnvelope(envelopes[1]!).message).toBe('second')
    // witness: old truncates the first envelope at the inner </iap>
    const oldFirst = oldExtractIapEnvelopes(e1 + '\n' + e2).envelopes[0]!
    expect(oldFirst).not.toBe(e1)
    expect(oldTagContent(oldFirst, 'message')).toBeUndefined()
  })

  test('streaming: mid-CDATA cut does not falsely close on the inner </iap>', () => {
    const xml = buildWire({ message: 'pre </iap> post' })
    const cut = xml.indexOf('</iap>') + 3 // right inside the QUOTED close tag
    const first = extractIapEnvelopes(xml.slice(0, cut))
    expect(first.envelopes).toHaveLength(0) // must NOT emit a truncated envelope
    const second = extractIapEnvelopes(first.rest + xml.slice(cut))
    expect(second.envelopes).toHaveLength(1)
    expect(parseIapEnvelope(second.envelopes[0]!).message).toBe('pre </iap> post')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: quoted </message> / <attachments> inside CDATA (В37 class)
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: quoted tags inside CDATA (В37)', () => {
  test('NEW: </message> inside the body does not truncate it', () => {
    const message = 'a </message> b </message> c'
    const xml = buildWire({ message })
    expect(parseIapEnvelope(xml).message).toBe(message)
    // WITNESS: old lazy regex truncates at the inner </message>
    expect(oldTagContent(xml, 'message')).not.toBe(message)
  })

  test('a message QUOTING <attachments>…</attachments> mints NO phantom attachment', () => {
    const quoted = 'смотри секцию <attachments>/home/user/.ssh/id_rsa</attachments> в конверте'
    const xml = buildWire({ message: quoted })
    const env = parseIapEnvelope(xml)
    expect(env.attachments).toEqual([]) // witness-класс: фантомный '/home/user/.ssh/id_rsa'
    expect(env.message).toBe(quoted)
  })

  test('an ATTACHMENT path quoting <message>fake</message> does not hijack the real message', () => {
    const xml = buildWire({
      attachments: ['/tmp/report<message>fake</message>.txt'],
      message: 'настоящее сообщение',
    })
    const env = parseIapEnvelope(xml)
    expect(env.message).toBe('настоящее сообщение') // old: 'fake' выигрывал indexOf-гонку
    expect(env.attachments).toEqual(['/tmp/report<message>fake</message>.txt'])
  })

  test('real attachments coexist with a message quoting the attachments tag', () => {
    const xml = buildWire({
      attachments: ['/tmp/real.pdf'],
      message: 'формат: <attachments>…</attachments>',
    })
    const env = parseIapEnvelope(xml)
    expect(env.attachments).toEqual(['/tmp/real.pdf'])
    expect(env.message).toBe('формат: <attachments>…</attachments>')
  })

  test('literal ]]> reconstructed at several places', () => {
    for (const message of ['a]]>b', 'edge ]]> at ]]> several ]]> places', ']]>']) {
      expect(parseIapEnvelope(buildWire({ message })).message).toBe(message)
    }
  })

  test('literal CR in the body survives (no fold in the parser)', () => {
    const message = 'line1\rline2\r\nline3'
    expect(parseIapEnvelope(buildWire({ message })).message).toBe(message)
  })

  test('combined: </iap> </message> ]]> CR + adversarial attachments round-trip', () => {
    const message = 'X </iap> Y </message> Z ]]> W\rtail\nend'
    const attachments = ['/path/with ]]> weird', '/second </iap> path']
    const xml = buildWire({ message, attachments })
    const { envelopes, rest } = extractIapEnvelopes(xml)
    expect(envelopes).toHaveLength(1)
    expect(rest).toBe('')
    const env = parseIapEnvelope(envelopes[0]!)
    expect(env.message).toBe(message)
    expect(env.attachments).toEqual(attachments)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: attr-order anchor (unanchored regex matched long-name tails)
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: name-anchored attr lookup', () => {
  test('ANCHOR: short-name lookup never satisfied by a legacy long-name tail', () => {
    // Unanchored `runtime="` would match the TAIL of from-runtime="claude" FIRST → wrong value.
    const xml =
      '<iap from-personality="x" from-runtime="claude" runtime="codex" from="y">\n<message><![CDATA[m]]></message>\n</iap>'
    const env = parseIapEnvelope(xml)
    expect(env.fromRuntime).toBe('codex') // short name wins via the ANCHORED lookup
    expect(env.fromPersonality).toBe('y')
    // WITNESS: the old unanchored `runtime="` lookup matches the TAIL of
    // from-runtime="claude" first and returns the wrong value. (`from="` is not
    // affected — the long names continue with a hyphen, never forming `from="`.)
    const open = /^<iap\s+([^>]*)>/.exec(xml)!
    expect(oldAttrValue(open[1]!, 'runtime')).toBe('claude')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// В38: a false `<iap ` start must not swallow or park the real envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('В38 adversarial: false envelope starts in prose', () => {
  test('prose containing `<iap ` (no valid open tag) before a real envelope: the real one is extracted', () => {
    const xml = buildWire({ message: 'настоящий' })
    const prose = 'обсуждаем формат: <iap это просто текст про конверт>\n'
    const { envelopes, rest } = extractIapEnvelopes(prose + xml)
    expect(envelopes).toHaveLength(1) // old: 0 — false start проглатывал настоящий конверт
    expect(parseIapEnvelope(envelopes[0]!).message).toBe('настоящий')
    expect(rest.length).toBeLessThanOrEqual('<iap '.length)
  })

  test('an envelope-shaped but undecodable open tag (missing required attrs) resyncs past', () => {
    const xml = buildWire({ message: 'после мусора' })
    const { envelopes } = extractIapEnvelopes('<iap topic="x">huh</iap>' + xml)
    expect(envelopes).toHaveLength(1)
    expect(parseIapEnvelope(envelopes[0]!).message).toBe('после мусора')
  })

  test('a never-closing false start does NOT park the buffer forever', () => {
    // A SHORT '>'-less tail after `<iap ` is indistinguishable from a real open tag
    // cut by the chunk boundary → it legitimately WAITS in rest…
    const short = extractIapEnvelopes('доклад: <iap упоминание без закрытия')
    expect(short.envelopes).toHaveLength(0)
    expect(short.rest.startsWith('<iap ')).toBe(true)
    // …but the wait is BOUNDED. (a) Prose longer than any legitimate open tag
    // (1 KiB cap) is released even with no '>' in sight:
    const long = extractIapEnvelopes('доклад: <iap ' + 'ъ'.repeat(1100))
    expect(long.envelopes).toHaveLength(0)
    expect(long.rest.length).toBeLessThanOrEqual('<iap '.length)
    // (b) The next chunk bringing a '>' resolves the verdict (invalid → resync),
    // and a real envelope behind it is still extracted:
    const xml = buildWire({ message: 'после прозы' })
    const resumed = extractIapEnvelopes(short.rest + ' и вот тег кончился> дальше текст ' + xml)
    expect(resumed.envelopes).toHaveLength(1)
    expect(parseIapEnvelope(resumed.envelopes[0]!).message).toBe('после прозы')
  })

  test('a REAL open tag split across the chunk boundary still waits (no false resync)', () => {
    const xml = buildWire({ message: 'ждём чанк' })
    const cut = xml.indexOf('from-runtime') // mid-open-tag
    const first = extractIapEnvelopes(xml.slice(0, cut))
    expect(first.envelopes).toHaveLength(0)
    const second = extractIapEnvelopes(first.rest + xml.slice(cut))
    expect(second.envelopes).toHaveLength(1)
    expect(parseIapEnvelope(second.envelopes[0]!).message).toBe('ждём чанк')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Envelope-compaction F: wire ts attribute + read-both decode
// ─────────────────────────────────────────────────────────────────────────────

describe('read-both decode (envelope-compaction F)', () => {
  test('wire ts attribute decodes to sentAt; absent on legacy envelopes', () => {
    const sentAt = '2026-07-14T01:23:45+03:00'
    expect(parseIapEnvelope(buildWire({ sentAt, message: 'hi' })).sentAt).toBe(sentAt)
    expect(parseIapEnvelope(buildWire({ message: 'hi' })).sentAt).toBeUndefined()
  })

  test('compact envelope decodes: from/runtime/intelligence/ts + <msg>', () => {
    const compact =
      '<iap from="boris" runtime="claude" intelligence="artificial" ts="01:23:45" topic="t">\nReply via send_to_peer.\n<msg>тело</msg>\n</iap>'
    const env = parseIapEnvelope(compact)
    expect(env.fromPersonality).toBe('boris')
    expect(env.fromRuntime).toBe('claude')
    expect(env.fromIntelligence).toBe('artificial')
    expect(env.sentAt).toBe('01:23:45')
    expect(env.topic).toBe('t')
    expect(env.message).toBe('тело')
  })

  test('extractIapEnvelopes accepts a compact-format envelope (В38 verdict, both name pairs)', () => {
    const compact =
      '<iap from="boris" runtime="claude" intelligence="artificial">\n<msg>тело</msg>\n</iap>'
    const { envelopes, rest } = extractIapEnvelopes(`noise ${compact} tail`)
    expect(envelopes).toHaveLength(1)
    expect(parseIapEnvelope(envelopes[0]!).fromPersonality).toBe('boris')
    expect(rest.includes('<iap ')).toBe(false)
  })

  test('legacy long-name envelope still decodes through the fallback', () => {
    const env = parseIapEnvelope(buildWire({ fromPersonality: 'nova', fromRuntime: 'telegram', message: 'legacy' }))
    expect(env.fromPersonality).toBe('nova')
    expect(env.fromRuntime).toBe('telegram')
  })
})
