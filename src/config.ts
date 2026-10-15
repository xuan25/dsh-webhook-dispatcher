// dsh-webhook-dispatcher configuration: the static Config schema (validated
// by the cordis loader against the delivered config layer before the
// constructor runs), the DSH_WEBHOOK_* env contract (the same endpoint shape
// declared as DSH_WEBHOOK_<ENDPOINT_ID>_<FIELD> variables, read once at
// boot), the channel folding (config layer > env > built-in defaults), and
// the cross-endpoint validation no single-field schema can express (id/path
// uniqueness across both channels, the framework route deny-list, the auth
// env presence fail-closed).
import Schema from '@deepseek-ai/schemastery'
import {
  ENDPOINT_ID_RE,
  ENDPOINT_PATH_RE,
  FRAMEWORK_EXACT_ROUTE_DENY,
  FRAMEWORK_PREFIX_ROUTE_DENY,
  PLUGIN_NAME,
  SANDBOX_MODES,
  isFrameworkRoute,
  isPlainObject,
} from './util.js'
import type { DeliveredConfig, EndpointConfig, ParsedConfig, SandboxMode } from './types.js'

/** The declared per-endpoint fields (the validation message reference). */
const ENDPOINT_FIELDS = {
  id: 'the endpoint id (config key / pipeline key / handover key)',
  path: 'the exact route on the main webServer',
  name: 'the human-readable name (optional, non-empty; default: the id)',
  policy: 'the trigger-session policy block (empty: free-policy fallback)',
  cwd: 'the trigger session working directory (absolute path, or empty for the shared plugin workspace under $DSH_HOME/dsh-webhook-dispatcher)',
  auth: 'the env var NAME holding the expected X-Webhook-Token value (empty: open endpoint)',
  sandbox: `the trigger session sandbox mode (${SANDBOX_MODES.join(' | ')})`,
  model: 'the trigger session model (default: the default selection ladder)',
  maxConcurrent: 'max in-flight trigger sessions (default 1)',
  maxQueue: 'max queued deliveries (default 100)',
  maxBodyBytes: 'max request body bytes (default 262144)',
  sessionRetention: 'the session retention window for automatic offload of settled trigger sessions (empty: no offload)',
} as const

/** The label of the per-endpoint schema in validation messages. */
const ENDPOINT_CONFIG_LABEL = 'an endpoint config of dsh-webhook-dispatcher'

/** The label of the top-level schema in validation messages. */
const CONFIG_LABEL = 'the dsh-webhook-dispatcher config'

/**
 * Wrap a schema so any object key beyond the declared set is a validation
 * failure: the loader would otherwise merge unknown keys into the validated
 * output, letting a patch-file typo (serer instead of server) pass silently.
 * The loader does not forward options into the transform callback, so
 * the error is raised with an empty option set; the message carries the unknown
 * key and the declared set.
 * @param inner the object schema to guard.
 * @param label the label used in the failure message.
 * @returns the guarded schema.
 */
function rejectUnknownKeys(inner: Schema, label: string): Schema {
  const declared = inner.dict ? Object.keys(inner.dict) : []
  const declaredSet = new Set(declared)
  return Schema.transform(inner, (value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!declaredSet.has(key)) {
          throw new Schema.ValidationError(
            `unknown key "${key}" in ${label} (known keys: ${declared.join(', ')})`,
            {},
          )
        }
      }
    }
    return value
  })
}

/** An integer in [min, max] (schemastery number schemas carry no integrality constraint). */
function integerField(min: number, max: number, description: string): Schema {
  return Schema.transform(Schema.number().min(min).max(max).description(description), (value) => {
    if (!Number.isInteger(value)) {
      throw new Schema.ValidationError(`${description} must be an integer`, {})
    }
    return value
  })
}

