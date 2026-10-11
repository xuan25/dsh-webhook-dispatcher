// dsh-webhook-dispatcher selftest (G2): strict ASCII hygiene, the config
// surface (schema + cross-validation + defaults), the handover slot, the
// prompt template (byte-strict), the pipeline lifecycle (queue / slots /
// handover / settlement via injected deps), the handler matrix (the rejection
// total order against mock request/response pairs), and the plugin
// integration face (routing on a fake webServer, the production
// trigger-session spawn lifecycle, and the degradation paths).
// Runs against the built lib/ (run `pnpm run build` first).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(path.join(root, 'lib', 'index.js'))
const {
  CONFIG,
  DshWebhookDispatcherPlugin,
  EndpointPipeline,
  buildPrompt,
  createHandler,
  dropHandoverSlot,
  foldConfig,
  stashHandover,
  takeHandoverSlot,
} = mod

let checks = 0
function ok(name, fn) {
  try {
    fn()
    checks += 1
    console.log(`  ok ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`)
    process.exitCode = 1
  }
}
function throws(name, fn) {
  try {
    fn()
    console.error(`  FAIL ${name}: expected a throw, none raised`)
    process.exitCode = 1
  } catch (err) {
    checks += 1
    console.log(`  ok ${name} (throws: ${String(err.message).slice(0, 80)})`)
  }
}

// ---------------------------------------------------------------- ASCII
// The strict gate: no char above U+007F in any shipped file (a language
// subset regex is a stand-in, not a gate - it would let through every other
// non-ASCII symbol).
console.log('ascii hygiene (strict: no char above U+007F in any shipped file)')
function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const scanned = [
  ...walk(path.join(root, 'src'), []),
  ...walk(path.join(root, 'test'), []),
  ...(existsSync(path.join(root, 'lib')) ? walk(path.join(root, 'lib'), []) : []),
  ...walk(path.join(root, 'skill'), []),
  path.join(root, 'README.md'),
  path.join(root, 'cordis.patch.yml'),
  path.join(root, 'package.json'),
  path.join(root, 'tsconfig.json'),
  path.join(root, 'eslint.config.js'),
  path.join(root, '.npmrc'),
  path.join(root, 'pnpm-workspace.yaml'),
]
for (const p of scanned) {
  const rel = path.relative(root, p)
  ok(`no non-ASCII in ${rel}`, () => {
    const text = readFileSync(p, 'utf8')
    const off = text.search(/[\u0080-\uFFFF]/)
    assert.equal(off, -1, `non-ASCII char at offset ${off} of ${rel}`)
  })
}

// ---------------------------------------------------------------- plugin class
console.log('plugin class surface')
ok('static name = dsh-webhook-dispatcher', () => assert.equal(DshWebhookDispatcherPlugin.name, 'dsh-webhook-dispatcher'))
ok('static inject', () => {
  assert.deepEqual([...DshWebhookDispatcherPlugin.inject], ['webServer', 'tools', 'skills', 'systemPrompt'])
})
ok('static Config present', () => assert.ok(DshWebhookDispatcherPlugin.Config))

// ---------------------------------------------------------------- config surface
console.log('config surface (schema + cross-validation + defaults)')
// schemastery follows the standard-schema spec: validate never throws, it
// returns { value } or { issues }. The cordis loader treats issues as a
// validation failure; the selftest mirrors that.
const validate = (value) => {
  const result = CONFIG['~standard'].validate(value)
  if ('issues' in result) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '))
  }
  return result.value
}

ok('zero-endpoint config accepted', () => {
  const cfg = foldConfig({}, validate({ endpoints: [] }), () => {})
  assert.deepEqual(cfg.endpoints, [])
})
ok('minimal endpoint gets the built-in defaults', () => {
  const cfg = foldConfig({}, validate({ endpoints: [{ id: 'gh', path: '/gh' }] }), () => {})
  assert.deepEqual(cfg.endpoints[0], {
    id: 'gh',
    path: '/gh',
    name: 'gh',
    policy: '',
    cwd: '',
    auth: '',
    maxConcurrent: 1,
    maxQueue: 100,
    maxBodyBytes: 262144,
  })
})
ok('explicit values beat the defaults', () => {
  const cfg = foldConfig(
    { T: 'secret' },
    validate({
      endpoints: [
        {
          id: 'gh',
          path: '/gh/v2',
          name: 'GitHub',
          policy: 'act on it',
          cwd: '/workspace',
          auth: 'T',
          sandbox: 'read-only',
          model: 'some/model',
          maxConcurrent: 4,
          maxQueue: 0,
          maxBodyBytes: 1024,
        },
      ],
    }),
    () => {},
  )
  assert.deepEqual(cfg.endpoints[0], {
    id: 'gh',
    path: '/gh/v2',
    name: 'GitHub',
    policy: 'act on it',
    cwd: '/workspace',
    auth: 'T',
    sandbox: 'read-only',
    model: 'some/model',
    maxConcurrent: 4,
    maxQueue: 0,
    maxBodyBytes: 1024,
  })
})
for (const [label, endpoint] of [
  ['uppercase id', { id: 'GH', path: '/a' }],
  ['id starting with a digit', { id: '1gh', path: '/a' }],
  ['id over 32 chars', { id: `a${'b'.repeat(32)}`, path: '/a' }],
  ['relative path', { id: 'gh', path: 'gh' }],
  ['uppercase path segment', { id: 'gh', path: '/GH' }],
  ['trailing-slash path', { id: 'gh', path: '/gh/' }],
  ['empty path', { id: 'gh', path: '' }],
  ['path with a space', { id: 'gh', path: '/gh x' }],
  ['unknown sandbox mode', { id: 'gh', path: '/gh', sandbox: 'full' }],
  ['maxConcurrent below 1', { id: 'gh', path: '/gh', maxConcurrent: 0 }],
  ['maxConcurrent above the bound', { id: 'gh', path: '/gh', maxConcurrent: 1001 }],
  ['maxConcurrent fractional', { id: 'gh', path: '/gh', maxConcurrent: 2.5 }],
  ['maxQueue negative', { id: 'gh', path: '/gh', maxQueue: -1 }],
  ['maxBodyBytes zero', { id: 'gh', path: '/gh', maxBodyBytes: 0 }],
  ['maxBodyBytes above the bound', { id: 'gh', path: '/gh', maxBodyBytes: 2 ** 24 }],
]) {
  throws(`schema rejects ${label}`, () => validate({ endpoints: [endpoint] }))
}
ok('schema rejects an unknown key (typo guard)', () => {
  try {
    validate({ endpoints: [{ id: 'gh', path: '/gh', serer: 'x' }] })
    assert.fail('unknown key passed')
  } catch (err) {
    assert.match(String(err.message), /unknown key "serer"/)
  }
})
ok('schema rejects an unknown top-level key', () => {
  try {
    validate({ endpoints: [], endpointz: [] })
    assert.fail('unknown key passed')
  } catch (err) {
    assert.match(String(err.message), /unknown key "endpointz"/)
  }
})
for (const [label, path] of [
  ['exact /api', '/api'],
  ['prefix /plugins', '/plugins'],
  ['under /plugins', '/plugins/events'],
  ['under /open-in-app/icon', '/open-in-app/icon/x.png'],
  ['exact /open-in-app/apps', '/open-in-app/apps'],
  ['exact /oauth/callback', '/oauth/callback'],
]) {
  throws(`deny-list rejects ${label}`, () =>
    foldConfig({}, { endpoints: [{ id: 'gh', path: path }] }, () => {}),
  )
}
ok('paths under /api/v0 but not framework-owned are still rejected by the prefix root', () => {
  throws('rejects /api/v0/anything', () => foldConfig({}, { endpoints: [{ id: 'a', path: '/api/v0/anything' }] }, () => {}))
})
ok('a distinctive path passes the deny-list', () => {
  const cfg = foldConfig({}, { endpoints: [{ id: 'gh', path: '/hooks/gh' }] }, () => {})
  assert.equal(cfg.endpoints[0].path, '/hooks/gh')
})
throws('duplicate endpoint id', () =>
  foldConfig({}, { endpoints: [{ id: 'gh', path: '/a' }, { id: 'gh', path: '/b' }] }, () => {}),
)
throws('duplicate endpoint path', () =>
  foldConfig({}, { endpoints: [{ id: 'a', path: '/x' }, { id: 'b', path: '/x' }] }, () => {}),
)
throws('auth env not set', () => foldConfig({}, { endpoints: [{ id: 'gh', path: '/gh', auth: 'MISSING' }] }, () => {}))
throws('auth env empty', () => foldConfig({ T: '' }, { endpoints: [{ id: 'gh', path: '/gh', auth: 'T' }] }, () => {}))
ok('auth env set', () => {
  const cfg = foldConfig({ T: 'secret' }, { endpoints: [{ id: 'gh', path: '/gh', auth: 'T' }] }, () => {})
  assert.equal(cfg.endpoints[0].auth, 'T')
})
throws('an empty name is rejected (cross-validation)', () =>
  foldConfig({}, { endpoints: [{ id: 'gh', path: '/gh', name: '' }] }, () => {}),
)
throws('a relative cwd is rejected (cross-validation)', () =>
  foldConfig({}, { endpoints: [{ id: 'gh', path: '/gh', cwd: 'relative/dir' }] }, () => {}),
)
ok('an absolute cwd is accepted', () => {
  const cfg = foldConfig({}, { endpoints: [{ id: 'gh', path: '/gh', cwd: '/tmp/wh' }] }, () => {})
  assert.equal(cfg.endpoints[0].cwd, '/tmp/wh')
})
ok('the numeric caps are the schema bounds (1000 / 100000 / 10 MiB)', () => {
  const cfg = foldConfig(
    {},
    validate({ endpoints: [{ id: 'gh', path: '/gh', maxConcurrent: 1000, maxQueue: 100000, maxBodyBytes: 10485760 }] }),
    () => {},
  )
  assert.equal(cfg.endpoints[0].maxConcurrent, 1000)
  assert.equal(cfg.endpoints[0].maxQueue, 100000)
  assert.equal(cfg.endpoints[0].maxBodyBytes, 10485760)
})

