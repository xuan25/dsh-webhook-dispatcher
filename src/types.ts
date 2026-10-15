// dsh-webhook-dispatcher shared types: cross-module contracts for endpoint
// configuration, delivery admission, pipeline state, the status view, and
// the handover slot. This file imports types only (zero runtime dependencies)
// and centralizes the framework type wiring (the cordis Context re-export;
// the dsh-host-webserver import loads its Context augmentation, which types
// ctx.webServer for the plugin).
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { SANDBOX_MODES } from './util.js'

export type { Context, Logger }
export type { WebServer }

export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** A fully resolved endpoint (defaults applied; auth carries the env NAME only, never the token value). */
export interface EndpointConfig {
  /** Endpoint id (config key / pipeline key / handover key). */
  id: string
  /** The exact route on the main webServer. */
  path: string
  /** Human-readable name (default: the id). */
  name: string
  /** Trigger-session policy block (empty: free-policy fallback). */
  policy: string
  /** Trigger session working directory (default: the shared plugin workspace under $DSH_HOME/dsh-webhook-dispatcher). */
  cwd: string
  /** Env var NAME holding the expected X-Webhook-Token value (empty: open endpoint). */
  auth: string
  /** Trigger session sandbox mode (absent: the session default). */
  sandbox?: SandboxMode
  /** Trigger session model (absent: the default selection ladder). */
  model?: string
  /** Max in-flight trigger sessions (default 1). */
  maxConcurrent: number
  /** Max queued deliveries (default 100). */
  maxQueue: number
  /** Max request body bytes (default 262144). */
  maxBodyBytes: number
  /** Session retention window for automatic offload of settled trigger
   * sessions (absent or empty: no offload; the window grammar and the
   * invalid-value behavior in the offload plane). */
  sessionRetention?: string
}

/** One endpoint of the delivered config layer (before default application). */
export interface DeliveredEndpoint {
  id: string
  path: string
  name?: string
  policy?: string
  cwd?: string
  auth?: string
  sandbox?: SandboxMode
  model?: string
  maxConcurrent?: number
  maxQueue?: number
  maxBodyBytes?: number
  sessionRetention?: string
}

/** The raw config layer delivered by the cordis loader (validated against the static Config schema). */
export interface DeliveredConfig {
  endpoints?: DeliveredEndpoint[]
}

/** The plugin's effective configuration. */
export interface ParsedConfig {
  endpoints: EndpointConfig[]
}

/** The delivery payload as received (body decoded per the content-type contract). */
export interface DeliveryContent {
  /** The request Content-Type header value (empty string when absent). */
  contentType: string
  /** Body size in bytes (0 for a body-less request). */
  bytes: number
  /** UTF-8 decoded body (absent when the body is empty). */
  content?: string
}

/** One inbound delivery request. */
export interface DeliveryRequest {
  method: 'GET' | 'POST'
  /** null for a GET (or a body-less request the method gate admits). */
  content: DeliveryContent | null
}

/** The per-delivery outcome recorded in the status ring and lastDelivery. */
export type DeliveryOutcome =
  | 'accepted'
  | 'queued'
  | 'rejected_unauthorized'
  | 'rejected_method_not_allowed'
  | 'rejected_body_too_large'
  | 'rejected_queue_full'
  | 'create_failed'
  | 'ok'
  | 'failed'

/** One entry of the recent-delivery ring (newest first). */
export interface RingEntry {
  /** ISO timestamp of the record. */
  at: string
  endpointId: string
  method: string
  outcome: DeliveryOutcome
  /** Present when a trigger session was spawned for the delivery. */
  sessionId?: string
}

/** The last recorded delivery of one endpoint (the status view). */
export interface LastDelivery {
  at: string
  method: string
  outcome: DeliveryOutcome
  sessionId?: string
}

/** A queued delivery (state stashed in the handover slot across reconstitution). */
export interface QueuedDelivery {
  deliveryId: string
  createdAt: string
  request: DeliveryRequest
}

/** An admitted, in-flight dispatch (dispatch started; the session id is set once create resolves, absent while the create is in progress). */
export interface InFlightEntry {
  deliveryId: string
  createdAt: string
  sessionId?: string
}

/** The per-endpoint pipeline state (the unit stashed in the handover slot). */
export interface PipelineState {
  /** FIFO queue of pending deliveries. */
  queued: QueuedDelivery[]
  /** Admitted dispatches with open trigger sessions. */
  inFlight: InFlightEntry[]
  /** Recent-delivery ring (newest first). */
  ring: RingEntry[]
  lastDelivery?: LastDelivery
}

/** The module-level handover slot: stashed on dispose, adopted by the successor. */
export interface HandoverSlot {
  /** Per-endpoint state keyed by endpoint id. */
  pipelines: Record<string, PipelineState>
}

/** The per-endpoint live view in the status result. */
export interface EndpointStatus {
  id: string
  path: string
  name: string
  inFlight: number
  queueDepth: number
  limits: {
    maxConcurrent: number
    maxQueue: number
    maxBodyBytes: number
  }
  lastDelivery?: LastDelivery
}

/** The `status` verb result. */
export interface StatusResult {
  /** Live ingress descriptor (the framework webServer instance). */
  ingress: {
    via: string
    host: string
    port: number
    routesRegistered: number
  }
  endpoints: EndpointStatus[]
  /** The recent-delivery ring (newest first, up to 50 entries). */
  recent: RingEntry[]
  /** The effective non-secret config per endpoint (auth is the env NAME only). */
  config: {
    endpoints: EndpointConfig[]
  }
}