/** One endpoint of the config layer (unknown keys rejected). */
export const ENDPOINT_CONFIG = rejectUnknownKeys(
  Schema.object({
    id: Schema.string().pattern(ENDPOINT_ID_RE).description(ENDPOINT_FIELDS.id),
    path: Schema.string().pattern(ENDPOINT_PATH_RE).description(ENDPOINT_FIELDS.path),
    name: Schema.string().description(ENDPOINT_FIELDS.name),
    policy: Schema.string().description(ENDPOINT_FIELDS.policy),
    cwd: Schema.string().description(ENDPOINT_FIELDS.cwd),
    auth: Schema.string().description(ENDPOINT_FIELDS.auth),
    sandbox: Schema.string()
      .pattern(new RegExp(`^(${SANDBOX_MODES.join('|')})$`))
      .description(ENDPOINT_FIELDS.sandbox),
    model: Schema.string().description(ENDPOINT_FIELDS.model),
    maxConcurrent: integerField(1, 1000, ENDPOINT_FIELDS.maxConcurrent),
    maxQueue: integerField(0, 100000, ENDPOINT_FIELDS.maxQueue),
    maxBodyBytes: integerField(1, 10485760, ENDPOINT_FIELDS.maxBodyBytes),
    sessionRetention: Schema.string().description(ENDPOINT_FIELDS.sessionRetention),
  }),
  ENDPOINT_CONFIG_LABEL,
)

/** The static Config schema: the loader validates the delivered config layer against it (a violation fails the entry loudly). */
export const CONFIG = rejectUnknownKeys(
  Schema.object({
    endpoints: Schema.array(ENDPOINT_CONFIG).default([]).description('the webhook endpoints (empty: no routes registered)'),
  }),
  CONFIG_LABEL,
)

/** Built-in defaults for the optional endpoint fields. */
export const ENDPOINT_DEFAULTS = {
  maxConcurrent: 1,
  maxQueue: 100,
  maxBodyBytes: 262144,
} as const

// ---------------------------------------------------------------------------
// The DSH_WEBHOOK_* env contract
//
// One endpoint is declared with DSH_WEBHOOK_<ENDPOINT_ID>_<FIELD> variables:
// the id segment is the endpoint id uppercased with hyphens written as
// underscores (the id charset carries no underscore, so the mapping is
// one-to-one), the suffix is the config field in SCREAMING_SNAKE (the 1:1
// table below). The env channel is read once at plugin boot (a change needs
// a process restart); the cordis config layer is hot (a patch change
// disposes and re-constructs the entry, which re-reads both channels).
// Precedence per field: config layer > env > built-in default - the layer is
// materialized as synthetic variables over a copy of the env record (the
// dsh-email foldConfig pattern) and the merged record is parsed by the
// single authority below.
//
// Deliberate deviation from dsh-email: dsh-email drops a half-declared
// account with a warning; this plugin is fully fail-closed (the config
// layer's existing posture) - a recognized declaration missing PATH, or
// failing any other check, rejects the plugin at boot.

/** The env variable prefix of the contract. */
export const ENV_PREFIX = 'DSH_WEBHOOK_'

/** Config-layer field -> the env suffix it maps onto (the 1:1 table). */
export const CONFIG_FIELD_TO_ENV = {
  path: 'PATH',
  name: 'NAME',
  policy: 'POLICY',
  cwd: 'CWD',
  auth: 'AUTH',
  sandbox: 'SANDBOX',
  model: 'MODEL',
  maxConcurrent: 'MAX_CONCURRENT',
  maxQueue: 'MAX_QUEUE',
  maxBodyBytes: 'MAX_BODY_BYTES',
  sessionRetention: 'SESSION_RETENTION',
} as const

/** The recognized suffixes, longest first (the match is deterministic). */
const ENV_FIELD_SUFFIXES: readonly string[] = [
  'SESSION_RETENTION',
  'MAX_BODY_BYTES',
  'MAX_CONCURRENT',
  'MAX_QUEUE',
  'PATH',
  'NAME',
  'POLICY',
  'CWD',
  'AUTH',
  'SANDBOX',
  'MODEL',
]

