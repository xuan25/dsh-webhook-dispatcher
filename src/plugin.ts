// dsh-webhook-dispatcher: inbound webhook dispatch plugin for dsh (class
// form). Endpoints are exact routes on the framework main webServer (the
// Web GUI server: 127.0.0.1:3080 in this deployment); the plugin owns no
// listener of its own, so external webhook senders reach its routes through
// the owner-managed reverse-proxy ingress. Each admitted delivery spawns a
// contained trigger session (bounded per endpoint by maxConcurrent /
// maxQueue) whose first-turn prompt carries the delivery content.
//
// Plugin form = cordis class plugin (Service subclass): `new
// DshWebhookDispatcherPlugin(ctx, validatedConfig)`. The constructor performs
// the full synchronous lifecycle (logger, config fold, handover adoption,
// route / tool / skill / system-prompt registration as framework-tracked
// effects, the dispose stash effect); the instance `async *[Service.init]()`
// is a no-op generator - the shape follows the dsh-timer convention, with
// no long-lived start step: route registrations and the three
// tool/skill/prompt registrations are effect disposers, and the only other
// timers (the 300 s create deadlines) are host timers owned per dispatch.
// A valid-but-failing registration (e.g. a duplicate route) throws at effect
// activation and fails the entry loudly.
//
// inject = every service the plugin reads: webServer (dsh-host-webserver:
// the route table the plugin registers on - a hard service, the plugin
// cannot compose without it) plus the dsh host services tools / skills /
// systemPrompt (ctx.tools.register / ctx.skills.registerProvider /
// ctx.systemPrompt.section). Soft-read services (agents / agentPresets /
// dshHomePath / agentDefaultModel, via ctx.get at dispatch time) are
// deliberately NOT injected: a host missing one degrades the affected
// dispatch step, it does not stop the plugin (the dsh-timer soft-read
// precedent).
//
// The static Config schema validates the delivered config layer before the
// constructor runs (a violation fails the entry loudly); the constructor
// folds it onto the built-in defaults (foldConfig), which also runs the
// cross-endpoint validation (uniqueness, the framework route deny-list, the
// auth env presence fail-closed).
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { Service, type Context, type Logger } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { errMsg, PLUGIN_NAME, RING_CAP } from './util.js'
import { CONFIG, foldConfig } from './config.js'
import type {
  DeliveredConfig,
  EndpointConfig,
  ParsedConfig,
  PipelineState,
  RingEntry,
  StatusResult,
} from './types.js'
import { EndpointPipeline, type PipelineDeps, type SpawnRequest, type SpawnResult } from './pipeline.js'
import { createHandler } from './handler.js'
import { registerTool } from './tool.js'
import { registerSkill } from './skill.js'
import { stashHandover, takeHandoverSlot } from './handover.js'

/**
 * Bounded deadline for the trigger-session create: a create that does not
 * resolve within this window settles the dispatch as create_failed
 * ("agent create timed out after Nms") and the late-resolving agent is
 * cancelled + disposed (orphan protection). This is the only escape for a
 * hung create; it bounds one create, never a session (port of the dsh-timer
 * runner constant).
 */
const CREATE_TIMEOUT_MS = 300_000

/** The settings.yaml section (and settings service namespace) of the deployment default model selection. */
const DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** The host's agents service surface (soft read via ctx.get; structural, not a dependency). */
interface AgentsService {
  create(options: CreateAgentOptions): Promise<AgentHandle>
}

/** The host's agent preset service surface (structural; dsh-agent-presets is not a dependency). */
interface PresetService {
  /** Deployment default when id is omitted; rejects for an unknown preset id. */
  resolve(id?: string): Promise<{ id: string }>
  /** Plug the preset's agent-plane composition into the unpublished agent scope (the create's setup hook). */
  mount(agentCtx: unknown, id: string): Promise<void>
}

interface DefaultModelSelection {
  provider: string
  model: string
}

/** Validate a candidate default selection: valid only when both fields are non-empty strings. */
function normalizeDefaultSelection(value: unknown): DefaultModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { provider?: unknown; model?: unknown }
  if (typeof v.provider !== 'string' || v.provider === '') return undefined
  if (typeof v.model !== 'string' || v.model === '') return undefined
  return { provider: v.provider, model: v.model }
}

interface TurnEndEvent {
  type?: unknown
  data?: { reason?: unknown } | null
}

