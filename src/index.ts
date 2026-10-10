// dsh-webhook-dispatcher package entry (public surface).
export { DshWebhookDispatcherPlugin } from './plugin.js'
export { default } from './plugin.js'
export { CONFIG, ENDPOINT_CONFIG, ENDPOINT_DEFAULTS, foldConfig } from './config.js'
export {
  ENDPOINT_ID_RE,
  ENDPOINT_PATH_RE,
  FRAMEWORK_EXACT_ROUTE_DENY,
  FRAMEWORK_PREFIX_ROUTE_DENY,
  PLUGIN_NAME,
  SANDBOX_MODES,
  errMsg,
  isFrameworkRoute,
  isPlainObject,
  packageRoot,
} from './util.js'
export { dropHandoverSlot, stashHandover, takeHandoverSlot } from './handover.js'
export { EndpointPipeline } from './pipeline.js'
export type { AdmitDecision, PipelineDeps } from './pipeline.js'
export { createHandler } from './handler.js'
export { buildPrompt } from './prompt.js'
export { registerSkill } from './skill.js'
export { VERBS, registerTool } from './tool.js'
export type {
  DeliveredConfig,
  DeliveredEndpoint,
  DeliveryContent,
  DeliveryOutcome,
  DeliveryRequest,
  EndpointConfig,
  EndpointStatus,
  HandoverSlot,
  InFlightEntry,
  LastDelivery,
  ParsedConfig,
  PipelineState,
  QueuedDelivery,
  RingEntry,
  SandboxMode,
  StatusResult,
} from './types.js'