/** The env form of an endpoint id segment (letter start, letters/digits, underscores standing for hyphens). */
const ENV_ID_SEG_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/

/** An unrecognized key that still looks like an endpoint declaration (an id segment plus an uppercase suffix). */
const ENV_DECLARATION_LIKE_RE = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*_[A-Z][A-Z_]*$/

/** One raw endpoint declaration accumulated from the env record. */
interface RawEndpoint {
  id: string
  /** Field suffix -> raw value. */
  fields: Record<string, string>
  /** Field suffix -> the env variable that set it (error messages). */
  vars: Record<string, string>
}

/** A non-negative integer within [min, max]; undefined = not of that shape. */
function parseIntBounded(value: string, min: number, max: number): number | undefined {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  if (n < min || n > max) return undefined
  return n
}

/**
 * Discover the DSH_WEBHOOK_* endpoint declarations in the env record: a key
 * is a declaration when a known field suffix matches at the tail and the
 * remaining segment is a valid endpoint id. The suffixes are tried longest
 * first, which makes the match deterministic for hyphenated ids
 * (DSH_WEBHOOK_CI_RUN_PATH = endpoint ci-run, field PATH; the one-word
 * suffixes can never be the tail of a multi-word field). A declared token
 * env (the AUTH value of any endpoint) is a credential value, not a
 * declaration: no warning for it. Any other declaration-like key (a
 * mistyped field, a malformed id) warns at boot.
 * @param env the env record (the process env at boot, or the merged record).
 * @param warn the boot-warning sink.
 * @returns the raw declarations, sorted by endpoint id.
 */
