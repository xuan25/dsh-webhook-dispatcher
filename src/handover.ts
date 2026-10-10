// dsh-webhook-dispatcher: the module-level handover slot. On dispose the dying instance stashes its pipeline state here; the
// successor instance adopts it in its constructor. Route registrations are
// re-made against the persistent framework webServer; only the pipeline
// state (queued deliveries, in-flight bookkeeping, the status ring) travels
// through the slot. In-flight sessions themselves are never touched: they
// settle on their own, detached from the pipeline instance that spawned
// them. The slot is process-lifetime (intrinsic to in-process plugins) and
// is cleared on adoption.
import type { HandoverSlot } from './types.js'

let slot: HandoverSlot | null = null

/** Stash the pipeline state of a disposed instance (overwrites any pending slot). */
export function stashHandover(next: HandoverSlot): void {
  slot = next
}

/** Adopt (and clear) the stashed slot; null when nothing is pending. */
export function takeHandoverSlot(): HandoverSlot | null {
  const taken = slot
  slot = null
  return taken
}

/** Drop a pending slot without adopting it (test and abort paths). */
export function dropHandoverSlot(): void {
  slot = null
}
