// dsh-webhook-dispatcher shared utilities: the plugin identity, the config
// grammar constants, and the framework route deny-list.
// The deny-list is source-verified against the web-profile
// route owners on the main webServer (dsh-client-connection,
// dsh-client-hmr, dsh-client-modules, dsh-deepseek-account-platform,
// dsh-host-open-in-app). It is data, not a scan: the framework's route set
// is static per release. A deny-list miss has two halves: a miss on a
// framework exact route fails loudly (a duplicate exact registration throws
// at the framework level); a miss on a framework prefix namespace shadows
// it silently, so the prefix roots are extended as the framework grows.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin identity (npm package name = plugin id = skill name). */
export const PLUGIN_NAME = 'dsh-webhook-dispatcher'

/** Endpoint id: lowercase start, 1-32 chars (the dsh-timer/dsh-email name rule). */
export const ENDPOINT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Endpoint path: absolute, lowercase a-z0-9._- segment charset, no trailing
 * slash, no query/fragment. Query strings are ignored at routing (the
 * framework dispatches on the pathname), so /gh?x=1 routes to /gh.
 */
export const ENDPOINT_PATH_RE = /^\/[a-z0-9._-]+(\/[a-z0-9._-]+)*$/

// The per-session sandbox modes: single source of truth = the framework's
// dsh-sandbox-policy export (1:1 with the deployment permission presets), so
// a mode added by a framework release is accepted by the validation without
// a plugin change.
export { SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'

/** The recent-delivery ring cap: per-endpoint and the aggregated status view (single source). */
export const RING_CAP = 50

/**
 * Framework-owned exact routes on the main webServer (source scan):
 * /api (dsh-client-connection; its per-channel RPC routes live under the /api
 * prefix), /plugins/events (dsh-client-hmr), /open-in-app/apps and
 * /open-in-app/open (dsh-host-open-in-app), /api/v0/users/get_user_summary,
 * /auth-api/v0/users/current and /oauth/callback
 * (dsh-deepseek-account-platform). An endpoint path equal to any of these
 * would shadow the framework route (exact dispatch wins) or throw at
 * registration, so the config validation rejects it.
 */
export const FRAMEWORK_EXACT_ROUTE_DENY = new Set<string>([
  '/api',
  '/plugins/events',
  '/open-in-app/apps',
  '/open-in-app/open',
  '/api/v0/users/get_user_summary',
  '/auth-api/v0/users/current',
  '/oauth/callback',
])

/**
 * Framework-owned prefix routes (source scan): /api
 * (dsh-client-connection), /plugins (dsh-client-modules bundle serving),
 * /open-in-app/icon (dsh-host-open-in-app). An endpoint path equal to a
 * root or under it is rejected: exact dispatch would win over the prefix
 * route and shadow the framework functionality.
 */
export const FRAMEWORK_PREFIX_ROUTE_DENY = [
  '/api',
  '/plugins',
  '/open-in-app/icon',
]

/** True when `path` collides with a framework-owned route. */
export function isFrameworkRoute(path: string): boolean {
  if (FRAMEWORK_EXACT_ROUTE_DENY.has(path)) return true
  for (const root of FRAMEWORK_PREFIX_ROUTE_DENY) {
    if (path === root || path.startsWith(`${root}/`)) return true
  }
  return false
}

/** True when `value` is a plain object (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The single-line error-message helper (the framework error text convention). */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Absolute package root: src/ (development) and lib/ (deployment) both sit
 * below the package root, so '..' from this file's directory is the package
 * root in both states.
 * @returns absolute package root path.
 */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}
