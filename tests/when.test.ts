import { describe, expect, test } from 'bun:test'
import { parseWhen, nextFire, type CronWhen, type IntervalWhen } from '../src/when.ts'

// All cron assertions use LOCAL time (the spec mandates system TZ). We build the
// `after` Date with the local-time constructor and assert the local-time fields
// of the result, so the test is TZ-independent.
function local(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s)
}

describe('parseWhen — valid', () => {
  test('parses a daily cron', () => {
    const p = parseWhen('0 9 * * *') as CronWhen
    expect(p.kind).toBe('cron')
    expect([...p.minute]).toEqual([0])
    expect([...p.hour]).toEqual([9])
    expect(p.domRestricted).toBe(false)
    expect(p.dowRestricted).toBe(false)
  })

  test('parses step in minute', () => {
    const p = parseWhen('*/15 * * * *') as CronWhen
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
  })

  test('parses ranges, lists and a-b/n step', () => {
    const p = parseWhen('0,30 9-17/4 * * 1-5') as CronWhen
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 30])
    expect([...p.hour].sort((a, b) => a - b)).toEqual([9, 13, 17])
    expect([...p.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(p.dowRestricted).toBe(true)
  })

  test('folds dow 7 to 0 (Sunday)', () => {
    const p = parseWhen('0 0 * * 7') as CronWhen
    expect([...p.dow]).toEqual([0])
  })

  test('parses @every interval forms', () => {
    expect((parseWhen('@every 30m') as IntervalWhen).ms).toBe(30 * 60_000)
    expect((parseWhen('@every 1h30m') as IntervalWhen).ms).toBe(90 * 60_000)
    expect((parseWhen('@every 90s') as IntervalWhen).ms).toBe(90 * 1_000)
    expect((parseWhen('@every 2d') as IntervalWhen).ms).toBe(2 * 86_400_000)
  })
})

describe('parseWhen — invalid', () => {
  test.each([
    ['', 'empty'],
    ['0 9 * *', 'four fields'],
    ['0 9 * * * *', 'six fields'],
    ['60 * * * *', 'minute 60 out of range'],
    ['* 24 * * *', 'hour 24 out of range'],
    ['* * 0 * *', 'dom 0 out of range'],
    ['* * * 13 *', 'month 13 out of range'],
    ['* * * * 8', 'dow 8 out of range'],
    ['*/0 * * * *', 'zero step'],
    ['5-1 * * * *', 'reversed range'],
    ['abc * * * *', 'garbage'],
    ['@every', 'no duration'],
    ['@every 0s', 'zero duration'],
    ['@every 500ms', 'unknown unit'],
    ['@every 10x', 'unknown unit'],
    ['@every 1h2', 'trailing garbage'],
    ['@hourly', 'unknown macro'],
  ])('throws on %p (%s)', input => {
    expect(() => parseWhen(input)).toThrow()
  })
})

describe('nextFire — cron golden table (local time)', () => {
  test('daily 0 9 * * *: next 09:00', () => {
    const p = parseWhen('0 9 * * *')
    const got = nextFire(p, local(2026, 6, 6, 10, 30))
    expect(got).toEqual(local(2026, 6, 7, 9, 0))
  })

  test('daily 0 9 * * * before 9am same day', () => {
    const p = parseWhen('0 9 * * *')
    const got = nextFire(p, local(2026, 6, 6, 8, 30))
    expect(got).toEqual(local(2026, 6, 6, 9, 0))
  })

  test('*/15: next quarter-hour, strictly after', () => {
    const p = parseWhen('*/15 * * * *')
    expect(nextFire(p, local(2026, 6, 6, 10, 0))).toEqual(local(2026, 6, 6, 10, 15))
    expect(nextFire(p, local(2026, 6, 6, 10, 14))).toEqual(local(2026, 6, 6, 10, 15))
    // Exactly on a slot → strictly after → next slot.
    expect(nextFire(p, local(2026, 6, 6, 10, 15))).toEqual(local(2026, 6, 6, 10, 30))
  })

  test('dom/dow OR-semantics: 0 0 13 * 5 (13th OR Friday)', () => {
    const p = parseWhen('0 0 13 * 5')
    // 2026-06-06 is a Saturday. Next Friday is 2026-06-12. The 13th is 2026-06-13.
    // OR-semantics → the earliest of the two = Friday the 12th.
    const got = nextFire(p, local(2026, 6, 6, 12, 0))
    expect(got).toEqual(local(2026, 6, 12, 0, 0))
    expect(got.getDay()).toBe(5)
  })

  test('dom/dow OR: lands on the 13th when it comes first', () => {
    const p = parseWhen('0 0 13 * 5')
    // From 2026-06-12 12:00, next match is the 13th (Saturday) — dom side fires.
    const got = nextFire(p, local(2026, 6, 12, 12, 0))
    expect(got).toEqual(local(2026, 6, 13, 0, 0))
    expect(got.getDate()).toBe(13)
  })

  test('weekdays 0 0 * * 1-5: Saturday → Monday', () => {
    const p = parseWhen('0 0 * * 1-5')
    // 2026-06-06 Sat → next weekday midnight is Mon 2026-06-08 00:00.
    const got = nextFire(p, local(2026, 6, 6, 12, 0))
    expect(got).toEqual(local(2026, 6, 8, 0, 0))
    expect(got.getDay()).toBe(1)
  })

  test('impossible expression 0 0 30 2 * throws', () => {
    const p = parseWhen('0 0 30 2 *')
    expect(() => nextFire(p, local(2026, 6, 6, 0, 0))).toThrow()
  })

  test('month rollover: 0 0 1 1 * → next Jan 1', () => {
    const p = parseWhen('0 0 1 1 *')
    const got = nextFire(p, local(2026, 6, 6, 0, 0))
    expect(got).toEqual(local(2027, 1, 1, 0, 0))
  })
})

describe('nextFire — interval (anchored, skip-to-next)', () => {
  test('first slot is anchor + ms', () => {
    const p = parseWhen('@every 30m')
    const anchor = local(2026, 6, 6, 10, 0)
    expect(nextFire(p, anchor, anchor)).toEqual(local(2026, 6, 6, 10, 30))
  })

  test('after < anchor → anchor + ms', () => {
    const p = parseWhen('@every 30m')
    const anchor = local(2026, 6, 6, 10, 0)
    const got = nextFire(p, local(2026, 6, 6, 9, 0), anchor)
    expect(got).toEqual(local(2026, 6, 6, 10, 30))
  })

  test('skip-to-next: after far in the future → single next slot, no catch-up', () => {
    const p = parseWhen('@every 30m')
    const anchor = local(2026, 6, 6, 10, 0)
    // 100 minutes later → grid slots at +30,+60,+90,+120; next strictly-after is +120.
    const got = nextFire(p, local(2026, 6, 6, 11, 40), anchor)
    expect(got).toEqual(local(2026, 6, 6, 12, 0))
  })

  test('exactly on a slot advances to the next (strictly after)', () => {
    const p = parseWhen('@every 30m')
    const anchor = local(2026, 6, 6, 10, 0)
    const got = nextFire(p, local(2026, 6, 6, 10, 30), anchor)
    expect(got).toEqual(local(2026, 6, 6, 11, 0))
  })

  test('omitted anchor defaults to after → first fire at after + ms', () => {
    const p = parseWhen('@every 1h30m')
    const after = local(2026, 6, 6, 10, 0)
    expect(nextFire(p, after)).toEqual(local(2026, 6, 6, 11, 30))
  })
})
