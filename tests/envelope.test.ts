import { describe, expect, test } from 'bun:test'
import { EnvelopeError, extractIapEnvelopes, parseIapEnvelope } from '../src/envelope.ts'

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