/** Find the most recent turn/end event, scanning from the tail; null when absent. */
function lastTurnEnd(events: readonly unknown[]): TurnEndEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as TurnEndEvent | null
    if (e && e.type === 'turn/end') return e
  }
  return null
}

/** Map a turn/end reason to its kind (string or {reason}/{kind} object). */
function reasonKind(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object') {
    const r = reason as { reason?: unknown; kind?: unknown }
    if (typeof r.reason === 'string') return r.reason
    if (typeof r.kind === 'string') return r.kind
  }
  return 'error'
}

/** The error message carried by an error-kind turn/end reason (when present). */
function turnErrorMessage(reason: unknown): string {
  if (!reason || typeof reason !== 'object') return ''
  const error = (reason as { error?: unknown }).error
  if (!error || typeof error !== 'object') return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

export class DshWebhookDispatcherPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['webServer', 'tools', 'skills', 'systemPrompt']
  static readonly Config = CONFIG

  private readonly hostCtx: Context
  private readonly log: Logger
  private readonly web: WebServer
  private readonly cfg: ParsedConfig
  private readonly pipelines = new Map<string, EndpointPipeline>()

  constructor(ctx: Context, config: DeliveredConfig | undefined) {
    super(ctx, PLUGIN_NAME)
    this.hostCtx = ctx
    this.log = ctx.logger(PLUGIN_NAME)
    this.web = ctx.webServer
    this.cfg = foldConfig(process.env, config, (msg) => this.log.warn(msg))

    // The pipeline dependency face: the production spawn drives the host
    // agents service (soft read per dispatch); the clock/ids are host
    // primitives.
    const deps: PipelineDeps = {
      log: this.log,
      now: () => Date.now(),
      newId: () => randomUUID(),
      spawn: (req) => this.spawnSession(req),
    }

    // Handover adoption: the state of a disposed
    // predecessor (hot reconstitution) is re-attached to the new pipeline
    // instances; state of endpoints removed from the config is dropped.
    const inherited = takeHandoverSlot()
    const inheritedPipelines = inherited?.pipelines ?? {}
    for (const endpoint of this.cfg.endpoints) {
      const pipeline = new EndpointPipeline(endpoint, deps, inheritedPipelines[endpoint.id])
      this.pipelines.set(endpoint.id, pipeline)
      // Route registration against the persistent framework webServer. A
      // duplicate (kind, path) throws at registration and fails the entry
      // loudly (fail-fast).
      const handler = createHandler(endpoint, pipeline)
      ctx.effect(
        () => ctx.webServer.register({ kind: 'exact', path: endpoint.path, handler }),
        `${PLUGIN_NAME}: ${endpoint.path}`,
      )
    }
    if (inherited !== null) {
      // One visible line per dropped endpoint, counts included: the stashed
      // state is the predecessor's raw state at dispose time.
      const stale = Object.keys(inheritedPipelines).filter(
        (id) => !this.cfg.endpoints.some((e) => e.id === id),
      )
      for (const id of stale) {
        const st = inheritedPipelines[id]
        this.log.warn(
          `${PLUGIN_NAME} handover: dropping state of endpoint "${id}" (removed from the config): ` +
            `${st?.queued.length ?? 0} queued, ${st?.inFlight.length ?? 0} in-flight`,
        )
      }
    }

    // Tool / skill / system-prompt registration (framework-tracked effects).
    registerTool(ctx, () => this.status())
    registerSkill(ctx)
    ctx.systemPrompt.section({
      name: PLUGIN_NAME,
      order: 3000,
      text:
        'Webhook deliveries are handled by the dsh-webhook-dispatcher plugin (webhook tool, status ' +
        'verb); see the dsh-webhook-dispatcher skill for the endpoint configuration reference and ' +
        'trigger session semantics.',
    })

    // Dispose stash: the pipeline state travels to the successor through the
    // module-level handover slot. Pipelines are flagged disposed BEFORE the
    // stash so a late-settling dispatch closure (its session settles
    // detached) can no longer mutate the stashed state object; in-
    // flight sessions are never cancelled.
    ctx.effect(
      () => () => {
        for (const pipeline of this.pipelines.values()) pipeline.disposed = true
        const pipelines: Record<string, PipelineState> = {}
        for (const [id, pipeline] of this.pipelines) {
          pipelines[id] = pipeline.state
        }
        stashHandover({ pipelines })
      },
      `${PLUGIN_NAME}: handover stash`,
    )
  }

  // No-op lifecycle generator: construction is fully synchronous (see the
  // class doc) and no long-lived start step exists. The pinned shape keeps
  // the dsh-timer convention explicit (the 300 s create deadlines are
  // per-dispatch host timers, not plugin timers).
  async *[Service.init](): AsyncGenerator<never, void, unknown> {
    // nothing to yield; the effect disposers own the teardown
  }

  /** The `status` verb live view. */
  status(): StatusResult {
    return {
      ingress: {
        via: 'framework webServer (main)',
        host: this.web.host,
        port: this.web.port,
        routesRegistered: this.pipelines.size,
      },
      endpoints: [...this.pipelines.values()].map((pipeline) => {
        const view = pipeline.statusView()
        return {
          id: pipeline.config.id,
          path: pipeline.config.path,
          name: pipeline.config.name,
          inFlight: view.inFlight,
          queueDepth: view.queueDepth,
          limits: {
            maxConcurrent: pipeline.config.maxConcurrent,
            maxQueue: pipeline.config.maxQueue,
            maxBodyBytes: pipeline.config.maxBodyBytes,
          },
          ...(view.lastDelivery !== undefined ? { lastDelivery: view.lastDelivery } : {}),
        }
      }),
      recent: this.recentRing(),
      config: { endpoints: this.cfg.endpoints },
    }
  }

  /** The recent-delivery ring aggregated over all endpoints (newest first, capped by the shared RING_CAP). */
  private recentRing(): RingEntry[] {
    const ring: RingEntry[] = []
    for (const pipeline of this.pipelines.values()) {
      ring.push(...pipeline.state.ring)
    }
    ring.sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : a.endpointId < b.endpointId ? 1 : a.endpointId > b.endpointId ? -1 : 0,
    )
    return ring.slice(0, RING_CAP)
  }

  // -- trigger-session dispatch (the pipeline's production spawn) ---------

  /**
   * The production trigger-session lifecycle: soft-read
   * the agents service, resolve the deployment-default preset and the model
   * selection ladder (the endpoint's model, when set, overlays the model
   * field of the resolved base), prepare the session workspace (the
   * endpoint cwd, or $DSH_HOME/dsh-webhook-dispatcher when unset), create
   * the session under the 300 s bounded deadline (late resolves are
   * cancelled + disposed), apply the per-session sandbox override when
   * configured, deliver the prompt as the first turn, settle on the
   * turn/end classification, and always dispose the handle. Ports the
   * dsh-email dispatchTriggerSession / dsh-timer runner pattern.
   */
  private async spawnSession(req: SpawnRequest): Promise<SpawnResult> {
    const endpoint = req.endpoint
    const tag = `endpoint "${endpoint.id}"`

    // The agents service: soft read (a host missing it degrades this
    // dispatch to a visible create_failed, not a plugin failure).
    let agents: AgentsService | undefined
    try {
      const s = this.hostCtx.get('agents')
      agents = s === undefined || s === null ? undefined : (s as AgentsService)
    } catch {
      agents = undefined
    }
    if (!agents || typeof agents.create !== 'function') {
      return { ok: false, kind: 'create_failed', detail: 'the host provides no agents service' }
    }

    const preset = await this.resolveDefaultPreset()
    const agentOptions = await this.resolveAgentOptions(endpoint)
    const workspace = await this.resolveWorkspace(endpoint)

    // The session meta mirrors every other in-process session creator in a
    // deployment: an explicit meta.cwd (the framework's no-cwd default dies
    // before the first LLM call) and meta.agentPreset for the mounted preset.
    const meta: { cwd?: string; agentPreset?: string } = {}
    if (workspace !== undefined) meta.cwd = workspace
    if (preset.id !== undefined) meta.agentPreset = preset.id

    const sid = randomUUID() as SessionId
    // Bounded create: a host setTimeout (deviation from dsh-email: the
    // plugin has no long-lived owner to track timers on - the deadline is
    // per-dispatch, fires at most once, and its orphan-protection handler
    // cancels + disposes a late-resolving handle).
    let disarmDeadline: (() => void) | null = null
    let deadlineDisposed = false
    const disarm = (): void => {
      if (deadlineDisposed || disarmDeadline === null) return
      deadlineDisposed = true
      try {
        disarmDeadline()
      } catch {
        /* timer already fired */
      }
    }
    const setup = preset.setup
    const createPromise = agents.create({
      sessionId: sid,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(agentOptions !== undefined ? { agentOptions } : {}),
      ...(setup !== undefined ? { setup } : {}),
    })
    const deadlineSignal = new Promise<{ timedOut: true }>((resolve) => {
      const t = setTimeout(() => {
        resolve({ timedOut: true })
        // Orphan protection: a create that resolves after the deadline would
        // leave an untracked in-flight session; cancel it and dispose it
        // instead.
        void createPromise.then(
          (late) => {
            try {
              late.agent.cancel({ kind: 'user' })
            } catch {
              /* agent gone already */
            }
            void late.dispose().catch(() => {
              /* already disposed */
            })
          },
          () => {
            /* create rejected after the deadline: nothing to dispose */
          },
        )
      }, CREATE_TIMEOUT_MS)
      disarmDeadline = () => {
        clearTimeout(t)
      }
    })

    const createResult = await Promise.race([
      createPromise.then(
        (handle): { timedOut: false; handle: AgentHandle } => ({ timedOut: false, handle }),
        (err): { failed: string } => ({ failed: errMsg(err) }),
      ),
      deadlineSignal,
    ])
    disarm()
    if ('failed' in createResult) {
      return { ok: false, kind: 'create_failed', detail: `agent create failed: ${createResult.failed}` }
    }
    if (createResult.timedOut) {
      return { ok: false, kind: 'create_failed', detail: `agent create timed out after ${CREATE_TIMEOUT_MS}ms` }
    }
    const created = createResult.handle
    req.onSessionCreated?.(sid)

    // Per-session sandbox override (endpoint config: absent = the session
    // default). Soft: a set failure warns, the session keeps its default.
    if (endpoint.sandbox !== undefined) {
      try {
        setSandboxMode(created.agent.session, endpoint.sandbox)
      } catch (err) {
        this.log.warn(`${PLUGIN_NAME} ${tag}: sandbox mode "${endpoint.sandbox}" could not be set: ${errMsg(err)}`)
      }
    }

    // The first turn: the delivery prompt.
    const msg = createUserMessage({
      content: [{ type: 'text', text: req.prompt }],
      source: { kind: 'user' },
    })
    let followupError: string | undefined
    try {
      // The typed followup returns void; at runtime some drivers return a
      // settle promise - keep the dsh-email defensive attach.
      const r = created.agent.followup(msg) as unknown
      if (r !== null && typeof r === 'object' && typeof (r as { catch?: unknown }).catch === 'function') {
        ;(r as { catch: (fn: (err: unknown) => void) => void }).catch((err) => {
          followupError = errMsg(err)
        })
      }
    } catch (err) {
      followupError = errMsg(err)
    }

    try {
      await created.agent.whenIdle()
    } catch {
      /* whenIdle is not expected to reject; ignore */
    }

    let endEvent: TurnEndEvent | null = null
    try {
      endEvent = lastTurnEnd(created.agent.session.snapshotEvents())
    } catch {
      endEvent = null
    }
    const kind = endEvent ? reasonKind(endEvent.data?.reason) : null

    let result: SpawnResult
    if (kind === 'completed' || kind === 'blocked' || kind === 'max-tokens') {
      result = { ok: true, sessionId: sid }
    } else if (endEvent !== null) {
      const detail = turnErrorMessage(endEvent.data?.reason)
      result = { ok: false, kind: 'failed', detail: detail || `turn ended with reason ${kind}`, sessionId: sid }
    } else if (followupError !== undefined) {
      result = { ok: false, kind: 'failed', detail: followupError, sessionId: sid }
    } else {
      this.log.warn(`${PLUGIN_NAME} ${tag}: trigger session for delivery "${req.deliveryId}" ended without a turn/end event; falling back to ok`)
      result = { ok: true, sessionId: sid }
    }
    try {
      await created.dispose()
    } catch {
      /* already disposed */
    }
    return result
  }

  /** The deployment-default preset of the trigger session (no per-endpoint preset knob; missing service = baseline, resolution failure = warn + baseline). */
  private async resolveDefaultPreset(): Promise<{ setup?: (agentCtx: unknown) => Promise<void>; id?: string }> {
    const service = this.getPresetsService()
    if (!service) return {}
    try {
      const id = (await service.resolve()).id
      return {
        id,
        setup: async (agentCtx: unknown): Promise<void> => {
          await service.mount(agentCtx, id)
        },
      }
    } catch (err) {
      this.log.warn(`${PLUGIN_NAME} deployment default preset resolution failed (${errMsg(err)}); continuing with the baseline composition`)
      return {}
    }
  }

  /** The host's agent preset service, or undefined when the host provides none. */
  private getPresetsService(): PresetService | undefined {
    const get = this.hostCtx.get
    if (typeof get !== 'function') return undefined
    try {
      const service = get('agentPresets')
      return service === undefined || service === null ? undefined : (service as PresetService)
    } catch {
      return undefined
    }
  }

  /**
   * The model route of the trigger session: the deployment's default
   * selection from the three SOFT sources (agentDefaultModel service ->
   * settings section -> $DSH_HOME/settings.yaml; none is a required inject;
   * sources 1 and 2 are read under one guard, so a throw in either skips
   * to source 3),
   * overlaid with the endpoint's model when configured (the model field
   * only; a base provider is kept). When no source resolves and the
   * endpoint sets no model, no route is passed and the framework's own
   * no-route rejection is surfaced at settlement (port of the dsh-email /
   * dsh-timer ladder).
   */
  private async resolveAgentOptions(endpoint: EndpointConfig): Promise<CreateAgentOptions['agentOptions']> {
    const base = await this.readDefaultModelSelection()
    const options: { provider?: string; model?: string } = {}
    if (base !== undefined) {
      options.provider = base.provider
      options.model = base.model
    }
    if (endpoint.model !== undefined && endpoint.model !== '') {
      options.model = endpoint.model
    }
    return Object.keys(options).length > 0 ? options : undefined
  }

  /** Read the deployment's default model selection from the three soft sources (in order; sources 1 and 2 share one guard - a failure in either skips to source 3). */
  private async readDefaultModelSelection(): Promise<DefaultModelSelection | undefined> {
    const get = this.hostCtx.get
    if (typeof get === 'function') {
      try {
        const service = get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
        const fromService = normalizeDefaultSelection(service?.currentSelection?.())
        if (fromService) return fromService
        const settings = get('settings') as { section?: (ns: string) => unknown } | undefined
        const fromSettings = normalizeDefaultSelection(settings?.section?.(DEFAULT_MODEL_SETTINGS_NAMESPACE))
        if (fromSettings) return fromSettings
      } catch {
        /* sources 1 and 2 share one guard: a failure in either skips to the settings.yaml source */
      }
    }
    let dshHomePath: unknown
    try {
      dshHomePath = typeof get === 'function' ? get('dshHomePath') : undefined
    } catch {
      return undefined
    }
    if (typeof dshHomePath !== 'function') return undefined
    try {
      const doc = parseYaml(await readFile(dshHomePath('settings.yaml'), 'utf8')) as unknown
      return normalizeDefaultSelection((doc as { [ns: string]: unknown } | null)?.[DEFAULT_MODEL_SETTINGS_NAMESPACE])
    } catch {
      return undefined
    }
  }

  /**
   * The trigger session workspace: the endpoint cwd when configured, else
   * $DSH_HOME/dsh-webhook-dispatcher (the shared plugin directory).
   * Every failure is soft: without the dshHomePath service (or on a mkdir
   * failure) the dispatch degrades to a workspace-less create and warns.
   */
  private async resolveWorkspace(endpoint: EndpointConfig): Promise<string | undefined> {
    let dir: string | undefined
    if (endpoint.cwd !== '') {
      dir = endpoint.cwd
    } else {
      let dshHomePath: unknown
      try {
        dshHomePath = this.hostCtx.get('dshHomePath')
      } catch {
        dshHomePath = undefined
      }
      if (typeof dshHomePath !== 'function') {
        this.log.warn(`${PLUGIN_NAME} endpoint "${endpoint.id}": no dshHomePath service; creating the session without a workspace`)
        return undefined
      }
      try {
        dir = (dshHomePath as (p: string) => string)(PLUGIN_NAME)
      } catch {
        this.log.warn(`${PLUGIN_NAME} endpoint "${endpoint.id}": dshHomePath failed; creating the session without a workspace`)
        return undefined
      }
    }
    try {
      await mkdir(dir, { recursive: true })
      return dir
    } catch (err) {
      this.log.warn(`${PLUGIN_NAME} endpoint "${endpoint.id}": workspace preparation failed (${errMsg(err)}); creating the session without a workspace`)
      return undefined
    }
  }
}

export default DshWebhookDispatcherPlugin
