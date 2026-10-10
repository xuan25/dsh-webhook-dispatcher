// dsh-webhook-dispatcher: the per-endpoint dispatch pipeline. One instance per endpoint: the FIFO queue (bounded by maxQueue),
// the in-flight ledger (bounded by maxConcurrent; an entry is held from
// dispatch start until the trigger session settles), and the recent-delivery
// ring. Admission is synchronous (queue/slot bookkeeping only); dispatch is
// a detached closure driven by the injected spawn (the full trigger-session
// lifecycle: bounded create with the 300 s deadline, per-session sandbox,
// the first-turn delivery, settlement classification, handle dispose). A
// spawned session is never cancelled on plugin dispose: closures
// settle on their own, and state mutations no-op once the owning instance
// is disposed. A reconstituted successor adopts the ledger through the
// handover slot: stale in-flight entries from the disposed predecessor are
// pruned at adoption (their dispatch closures settle in the predecessor as
// no-ops, so the successor could never release those slots and a leftover
// entry would pin the endpoint queue-only forever), and queued deliveries
// re-drain into the freed slots in the successor's constructor. The trigger
// sessions those stale entries describe keep running on the host,
// unaffected.
//
// Adoption pruning is safe: the predecessor is flagged disposed BEFORE the
// stash, so a late-settling predecessor closure no-ops (it never mutates
// the stashed state), and the pruned entries are simply absent from the
// successor's ledger.
import type { Logger } from '@deepseek-ai/cordis'
import { errMsg, PLUGIN_NAME, RING_CAP } from './util.js'
import type {
  DeliveryContent,
  DeliveryOutcome,
  DeliveryRequest,
  EndpointConfig,
  InFlightEntry,
  LastDelivery,
  PipelineState,
  RingEntry,
} from './types.js'
import { buildPrompt } from './prompt.js'

/** The admission decision of one delivery (method/auth/budget were checked by the handler first). */
export type AdmitDecision =
  | { kind: 'accepted' }
  | { kind: 'queued' }
  | { kind: 'rejected'; outcome: DeliveryOutcome }

/** The result of one full trigger-session lifecycle (create -> followup -> settle -> dispose). */
export type SpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; kind: 'create_failed' | 'failed'; detail: string; sessionId?: string }

/** The spawn request handed to the injected lifecycle runner. */
export interface SpawnRequest {
  /** The effective endpoint config. */
  endpoint: EndpointConfig
  /** The id of the delivery being dispatched. */
  deliveryId: string
  /** The trigger-session first-turn prompt (built by the pipeline). */
  prompt: string
  /** The delivery payload (null = no content). */
  content: DeliveryContent | null
  /**
   * Called once the trigger session exists (create resolved): the pipeline
   * records the session id on the in-flight ledger entry (absent while the
   * create is in progress; a create_failed dispatch never calls it).
   */
  onSessionCreated?: (sessionId: string) => void
}

/**
 * Dependencies injected into the pipeline (assembled by the plugin from the
 * soft-read framework services): the logger, the clock, the id generator,
 * and the spawn face (the production spawn drives the host agents service;
 * tests inject a controllable double).
 */
export interface PipelineDeps {
  /** The plugin logger. */
  log: Logger
  /** The clock (ms epoch). */
  now: () => number
  /** Delivery/session id generator. */
  newId: () => string
  /** Run one full trigger-session lifecycle; resolves at settlement. */
  spawn: (req: SpawnRequest) => Promise<SpawnResult>
}

/**
 * One endpoint's dispatch pipeline. Instances are reconstituted on hot
 * config change; their state travels through the handover slot.
 */
export class EndpointPipeline {
  /** The effective endpoint config. */
  readonly config: EndpointConfig
  /** The injected dependency face. */
  readonly deps: PipelineDeps
  /** The live pipeline state (the handover unit). */
  state: PipelineState
  /** True once the owning plugin instance disposed this pipeline. */
  disposed = false

  constructor(
    config: EndpointConfig,
    deps: PipelineDeps,
    /** Inherited state from a disposed predecessor (the handover slot). */
    inherited?: PipelineState,
  ) {
    this.config = config
    this.deps = deps
    this.state = inherited ?? { queued: [], inFlight: [], ring: [] }
    if (inherited !== undefined) {
      // Prune the in-flight entries adopted from the disposed predecessor:
      // their dispatch closures live in the predecessor and settle there as
      // no-ops (a disposed instance never mutates the stashed state), so
      // under this instance those slots could never be released. Left
      // unpruned they would pin the endpoint queue-only (then 429 at the
      // queue cap) for the life of this instance. The trigger sessions the
      // pruned entries describe keep running on the host, unaffected.
      this.state.inFlight.length = 0
    }
    // Re-drain on adoption: the slots freed by the prune (and by settled
    // sessions) admit the inherited queued deliveries on this instance.
    this.drain()
  }