// ---------------------------------------------------------------- env contract
// The DSH_WEBHOOK_* env channel (v2.4): the same endpoint shape declared as
// DSH_WEBHOOK_<ENDPOINT_ID>_<FIELD> variables; precedence config layer >
// env > built-in defaults; fully fail-closed like the config layer.
console.log('env contract (DSH_WEBHOOK_* channel)')

ok('env-only endpoint gets the built-in defaults', () => {
  const cfg = foldConfig(
    { DSH_WEBHOOK_GH_PATH: '/hooks/gh', DSH_WEBHOOK_GH_POLICY: 'act on it' },
    undefined,
    () => {},
  )
  assert.deepEqual(cfg.endpoints, [
    {
      id: 'gh',
      path: '/hooks/gh',
      name: 'gh',
      policy: 'act on it',
      cwd: '',
      auth: '',
      maxConcurrent: 1,
      maxQueue: 100,
      maxBodyBytes: 262144,
    },
  ])
})
ok('hyphenated id: DSH_WEBHOOK_CI_RUN_PATH declares endpoint ci-run', () => {
  const cfg = foldConfig({ DSH_WEBHOOK_CI_RUN_PATH: '/ci/run' }, undefined, () => {})
  assert.equal(cfg.endpoints[0].id, 'ci-run')
})
ok('per-field precedence: config layer beats env, env beats defaults', () => {
  const cfg = foldConfig(
    { DSH_WEBHOOK_GH_PATH: '/env', DSH_WEBHOOK_GH_POLICY: 'env-policy', DSH_WEBHOOK_GH_MODEL: 'env/model' },
    validate({ endpoints: [{ id: 'gh', path: '/cfg', model: 'cfg/model', maxConcurrent: 3 }] }),
    () => {},
  )
  assert.deepEqual(cfg.endpoints[0], {
    id: 'gh',
    path: '/cfg', // config beats env
    name: 'gh',
    policy: 'env-policy', // env-only field survives the merge
    cwd: '',
    auth: '',
    model: 'cfg/model', // config beats env
    maxConcurrent: 3,
    maxQueue: 100,
    maxBodyBytes: 262144,
  })
})
ok('two channels, two endpoints: the union of ids', () => {
  const cfg = foldConfig(
    { DSH_WEBHOOK_BB_PATH: '/b' },
    validate({ endpoints: [{ id: 'aa', path: '/a' }] }),
    () => {},
  )
  assert.deepEqual(cfg.endpoints.map((e) => e.id), ['aa', 'bb'])
})
ok('empty optional env values behave as absent', () => {
  const cfg = foldConfig(
    { DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_SANDBOX: '', DSH_WEBHOOK_GH_MODEL: '' },
    undefined,
    () => {},
  )
  assert.equal('sandbox' in cfg.endpoints[0], false)
  assert.equal('model' in cfg.endpoints[0], false)
})
throws('an env declaration without PATH rejects the boot', () =>
  foldConfig({ DSH_WEBHOOK_GH_POLICY: 'x' }, undefined, () => {}),
)
throws('an empty PATH env behaves as missing', () => foldConfig({ DSH_WEBHOOK_GH_PATH: '' }, undefined, () => {}))
throws('an env path outside the route charset', () => foldConfig({ DSH_WEBHOOK_GH_PATH: '/GH' }, undefined, () => {}))
throws('an env path on the framework deny-list', () => foldConfig({ DSH_WEBHOOK_GH_PATH: '/plugins' }, undefined, () => {}))
ok('an id present on both channels merges into one endpoint (config fields win, env-only fields survive)', () => {
  const cfg = foldConfig(
    { DSH_WEBHOOK_GH_PATH: '/env', DSH_WEBHOOK_GH_MODEL: 'env/model' },
    validate({ endpoints: [{ id: 'gh', path: '/cfg' }] }),
    () => {},
  )
  assert.equal(cfg.endpoints.length, 1)
  assert.equal(cfg.endpoints[0].path, '/cfg')
  assert.equal(cfg.endpoints[0].model, 'env/model')
})
throws('an env path colliding with a config-layer path', () =>
  foldConfig({ DSH_WEBHOOK_LM_PATH: '/x' }, validate({ endpoints: [{ id: 'gh', path: '/x' }] }), () => {}),
)
throws('an env sandbox outside the declared modes', () =>
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_SANDBOX: 'full' }, undefined, () => {}),
)
throws('an env integer outside the shape (MAX_QUEUE=abc)', () =>
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_MAX_QUEUE: 'abc' }, undefined, () => {}),
)
throws('an env integer below the bound (MAX_CONCURRENT=0)', () =>
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_MAX_CONCURRENT: '0' }, undefined, () => {}),
)
throws('an env auth name that is not set rejects the boot (fail-closed)', () =>
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_AUTH: 'NO_SUCH_ENV' }, undefined, () => {}),
)
throws('an env auth name that is empty rejects the boot (fail-closed)', () =>
  foldConfig({ GH_TOK: '', DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_AUTH: 'GH_TOK' }, undefined, () => {}),
)
ok('an env auth name that is set: the NAME is carried, the value is not', () => {
  const cfg = foldConfig(
    { GH_TOK: 'secret', DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_AUTH: 'GH_TOK' },
    undefined,
    () => {},
  )
  assert.equal(cfg.endpoints[0].auth, 'GH_TOK')
})
throws('an empty NAME env value is rejected (the config-layer posture)', () =>
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_NAME: '' }, undefined, () => {}),
)
ok('a declared token env in the plugin namespace stays quiet', () => {
  const warnings = []
  foldConfig(
    {
      DSH_WEBHOOK_GH_TOKEN: 'secret',
      DSH_WEBHOOK_GH_PATH: '/g',
      DSH_WEBHOOK_GH_AUTH: 'DSH_WEBHOOK_GH_TOKEN',
    },
    undefined,
    (msg) => warnings.push(msg),
  )
  assert.deepEqual(warnings, [])
})
ok('a mistyped env field warns at boot', () => {
  const warnings = []
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_POLCI: 'x' }, undefined, (msg) => warnings.push(msg))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /DSH_WEBHOOK_GH_POLCI/)
})
ok('a DSH_WEBHOOK_ key without an uppercase field suffix stays quiet', () => {
  const warnings = []
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_TOKEN2: 'x' }, undefined, (msg) => warnings.push(msg))
  assert.deepEqual(warnings, [])
})
ok('the input env record is not mutated by the fold', () => {
  const env = { DSH_WEBHOOK_GH_PATH: '/g' }
  foldConfig(env, validate({ endpoints: [{ id: 'gh', model: 'm' }] }), () => {})
  assert.deepEqual(env, { DSH_WEBHOOK_GH_PATH: '/g' })
})
ok('zero env and zero config: zero endpoints (the no-op posture is unchanged)', () => {
  const cfg = foldConfig({}, undefined, () => {})
  assert.deepEqual(cfg.endpoints, [])
})
ok('the longest suffix wins: DSH_WEBHOOK_GH_MAX_QUEUE = endpoint gh, field MAX_QUEUE', () => {
  const cfg = foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_MAX_QUEUE: '7' }, undefined, () => {})
  assert.equal(cfg.endpoints[0].id, 'gh')
  assert.equal(cfg.endpoints[0].maxQueue, 7)
})
ok('a hyphenated id plus a multi-word field: DSH_WEBHOOK_X_MAX_MAX_QUEUE = endpoint x-max, field MAX_QUEUE', () => {
  const cfg = foldConfig(
    { DSH_WEBHOOK_X_MAX_PATH: '/x', DSH_WEBHOOK_X_MAX_MAX_QUEUE: '5' },
    undefined,
    () => {},
  )
  assert.equal(cfg.endpoints[0].id, 'x-max')
  assert.equal(cfg.endpoints[0].maxQueue, 5)
})

