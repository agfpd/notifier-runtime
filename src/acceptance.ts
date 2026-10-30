import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { IapEnvelope } from './envelope.ts'

export interface AcceptanceEvent {
  deliveryId: string
  outcome: 'delivered' | 'failed' | 'unresolved'
  recipient: string
  reason?: string
}

export interface AcceptanceStore {
  get(id: string): AcceptanceEvent | undefined
  put(event: AcceptanceEvent): void
}

export class MemoryAcceptanceStore implements AcceptanceStore {
  private events = new Map<string, AcceptanceEvent>()
  get(id: string) { return this.events.get(id) }
  put(event: AcceptanceEvent) {
    const prior = this.get(event.deliveryId)
    if (!prior || prior.outcome === 'unresolved') this.events.set(event.deliveryId, { ...event })
  }
}

export function makeAcceptanceStore(dir: string): AcceptanceStore {
  const path = (id: string) => {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('invalid deliveryId')
    return join(dir, `${id}.json`)
  }
  const get = (id: string): AcceptanceEvent | undefined => {
    try { return JSON.parse(readFileSync(path(id), 'utf8')) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
  }
  return { get, put(event) {
    const prior = get(event.deliveryId)
    // Delivered/failed are terminal; a delayed unresolved reminder cannot regress them.
    if (prior && prior.outcome !== 'unresolved') return
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const dest = path(event.deliveryId), tmp = `${dest}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(event) + '\n', { mode: 0o600 })
    renameSync(tmp, dest)
  } }
}

// Only the core system sender may resolve custody. Never reply to these events
// as malformed trigger registrations. Attachment variants need only these keys.
export function parseAcceptanceEvent(env: IapEnvelope): AcceptanceEvent | null {
  if (env.fromRuntime !== 'core' || env.fromPersonality !== 'iapeer-system' || env.topic !== 'delivery-acceptance') return null
  const e = JSON.parse(env.message)
  if (e.event !== 'delivery-acceptance' || typeof e.deliveryId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(e.deliveryId)
    || !['delivered', 'failed', 'unresolved'].includes(e.outcome) || typeof e.recipient !== 'string') {
    throw new Error('invalid delivery-acceptance event')
  }
  return { deliveryId: e.deliveryId, outcome: e.outcome, recipient: e.recipient,
    ...(typeof e.reason === 'string' ? { reason: e.reason } : {}) }
}