function parseEndpointEnv(env: Record<string, string | undefined>, warn: (msg: string) => void): RawEndpoint[] {
  const raw = new Map<string, RawEndpoint>()
  const unrecognized: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    if (!key.startsWith(ENV_PREFIX)) continue
    const rest = key.slice(ENV_PREFIX.length)
    let field: string | undefined
    let idSeg: string | undefined
    for (const suffix of ENV_FIELD_SUFFIXES) {
      if (rest.length <= suffix.length + 1) continue
      if (!rest.endsWith(`_${suffix}`)) continue
      const seg = rest.slice(0, rest.length - suffix.length - 1)
      if (!ENV_ID_SEG_RE.test(seg)) continue
      field = suffix
      idSeg = seg
      break
    }
    if (field === undefined || idSeg === undefined) {
      if (ENV_DECLARATION_LIKE_RE.test(rest)) unrecognized.push(key)
      continue
    }
    const id = idSeg.toLowerCase().replace(/_/g, '-')
    let e = raw.get(id)
    if (e === undefined) {
      e = { id, fields: {}, vars: {} }
      raw.set(id, e)
    }
    e.fields[field] = value
    e.vars[field] = key
  }
  const declaredAuth = new Set<string>()
  for (const e of raw.values()) {
    const auth = e.fields.AUTH
    if (auth !== undefined && auth.trim() !== '') declaredAuth.add(auth)
  }
  for (const key of unrecognized) {
    if (declaredAuth.has(key)) continue
    warn(
      `${ENV_PREFIX} variable "${key}" is not recognized as an endpoint declaration: ` +
        `expected ${ENV_PREFIX}<ENDPOINT_ID>_<FIELD> with FIELD one of ` +
        `${Object.values(CONFIG_FIELD_TO_ENV).join(', ')}; the endpoint id is a letter ` +
        'followed by letters, digits and hyphens',
    )
  }
  return [...raw.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Validate the raw declarations (both channels, after the merge) and apply
 * the built-in defaults:
 * - PATH is the only required field (a declaration without it rejects the
 *   boot - the fail-closed posture of the config layer),
 * - `path` is inside the route charset and not in the framework deny-list,
 * - `id` and `path` are unique across both channels,
 * - a present `name` must be non-empty (the default when absent is the id),
 * - a present `cwd` must be absolute (empty = the shared plugin workspace),
 * - a present `sandbox` must be a declared mode,
 * - the integer fields must be in bounds,
 * - a non-empty `auth` env name must be set to a non-empty value in the
 *   process env (fail-closed): a declared token that cannot be read rejects
 *   the boot rather than silently opening the route,
 * - `sessionRetention` is a raw retention window string: the boot checks its
 *   type only (any non-empty string passes), so an invalid window never
 *   rejects the endpoint; the offload plane warns and treats the window as 0
 *   (retain) when it loads.
 * An empty value of the other optional fields (policy / cwd / auth / model /
 * sessionRetention) behaves as absent.
 * @param raw the merged raw declarations (config layer over env).
 * @param env the process env: the auth presence check reads this record, not
 *   the merged one (a token value env can sit in the plugin namespace).
 * @returns the effective config (defaults applied).
 * @throws on any violation (the entry fails loudly).
 */
function buildEndpoints(raw: RawEndpoint[], env: Record<string, string | undefined>): ParsedConfig {
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  const endpoints: EndpointConfig[] = raw.map((e) => {
    if (seenIds.has(e.id)) {
      throw new Error(`${PLUGIN_NAME} config: duplicate endpoint id "${e.id}"`)
    }
    seenIds.add(e.id)
    const f = e.fields
    const path = f.PATH !== undefined && f.PATH.trim() !== '' ? f.PATH : undefined
    if (path === undefined) {
      throw new Error(
        `${PLUGIN_NAME} config: endpoint "${e.id}" has no path (declare ${ENV_PREFIX}${e.id.toUpperCase().replace(/-/g, '_')}_PATH or a config-layer path)`,
      )
    }
    if (!ENDPOINT_PATH_RE.test(path)) {
      throw new Error(
        `${PLUGIN_NAME} config: endpoint "${e.id}" path "${path}" is outside the route charset ` +
          '(a / followed by lowercase letters, digits, dots and dashes, in one or more segments)',
      )
    }
    if (seenPaths.has(path)) {
      throw new Error(`${PLUGIN_NAME} config: duplicate endpoint path "${path}"`)
    }
    seenPaths.add(path)
    let name: string
    if (f.NAME !== undefined) {
      if (f.NAME === '') {
        throw new Error(`${PLUGIN_NAME} config: endpoint "${e.id}" name must be a non-empty string`)
      }
      name = f.NAME
    } else {
      name = e.id
    }
    const policy = f.POLICY ?? ''
    const cwd = f.CWD ?? ''
    if (cwd !== '' && !cwd.startsWith('/')) {
      throw new Error(`${PLUGIN_NAME} config: endpoint "${e.id}" cwd "${cwd}" must be an absolute path (or empty)`)
    }
    if (isFrameworkRoute(path)) {
      throw new Error(
        `${PLUGIN_NAME} config: endpoint "${e.id}" path "${path}" is owned by the framework ` +
          `webServer (exact deny: ${[...FRAMEWORK_EXACT_ROUTE_DENY].join(', ')}; ` +
          `prefix deny roots: ${FRAMEWORK_PREFIX_ROUTE_DENY.join(', ')})`,
      )
    }
    let sandbox: SandboxMode | undefined
    if (f.SANDBOX !== undefined && f.SANDBOX !== '') {
      if (!(SANDBOX_MODES as readonly string[]).includes(f.SANDBOX)) {
        throw new Error(
          `${PLUGIN_NAME} config: endpoint "${e.id}" sandbox "${f.SANDBOX}" is not a valid mode ` +
            `(expected: ${SANDBOX_MODES.join(' | ')}) (variable ${e.vars.SANDBOX})`,
        )
      }
      sandbox = f.SANDBOX as SandboxMode
    }
    const model = f.MODEL !== undefined && f.MODEL !== '' ? f.MODEL : undefined
    const int = (
      field: 'maxConcurrent' | 'maxQueue' | 'maxBodyBytes',
      suffix: string,
      min: number,
      max: number,
      def: number,
    ): number => {
      const value = f[suffix]
      if (value === undefined || value.trim() === '') return def
      const n = parseIntBounded(value, min, max)
      if (n === undefined) {
        throw new Error(
          `${PLUGIN_NAME} config: endpoint "${e.id}" ${field} "${value}" is not an integer in [${min}, ${max}] ` +
            `(variable ${e.vars[suffix]})`,
        )
      }
      return n
    }
    const sessionRetention =
      f.SESSION_RETENTION !== undefined && f.SESSION_RETENTION !== '' ? f.SESSION_RETENTION : undefined
    const auth = f.AUTH ?? ''
    if (auth !== '') {
      const value = env[auth]
      if (value === undefined || value === '') {
        throw new Error(
          `${PLUGIN_NAME} config: endpoint "${e.id}" auth env "${auth}" is not set or empty ` +
            '(fail-closed: the endpoint would open without a token)',
        )
      }
    }
    return {
      id: e.id,
      path,
      name,
      policy,
      cwd,
      auth,
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(model !== undefined ? { model } : {}),
      maxConcurrent: int('maxConcurrent', 'MAX_CONCURRENT', 1, 1000, ENDPOINT_DEFAULTS.maxConcurrent),
      maxQueue: int('maxQueue', 'MAX_QUEUE', 0, 100000, ENDPOINT_DEFAULTS.maxQueue),
      maxBodyBytes: int('maxBodyBytes', 'MAX_BODY_BYTES', 1, 10485760, ENDPOINT_DEFAULTS.maxBodyBytes),
      ...(sessionRetention !== undefined ? { sessionRetention } : {}),
    }
  })
  return { endpoints }
}

/**
 * Fold the config channels into the effective config: built-in defaults <
 * the DSH_WEBHOOK_* env contract (read once at boot) < the delivered cordis
 * config layer (hot). The layer is materialized as synthetic env variables
 * written over a copy of the env record (a delivered value beats the env
 * value, which beats the built-in default; fields the layer omits resolve as
 * the env contract), and the merged record is parsed by the single authority
 * (parseEndpointEnv + buildEndpoints). Duplicate endpoint ids inside the
 * layer are rejected before the merge (the merge would fold the two rows
 * into one endpoint). The input env record is not mutated.
 * @param env the env record (process.env at boot; test-injectable).
 * @param delivered the loader-validated delivered config layer (may be undefined).
 * @param warn the boot-warning sink (unrecognized DSH_WEBHOOK_ variables).
 * @returns the effective config (defaults applied).
 * @throws on any cross-endpoint violation (the entry fails loudly).
 */
export function foldConfig(
  env: Record<string, string | undefined>,
  delivered: DeliveredConfig | undefined,
  warn: (msg: string) => void,
): ParsedConfig {
  const layer = isPlainObject(delivered) && Array.isArray(delivered.endpoints) ? delivered.endpoints : []
  const layerIds = new Set<string>()
  for (const e of layer) {
    if (layerIds.has(e.id)) {
      throw new Error(`${PLUGIN_NAME} config: duplicate endpoint id "${e.id}"`)
    }
    layerIds.add(e.id)
  }
  const merged: Record<string, string | undefined> = { ...env }
  for (const e of layer) {
    const idSeg = e.id.toUpperCase().replace(/-/g, '_')
    for (const [key, value] of Object.entries(e) as [string, string | number | undefined][]) {
      if (key === 'id') continue
      if (value === undefined) continue
      const suffix = (CONFIG_FIELD_TO_ENV as Record<string, string | undefined>)[key]
      if (suffix === undefined) continue
      merged[`${ENV_PREFIX}${idSeg}_${suffix}`] = typeof value === 'number' ? String(value) : value
    }
  }
  const raw = parseEndpointEnv(merged, warn)
  return buildEndpoints(raw, env)
}