  /**
   * Admit one delivery (the queue stage of the rejection total order; method/auth/
   * budget were checked by the handler). A free in-flight slot starts the
   * dispatch immediately (202 accepted); otherwise the delivery is enqueued
   * (202 queued) or rejected (429) when the queue is at its cap.
   */
  admit(request: DeliveryRequest): AdmitDecision {
    if (this.state.inFlight.length < this.config.maxConcurrent) {
      const entry: InFlightEntry = {
        deliveryId: this.deps.newId(),
        createdAt: new Date(this.deps.now()).toISOString(),
      }
      this.state.inFlight.push(entry)
      void this.runDispatch(entry, request)
      return { kind: 'accepted' }
    }
    if (this.state.queued.length < this.config.maxQueue) {
      this.state.queued.push({
        deliveryId: this.deps.newId(),
        createdAt: new Date(this.deps.now()).toISOString(),
        request,
      })
      return { kind: 'queued' }
    }
    return { kind: 'rejected', outcome: 'rejected_queue_full' }
  }

  /**
   * Record one delivery outcome in the per-endpoint ring and lastDelivery
   * (newest first; the per-endpoint ring is capped at RING_CAP, the status
   * view aggregates to 50).
   */
  record(outcome: DeliveryOutcome, method: string, sessionId?: string): void {
    const at = new Date(this.deps.now()).toISOString()
    const entry: RingEntry = {
      at,
      endpointId: this.config.id,
      method,
      outcome,
      ...(sessionId !== undefined ? { sessionId } : {}),
    }
    this.state.ring = [entry, ...this.state.ring].slice(0, RING_CAP)
    const last: LastDelivery = { at, method, outcome, ...(sessionId !== undefined ? { sessionId } : {}) }
    this.state.lastDelivery = last
  }

  /** The live status view (counts and the last recorded delivery). */
  statusView(): {
    inFlight: number
    queueDepth: number
    lastDelivery?: LastDelivery
  } {
    return {
      inFlight: this.state.inFlight.length,
      queueDepth: this.state.queued.length,
      lastDelivery: this.state.lastDelivery,
    }
  }

  /** Start dispatches until the in-flight cap is reached (the queue is FIFO). */
  private drain(): void {
    while (this.state.inFlight.length < this.config.maxConcurrent && this.state.queued.length > 0) {
      const next = this.state.queued.shift()
      if (next === undefined) break
      const entry: InFlightEntry = { deliveryId: next.deliveryId, createdAt: next.createdAt }
      this.state.inFlight.push(entry)
      void this.runDispatch(entry, next.request)
    }
  }

  /** The detached dispatch closure: run the lifecycle, then settle the ledger. */
  private runDispatch(entry: InFlightEntry, request: DeliveryRequest): void {
    const prompt = buildPrompt(this.config, request.content)
    void this.deps
      .spawn({
        endpoint: this.config,
        deliveryId: entry.deliveryId,
        prompt,
        content: request.content,
        onSessionCreated: (sessionId) => {
          const e = this.state.inFlight.find((x) => x.deliveryId === entry.deliveryId)
          if (e !== undefined) e.sessionId = sessionId
        },
      })
      .then((result) => this.settle(entry, request, result), (err) => {
        this.deps.log.warn(
          `${PLUGIN_NAME} endpoint "${this.config.id}": dispatch of "${entry.deliveryId}" threw unexpectedly: ${errMsg(err)}`,
        )
        this.settle(entry, request, { ok: false, kind: 'create_failed', detail: errMsg(err) })
      })
  }

  /** Settle one dispatch: release the slot, record the outcome, re-drain. */
  private settle(entry: InFlightEntry, request: DeliveryRequest, result: SpawnResult): void {
    if (this.disposed) return
    const idx = this.state.inFlight.findIndex((e) => e.deliveryId === entry.deliveryId)
    if (idx === -1) return
    this.state.inFlight.splice(idx, 1)
    if (result.ok) {
      this.record('ok', request.method, result.sessionId)
    } else {
      this.record(result.kind === 'create_failed' ? 'create_failed' : 'failed', request.method, result.sessionId)
      this.deps.log.warn(
        `${PLUGIN_NAME} endpoint "${this.config.id}": ${result.kind === 'create_failed' ? 'session creation failed' : 'trigger session failed'} for delivery "${entry.deliveryId}": ${result.detail}`,
      )
    }
    this.drain()
  }
}
