# dsh-webhook-dispatcher

dsh-webhook-dispatcher gives a dsh deployment inbound webhook dispatch: when
an HTTP caller reaches one of the plugin's endpoints, a fresh, isolated agent
session handles the delivered content. External systems such as CI pipelines,
issue trackers, or monitoring tools can drive dsh sessions directly - no
per-service bridge code.

- Endpoints are exact routes on the profile's webServer service (the Web GUI
  server in the web profile; other profiles compose
  @deepseek-ai/dsh-host-webserver - see Cross-profile deployment); external
  reachability is the operator's reverse-proxy decision
- Per-endpoint configuration: identity (id / path / name), token auth, policy
  text, working directory, sandbox, model, and resource limits
- Each admitted delivery spawns a fresh agent session; per-endpoint
  concurrency and queue caps, with `429` + `Retry-After` backpressure
- A single `webhook status` tool verb reports live routes, queue depth, and
  recent delivery history; the plugin creates no config files
- Session offload: a per-minute sweep archives settled trigger sessions that
  outlived the endpoint's `sessionRetention` window, keeping the framework
  session store bounded

## Installation

dsh-webhook-dispatcher is an out-of-tree plugin for a dsh profile. Install it
with the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-webhook-dispatcher
```

Configure endpoints through the `DSH_WEBHOOK_*` env block and/or the cordis
config layer (see Configuration).

## Cross-profile deployment

Endpoints register as exact routes on the profile's `webServer` service. The
`web` profile provides it through the Web GUI server; every other profile
(`sdk`, `acp`, a custom bundle) must compose a `webServer` provider into its
own composition - the framework's route server
`@deepseek-ai/dsh-host-webserver` (see its own docs). One-shot surfaces such
as `headless` cannot host a resident listener, so they cannot host this plugin:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml (example)
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: <host>
        port: <port>  # a free fixed port; port 0 re-resolves the bound address on every restart
```

## Configuration

Endpoints are configured through two equal channels that fold onto one
contract: the `DSH_WEBHOOK_*` env block (read once at process boot) and the
cordis config layer (the profile/user `cordis.patch.yml` entry targeting the
plugin id `dsh-webhook-dispatcher`; hot - a patch change re-constructs the
plugin entry, which re-reads both channels). Precedence per field: config
layer > env > built-in defaults.

### Config layer

```yaml
- id: dsh-webhook-dispatcher
  config:
    endpoints:
      - id: <name>
        path: /<path>
        policy: "Treat the content as a task description and act on it."
        # name: <name>           (default: the id)
        # cwd: /abs/path         (default: $DSH_HOME/dsh-webhook-dispatcher)
        # auth: <TOKEN_ENV>           (env var NAME holding the token value; empty = open endpoint)
        # sandbox: workspace-write    (read-only | workspace-write | danger-full-access)
        # model: some/model           (default: the default selection ladder)
        # maxConcurrent: 1            (default)
        # maxQueue: 100               (default)
        # maxBodyBytes: 262144        (default)
        # sessionRetention: 24h       (session offload window; absent/0 = retain in the store)
```

Unknown keys are rejected (a typo guard); `path` must not collide with a
framework-owned route.

### Env contract

The same endpoint shape as `DSH_WEBHOOK_<ENDPOINT_ID>_<FIELD>` variables:

```sh
DSH_WEBHOOK_<NAME>_PATH=/<path>
DSH_WEBHOOK_<NAME>_POLICY="Treat the content as a task description and act on it."
DSH_WEBHOOK_<NAME>_AUTH=<TOKEN_ENV>   # the NAME of the env holding the token value
DSH_WEBHOOK_<NAME>_MODEL=some/model
<TOKEN_ENV>=...
```

| field | env suffix | built-in default |
| --- | --- | --- |
| `path` (required) | `PATH` | - |
| `name` | `NAME` | the id |
| `policy` | `POLICY` | empty (free-policy fallback) |
| `cwd` | `CWD` | `$DSH_HOME/dsh-webhook-dispatcher` |
| `auth` | `AUTH` | empty (open endpoint) |
| `sandbox` | `SANDBOX` | the session default |
| `model` | `MODEL` | the default selection ladder |
| `maxConcurrent` | `MAX_CONCURRENT` | 1 |
| `maxQueue` | `MAX_QUEUE` | 100 |
| `maxBodyBytes` | `MAX_BODY_BYTES` | 262144 |
| `sessionRetention` | `SESSION_RETENTION` | absent (retain in the store) |

- The id segment is the endpoint id uppercased with hyphens written as
  underscores (`ci-run` -> `DSH_WEBHOOK_CI_RUN_*`)
- Both channels share one validator: a declaration without `PATH`, an
  out-of-bounds value, or a declared `AUTH` name that is not set fails the
  plugin at boot (fail-closed, the config layer's posture)
- A declared token env produces no warning; any other mistyped
  `DSH_WEBHOOK_` variable warns at boot

## Tool

`webhook { verb: "status" }` - the live endpoint state, the recent-delivery
ring, and the effective (non-secret) endpoint config. See the
`dsh-webhook-dispatcher` skill for the full reference.

## Session offload

Webhook dispatches leave on-disk session logs in the framework session store;
at delivery volume (frequent or chatty endpoints) the store grows without
bound. The per-minute offload sweep archives settled trigger sessions once
their endpoint's `sessionRetention` window elapses, so the store stays
bounded: the store is never deleted, only moved, and a session that is still
running is kept until it settles.

- **Windows**: `sessionRetention` is per-endpoint (the config layer's
  `sessionRetention` field or the env
  `DSH_WEBHOOK_<ID>_SESSION_RETENTION`): a non-negative integer number of
  milliseconds, or a duration string of 1-2 digits+unit segments (units
  d/h/m/s/ms) in descending order (e.g. `24h`, `4h30m`, `90s`, `5000ms`;
  a bare numeric string is invalid). 0 / absent = retain (no offload); an
  invalid value warns and is treated as 0 (never a boot failure).
- **Budget**: `DSH_WEBHOOK_OFFLOAD_BATCH` (env, default 50) bounds the
  sessions one sweep may process; an invalid value warns and falls back to
  50, never disabling the sweep. When consecutive sweeps observe new log
  lines arriving faster than the budget, the sweep logs a trend warning
  (raise the knob or lower the retention windows; the warning takes no
  action on its own).
- **Failure semantics**: an unreachable persistence service, a missing store
  root, or an archive on a different mount disables the sweep for that round
  (a visible warning; log lines are never lost); a failed individual move is
  retried next round.

The offload state (retention log `retention-log.jsonl`, archive
`archived-sessions/`, and the default trigger-session workspace) lives under
the plugin home `$DSH_HOME/dsh-webhook-dispatcher/`. The selftest covers the
offload plane as well (window parsing, retention-log mechanics, the sweep's
window/liveness/budget/trend semantics, the dispatch write gate, the archive
move, and the layout pin).

## Development

```
pnpm install     # peers resolve from the registry (onboarding .npmrc / pnpm-workspace.yaml)
pnpm run build   # tsc -> lib/
pnpm run typecheck
pnpm run lint    # eslint over src/ and test/
pnpm run selftest
```

Peer resolution is a deliberate dev/staged pair: the dev tree keeps
`autoInstallPeers: true` so the peer closure resolves from the package's own
`node_modules` (needed for the in-tree typecheck); the staged deployment tree
ships `autoInstallPeers: false` plus `.npmrc legacy-peer-deps=true`, so peers
resolve from the enclosing plugin tree of the deployment, like every
neighbor plugin.
