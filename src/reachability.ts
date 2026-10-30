import { existsSync, readFileSync } from 'fs'
import { resolveIapeerRoot } from './manifest.ts'
import { join } from 'path'

// ── Static reachability of a peer FROM the notifier ─────────────────────────
//
// Incident 26.08–17.10.2026: 2335 timer fires went "lost" over seven weeks and
// nobody noticed. One reason: mrbooker's chain was `mrbooker → arthur → boris`,
// and the `arthur` link is dead BY CONSTRUCTION — arthur is a human, iapeer
// delivers to a human only over a telegram face, and the notifier personalities
// (timer/watcher) have none ("telegram policy: sender "timer" has no telegram
// face"). The trigger was accepted silently, and every fire burned two attempts
// + a 30 s retry on a link that could never succeed.
//
// This module answers, from the peer registry alone (no network, no wake), the
// question "can the notifier EVER deliver to this peer?". It never tries to
// predict transient failures (a wake that fails today may work tomorrow) — only
// structural ones that no retry can fix:
//   • a human peer (intelligence "natural") while the sender has no telegram
//     face → iapeer refuses by policy;
//   • a program peer with no model (intelligence "absent": timer, watcher,
//     voice-notifier) → nobody ever reads the message;
//   • a peer missing from the registry → a WARNING only (it may be registered
//     later), never a hard refusal.
// Unknown/missing fields are treated as reachable: the check only refuses what
// it can prove.

export interface RegistryPeer {
  personality: string
  intelligence?: string
  telegramBot?: string
}

export type Registry = Map<string, RegistryPeer>

export function parseRegistry(raw: unknown): Registry {
  const out: Registry = new Map()
  const peers = Array.isArray((raw as { peers?: unknown })?.peers) ? (raw as { peers: unknown[] }).peers : []
  for (const p of peers) {
    const r = p as { personality?: unknown; intelligence?: unknown; interfaces?: unknown }
    if (typeof r?.personality !== 'string') continue
    const tg = (r.interfaces as { telegram?: { bot_username?: unknown } } | undefined)?.telegram
    out.set(r.personality, {
      personality: r.personality,
      ...(typeof r.intelligence === 'string' ? { intelligence: r.intelligence } : {}),
      ...(typeof tg?.bot_username === 'string' && tg.bot_username ? { telegramBot: tg.bot_username } : {}),
    })
  }
  return out
}

// Best-effort registry read: any failure → empty registry (every peer then
// reads as "unknown" → warnings only, never a refusal on a broken read).
export function readRegistry(path = join(resolveIapeerRoot(), 'peers-profiles.json')): Registry {
  try {
    if (!existsSync(path)) return new Map()
    return parseRegistry(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return new Map()
  }
}

export interface Unreachable {
  // error — structurally undeliverable, no retry can fix it (refuse at
  // register, skip at runtime). warn — cannot verify (not in the registry).
  level: 'error' | 'warn'
  reason: string
}

// Telegram-faced AGENT peers — the ones that can relay a message to a human.
export function telegramRelays(reg: Registry): string[] {
  return [...reg.values()]
    .filter(p => p.telegramBot && p.intelligence !== 'natural' && p.intelligence !== 'absent')
    .map(p => p.personality)
}

export function checkReachable(peer: string, sender: string, reg: Registry): Unreachable | null {
  const p = reg.get(peer)
  if (!p) {
    return reg.size === 0
      ? null // registry unreadable — say nothing rather than warn on everything
      : { level: 'warn', reason: `"${peer}" is not in the peer registry — delivery will fail until it is registered` }
  }
  if (p.intelligence === 'natural' && !reg.get(sender)?.telegramBot) {
    const relays = telegramRelays(reg).slice(0, 3)
    return {
      level: 'error',
      reason:
        `"${peer}" is a human; iapeer delivers to a human only over a telegram face and ` +
        `"${sender}" has none (telegram policy) — this link can never be delivered` +
        (relays.length ? `. Use a telegram-faced agent as relay instead (e.g. ${relays.map(r => `"${r}"`).join(', ')})` : ''),
    }
  }
  if (p.intelligence === 'absent') {
    return {
      level: 'error',
      reason: `"${peer}" is a program peer with no model (intelligence "absent") — nobody reads its messages`,
    }
  }
  return null
}