// ---------------------------------------------------------------- handover slot
console.log('handover slot')
dropHandoverSlot()
ok('take on an empty slot is null', () => assert.equal(takeHandoverSlot(), null))
stashHandover({ pipelines: { gh: { queued: [], inFlight: [], ring: [] } } })
ok('stash then take round-trips and clears', () => {
  const taken = takeHandoverSlot()
  assert.deepEqual(taken, { pipelines: { gh: { queued: [], inFlight: [], ring: [] } } })
  assert.equal(takeHandoverSlot(), null)
})

// ---------------------------------------------------------------- prompt template
console.log('prompt template (byte-strict)')
const promptCfg = {
  id: 'gh',
  path: '/hooks/gh',
  name: 'GitHub',
  policy: '',
  cwd: '',
  auth: '',
  maxConcurrent: 1,
  maxQueue: 100,
  maxBodyBytes: 1024,
}
const RULES = 'Execution rules: see the "Trigger session" section of the dsh-webhook-dispatcher skill.'
ok('prompt: delivery with content, no policy', () => {
  const text = buildPrompt(promptCfg, { contentType: 'application/json', bytes: 7, content: '{"a":1}' })
  assert.equal(
    text,
    [
      '<dsh-webhook-dispatcher> delivery from endpoint "GitHub" (/hooks/gh):',
      'Content-Type: application/json',
      'Bytes: 7',
      '',
      '```',
      '{"a":1}',
      '```',
      '',
      RULES,
    ].join('\n'),
  )
})
ok('prompt: no-content delivery + policy block', () => {
  const text = buildPrompt({ ...promptCfg, policy: 'act on it' }, { contentType: 'application/x-www-form-urlencoded', bytes: 0 })
  assert.equal(
    text,
    [
      '<dsh-webhook-dispatcher> delivery from endpoint "GitHub" (/hooks/gh):',
      '(no content)',
      '',
      'Policy:',
      'act on it',
      '',
      RULES,
    ].join('\n'),
  )
})
ok('prompt: no-content GET, no policy', () => {
  const text = buildPrompt(promptCfg, null)
  assert.equal(
    text,
    ['<dsh-webhook-dispatcher> delivery from endpoint "GitHub" (/hooks/gh):', '(no content)', '', RULES].join('\n'),
  )
})
ok('prompt: an empty policy omits the block', () => {
  const text = buildPrompt(promptCfg, { contentType: 'text/plain', bytes: 3, content: 'abc' })
  assert.ok(!text.includes('Policy:'))
})
ok('prompt: unknown content-type renders as "unknown"', () => {
  const text = buildPrompt(promptCfg, { contentType: '', bytes: 3, content: 'abc' })
  assert.match(text, /Content-Type: unknown\nBytes: 3\n/)
})
ok('prompt: the fence outgrows the longest backtick run in the content', () => {
  const content = 'a``b````c'
  const text = buildPrompt(promptCfg, { contentType: 'text/plain', bytes: content.length, content })
  assert.match(text, /\n`````\na``b````c\n`````\n/)
})
ok('prompt: a three-tick content run forces a four-tick fence', () => {
  const content = 'x```y'
  const text = buildPrompt(promptCfg, { contentType: 'text/plain', bytes: content.length, content })
  assert.match(text, /\n````\nx```y\n````\n/)
})
ok('prompt: multi-line content survives verbatim under its fence', () => {
  const content = 'line1\n```\nline3'
  const text = buildPrompt(promptCfg, { contentType: 'text/plain', bytes: content.length, content })
  assert.match(text, /\n````\nline1\n```\nline3\n````\n/)
})
ok('prompt: no trailing newline', () => {
  assert.ok(!buildPrompt(promptCfg, null).endsWith('\n'))
})

// ---------------------------------------------------------------- pipeline lifecycle
console.log('pipeline lifecycle (injected deps: clock, ids, spawn)')
import { EventEmitter } from 'node:events'
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const NOW = 1760000000000
function fakeDeps(over = {}) {
  let n = 0
  return {
    log: silentLog,
    now: () => NOW,
    newId: () => `d-${++n}`,
    spawn: over.spawn ?? (async () => ({ ok: true, sessionId: 'sess-x' })),
  }
}
/** A spawn that resolves only when the test settles it: captures every request. */
function controllableSpawn() {
  const pending = []
  const spawn = (req) => new Promise((resolve) => pending.push({ req, resolve }))
  return { spawn, pending, settle: (i, result) => pending[i].resolve(result) }
}
const tick = () => new Promise((r) => setImmediate(r))
const tick2 = async () => {
  await tick()
  await tick()
}
async function okA(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ok ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

await okA('admission: a free slot accepts and settles ok', async () => {
  const p = new EndpointPipeline(promptCfg, fakeDeps())
  assert.deepEqual(p.admit({ method: 'POST', content: null }), { kind: 'accepted' })
  assert.equal(p.statusView().inFlight, 1)
  await tick2()
  assert.equal(p.statusView().inFlight, 0)
  assert.equal(p.statusView().lastDelivery.outcome, 'ok')
  assert.equal(p.statusView().lastDelivery.sessionId, 'sess-x')
  assert.equal(p.state.ring.length, 1)
  assert.equal(p.state.ring[0].outcome, 'ok')
})
await okA('admission: the second delivery queues; settlement drains FIFO', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  assert.equal(p.admit({ method: 'POST', content: null }).kind, 'accepted')
  assert.equal(p.admit({ method: 'GET', content: null }).kind, 'queued')
  assert.equal(p.statusView().queueDepth, 1)
  c.settle(0, { ok: true, sessionId: 's1' })
  await tick2()
  assert.equal(c.pending.length, 2, 'the queued delivery was dispatched')
  assert.equal(p.statusView().inFlight, 1)
  c.settle(1, { ok: true, sessionId: 's2' })
  await tick2()
  assert.equal(p.statusView().inFlight, 0)
  assert.equal(p.statusView().queueDepth, 0)
  assert.equal(p.state.ring[0].outcome, 'ok')
  assert.equal(p.state.ring[1].outcome, 'ok')
  assert.equal(p.state.ring[0].sessionId, 's2')
})
await okA('settlement: a create failure records create_failed and frees the slot', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  p.admit({ method: 'POST', content: null })
  c.settle(0, { ok: false, kind: 'create_failed', detail: 'agent create failed: boom' })
  await tick2()
  assert.equal(p.statusView().inFlight, 0)
  assert.equal(p.state.ring[0].outcome, 'create_failed')
  assert.equal(p.state.ring[0].sessionId, undefined)
})
await okA('settlement: a turn failure records failed with the session id', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  p.admit({ method: 'POST', content: null })
  c.settle(0, { ok: false, kind: 'failed', detail: 'turn ended with reason aborted', sessionId: 's9' })
  await tick2()
  assert.equal(p.state.ring[0].outcome, 'failed')
  assert.equal(p.state.ring[0].sessionId, 's9')
})
await okA('admission: the queue cap rejects (429 territory)', async () => {
  const c = controllableSpawn()
  const cfg = { ...promptCfg, maxQueue: 1 }
  const p = new EndpointPipeline(cfg, fakeDeps({ spawn: c.spawn }))
  assert.equal(p.admit({ method: 'POST', content: null }).kind, 'accepted')
  assert.equal(p.admit({ method: 'POST', content: null }).kind, 'queued')
  assert.deepEqual(p.admit({ method: 'POST', content: null }), { kind: 'rejected', outcome: 'rejected_queue_full' })
})
await okA('admission: maxQueue=0 rejects immediately while a slot is held', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline({ ...promptCfg, maxQueue: 0 }, fakeDeps({ spawn: c.spawn }))
  assert.equal(p.admit({ method: 'POST', content: null }).kind, 'accepted')
  assert.deepEqual(p.admit({ method: 'POST', content: null }), { kind: 'rejected', outcome: 'rejected_queue_full' })
})
await okA('handover: a raised maxConcurrent re-drains the inherited queue on the successor', async () => {
  const c = controllableSpawn()
  const deps = fakeDeps({ spawn: c.spawn })
  const p1 = new EndpointPipeline(promptCfg, deps) // maxConcurrent 1
  assert.equal(p1.admit({ method: 'POST', content: null }).kind, 'accepted')
  assert.equal(p1.admit({ method: 'GET', content: null }).kind, 'queued')
  p1.disposed = true
  // Hot reload raises the concurrency cap: the successor's free slot admits
  // the inherited queued delivery.
  const p2 = new EndpointPipeline({ ...promptCfg, maxConcurrent: 2 }, deps, p1.state)
  assert.equal(p2.statusView().queueDepth, 0, 'the successor drained the queue into its free slot')
  assert.equal(c.pending.length, 2, 'the successor dispatched the queued delivery')
  c.settle(1, { ok: true, sessionId: 's2' })
  await tick2()
  assert.equal(p2.statusView().inFlight, 0, 'no stale entry remains; the slot is free again')
  assert.equal(p2.state.ring[0].outcome, 'ok')
})
await okA('handover: stale in-flight entries are pruned at adoption and their slot re-drains the queue', async () => {
  const c = controllableSpawn()
  const deps = fakeDeps({ spawn: c.spawn })
  const p1 = new EndpointPipeline(promptCfg, deps)
  p1.admit({ method: 'POST', content: null }) // in flight on the predecessor (its closure cannot settle here)
  p1.admit({ method: 'GET', content: null }) // queued
  p1.disposed = true
  const p2 = new EndpointPipeline(promptCfg, deps, p1.state)
  assert.equal(p2.statusView().inFlight, 1, 'the stale entry was pruned; the queued delivery took the freed slot')
  assert.equal(p2.statusView().queueDepth, 0, 'the successor drained the inherited queue')
  assert.equal(c.pending.length, 2, 'the successor dispatched the queued delivery')
  c.settle(1, { ok: true, sessionId: 's2' })
  await tick2()
  assert.equal(p2.statusView().inFlight, 0, 'the slot is free again (no permanent slot leak)')
})
await okA('handover: a chained reconstitution prunes the successor own entries too', async () => {
  const c = controllableSpawn()
  const deps = fakeDeps({ spawn: c.spawn })
  const p1 = new EndpointPipeline(promptCfg, deps)
  p1.admit({ method: 'POST', content: null })
  p1.disposed = true
  const p2 = new EndpointPipeline(promptCfg, deps, p1.state) // prunes p1's stale entry
  p2.admit({ method: 'POST', content: null }) // a fresh in-flight entry under p2
  assert.equal(p2.statusView().inFlight, 1)
  p2.disposed = true
  const p3 = new EndpointPipeline(promptCfg, deps, p2.state)
  assert.equal(p3.statusView().inFlight, 0, 'p2 in-flight entry is pruned at the third reconstitution')
})
await okA('disposal: a disposed pipeline ignores late settlements', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  p.admit({ method: 'POST', content: null })
  p.disposed = true
  const before = JSON.stringify(p.state)
  c.settle(0, { ok: true, sessionId: 's1' })
  await tick2()
  assert.equal(JSON.stringify(p.state), before)
})
await okA('record: the per-endpoint ring caps at 50 (newest first)', async () => {
  const p = new EndpointPipeline(promptCfg, fakeDeps())
  for (let i = 0; i < 60; i++) p.record('ok', 'POST', `s${i}`)
  assert.equal(p.state.ring.length, 50)
  assert.equal(p.state.ring[0].sessionId, 's59')
  assert.equal(p.state.ring[49].sessionId, 's10')
})
await okA('handover: settled ring entries survive rebind into the successor', async () => {
  const c = controllableSpawn()
  const deps = fakeDeps({ spawn: c.spawn })
  const p1 = new EndpointPipeline(promptCfg, deps)
  p1.admit({ method: 'POST', content: null })
  await tick2()
  c.settle(0, { ok: true, sessionId: 'sPrev' })
  await tick2()
  assert.equal(p1.state.ring.length, 1)
  assert.equal(p1.state.ring[0].sessionId, 'sPrev')
  p1.disposed = true
  const p2 = new EndpointPipeline(promptCfg, deps, p1.state)
  assert.equal(p2.state.ring.length, 1, 'the predecessor ring entry carried over')
  assert.equal(p2.state.ring[0].sessionId, 'sPrev')
  assert.equal(p2.state.ring[0].outcome, 'ok')
  // A fresh delivery on the successor appends above the inherited entry.
  p2.admit({ method: 'POST', content: null })
  await tick2()
  c.settle(1, { ok: true, sessionId: 'sSucc' })
  await tick2()
  assert.equal(p2.state.ring.length, 2)
  assert.equal(p2.state.ring[0].sessionId, 'sSucc')
  assert.equal(p2.state.ring[1].sessionId, 'sPrev')
})
await okA('dispatch: the spawn receives the prompt and the payload', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  p.admit({ method: 'POST', content: { contentType: 'application/json', bytes: 4, content: '{}' } })
  await tick2()
  const { prompt, content } = c.pending[0].req
  assert.equal(content.contentType, 'application/json')
  assert.equal(prompt.split('\n')[0], '<dsh-webhook-dispatcher> delivery from endpoint "GitHub" (/hooks/gh):')
  assert.match(prompt, /\n```\n\{\}\n```\n/)
  c.settle(0, { ok: true, sessionId: 's1' })
  await tick2()
})

// ---------------------------------------------------------------- handler matrix
console.log('handler matrix (rejection total order: method -> auth -> body budget -> queue)')
process.env.WH_SELFTEST_TOKEN = 'secret'
function fakeRes() {
  const res = { status: undefined, headers: undefined, body: undefined, calls: [] }
  res.writeHead = (code, headers) => {
    res.status = code
    res.headers = headers
    res.calls.push(['writeHead', code, headers])
  }
  res.end = (body) => {
    res.body = body
    res.calls.push(['end', body])
  }
  return res
}
function fakeReq({ method = 'GET', headers = {}, body = null }) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req._resumed = false
  req.resume = () => {
    req._resumed = true
  }
  const deliver = () => {
    if (body !== null) for (const chunk of [body]) req.emit('data', chunk)
    req.emit('end')
  }
  return { req, deliver }
}
const authCfg = { ...promptCfg, auth: 'WH_SELFTEST_TOKEN' }

await okA('405: a non-GET/POST method is rejected with the Allow header', async () => {
  const p = new EndpointPipeline(promptCfg, fakeDeps())
  const handler = createHandler(promptCfg, p)
  const { req } = fakeReq({ method: 'PUT' })
  const res = fakeRes()
  handler(req, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, POST')
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed')
  assert.equal(p.state.ring[0].outcome, 'rejected_method_not_allowed')
})
await okA('401: a protected endpoint without a token', async () => {
  const p = new EndpointPipeline(authCfg, fakeDeps())
  const handler = createHandler(authCfg, p)
  const res = fakeRes()
  handler(fakeReq({ method: 'GET' }).req, res)
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).error, 'unauthorized')
  assert.equal(p.state.ring[0].outcome, 'rejected_unauthorized')
})
await okA('401: a wrong X-Webhook-Token', async () => {
  const p = new EndpointPipeline(authCfg, fakeDeps())
  const handler = createHandler(authCfg, p)
  const res = fakeRes()
  handler(fakeReq({ method: 'GET', headers: { 'x-webhook-token': 'wrong' } }).req, res)
  assert.equal(res.status, 401)
})
await okA('202: the X-Webhook-Token header authenticates', async () => {
  const p = new EndpointPipeline(authCfg, fakeDeps())
  const handler = createHandler(authCfg, p)
  const res = fakeRes()
  handler(fakeReq({ method: 'GET', headers: { 'x-webhook-token': 'secret' } }).req, res)
  assert.equal(res.status, 202)
  assert.equal(JSON.parse(res.body).status, 'accepted')
  assert.equal(p.statusView().inFlight, 1)
})
await okA('202: the Authorization Bearer form authenticates', async () => {
  const p = new EndpointPipeline(authCfg, fakeDeps())
  const handler = createHandler(authCfg, p)
  const res = fakeRes()
  handler(fakeReq({ method: 'GET', headers: { authorization: 'Bearer secret' } }).req, res)
  assert.equal(res.status, 202)
})
await okA('401: X-Webhook-Token takes precedence over Authorization', async () => {
  const p = new EndpointPipeline(authCfg, fakeDeps())
  const handler = createHandler(authCfg, p)
  const res = fakeRes()
  handler(
    fakeReq({ method: 'GET', headers: { 'x-webhook-token': 'wrong', authorization: 'Bearer secret' } }).req,
    res,
  )
  assert.equal(res.status, 401)
})
await okA('401: an auth env emptied at runtime fails closed', async () => {
  const cfg = { ...promptCfg, auth: 'WH_SELFTEST_EMPTY' }
  process.env.WH_SELFTEST_EMPTY = ''
  const p = new EndpointPipeline(cfg, fakeDeps())
  const handler = createHandler(cfg, p)
  const res = fakeRes()
  handler(fakeReq({ method: 'GET' }).req, res)
  delete process.env.WH_SELFTEST_EMPTY
  assert.equal(res.status, 401)
  assert.match(JSON.parse(res.body).message, /not set/)
})
await okA('202: an open endpoint (auth="") admits without a token', async () => {
  const p = new EndpointPipeline(promptCfg, fakeDeps())
  const handler = createHandler(promptCfg, p)
  const res = fakeRes()
  handler(fakeReq({ method: 'GET' }).req, res)
  assert.equal(res.status, 202)
})
await okA('413: an oversize body is drained and rejected (no socket destroy)', async () => {
  const p = new EndpointPipeline({ ...promptCfg, maxBodyBytes: 10 }, fakeDeps())
  const handler = createHandler({ ...promptCfg, maxBodyBytes: 10 }, p)
  const { req, deliver } = fakeReq({ method: 'POST', body: Buffer.alloc(20) })
  const res = fakeRes()
  handler(req, res)
  deliver()
  await tick2()
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).error, 'body_too_large')
  assert.equal(req._resumed, true, 'the request was drained after the budget')
  assert.equal(p.state.ring[0].outcome, 'rejected_body_too_large')
})
await okA('202: a body exactly at the budget is admitted', async () => {
  const cfg = { ...promptCfg, maxBodyBytes: 10 }
  const p = new EndpointPipeline(cfg, fakeDeps())
  const handler = createHandler(cfg, p)
  const { req, deliver } = fakeReq({ method: 'POST', body: Buffer.alloc(10) })
  const res = fakeRes()
  handler(req, res)
  deliver()
  await tick2()
  assert.equal(res.status, 202)
  assert.equal(JSON.parse(res.body).status, 'accepted')
})
await okA('202: the body is UTF-8 decoded with U+FFFD substitution (no plugin 400)', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  const handler = createHandler(promptCfg, p)
  const { req, deliver } = fakeReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: Buffer.from([0xff, 0xfe, 0xfd]) })
  const res = fakeRes()
  handler(req, res)
  deliver()
  await tick2()
  assert.equal(res.status, 202)
  assert.match(c.pending[0].req.prompt, /Content-Type: text\/plain\nBytes: 3/)
  assert.match(c.pending[0].req.prompt, /\uFFFD\uFFFD\uFFFD/)
  c.settle(0, { ok: true, sessionId: 's1' })
  await tick2()
})
await okA('202: a GET delivery carries no content in the prompt', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  const handler = createHandler(promptCfg, p)
  const res = fakeRes()
  handler(fakeReq({ method: 'GET' }).req, res)
  await tick2()
  assert.equal(res.status, 202)
  assert.match(c.pending[0].req.prompt, /\n\(no content\)\n/)
  c.settle(0, { ok: true, sessionId: 's1' })
  await tick2()
})
await okA('202: a body-less POST is a no-content delivery, not an error', async () => {
  const c = controllableSpawn()
  const p = new EndpointPipeline(promptCfg, fakeDeps({ spawn: c.spawn }))
  const handler = createHandler(promptCfg, p)
  const { req, deliver } = fakeReq({ method: 'POST', body: null })
  const res = fakeRes()
  handler(req, res)
  deliver()
  await tick2()
  assert.equal(res.status, 202)
  assert.match(c.pending[0].req.prompt, /\n\(no content\)\n/)
  c.settle(0, { ok: true, sessionId: 's1' })
  await tick2()
})
await okA('429: a full queue answers 429 with Retry-After: 5', async () => {
  const c = controllableSpawn()
  const cfg = { ...promptCfg, maxQueue: 0 }
  const p = new EndpointPipeline(cfg, fakeDeps({ spawn: c.spawn }))
  const handler = createHandler(cfg, p)
  handler(fakeReq({ method: 'GET' }).req, fakeRes()) // holds the single slot (held spawn)
  await tick2()
  const res = fakeRes()
  handler(fakeReq({ method: 'GET' }).req, res)
  assert.equal(res.status, 429)
  assert.equal(res.headers['retry-after'], '5')
  assert.equal(JSON.parse(res.body).error, 'queue_full')
  assert.equal(p.state.ring[0].outcome, 'rejected_queue_full')
})
await okA('400: a body stream error answers a transport-level 400', async () => {
  const p = new EndpointPipeline(promptCfg, fakeDeps())
  const handler = createHandler(promptCfg, p)
  const { req } = fakeReq({ method: 'POST' })
  const res = fakeRes()
  handler(req, res)
  req.emit('error', new Error('boom'))
  await tick2()
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).error, 'bad_request')
})
// ---------------------------------------------------------------- plugin integration
console.log('plugin integration (fake host context: routing, spawn lifecycle, degradation)')

const wsTmp = path.join(root, '.selftest-ws')
mkdirSync(wsTmp, { recursive: true })
const ENDPOINT_GH = { id: 'gh', path: '/gh' }

/**
 * A fake host context matching the cordis surface the plugin uses:
 * reflect.provide, logger, get (soft services), effect,
 * webServer.register/registerFallback/dispatch (a dispatch simulation
 * mirroring the framework order: exact table -> prefix table longest-wins
 * -> fallback seat -> pre-fallback 404), tools.register,
 * skills.registerProvider, systemPrompt.section.
 */
function makeFakeCtx(services = {}) {
  const routes = new Map()
  const prefixes = []
  let fallback = null
  const logs = { info: [], warn: [], error: [] }
  const tools = []
  const skillProviders = []
  const promptSections = []
  const effects = []
  const webServer = {
    host: '127.0.0.1',
    port: 3080,
    register(spec) {
      if (spec.kind === 'exact') {
        if (routes.has(spec.path)) {
          throw new Error(`duplicate exact route ${spec.path}`)
        }
        routes.set(spec.path, spec)
        return () => {
          routes.delete(spec.path)
        }
      }
      prefixes.push(spec)
      return () => {
        const i = prefixes.indexOf(spec)
        if (i !== -1) prefixes.splice(i, 1)
      }
    },
    // The framework fallback seat (one owner; a second claim throws).
    registerFallback(handler) {
      if (fallback !== null) throw new Error('fallback seat already claimed')
      fallback = { handler }
      return () => {
        fallback = null
      }
    },
    // Dispatch simulation mirroring the framework order: exact table, then
    // the prefix table (longest prefix wins), then the fallback seat, then
    // the pre-fallback 404 the framework answers until the fallback owner
    // registers.
    dispatch(method, pathname, { headers = {}, body = null } = {}) {
      const path = pathname.split('?')[0]
      let route = routes.get(path)
      let via = route === undefined ? null : `exact ${path}`
      if (route === undefined) {
        let best = null
        for (const p of prefixes) {
          if ((path === p.path || path.startsWith(`${p.path}/`)) && (best === null || p.path.length > best.path.length)) best = p
        }
        if (best !== null) {
          route = best
          via = `prefix ${best.path}`
        }
      }
      if (route === undefined && fallback === null) {
        const res = fakeRes()
        res.writeHead(404, {})
        res.end()
        return { res, deliver: () => {}, via: 'none (pre-fallback 404)' }
      }
      const handler = route !== undefined ? route.handler : fallback.handler
      const { req, deliver } = fakeReq({ method, headers, body })
      req.url = pathname
      const res = fakeRes()
      handler(req, res)
      return { req, res, deliver, via: route !== undefined ? via : 'fallback' }
    },
  }
  const ctx = {
    reflect: { provide() {} },
    logger: () => ({
      debug: () => {},
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    }),
    get: (name) => (name in services ? services[name] : undefined),
    effect(fn, label) {
      const disposer = fn()
      const record = { label, dispose: () => disposer?.() }
      effects.push(record)
      return record
    },
    webServer,
    tools: {
      register(def) {
        tools.push(def)
        return () => {}
      },
    },
    skills: {
      registerProvider(factory) {
        skillProviders.push(factory)
        return () => {}
      },
    },
    systemPrompt: {
      section(cfg) {
        promptSections.push(cfg)
        return () => {}
      },
    },
  }
  return { ctx, routes, logs, tools, skillProviders, promptSections, effects }
}

/** A host agents-service double: create() captures the options and resolves to a fake handle. */
function makeFakeAgents(handleFactory) {
  const calls = []
  return {
    calls,
    create(options) {
      calls.push(options)
      return handleFactory(options)
    },
  }
}

/** A fake session handle: appends record sandbox events, events feed snapshotEvents. */
function makeFakeHandle({ events = [], sandboxOk = true, followupRejects = false } = {}) {
  const appends = []
  const cancelCalls = []
  let disposed = false
  const agent = {
    session: {
      append(type, data) {
        if (!sandboxOk) throw new Error('sandbox append failed')
        appends.push([type, data])
      },
      snapshotEvents() {
        return events
      },
    },
    followup() {
      if (followupRejects) return Promise.reject(new Error('followup boom'))
      return undefined
    },
    whenIdle() {
      return Promise.resolve()
    },
    cancel(kind) {
      cancelCalls.push(kind)
    },
  }
  const handle = {
    agent,
    dispose: async () => {
      disposed = true
    },
  }
  return { handle, appends, cancelCalls, isDisposed: () => disposed }
}

const okHandle = () => makeFakeHandle({ events: [{ type: 'turn/end', data: { reason: 'completed' } }] })
// 1000-tick budget: the spawn chain includes real fs calls (mkdir, the
// settings.yaml probe), and under a loaded event loop (concurrent tooling
// sharing the libuv threadpool) those callbacks can outrun a smaller budget.
const flush = async () => {
  for (let i = 0; i < 1000; i++) await tick()
}
const disposeAll = (effects) => {
  for (const e of [...effects].reverse()) e.dispose()
}

/**
 * Patch the host timer face around the 300 s create deadline. Mode 'fire'
 * delivers the deadline callback as a microtask (standing in for the 300 s
 * timer firing once); mode 'never' schedules it without letting it fire (the
 * test must not leave a live 300 s host timer that holds the process open).
 */
async function withFakeDeadlineTimer(mode, fn) {
  const origST = globalThis.setTimeout
  const origCT = globalThis.clearTimeout
  const timers = new Map()
  let seq = 0
  globalThis.setTimeout = (callback, ms, ...rest) => {
    if (ms === 300000) {
      const id = ++seq
      const rec = { cancelled: false }
      timers.set(id, rec)
      if (mode === 'fire') {
        queueMicrotask(() => {
          if (!rec.cancelled) {
            rec.cancelled = true
            callback()
          }
        })
      }
      return id
    }
    return origST(callback, ms, ...rest)
  }
  globalThis.clearTimeout = (id) => {
    const rec = timers.get(id)
    if (rec !== undefined) {
      rec.cancelled = true
      return undefined
    }
    return origCT(id)
  }
  try {
    await fn()
  } finally {
    globalThis.setTimeout = origST
    globalThis.clearTimeout = origCT
  }
}

await okA('plugin: construction registers exactly the configured paths (no leak, no fallback route)', async () => {
  dropHandoverSlot()
  const { ctx, routes, tools, skillProviders, promptSections, effects } = makeFakeCtx()
  const plugin = new DshWebhookDispatcherPlugin(ctx, {
    endpoints: [{ id: 'gh', path: '/gh' }, { id: 'ci', path: '/ci/run' }],
  })
  assert.deepEqual([...routes.keys()].sort(), ['/ci/run', '/gh'])
  const st = plugin.status()
  assert.equal(st.ingress.via, 'framework webServer (main)')
  assert.equal(st.ingress.host, '127.0.0.1')
  assert.equal(st.ingress.port, 3080)
  assert.equal(st.ingress.routesRegistered, 2)
  assert.ok(tools.some((t) => t.name === 'webhook'))
  assert.equal(skillProviders.length, 1)
  const provider = skillProviders[0]()
  assert.equal(provider.name, 'dsh-webhook-dispatcher')
  assert.ok(promptSections.some((s) => s.name === 'dsh-webhook-dispatcher'))
  assert.ok(effects.some((e) => e.label.includes('handover stash')))
  disposeAll(effects)
  assert.equal(routes.size, 0, 'the route disposers unregistered every route')
})

await okA('unknown-path no-leak (dispatch level): an unknown path reaches only the framework fallback, never a plugin handler', async () => {
  dropHandoverSlot()
  const fallbackCalls = []
  const { ctx, effects } = makeFakeCtx()
  // Claim the fallback seat with a framework-fallback double that mirrors
  // the real seat (the shipped Web composition installs the static dist
  // server there): one fake dist asset, the SPA index only at the two
  // index paths, an empty 404 for any other GET/HEAD, and an empty 405
  // for every other method.
  const FAKE_DIST = { '/assets/app.js': 'console.log(1)' }
  const INDEX_PATHS = new Set(['/', '/index.html'])
  const disposeFallback = ctx.webServer.registerFallback((req, res) => {
    fallbackCalls.push(req.url)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {})
      res.end()
      return
    }
    if (Object.prototype.hasOwnProperty.call(FAKE_DIST, req.url)) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end(FAKE_DIST[req.url])
      return
    }
    if (INDEX_PATHS.has(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html>index')
      return
    }
    res.writeHead(404, {})
    res.end()
  })
  const plugin = new DshWebhookDispatcherPlugin(ctx, {
    endpoints: [{ id: 'gh', path: '/gh' }, { id: 'ci', path: '/ci/run' }],
  })
  // Unknown paths (any method): answered by the fallback, no plugin route
  // involved, no endpoint records a delivery.
  const r1 = ctx.webServer.dispatch('GET', '/no-such-path')
  assert.equal(r1.via, 'fallback')
  assert.equal(r1.res.status, 404)
  // The mirror's method split: a non-GET/HEAD unknown path answers 405.
  const r2 = ctx.webServer.dispatch('POST', '/hooks/elsewhere', { body: Buffer.from('x') })
  r2.deliver()
  await tick2()
  assert.equal(r2.via, 'fallback')
  assert.equal(r2.res.status, 405)
  // The mirror's dist shape: the asset path and the two index paths serve
  // 200 from the fallback - still never from a plugin route.
  const r4 = ctx.webServer.dispatch('GET', '/assets/app.js')
  assert.equal(r4.via, 'fallback')
  assert.equal(r4.res.status, 200)
  const r5 = ctx.webServer.dispatch('GET', '/')
  assert.equal(r5.via, 'fallback')
  assert.equal(r5.res.status, 200)
  assert.equal(fallbackCalls.length, 4)
  for (const ep of plugin.status().endpoints) {
    assert.equal(ep.lastDelivery, undefined, `endpoint "${ep.id}" must not record a delivery for an unknown path`)
  }
  // A known path still reaches the plugin handler.
  const r3 = ctx.webServer.dispatch('GET', '/gh')
  assert.equal(r3.via, 'exact /gh')
  assert.equal(r3.res.status, 202)
  disposeAll(effects)
  disposeFallback()
})

await okA('plugin: a delivery through the registered route runs the production spawn end to end', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes, logs } = makeFakeCtx({
    agents,
    dshHomePath: (p) => path.join(wsTmp, p),
  })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [{ ...ENDPOINT_GH, cwd: path.join(wsTmp, 'gh') }] })
  const res = fakeRes()
  const { req, deliver } = fakeReq({ method: 'POST', body: Buffer.from('ping'), headers: { 'content-type': 'text/plain' } })
  routes.get('/gh').handler(req, res)
  deliver()
  await tick()
  assert.equal(res.status, 202)
  assert.equal(JSON.parse(res.body).status, 'accepted')
  await flush()
  const st = plugin.status()
  assert.equal(st.endpoints[0].inFlight, 0)
  assert.equal(st.endpoints[0].queueDepth, 0)
  assert.equal(st.endpoints[0].lastDelivery.outcome, 'ok')
  assert.ok(st.endpoints[0].lastDelivery.sessionId)
  assert.equal(agents.calls.length, 1)
  assert.equal(agents.calls[0].meta.cwd, path.join(wsTmp, 'gh'))
  assert.ok(!logs.warn.length, `unexpected warnings: ${logs.warn.join(' | ')}`)
})

await okA('plugin: the registered handler is query-agnostic (the framework routes on the path alone)', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  const { req } = fakeReq({ method: 'GET' })
  req.url = '/gh?x=1'
  const res = fakeRes()
  routes.get('/gh').handler(req, res)
  assert.equal(res.status, 202)
  await flush()
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: a configured sandbox mode appends the session sandbox/mode event', async () => {
  dropHandoverSlot()
  const created = okHandle()
  const agents = makeFakeAgents(() => Promise.resolve(created.handle))
  const { ctx, routes } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, {
    endpoints: [{ ...ENDPOINT_GH, sandbox: 'danger-full-access' }],
  })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  const sandbox = created.appends.find(([t]) => t === 'sandbox/mode')
  assert.ok(sandbox, 'a sandbox/mode event was appended to the session')
  assert.equal(sandbox[1].mode, 'danger-full-access')
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: an unset sandbox leaves the session mode untouched', async () => {
  dropHandoverSlot()
  const created = okHandle()
  const agents = makeFakeAgents(() => Promise.resolve(created.handle))
  const { ctx, routes } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.equal(created.appends.length, 0)
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: a failing sandbox override degrades to a warning, the delivery still lands', async () => {
  dropHandoverSlot()
  const created = makeFakeHandle({ events: [{ type: 'turn/end', data: { reason: 'completed' } }], sandboxOk: false })
  const agents = makeFakeAgents(() => Promise.resolve(created.handle))
  const { ctx, routes, logs } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, {
    endpoints: [{ ...ENDPOINT_GH, sandbox: 'workspace-write' }],
  })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.ok(logs.warn.some((m) => m.includes('sandbox mode "workspace-write" could not be set')))
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: the model ladder takes the deployment default; the endpoint model overlays the model field', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p1', model: 'm1' }) },
    dshHomePath: (p) => path.join(wsTmp, p),
  })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [{ ...ENDPOINT_GH, model: 'em' }] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.deepEqual(agents.calls[0].agentOptions, { provider: 'p1', model: 'em' })
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: the settings section is the next model source', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({
    agents,
    settings: { section: (ns) => (ns === 'agent-default-model' ? { provider: 'p2', model: 'm2' } : undefined) },
    dshHomePath: (p) => path.join(wsTmp, p),
  })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.deepEqual(agents.calls[0].agentOptions, { provider: 'p2', model: 'm2' })
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: with no model source and no endpoint model, no route is passed', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.equal('agentOptions' in agents.calls[0], false)
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: the deployment default preset is mounted through the create setup hook', async () => {
  dropHandoverSlot()
  const mounts = []
  const agents = makeFakeAgents(async (options) => {
    if (options.setup) await options.setup('ctx-x')
    return okHandle().handle
  })
  const { ctx, routes } = makeFakeCtx({
    agents,
    agentPresets: {
      resolve: async () => ({ id: 'default-preset' }),
      mount: async (agentCtx, id) => {
        mounts.push([agentCtx, id])
      },
    },
    dshHomePath: (p) => path.join(wsTmp, p),
  })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.equal(agents.calls[0].meta.agentPreset, 'default-preset')
  assert.ok(typeof agents.calls[0].setup === 'function')
  assert.deepEqual(mounts, [['ctx-x', 'default-preset']])
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: a failed turn/end reason lands as failed with the error detail', async () => {
  dropHandoverSlot()
  const created = makeFakeHandle({
    events: [{ type: 'turn/end', data: { reason: { reason: 'error', error: { message: 'kaboom' } } } }],
  })
  const agents = makeFakeAgents(() => Promise.resolve(created.handle))
  const { ctx, routes, logs } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  const last = plugin.status().endpoints[0].lastDelivery
  assert.equal(last.outcome, 'failed')
  assert.ok(last.sessionId)
  assert.ok(logs.warn.some((m) => m.includes('kaboom')), 'the turn error detail reaches the plugin log')
})

await okA('plugin: a max-tokens turn end counts as ok', async () => {
  dropHandoverSlot()
  const created = makeFakeHandle({ events: [{ type: 'turn/end', data: { reason: 'max-tokens' } }] })
  const agents = makeFakeAgents(() => Promise.resolve(created.handle))
  const { ctx, routes } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: a session that ends without a turn/end event falls back to ok with a warning', async () => {
  dropHandoverSlot()
  const created = makeFakeHandle({ events: [] })
  const agents = makeFakeAgents(() => Promise.resolve(created.handle))
  const { ctx, routes, logs } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
  assert.ok(logs.warn.some((m) => m.includes('ended without a turn/end event')))
})

await okA('plugin: a host without an agents service degrades the delivery to create_failed, the plugin stays healthy', async () => {
  dropHandoverSlot()
  const { ctx, routes, logs } = makeFakeCtx({ dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  const res = fakeRes()
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, res)
  assert.equal(res.status, 202)
  await flush()
  const last = plugin.status().endpoints[0].lastDelivery
  assert.equal(last.outcome, 'create_failed')
  assert.ok(logs.warn.some((m) => m.includes('no agents service')))
})

await okA('plugin: a missing dshHomePath degrades to a workspace-less create with a warning', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes, logs } = makeFakeCtx({ agents })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
  assert.equal('meta' in agents.calls[0], false)
  assert.ok(logs.warn.some((m) => m.includes('no dshHomePath service')))
})

await okA('plugin: a create past the 300 s deadline is a visible create_failed; the late handle is cancelled + disposed', async () => {
  dropHandoverSlot()
  const late = okHandle()
  let resolveCreate
  const agents = makeFakeAgents(
    () =>
      new Promise((resolve) => {
        resolveCreate = () => resolve(late.handle)
      }),
  )
  const { ctx, routes, logs } = makeFakeCtx({ agents })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  const res = fakeRes()
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, res)
  assert.equal(res.status, 202)
  await withFakeDeadlineTimer('fire', async () => {
    await flush()
  })
  const last = plugin.status().endpoints[0].lastDelivery
  assert.equal(last.outcome, 'create_failed')
  assert.ok(logs.warn.some((m) => m.includes('timed out after 300000ms')))
  resolveCreate()
  await flush()
  assert.deepEqual(late.cancelCalls, [{ kind: 'user' }])
  assert.ok(late.isDisposed())
})

await okA('plugin: a reconstitution stashes the state; the successor prunes the stale entry and stays free', async () => {
  dropHandoverSlot()
  const firstAgents = makeFakeAgents(() => new Promise(() => {})) // in flight at dispose time
  const first = makeFakeCtx({ agents: firstAgents, dshHomePath: (p) => path.join(wsTmp, p) })
  const p1 = new DshWebhookDispatcherPlugin(first.ctx, { endpoints: [ENDPOINT_GH] })
  const res = fakeRes()
  first.routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, res)
  assert.equal(res.status, 202)
  await withFakeDeadlineTimer('never', async () => {
    await flush()
  })
  assert.equal(p1.status().endpoints[0].inFlight, 1)
  disposeAll(first.effects)
  assert.equal(first.routes.size, 0)
  const secondAgents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const second = makeFakeCtx({ agents: secondAgents, dshHomePath: (p) => path.join(wsTmp, p) })
  const p2 = new DshWebhookDispatcherPlugin(second.ctx, { endpoints: [ENDPOINT_GH] })
  assert.equal(p2.status().endpoints[0].inFlight, 0, 'the stale in-flight entry was pruned at adoption')
  const res2 = fakeRes()
  second.routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, res2)
  assert.equal(res2.status, 202)
  await flush()
  assert.equal(p2.status().endpoints[0].lastDelivery.outcome, 'ok')
})

await okA('plugin: a dropped endpoint logs one line with its stale counts on reconstitution', async () => {
  const EP_AC = { id: 'ac', path: '/ac' }
  dropHandoverSlot()
  const firstAgents = makeFakeAgents(() => new Promise(() => {})) // in flight at dispose time
  const first = makeFakeCtx({ agents: firstAgents, dshHomePath: (p) => path.join(wsTmp, p) })
  const p1 = new DshWebhookDispatcherPlugin(first.ctx, { endpoints: [ENDPOINT_GH, EP_AC] })
  first.routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  first.routes.get('/ac').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await withFakeDeadlineTimer('never', async () => {
    await flush()
  })
  assert.equal(p1.status().endpoints[1].inFlight, 1)
  disposeAll(first.effects)
  const secondAgents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const second = makeFakeCtx({ agents: secondAgents, dshHomePath: (p) => path.join(wsTmp, p) })
  new DshWebhookDispatcherPlugin(second.ctx, { endpoints: [ENDPOINT_GH] })
  assert.ok(
    second.logs.warn.some((m) => m.includes('dropping state of endpoint "ac"') && m.includes('0 queued, 1 in-flight')),
    'one visible line per dropped endpoint, counts included',
  )
})

// selftest hygiene guard
{
  // The shipped tree is self-contained and decoupled from any design
  // document: the same pattern set applies to the test source (everything
  // above this marker), every shipped source file, and the shipped
  // skill/README. A reader needs only this package plus stable external
  // authorities. This guard block is excluded from its own scan. The set
  // is FROZEN: closed token families only; open-class failures belong to
  // the review layer, not new patterns (2026-10-11 policy; details in the
  // dsh_webhook entity file).
  const patterns = [
    ['design-doc section pointers', /design doc|design v\d|\u00a7\d/],
    ['source line-number pointers', /L\d+[-\u2013\u2014]L?\d+/],
    ['review-round wrappers', /round-?\d+|review #\d/],
    ['project version-round tags', /\bv\d{2}\b/],
    ['review finding identifiers', /\b[RWV]\d{1,2}\b/],
    ['version-round identifiers', /\bv\d{2}[A-Za-z_]\w*/],
    ['calendar dates', /20\d{2}-\d{2}-\d{2}/],
    ['CJK characters', /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/],
  ]
  // Skill files ship into any profile's agent context: they must be
  // deployment-agnostic (no literal host:port addresses - the curl recipes
  // use the <host>:<port> placeholder, derived from the webhook status
  // ingress block). Applied to skill/ files only (the README may show
  // concrete example values in configuration snippets).
  const skillOnlyPatterns = [
    ['literal host:port addresses', /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/],
  ]
  const raw = readFileSync(path.join(root, 'test', 'selftest.mjs'), 'utf8')
  const sources = { 'test/selftest.mjs': raw.slice(0, raw.indexOf('// selftest hygiene guard')) }
  for (const f of readdirSync(path.join(root, 'src'))) {
    if (!f.endsWith('.ts')) continue
    sources[`src/${f}`] = readFileSync(path.join(root, 'src', f), 'utf8')
  }
  for (const f of readdirSync(path.join(root, 'skill', 'dsh-webhook-dispatcher'))) {
    sources[`skill/dsh-webhook-dispatcher/${f}`] = readFileSync(path.join(root, 'skill', 'dsh-webhook-dispatcher', f), 'utf8')
  }
  sources['README.md'] = readFileSync(path.join(root, 'README.md'), 'utf8')
  for (const [file, code] of Object.entries(sources)) {
    for (const [label, re] of patterns) {
      ok(`hygiene ${file}: no ${label}`, () => {
        if (re.test(code)) throw new Error(`pattern matched: ${re}`)
      })
    }
    if (file.startsWith('skill/')) {
      for (const [label, re] of skillOnlyPatterns) {
        ok(`hygiene ${file}: no ${label}`, () => {
          if (re.test(code)) throw new Error(`pattern matched: ${re}`)
        })
      }
    }
  }
}

rmSync(wsTmp, { recursive: true, force: true })
dropHandoverSlot()

delete process.env.WH_SELFTEST_TOKEN
delete process.env.WH_SELFTEST_EMPTY

console.log(`\n${checks} checks passed${process.exitCode ? ' (with failures)' : ''}`)
