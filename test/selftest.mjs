// dsh-webhook-dispatcher selftest (G2): strict ASCII hygiene, the config
// surface (schema + cross-validation + defaults), the handover slot, the
// prompt template (byte-strict), the pipeline lifecycle (queue / slots /
// handover / settlement via injected deps), the handler matrix (the rejection
// total order against mock request/response pairs), and the plugin
// integration face (routing on a fake webServer, the production
// trigger-session spawn lifecycle, and the degradation paths).
// Runs against the built lib/ (run `pnpm run build` first).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const { REASONING_EFFORTS } = await import(path.join(root, 'lib', 'config.js'))

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
          reasoningEffort: 'low',
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
    reasoningEffort: 'low',
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
  ['reasoningEffort outside the closed set', { id: 'gh', path: '/gh', reasoningEffort: 'banana' }],
  ['empty reasoningEffort (the closed set allows no empty member)', { id: 'gh', path: '/gh', reasoningEffort: '' }],
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
    { DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_SANDBOX: '', DSH_WEBHOOK_GH_MODEL: '', DSH_WEBHOOK_GH_REASONING_EFFORT: '' },
    undefined,
    () => {},
  )
  assert.equal('sandbox' in cfg.endpoints[0], false)
  assert.equal('model' in cfg.endpoints[0], false)
  assert.equal('reasoningEffort' in cfg.endpoints[0], false)
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
ok('a valid env reasoningEffort is carried', () => {
  const cfg = foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_REASONING_EFFORT: 'off' }, undefined, () => {})
  assert.equal(cfg.endpoints[0].reasoningEffort, 'off')
})
ok('the env channel accepts every level of the closed set', () => {
  for (const level of REASONING_EFFORTS) {
    const cfg = foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_REASONING_EFFORT: level }, undefined, () => {})
    assert.equal(cfg.endpoints[0].reasoningEffort, level)
  }
})
ok('the config channel accepts every level of the closed set', () => {
  for (const level of REASONING_EFFORTS) {
    validate({ endpoints: [{ id: 'gh', path: '/gh', reasoningEffort: level }] })
  }
})
throws('an env reasoningEffort outside the closed set', () =>
  foldConfig({ DSH_WEBHOOK_GH_PATH: '/g', DSH_WEBHOOK_GH_REASONING_EFFORT: 'banana' }, undefined, () => {}),
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

/**
 * Offload-plane service doubles: a persistence locator over the given store
 * root (the framework jsonl layout, keyed on the cwd basename) and a live
 * session registry whose membership a test can grow (empty = dead).
 */
function offloadDoubles(storeRoot, live = new Set()) {
  return {
    sessionPersistence: {
      locate: (meta) => ({
        kind: 'jsonl',
        path: path.join(storeRoot, meta.cwd === undefined ? '' : path.basename(meta.cwd), meta.id, 'session.v4.jsonl.zstd'),
      }),
    },
    sessions: { get: (id) => (live.has(id) ? { id } : undefined) },
  }
}
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
  // The offload plane's first sweep round must stay silent: both its soft
  // services are present and the store root exists on the harness home.
  const storeRoot = path.join(wsTmp, 'sessions')
  mkdirSync(storeRoot, { recursive: true })
  const { ctx, routes, logs } = makeFakeCtx({
    agents,
    dshHomePath: (p) => path.join(wsTmp, p),
    ...offloadDoubles(storeRoot),
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

// Reasoning effort (isomorphic to the other session-producing plugins): a set
// level passes through to the create's agentOptions alongside the model route
// (alone when no route resolves); unset with no route source = the
// agentOptions key is omitted entirely.
await okA('plugin: a set reasoning effort with no model source is carried alone', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [{ ...ENDPOINT_GH, reasoningEffort: 'low' }] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.deepEqual(agents.calls[0].agentOptions, { reasoningEffort: 'low' })
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})
await okA('plugin: a set reasoning effort rides alongside the default selection', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p1', model: 'm1' }) },
    dshHomePath: (p) => path.join(wsTmp, p),
  })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [{ ...ENDPOINT_GH, reasoningEffort: 'off' }] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.deepEqual(agents.calls[0].agentOptions, { provider: 'p1', model: 'm1', reasoningEffort: 'off' })
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})
await okA('plugin: a set reasoning effort rides alongside the endpoint model', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p1', model: 'm1' }) },
    dshHomePath: (p) => path.join(wsTmp, p),
  })
  const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints: [{ ...ENDPOINT_GH, model: 'em', reasoningEffort: 'max' }] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.deepEqual(agents.calls[0].agentOptions, { provider: 'p1', model: 'em', reasoningEffort: 'max' })
  assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
})
await okA('plugin: no reasoning effort with no model source: the agentOptions key is absent', async () => {
  dropHandoverSlot()
  const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
  const { ctx, routes } = makeFakeCtx({ agents, dshHomePath: (p) => path.join(wsTmp, p) })
  new DshWebhookDispatcherPlugin(ctx, { endpoints: [ENDPOINT_GH] })
  routes.get('/gh').handler(fakeReq({ method: 'GET' }).req, fakeRes())
  await flush()
  assert.equal('agentOptions' in agents.calls[0], false)
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

// ---------------------------------------------------------------- offload plane
// The offload plane (retention window, retention log, the sweep, the plugin
// lifecycle), in the same section order as the other offload plugins: window
// the window grammar, retlog the retention log format, knob the offload batch
// knob, health the round-health gates, sweep the sweep entry-pass states,
// budget the per-sweep budget and compaction, trend the growth-trend alert,
// arming the periodic arming, lifecycle the dispatch lifecycle through the
// real plugin, logfault the lost-log warning and the append/rewrite mutex,
// layout the layout pin.
console.log('offload plane')
{
  const offload = await import(path.join(root, 'lib', 'offload.js'))
  const {
    COMPACTION_RATIO,
    OffloadSweeper,
    OFFLOAD_ARCHIVE_DIR,
    OFFLOAD_HOME_BASE,
    OFFLOAD_LOG_FILE,
    OFFLOAD_STORE_ROOT,
    appendRetentionEntry,
    offloadLayout,
    readRetentionLog,
    rewriteRetentionLog,
  } = offload
  const retention = await import(path.join(root, 'lib', 'retention.js'))
  const { DEFAULT_OFFLOAD_BATCH, parseOffloadBatch, parseWindowMs } = retention

  const T0 = 1_000_000
  const W = 60_000 // the endpoint retention window used across the sweep cases
  const CWD = '/x/w' // a fake workspace; the fake persistence service keys on its basename
  const WS = path.basename(CWD) // the store-root segment the workspace maps to
  const iso = (ms) => new Date(ms).toISOString()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const mapUnit = (ms = W) => new Map([['gh', ms]])

  // A fake sessionPersistence service: locate() mirrors the framework jsonl
  // layout (the session dir is the dirname of the log path; a cwd-less
  // session lives at the store root's top level). Dispatched sessions always
  // carry a workspace, so the cwd-less branch is exercised only by directly
  // seeded log lines.
  const makeSpService = (storeRoot) => ({
    locate: (meta) => ({
      kind: 'jsonl',
      path: path.join(storeRoot, meta.cwd === undefined ? '' : path.basename(meta.cwd), meta.id, 'session.v4.jsonl.zstd'),
    }),
  })

  // A fake live-session registry (the ctx.get('sessions') face; `known` is a
  // mutable Set so a case can make a session live between two reads).
  const makeRegistry = (known) => {
    const set = known === undefined ? new Set() : known instanceof Set ? known : new Set(known)
    return { known: set, get: (id) => (set.has(id) ? { id } : undefined) }
  }

  // A capturing minimal ctx for the component tests: ctx.get routes to the
  // given services (soft read), the logger records warn/info/error/debug lines.
  const compCtx = (services = {}) => {
    const warns = []
    const infos = []
    const debugs = []
    const mkLog = () => ({
      warn: (m) => warns.push(m),
      error: (m) => warns.push(m),
      info: (m) => infos.push(m),
      debug: (m) => debugs.push(m),
    })
    const ctx = { get: (name) => (name in services ? services[name] : undefined), logger: mkLog }
    return { ctx, warns, infos, debugs }
  }

  // Build an OffloadSweeper rooted at a temp harness home (all the optional
  // test seams default to the production behavior).
  const makeSweeper = (home, opts = {}) => {
    const services = opts.services ?? {}
    const { ctx, warns, infos, debugs } = compCtx(services)
    const storeRoot = opts.storeRoot ?? path.join(home, OFFLOAD_STORE_ROOT)
    const pluginHome = path.join(home, OFFLOAD_HOME_BASE)
    const sweeper = new OffloadSweeper({
      ctx,
      logger: ctx.logger(),
      home: {
        base: pluginHome,
        archive: path.join(pluginHome, OFFLOAD_ARCHIVE_DIR),
        log: path.join(pluginHome, OFFLOAD_LOG_FILE),
        storeRoot,
      },
      units: () => (opts.units === undefined ? new Map() : opts.units),
      inflight: opts.inflight ?? new Set(),
      cap: opts.cap ?? DEFAULT_OFFLOAD_BATCH,
      now: opts.now,
      devOf: opts.devOf,
      move: opts.move,
    })
    return { sweeper, warns, infos, debugs, storeRoot }
  }

  // One round of fixtures: setup builds the home (store dir, log lines,
  // session dirs) and returns the sweeper handles; the round runs; the
  // asserts get the report plus the fixture paths.
  async function runCase(setup, verify) {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
    try {
      const ctx = {
        home,
        storeRoot: path.join(home, OFFLOAD_STORE_ROOT),
        logPath: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE),
        archiveDir: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR),
      }
      const handles = await setup(ctx)
      const report = await handles.sweeper.sweep()
      await verify({ ...ctx, report, warns: handles.warns ?? [] })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // Create a source session dir (the store side) the way the framework
  // would, and return its path.
  const makeSessionDir = (storeRoot, id, cwd) => {
    const dir = path.join(storeRoot, cwd === undefined ? '' : path.basename(cwd), id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'log')
    return dir
  }

  // -- window: the retention window parser (number = ms; string = 1-2 segments
  //        in descending unit order; the discriminating vectors rejected)
  ok('window-a: number windows are non-negative integer ms', () =>
    assert.deepEqual([parseWindowMs(0).ms, parseWindowMs(900000).ms], [0, 900000]),
  )
  ok('window-a: a negative, fractional or NaN number window is invalid', () =>
    assert.ok(!parseWindowMs(-1).ok && !parseWindowMs(1.5).ok && !parseWindowMs(Number.NaN).ok),
  )
  ok('window-b: one-segment duration strings', () =>
    assert.deepEqual(
      [parseWindowMs('1d').ms, parseWindowMs('24h').ms, parseWindowMs('30m').ms, parseWindowMs('90s').ms, parseWindowMs('5000ms').ms],
      [86_400_000, 86_400_000, 1_800_000, 90_000, 5000],
    ),
  )
  ok('window-b: two-segment durations in descending unit order', () =>
    assert.deepEqual(
      [parseWindowMs('1h30m').ms, parseWindowMs('4h30m').ms, parseWindowMs('1m30s').ms, parseWindowMs('1s500ms').ms],
      [5_400_000, 16_200_000, 90_000, 1500],
    ),
  )
  ok('window-c: the discriminating vectors are all invalid (strict segment grammar)', () =>
    assert.ok(
      ['1h30m30s', '30m4h', '1w', '1h 30m', '30', '5000', 'h', '24H', '1ms2s', '1w30m', 'banana', ''].every((v) => !parseWindowMs(v).ok),
    ),
  )
  ok('window-c: the range guard rejects overflow', () => assert.ok(!parseWindowMs('900000000d').ok))

  // -- retlog: the retention log (round trip, single append write per line, the
  //        torn-tail repair, the bad-line skip, the atomic rewrite)
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
    try {
      const log = path.join(dir, 'sub', 'retention-log.jsonl')
      const r0 = await readRetentionLog(log)
      ok('retlog-a: reading a missing log is an empty, un-repaired read', () =>
        assert.deepEqual([r0.entries.length, r0.repaired, r0.badLines], [0, false, 0]),
      )
      await appendRetentionEntry(log, { id: 'a', createdAt: iso(1), unit: 'gh', cwd: '/x/w' })
      await appendRetentionEntry(log, { id: 'b', createdAt: iso(2), unit: 'gh' })
      const lines = readFileSync(log, 'utf8').split('\n')
      ok('retlog-a: each append is exactly one complete line (single write per line)', () =>
        assert.equal(lines.filter((l) => l !== '').length, 2),
      )
      ok('retlog-a: the cwd key is present for the first line and omitted for the second', () =>
        assert.ok(lines[0].includes('"cwd":"/x/w"') && !lines[1].includes('cwd')),
      )
      const r1 = await readRetentionLog(log)
      ok('retlog-a: the round trip preserves the entry shape and order', () =>
        assert.equal(
          JSON.stringify(r1.entries),
          JSON.stringify([{ id: 'a', createdAt: iso(1), unit: 'gh', cwd: '/x/w' }, { id: 'b', createdAt: iso(2), unit: 'gh' }]),
        ),
      )
      const torn = path.join(dir, 'torn.jsonl')
      writeFileSync(torn, `{"id":"a","createdAt":"${iso(1)}","unit":"gh"}\n{"id":"p","createdAt":"${iso(2)}","unit":"gh"`)
      const rt = await readRetentionLog(torn)
      ok('retlog-b: a torn trailing line is repaired in place (back to the last newline)', () =>
        assert.ok(
          rt.repaired === true &&
            rt.entries.length === 1 &&
            readFileSync(torn, 'utf8') === `{"id":"a","createdAt":"${iso(1)}","unit":"gh"}\n`,
        ),
      )
      await appendRetentionEntry(torn, { id: 'c', createdAt: iso(3), unit: 'gh' })
      ok('retlog-b: an append after the repair lands on its own line', () =>
        assert.ok(readFileSync(torn, 'utf8').endsWith(`{"id":"c","createdAt":"${iso(3)}","unit":"gh"}\n`)),
      )
      const torn2 = path.join(dir, 'torn2.jsonl')
      writeFileSync(torn2, `{"id":"a","createdAt":"${iso(1)}","unit":"gh"`) // no trailing newline
      await appendRetentionEntry(torn2, { id: 'c', createdAt: iso(3), unit: 'gh' })
      const rt2 = await readRetentionLog(torn2)
      ok('retlog-b: an append to a torn tail closes it first (the new line stays parseable)', () =>
        assert.ok(
          readFileSync(torn2, 'utf8') ===
            `{"id":"a","createdAt":"${iso(1)}","unit":"gh"\n{"id":"c","createdAt":"${iso(3)}","unit":"gh"}\n` &&
            [rt2.entries.length, rt2.badLines, rt2.repaired].join() === '1,1,false',
        ),
      )
      const bad = path.join(dir, 'bad.jsonl')
      writeFileSync(bad, `{"id":"a","createdAt":"${iso(1)}","unit":"gh"}\nnot json\n{"id":"b","createdAt":"${iso(2)}","unit":"gh"}\n`)
      const rb = await readRetentionLog(bad)
      ok('retlog-c: unparseable lines are skipped and counted', () =>
        assert.deepEqual([rb.entries.length, rb.badLines, rb.repaired], [2, 1, false]),
      )
      await rewriteRetentionLog(log, [r1.entries[1]])
      const r2 = await readRetentionLog(log)
      ok('retlog-d: the compaction rewrite keeps exactly the survivors, in order', () =>
        assert.deepEqual(r2.entries.map((e) => e.id), ['b']),
      )
      ok('retlog-d: no temp file remains after the rewrite', () => assert.ok(!existsSync(`${log}.tmp`)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // -- knob: the offload batch knob (env DSH_WEBHOOK_OFFLOAD_BATCH: a positive
  //        integer, or the warn-and-keep degradation; the window itself is an
  //        endpoint field / DSH_WEBHOOK_<ID>_SESSION_RETENTION, exercised in
  //        the plugin-level lifecycle cases)
  {
    ok('knob-a: an absent knob falls back to the default', () =>
      assert.equal(parseOffloadBatch(undefined, () => {}), DEFAULT_OFFLOAD_BATCH),
    )
    ok('knob-a: a valid knob value is used', () => assert.equal(parseOffloadBatch('7', () => {}), 7))
    ok('knob-a: the default constant is 50', () => assert.equal(DEFAULT_OFFLOAD_BATCH, 50))
    const warns = []
    for (const v of ['0', '-2', 'abc', '5.5']) parseOffloadBatch(v, (m) => warns.push(m))
    ok('knob-b: each invalid knob value warns and falls back to the default', () => assert.equal(warns.length, 4))
    ok('knob-b: the warning names the knob', () => assert.ok(warns.every((m) => m.includes('DSH_WEBHOOK_OFFLOAD_BATCH'))))
  }

  // -- health: round health (the disabled branches: unreachable persistence
  //        service, missing store root, the mount mismatch; the registry
  //        fallback to the in-flight set)
  {
    await runCase(
      ({ home, storeRoot }) => {
        mkdirSync(storeRoot)
        return makeSweeper(home, { storeRoot, services: {} })
      },
      ({ report, warns }) => {
        ok('health-a: an unreachable persistence service skips the round with a warning', () => {
          assert.ok(report.disabled !== undefined)
          assert.ok(warns.some((m) => m.includes('persistence service is unreachable')))
        })
        ok('health-a: the skipped round performs no action', () =>
          assert.deepEqual([report.candidates, report.offloaded, report.balance], [0, 0, 0]),
        )
      },
    )
    await runCase(
      ({ home, storeRoot }) => {
        // The store root is never created (missing on this host).
        return makeSweeper(home, { storeRoot, services: { sessionPersistence: makeSpService(storeRoot) } })
      },
      ({ report, warns }) => {
        ok('health-b: a missing store root disables the round with a warning', () => {
          assert.ok(report.disabled !== undefined)
          assert.ok(warns.some((m) => m.includes('store root is missing')))
        })
      },
    )
    await runCase(
      ({ home, storeRoot }) => {
        mkdirSync(storeRoot)
        return makeSweeper(home, {
          storeRoot,
          services: { sessionPersistence: makeSpService(storeRoot) },
          devOf: (p) => Promise.resolve(p.includes(OFFLOAD_ARCHIVE_DIR) ? 1 : 2),
        })
      },
      ({ report, warns }) => {
        ok('health-c: a mount mismatch disables the round with a warning', () => {
          assert.ok(report.disabled !== undefined)
          assert.ok(warns.some((m) => m.includes('different mounts')))
        })
      },
    )
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'o4', CWD)
        await appendRetentionEntry(logPath, { id: 'o4', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot) },
          now: () => T0,
        })
      },
      ({ report, warns }) => {
        ok('health-d: an unreachable registry falls back to the in-flight set with a warning', () => {
          assert.equal(report.offloaded, 1)
          assert.ok(warns.some((m) => m.includes('registry service is unreachable')))
        })
      },
    )
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'o4', CWD)
        await appendRetentionEntry(logPath, { id: 'o4', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          inflight: new Set(['o4']),
          services: { sessionPersistence: makeSpService(storeRoot) },
          now: () => T0,
        })
      },
      async ({ report, warns, logPath }) => {
        ok('health-d: with the registry unreachable the in-flight set alone gates liveness', () => {
          assert.equal(report.skippedLive, 1)
          assert.ok(warns.some((m) => m.includes('registry service is unreachable')))
        })
        await okA('health-d: the live entry stays in the log', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 1),
        )
      },
    )
  }

  // -- sweep: the sweep core (window semantics, the existence table, the
  //        liveness rollback, the retry, the unit-gone rule)
  {
    // Cell 1: source present, destination absent (the normal path).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'c1', CWD)
        await appendRetentionEntry(logPath, { id: 'c1', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      async ({ report, storeRoot, archiveDir, logPath }) => {
        ok('sweep-a: the over-window settled session is offloaded', () =>
          assert.deepEqual([report.offloaded, report.candidates], [1, 1]),
        )
        ok('sweep-a: the session dir left the store and entered the archive', () => {
          assert.ok(!existsSync(path.join(storeRoot, WS, 'c1')))
          assert.ok(existsSync(path.join(archiveDir, 'c1')))
        })
        await okA('sweep-a: the completed line is removed by the compaction rewrite', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 0),
        )
      },
    )
    // Cell 2: neither side (the session was cleaned up externally).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        await appendRetentionEntry(logPath, { id: 'c2', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      async ({ report, logPath }) => {
        ok('sweep-b: a session on neither side completes (source gone)', () =>
          assert.deepEqual([report.sourceGone, report.offloaded, report.errors], [1, 0, 0]),
        )
        await okA('sweep-b: the completed line is removed', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 0),
        )
      },
    )
    // Cell 3: the archive already holds the session (an earlier round moved it).
    await runCase(
      async ({ home, storeRoot, archiveDir, logPath }) => {
        mkdirSync(storeRoot)
        mkdirSync(path.join(archiveDir, 'c3'), { recursive: true })
        writeFileSync(path.join(archiveDir, 'c3', 'session.v4.jsonl.zstd'), 'log')
        await appendRetentionEntry(logPath, { id: 'c3', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      async ({ report, logPath }) => {
        ok('sweep-c: a session already in the archive completes (already archived)', () =>
          assert.deepEqual([report.alreadyArchived, report.offloaded, report.errors], [1, 0, 0]),
        )
        await okA('sweep-c: the completed line is removed', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 0),
        )
      },
    )
    // Cell 4: both sides present (a true conflict the sweep must not resolve).
    await runCase(
      async ({ home, storeRoot, archiveDir, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'c4', CWD)
        mkdirSync(path.join(archiveDir, 'c4'), { recursive: true })
        writeFileSync(path.join(archiveDir, 'c4', 'session.v4.jsonl.zstd'), 'log')
        await appendRetentionEntry(logPath, { id: 'c4', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      async ({ report, storeRoot, archiveDir, logPath, warns }) => {
        ok('sweep-d: both sides present is an error, both sides kept', () => {
          assert.deepEqual([report.errors, report.offloaded], [1, 0])
          assert.ok(warns.some((m) => m.includes('both exist for session c4')))
        })
        ok('sweep-d: the source is intact and the archive side untouched', () => {
          assert.ok(existsSync(path.join(storeRoot, WS, 'c4')))
          assert.ok(existsSync(path.join(archiveDir, 'c4')))
        })
        await okA('sweep-d: the line stays in the log', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 1),
        )
      },
    )
    // A rename that fails with a transport error: the entry is kept, the
    // round retries it next time.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eio', CWD)
        await appendRetentionEntry(logPath, { id: 'eio', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        const err = new Error('i/o')
        err.code = 'EIO'
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
          move: () => Promise.reject(err),
        })
      },
      async ({ report, storeRoot, logPath, warns }) => {
        ok('sweep-e: a rename transport failure is an error, the entry is kept', () => {
          assert.deepEqual([report.errors, report.offloaded], [1, 0])
          assert.ok(warns.some((m) => m.includes('retried next round')))
        })
        ok('sweep-e: the source is intact', () => assert.ok(existsSync(path.join(storeRoot, WS, 'eio'))))
        await okA('sweep-e: the line stays in the log', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 1),
        )
      },
    )
    // A rename that reports ENOENT (the source vanished between the check
    // and the move).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eno', CWD)
        await appendRetentionEntry(logPath, { id: 'eno', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        const err = new Error('no such file')
        err.code = 'ENOENT'
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
          move: () => Promise.reject(err),
        })
      },
      async ({ report, logPath }) => {
        ok('sweep-f: a rename ENOENT converges to source-gone', () =>
          assert.deepEqual([report.sourceGone, report.errors], [1, 0]),
        )
        await okA('sweep-f: the entry completed and its line was removed', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 0),
        )
      },
    )
    // A rename that reports EEXIST with the source gone (an earlier round
    // moved it).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eex', CWD)
        await appendRetentionEntry(logPath, { id: 'eex', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        const err = new Error('file exists')
        err.code = 'EEXIST'
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
          move: async (s) => {
            rmSync(s, { recursive: true, force: true })
            throw err
          },
        })
      },
      async ({ report, logPath }) => {
        ok('sweep-g: an EEXIST with the source gone means the offload already happened', () =>
          assert.deepEqual([report.alreadyArchived, report.errors], [1, 0]),
        )
        await okA('sweep-g: the entry completed', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 0),
        )
      },
    )
    // A rename that reports EEXIST with the source still present (a true
    // conflict).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eex', CWD)
        await appendRetentionEntry(logPath, { id: 'eex', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        const err = new Error('file exists')
        err.code = 'EEXIST'
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
          move: () => Promise.reject(err),
        })
      },
      async ({ report, storeRoot, logPath, warns }) => {
        ok('sweep-g: an EEXIST with the source present is an error, both sides kept', () => {
          assert.deepEqual([report.errors, report.offloaded], [1, 0])
          assert.ok(warns.some((m) => m.includes('both sides remain')))
        })
        ok('sweep-g: the source is intact', () => assert.ok(existsSync(path.join(storeRoot, WS, 'eex'))))
        await okA('sweep-g: the line stays in the log', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 1),
        )
      },
    )
    // The locate call itself throws (a broken persistence backend).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        const broken = { locate: () => { throw new Error('backend down') } }
        await appendRetentionEntry(logPath, { id: 'loc', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: broken, sessions: makeRegistry() },
          now: () => T0,
        })
      },
      async ({ report, logPath, warns }) => {
        ok('sweep-h: a locate failure keeps the entry for the next round', () => {
          assert.deepEqual([report.errors, report.offloaded], [1, 0])
          assert.ok(warns.some((m) => m.includes('locating session loc failed')))
        })
        await okA('sweep-h: the line stays in the log', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 1),
        )
      },
    )
    // The liveness rollback: the session goes live between the gate and the
    // move (the source is moved back, the entry is kept).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'rb', CWD)
        await appendRetentionEntry(logPath, { id: 'rb', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        const reg = makeRegistry()
        const quiet = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
        const services = { sessionPersistence: makeSpService(storeRoot), sessions: reg }
        return {
          sweeper: new OffloadSweeper({
            ctx: { get: (name) => (name in services ? services[name] : undefined) },
            logger: quiet,
            home: {
              base: path.join(home, OFFLOAD_HOME_BASE),
              archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR),
              log: logPath,
              storeRoot,
            },
            units: () => mapUnit(),
            inflight: new Set(),
            cap: DEFAULT_OFFLOAD_BATCH,
            now: () => T0,
            move: async () => {
              reg.known.add('rb') // the session goes live in the gap
            },
          }),
        }
      },
      async ({ report, storeRoot, archiveDir, logPath }) => {
        ok('sweep-i: a session that goes live in the gap is neither offloaded nor an error', () =>
          assert.deepEqual([report.offloaded, report.errors, report.skippedLive], [0, 0, 0]),
        )
        ok('sweep-i: the rollback moved the session back to the store', () => {
          assert.ok(existsSync(path.join(storeRoot, WS, 'rb')))
          assert.ok(!existsSync(path.join(archiveDir, 'rb')))
        })
        await okA('sweep-i: the entry is kept for the next round', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 1),
        )
      },
    )
    // The unit-gone rule: no age check, the liveness gate still applies.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'ug', CWD)
        await appendRetentionEntry(logPath, { id: 'ug', createdAt: iso(T0 - 1000), unit: 'ghost', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      ({ report, archiveDir }) => {
        ok('sweep-j: a vanished unit is offloaded immediately, regardless of age', () =>
          assert.deepEqual([report.offloaded, report.candidates], [1, 1]),
        )
        ok('sweep-j: the fresh (within-window-age) session was moved', () => assert.ok(existsSync(path.join(archiveDir, 'ug'))))
      },
    )
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'ugl', CWD)
        const reg = makeRegistry(['ugl'])
        await appendRetentionEntry(logPath, { id: 'ugl', createdAt: iso(T0 - 1000), unit: 'ghost', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: reg },
          now: () => T0,
        })
      },
      ({ report }) => {
        ok('sweep-j: the liveness gate still applies to a vanished unit', () =>
          assert.deepEqual([report.skippedLive, report.offloaded], [1, 0]),
        )
      },
    )
    // The window-0 unit (retention closed): entries are kept, never
    // candidates.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'keep', CWD)
        await appendRetentionEntry(logPath, { id: 'keep', createdAt: iso(T0 - 10 * 365 * W), unit: 'cold', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: new Map([['cold', 0]]),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      async ({ report, logPath }) => {
        ok('sweep-k: a window-0 unit keeps even ancient entries', () =>
          assert.deepEqual([report.candidates, report.offloaded], [0, 0]),
        )
        await okA('sweep-k: the line survives', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 1),
        )
      },
    )
    // Reopening the window re-manages the retained entries (over-window
    // offloaded, within-window kept).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'old', CWD)
        makeSessionDir(storeRoot, 'new', CWD)
        await appendRetentionEntry(logPath, { id: 'old', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        await appendRetentionEntry(logPath, { id: 'new', createdAt: iso(T0 - 1000), unit: 'gh', cwd: CWD })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      ({ report, archiveDir, storeRoot }) => {
        ok('sweep-l: the reopened window offloads the over-window entries and keeps the fresh one', () =>
          assert.deepEqual([report.offloaded, report.candidates], [1, 1]),
        )
        ok('sweep-l: the over-window session is archived, the fresh one stays in the store', () => {
          assert.ok(existsSync(path.join(archiveDir, 'old')))
          assert.ok(existsSync(path.join(storeRoot, WS, 'new')))
        })
      },
    )
    // A cwd-less entry resolves through the store root's top level (a line
    // written before the workspace convention, or by an older plugin).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'nc', undefined)
        await appendRetentionEntry(logPath, { id: 'nc', createdAt: iso(T0 - 2 * W), unit: 'gh' })
        return makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
      },
      ({ report, archiveDir }) => {
        ok('sweep-m: a cwd-less entry is offloaded through the store-root top level', () =>
          assert.deepEqual([report.offloaded, report.errors], [1, 0]),
        )
        ok('sweep-m: the archive copy is named after the session id', () => assert.ok(existsSync(path.join(archiveDir, 'nc'))))
      },
    )
    // The archive dir is rebuilt after external deletion (the next round
    // heals).
    await runCase(
      async ({ home, storeRoot, logPath, archiveDir }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'h1', CWD)
        makeSessionDir(storeRoot, 'h2', CWD)
        await appendRetentionEntry(logPath, { id: 'h1', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        await appendRetentionEntry(logPath, { id: 'h2', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        const handles = makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        await handles.sweeper.sweep() // the first round: both offloaded, the archive exists
        rmSync(archiveDir, { recursive: true, force: true }) // the operator wiped it
        makeSessionDir(storeRoot, 'h3', CWD)
        await appendRetentionEntry(logPath, { id: 'h3', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        return handles
      },
      ({ report, archiveDir }) => {
        ok('sweep-n: after the archive dir was deleted externally the next round rebuilds it and continues', () =>
          assert.deepEqual([report.offloaded, report.errors], [1, 0]),
        )
        ok('sweep-n: the rebuilt archive holds the new offload', () => assert.ok(existsSync(path.join(archiveDir, 'h3'))))
      },
    )
  }

  // -- budget: the per-sweep budget (file order, the oldest-first identity, the
  //        knob, the compaction regimes, sweep idempotency)
  {
    // 51 candidates with the default cap of 50: the first round takes the
    // fifty oldest (file order), the second round the remainder.
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        for (let i = 0; i < 51; i++) {
          const id = `n${String(i).padStart(2, '0')}`
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        }
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        const first = await sweeper.sweep()
        ok('budget-a: the first round offloads exactly the budget', () =>
          assert.deepEqual([first.offloaded, first.candidates], [50, 50]),
        )
        await okA('budget-a: the identity is the single remainder line, in file order', async () =>
          assert.equal(
            JSON.stringify((await readRetentionLog(logPath)).entries.map((e) => e.id)),
            JSON.stringify(['n50']),
          ),
        )
        const second = await sweeper.sweep()
        ok('budget-a: the second round offloads the single remainder', () =>
          assert.deepEqual([second.offloaded, second.candidates], [1, 1]),
        )
        await okA('budget-a: the log is empty after both rounds', async () =>
          assert.equal((await readRetentionLog(logPath)).entries.length, 0),
        )
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // The knob: cap 3 over five candidates (three offloaded in file order,
    // then two).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        for (const id of ['k1', 'k2', 'k3', 'k4', 'k5']) {
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        }
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          cap: 3,
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        const first = await sweeper.sweep()
        ok('budget-b: a valid knob value caps the round', () => assert.deepEqual([first.offloaded, first.candidates], [3, 3]))
        const second = await sweeper.sweep()
        ok('budget-b: the remainder drains on the next round', () => assert.equal(second.offloaded, 2))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Compaction regime 1: the rate fits the budget (the file drains to
    // steady state, the second round is a zero-action no-op).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        for (let i = 0; i < 30; i++) {
          const id = `s${i}`
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        }
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        const first = await sweeper.sweep()
        ok('budget-c: the rate within the budget drains the file in one round', () =>
          assert.deepEqual([first.offloaded, first.removedLines, first.balance], [30, 30, 0]),
        )
        ok('budget-c: the compaction ratio triggered the rewrite', () => assert.equal(first.completedRatio, 1))
        const second = await sweeper.sweep()
        ok('budget-c: the next round is a zero-action no-op (sweep idempotency)', () =>
          assert.deepEqual([second.candidates, second.offloaded, second.removedLines, second.balance, second.increment], [0, 0, 0, 0, 0]),
        )
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Compaction regime 2: the rate exceeds the budget (the rewrite runs
    // while the completed share stays high; the balance creeps up by the
    // overrun per round).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        const archiveDir = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          cap: 3,
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        const rounds = []
        for (let r = 0; r < 3; r++) {
          for (let i = 0; i < 5; i++) {
            const id = `q${r}${i}`
            makeSessionDir(storeRoot, id, CWD)
            await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
          }
          rounds.push(await sweeper.sweep())
        }
        ok('budget-d: the over-budget rate rewrites while the completed share stays high', () =>
          assert.equal(
            JSON.stringify(rounds.map((rp) => [rp.offloaded, rp.removedLines, rp.balance])),
            JSON.stringify([[3, 3, 2], [3, 3, 4], [3, 3, 6]]),
          ),
        )
        ok('budget-d: every offload landed in the archive', () => {
          assert.ok(existsSync(path.join(archiveDir, 'q00')))
          assert.ok(existsSync(path.join(archiveDir, 'q13')))
        })
        ok('budget-d: the file line count equals the reported balance', () =>
          assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 6),
        )
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  }

  // -- trend: the trend alert (the consecutive over-envelope increments, the
  //        healthy negatives, the out-of-regime dormant branch, the knob
  //        recovery)
  {
    // Positive: the arrivals keep exceeding the budget for K rounds in a row.
    // (The first round only re-derives the balance baseline: it never judges.)
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: new Map([['cold', 0]]),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        const results = []
        for (let r = 0; r < 13; r++) {
          for (let i = 0; i < 60; i++) await appendRetentionEntry(logPath, { id: `t${r}-${i}`, createdAt: iso(T0), unit: 'cold' })
          results.push(await sweeper.sweep())
        }
        ok('trend-a: the alert fires exactly on the K-th consecutive over-envelope sweep', () =>
          assert.equal(
            JSON.stringify(results.map((rp) => rp.trendAlert)),
            JSON.stringify([false, false, false, false, false, false, false, false, false, false, true, true, true]),
          ),
        )
        ok('trend-a: the balance grows by the arrivals each round', () => assert.equal(results[12].balance, 13 * 60))
        ok('trend-a: the reported increment is the arrivals', () => assert.equal(results[12].increment, 60))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Healthy negative: bursts shorter than K rounds reset the counter.
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: new Map([['cold', 0]]),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        const results = []
        for (let r = 0; r < 8; r++) {
          const burst = r < 3 ? 60 : 0
          for (let i = 0; i < burst; i++) await appendRetentionEntry(logPath, { id: `h${r}-${i}`, createdAt: iso(T0), unit: 'cold' })
          results.push(await sweeper.sweep())
        }
        ok('trend-b: a burst shorter than K rounds never alerts', () => assert.ok(results.every((rp) => !rp.trendAlert)))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // At the boundary: arrivals equal to the budget are not over it (strict).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: new Map([['cold', 0]]),
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
          now: () => T0,
        })
        const results = []
        for (let r = 0; r < 12; r++) {
          for (let i = 0; i < 50; i++) await appendRetentionEntry(logPath, { id: `b${r}-${i}`, createdAt: iso(T0), unit: 'cold' })
          results.push(await sweeper.sweep())
        }
        ok('trend-c: arrivals at exactly the budget never alert (the comparison is strict)', () =>
          assert.ok(results.every((rp) => !rp.trendAlert)),
        )
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Out of regime: the rate is at least four times the budget (the
    // compaction trigger stays dormant, the alert is the visible signal);
    // raising the knob recovers it and flushes the completed backlog.
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        const services = { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }
        const units = mapUnit()
        const quiet = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
        const mkCtx = () => ({ get: (name) => (name in services ? services[name] : undefined), logger: () => quiet })
        let sweeper = new OffloadSweeper({
          ctx: mkCtx(),
          logger: quiet,
          home: {
            base: path.join(home, OFFLOAD_HOME_BASE),
            archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR),
            log: logPath,
            storeRoot,
          },
          units: () => units,
          inflight: new Set(),
          cap: 5,
          now: () => T0,
        })
        const results = []
        for (let r = 0; r < 12; r++) {
          for (let i = 0; i < 21; i++) {
            const id = `o${r}-${i}`
            makeSessionDir(storeRoot, id, CWD)
            await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
          }
          results.push(await sweeper.sweep())
        }
        ok('trend-d: the out-of-regime rate alerts after K consecutive rounds', () =>
          assert.equal(
            JSON.stringify(results.map((rp) => rp.trendAlert)),
            JSON.stringify([false, false, false, false, false, false, false, false, false, false, true, true]),
          ),
        )
        ok('trend-d: the compaction trigger stayed dormant through the whole burst', () =>
          assert.ok(results.every((rp) => rp.removedLines === 0 && rp.completedRatio < COMPACTION_RATIO)),
        )
        ok('trend-d: the deadweight backlog accumulated in the log file', () =>
          assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 12 * 21),
        )
        // The operator raises the knob: a fresh instance (like a process
        // restart) re-derives the baseline and the streak starts over.
        sweeper = new OffloadSweeper({
          ctx: mkCtx(),
          logger: quiet,
          home: {
            base: path.join(home, OFFLOAD_HOME_BASE),
            archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR),
            log: logPath,
            storeRoot,
          },
          units: () => units,
          inflight: new Set(),
          cap: 25,
          now: () => T0,
        })
        const recovery = []
        for (let r = 0; r < 3; r++) {
          recovery.push(await sweeper.sweep())
        }
        ok('trend-d: the raised knob re-enables the compaction trigger and flushes the backlog', () =>
          assert.equal(
            JSON.stringify(recovery.map((rp) => [rp.offloaded, rp.removedLines, rp.balance])),
            JSON.stringify([[25, 85, 167], [25, 0, 167], [25, 50, 117]]),
          ),
        )
        ok('trend-d: no trend alert under the recovered budget', () => assert.ok(recovery.every((rp) => !rp.trendAlert)))
        const survivors = await readRetentionLog(logPath)
        ok('trend-d: only the pending (never-offloaded) lines survived the flush', () =>
          assert.equal(survivors.entries.length, 117),
        )
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // trend-e: the alert line content (growth rate = (increment - cap) per sweep
    // and the branch discriminator: dormant out-of-regime vs active in-regime).
    {
      for (const [arrivals, cap, dormant] of [
        [21, 5, true],
        [12, 10, false],
      ]) {
        const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
        try {
          const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
          const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
          const services = { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }
          const units = mapUnit()
          const warns = []
          const mkLog = () => ({ warn: (m) => warns.push(m), error: () => {}, info: () => {}, debug: () => {} })
          const sweeper = new OffloadSweeper({
            ctx: { get: (name) => (name in services ? services[name] : undefined), logger: mkLog },
            logger: mkLog(),
            home: {
              base: path.join(home, OFFLOAD_HOME_BASE),
              archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR),
              log: logPath,
              storeRoot,
            },
            units: () => units,
            inflight: new Set(),
            cap,
            now: () => T0,
          })
          for (let r = 0; r < 12; r++) {
            for (let i = 0; i < arrivals; i++) {
              const id = `x${arrivals}-${r}-${i}`
              makeSessionDir(storeRoot, id, CWD)
              await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
            }
            await sweeper.sweep()
          }
          const alert = warns.find((m) => m.includes('trend alert'))
          const want = dormant
            ? ['growth rate 16/sweep', 'permanently dormant', 'completed lines are never evicted', 'check the offload batch knob first']
            : ['growth rate 2/sweep', 'still active', 'raise the offload batch knob or lower the dispatch rate']
          ok(`trend-e: the alert line carries the ${dormant ? 'dormant-branch' : 'active-branch'} content`, () => {
            assert.ok(alert !== undefined)
            for (const f of want) assert.ok(alert.includes(f), `missing: ${f}`)
          })
          sweeper.dispose()
        } finally {
          rmSync(home, { recursive: true, force: true })
        }
      }
    }
  }

  // -- arming: the periodic arming (the immediate first round, re-arm is a
  //        no-op, the disposer stops the timer)
  {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
    try {
      const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
      mkdirSync(storeRoot, { recursive: true })
      const { sweeper, debugs } = makeSweeper(home, {
        storeRoot,
        services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
      })
      sweeper.start()
      await flush()
      ok('arming-a: start arms an immediate first round (the no-op round logs at debug)', () =>
        assert.ok(debugs.some((m) => m.includes('sweep done'))),
      )
      sweeper.start() // re-arming is a no-op
      sweeper.dispose()
      ok('arming-a: dispose stops the timer without error', () => true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // -- lifecycle: the dispatch lifecycle through the real plugin (the write gate,
  //        the end-to-end archive move, the liveness gates, the units
  //        snapshot, the plane-unloaded degradation)
  {
    // Construct the real plugin on a fresh harness home with the offload
    // plane loaded, and return the fixture handles.
    function pluginProbe({ endpoints, agents, live } = {}) {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
      mkdirSync(storeRoot, { recursive: true })
      const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
      const { ctx, routes, logs, effects } = makeFakeCtx({
        agents,
        dshHomePath: (p) => path.join(home, p),
        ...offloadDoubles(storeRoot, live),
      })
      const plugin = new DshWebhookDispatcherPlugin(ctx, { endpoints })
      return { home, storeRoot, logPath, ctx, routes, logs, effects, plugin }
    }
    // Fire one delivery through the registered /gh route and hand back the
    // response double.
    function fireDelivery({ routes }) {
      const res = fakeRes()
      const { req, deliver } = fakeReq({ method: 'POST', body: Buffer.from('ping'), headers: { 'content-type': 'text/plain' } })
      routes.get('/gh').handler(req, res)
      deliver()
      return res
    }

    // lifecycle-a: the write gate open - a dispatched settled session is logged with
    // the session id, the endpoint unit, the dispatch time and the shared
    // workspace (the D18 default).
    await okA('lifecycle-a: a dispatched session with a retention window records the line (the write gate)', async () => {
      dropHandoverSlot()
      const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { home, logPath, routes, effects, plugin } = pluginProbe({
        endpoints: [{ ...ENDPOINT_GH, sessionRetention: '24h' }],
        agents,
      })
      fireDelivery({ routes })
      await flush()
      assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
      const sid = plugin.status().endpoints[0].lastDelivery.sessionId
      const lines = (await readRetentionLog(logPath)).entries
      assert.equal(lines.length, 1)
      assert.equal(lines[0].id, sid)
      assert.equal(lines[0].unit, 'gh')
      assert.equal(lines[0].cwd, path.join(home, OFFLOAD_HOME_BASE, 'workspace'))
      assert.ok(!Number.isNaN(Date.parse(lines[0].createdAt)))
      assert.equal(plugin['offloadInflight'].size, 0)
      disposeAll(effects)
      rmSync(home, { recursive: true, force: true })
    })
    // lifecycle-b: the write gate closed - a zero window is not tracked.
    await okA('lifecycle-b: a zero-window (unconfigured) endpoint records nothing (the write gate closed)', async () => {
      dropHandoverSlot()
      const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { home, logPath, routes, effects, plugin } = pluginProbe({ endpoints: [ENDPOINT_GH], agents })
      fireDelivery({ routes })
      await flush()
      await sleep(50) // any (skipped) retention append would have settled by now
      assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
      assert.ok(!existsSync(logPath))
      assert.equal(plugin['offloadInflight'].size, 0)
      disposeAll(effects)
      rmSync(home, { recursive: true, force: true })
    })
    // lifecycle-c: the write gate, workspace side - a session whose workspace could
    // not be prepared is never tracked (its store location is undeterminable).
    await okA('lifecycle-c: a session whose workspace could not be prepared is never tracked (silent)', async () => {
      dropHandoverSlot()
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
      mkdirSync(storeRoot, { recursive: true })
      // A file where the workspace directory must be created: the
      // preparation fails (ENOTDIR), the session is created without a
      // workspace.
      const blocker = path.join(home, 'blocker')
      writeFileSync(blocker, 'file')
      const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { ctx, routes, logs, effects } = makeFakeCtx({
        agents,
        dshHomePath: (p) => path.join(home, p),
        ...offloadDoubles(storeRoot),
      })
      const plugin = new DshWebhookDispatcherPlugin(ctx, {
        endpoints: [{ ...ENDPOINT_GH, cwd: path.join(blocker, 'sub'), sessionRetention: '24h' }],
      })
      fireDelivery({ routes })
      await flush()
      assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
      assert.ok(logs.warn.some((m) => m.includes('workspace preparation failed')))
      assert.ok(!existsSync(path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)))
      assert.equal(plugin['offloadInflight'].size, 0)
      disposeAll(effects)
      rmSync(home, { recursive: true, force: true })
    })
    // lifecycle-d: the end-to-end archive move through the plugin's own sweeper.
    await okA('lifecycle-d: an over-window settled session is offloaded end to end through the plugin sweeper', async () => {
      dropHandoverSlot()
      const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { home, storeRoot, logPath, routes, effects, plugin } = pluginProbe({
        endpoints: [{ ...ENDPOINT_GH, sessionRetention: '1ms' }],
        agents,
      })
      fireDelivery({ routes })
      await flush()
      assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
      const sid = plugin.status().endpoints[0].lastDelivery.sessionId
      // The framework store gains the settled session's log (the offload
      // source).
      mkdirSync(path.join(storeRoot, 'workspace', sid), { recursive: true })
      writeFileSync(path.join(storeRoot, 'workspace', sid, 'session.v4.jsonl.zstd'), 'log')
      await sleep(60) // age past the 1ms window
      const report = await plugin['sweeper'].sweep()
      assert.deepEqual([report.offloaded, report.candidates], [1, 1])
      assert.ok(!existsSync(path.join(storeRoot, 'workspace', sid)))
      assert.ok(existsSync(path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR, sid)))
      assert.equal((await readRetentionLog(logPath)).entries.length, 0)
      disposeAll(effects)
      rmSync(home, { recursive: true, force: true })
    })
    // lifecycle-e: the registry liveness gate (a session live in the framework
    // registry is never offloaded).
    await okA('lifecycle-e: a session that is live in the registry is never offloaded (the liveness gate)', async () => {
      dropHandoverSlot()
      const live = new Set()
      const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { home, storeRoot, logPath, routes, effects, plugin } = pluginProbe({
        endpoints: [{ ...ENDPOINT_GH, sessionRetention: '1ms' }],
        agents,
        live,
      })
      fireDelivery({ routes })
      await flush()
      const sid = plugin.status().endpoints[0].lastDelivery.sessionId
      live.add(sid)
      mkdirSync(path.join(storeRoot, 'workspace', sid), { recursive: true })
      writeFileSync(path.join(storeRoot, 'workspace', sid, 'session.v4.jsonl.zstd'), 'log')
      await sleep(60)
      const report = await plugin['sweeper'].sweep()
      assert.equal(report.skippedLive, 1)
      assert.ok(existsSync(path.join(storeRoot, 'workspace', sid)))
      assert.equal((await readRetentionLog(logPath)).entries.length, 1)
      disposeAll(effects)
      rmSync(home, { recursive: true, force: true })
    })
    // lifecycle-f: the in-flight gate (an unsettled dispatch is never offloaded,
    // regardless of age).
    await okA('lifecycle-f: an unsettled (in-flight) dispatch is never offloaded', async () => {
      dropHandoverSlot()
      const hang = makeFakeHandle({ events: [{ type: 'turn/end', data: { reason: 'completed' } }] })
      hang.handle.agent.whenIdle = () => new Promise(() => {}) // the settlement never completes
      const agents = makeFakeAgents(() => Promise.resolve(hang.handle))
      const { home, logPath, routes, effects, plugin } = pluginProbe({
        endpoints: [{ ...ENDPOINT_GH, sessionRetention: '1ms' }],
        agents,
      })
      fireDelivery({ routes })
      await flush()
      const st = plugin.status()
      assert.equal(st.endpoints[0].inFlight, 1)
      // The 202 already recorded the delivery as accepted; settlement
      // (and the final outcome) never completes while the session is hung.
      assert.equal(st.endpoints[0].lastDelivery.outcome, 'accepted')
      assert.equal(st.endpoints[0].lastDelivery.sessionId, undefined)
      assert.equal((await readRetentionLog(logPath)).entries.length, 1)
      assert.equal(plugin['offloadInflight'].size, 1)
      await sleep(60) // age past the 1ms window
      const report = await plugin['sweeper'].sweep()
      assert.equal(report.skippedLive, 1)
      assert.equal((await readRetentionLog(logPath)).entries.length, 1)
      disposeAll(effects)
      rmSync(home, { recursive: true, force: true })
    })
    // lifecycle-g: the units snapshot (a rebuilt plugin instance carries its own
    // endpoint view; a removed endpoint is a vanished unit whose pending
    // lines follow the non-retention semantics).
    await okA('lifecycle-g: a rebuilt instance carries its own endpoint view (a removed endpoint is a vanished unit)', async () => {
      dropHandoverSlot()
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
      mkdirSync(storeRoot, { recursive: true })
      const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
      // Instance A: the endpoint with a retention window dispatches (the line
      // is written; the window is too wide to offload anything while A lives).
      const agentsA = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { ctx: ctxA, routes: routesA, effects: effectsA } = makeFakeCtx({
        agents: agentsA,
        dshHomePath: (p) => path.join(home, p),
        ...offloadDoubles(storeRoot),
      })
      const pluginA = new DshWebhookDispatcherPlugin(ctxA, {
        endpoints: [{ ...ENDPOINT_GH, sessionRetention: '24h' }],
      })
      fireDelivery({ routes: routesA })
      await flush()
      const sid = pluginA.status().endpoints[0].lastDelivery.sessionId
      assert.equal((await readRetentionLog(logPath)).entries.length, 1)
      disposeAll(effectsA)
      // The framework store gains the settled session's log (the offload
      // source).
      mkdirSync(path.join(storeRoot, 'workspace', sid), { recursive: true })
      writeFileSync(path.join(storeRoot, 'workspace', sid, 'session.v4.jsonl.zstd'), 'log')
      // Instance B: the same home, the endpoint removed from the
      // configuration (its units view is empty: the line's unit has
      // vanished).
      const { ctx: ctxB, effects: effectsB } = makeFakeCtx({
        dshHomePath: (p) => path.join(home, p),
        ...offloadDoubles(storeRoot),
      })
      const pluginB = new DshWebhookDispatcherPlugin(ctxB, { endpoints: [] })
      assert.equal(pluginB.status().endpoints.length, 0)
      await flush()
      // B's first sweep round offloads the vanished unit's source without an
      // age check and drains the line.
      assert.ok(existsSync(path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR, sid)))
      assert.ok(!existsSync(path.join(storeRoot, 'workspace', sid)))
      assert.equal((await readRetentionLog(logPath)).entries.length, 0)
      disposeAll(effectsB)
      rmSync(home, { recursive: true, force: true })
    })
    // lifecycle-h: a host without the dshHomePath service loads the offload plane as
    // unloaded (the plugin still dispatches; nothing is tracked).
    await okA('lifecycle-h: a host without dshHomePath loads the offload plane as unloaded', async () => {
      dropHandoverSlot()
      const agents = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { ctx, routes, logs, effects } = makeFakeCtx({ agents })
      const plugin = new DshWebhookDispatcherPlugin(ctx, {
        endpoints: [{ ...ENDPOINT_GH, sessionRetention: '24h' }],
      })
      assert.equal(plugin['sweeper'], undefined)
      const res = fakeRes()
      const { req, deliver } = fakeReq({ method: 'POST', body: Buffer.from('ping'), headers: { 'content-type': 'text/plain' } })
      routes.get('/gh').handler(req, res)
      deliver()
      await flush()
      assert.equal(plugin.status().endpoints[0].lastDelivery.outcome, 'ok')
      assert.ok(logs.warn.some((m) => m.includes('offload plane (retention + archive) is not loaded')))
      assert.ok(logs.warn.some((m) => m.includes('no dshHomePath service; creating the session without a workspace')))
      disposeAll(effects)
    })
    // lifecycle-i: the unit is ALIVE but its window is removed (the endpoint stays
    // in the configuration without sessionRetention) the recorded line is
    // retained (window 0), in contrast to lifecycle-g's vanished unit. Pins the
    // constructor's units-map rule: a present endpoint without a window is a
    // live unit of window 0, never an absent unit.
    await okA('lifecycle-i: a present endpoint whose retention is removed keeps its recorded lines', async () => {
      dropHandoverSlot()
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
      mkdirSync(storeRoot, { recursive: true })
      const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
      // Instance A: the endpoint with a retention window dispatches (the line
      // is written; the window is too wide to offload anything while A lives).
      const agentsA = makeFakeAgents(() => Promise.resolve(okHandle().handle))
      const { ctx: ctxA, routes: routesA, effects: effectsA } = makeFakeCtx({
        agents: agentsA,
        dshHomePath: (p) => path.join(home, p),
        ...offloadDoubles(storeRoot),
      })
      const pluginA = new DshWebhookDispatcherPlugin(ctxA, {
        endpoints: [{ ...ENDPOINT_GH, sessionRetention: '24h' }],
      })
      fireDelivery({ routes: routesA })
      await flush()
      const sid = pluginA.status().endpoints[0].lastDelivery.sessionId
      assert.equal((await readRetentionLog(logPath)).entries.length, 1)
      disposeAll(effectsA)
      // The framework store gains the settled session's log (the offload
      // source).
      mkdirSync(path.join(storeRoot, 'workspace', sid), { recursive: true })
      writeFileSync(path.join(storeRoot, 'workspace', sid, 'session.v4.jsonl.zstd'), 'log')
      // Instance B: the same home, the SAME endpoint kept but without the
      // retention field (the unit is alive, its window is 0).
      const { ctx: ctxB, effects: effectsB } = makeFakeCtx({
        dshHomePath: (p) => path.join(home, p),
        ...offloadDoubles(storeRoot),
      })
      const pluginB = new DshWebhookDispatcherPlugin(ctxB, { endpoints: [{ ...ENDPOINT_GH }] })
      assert.equal(pluginB.status().endpoints.length, 1)
      await flush()
      // B's first sweep round retains the line (window 0): no archive, the
      // store side untouched, the line intact.
      assert.ok(!existsSync(path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR, sid)))
      assert.ok(existsSync(path.join(storeRoot, 'workspace', sid)))
      const kept = await readRetentionLog(logPath)
      assert.equal(kept.entries.length, 1)
      assert.equal(kept.entries[0].unit, 'gh')
      disposeAll(effectsB)
      rmSync(home, { recursive: true, force: true })
    })
  }

  // -- logfault: the lost-retention-log startup warning and the
  //         append<->compaction mutex (the rewrite-window seam)
  {
    const mkLostLogCase = async (seed) => {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const archive = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR)
        mkdirSync(storeRoot)
        const { sweeper, warns } = makeSweeper(home, {
          storeRoot,
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() },
        })
        seed(archive)
        await sweeper.sweep()
        await sweeper.sweep()
        sweeper.dispose()
        return warns.filter((m) => m.includes('retention log is missing'))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    const fresh = await mkLostLogCase(() => {})
    ok('logfault-a: a fresh install (no archive, no log) stays silent', () => assert.equal(fresh.length, 0))
    const lost = await mkLostLogCase((archive) => {
      mkdirSync(path.join(archive, 'x'), { recursive: true })
      writeFileSync(path.join(archive, 'x', 'session.v4.jsonl.zstd'), 'log')
    })
    ok('logfault-b: the lost log warns on the first round only (exactly once across rounds)', () => assert.equal(lost.length, 1))
    // logfault-c: park the compaction rewrite between its temp write and its
    // rename, append across the window, and prove the mutex serializes the
    // append onto the post-rename file (the line survives).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-webhook-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const archive = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot, { recursive: true })
        mkdirSync(archive, { recursive: true })
        // Four entries pre-archived (completed), one live (kept by the
        // rewrite): the round rewrites the log down to the live line.
        const liveId = 'm4'
        for (let i = 0; i < 5; i++) {
          const id = `m${i}`
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        }
        for (let i = 0; i < 4; i++) {
          renameSync(path.join(storeRoot, path.basename(CWD), `m${i}`), path.join(archive, `m${i}`))
        }
        let parked = false
        let release
        const gate = new Promise((r) => {
          release = r
        })
        offload.rewriteBarrier.fn = async () => {
          parked = true
          await gate
        }
        const { sweeper } = makeSweeper(home, {
          storeRoot,
          units: mapUnit(),
          now: () => T0,
          services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry([liveId]) },
        })
        // A ref'd keep-alive handle: the parked rewrite and the queued
        // append are pure promise chains, which alone would let the event
        // loop empty and end the process mid-window.
        const keepAlive = setInterval(() => {}, 50)
        const run = sweeper.sweep()
        while (!parked) await sleep(5)
        // The append is created (queued behind the rewrite in the mutex) but
        // not awaited yet: awaiting it before the release would deadlock,
        // because the rewrite holds the mutex until its rename.
        const pendingAppend = appendRetentionEntry(logPath, { id: 'mnew', createdAt: iso(T0 - 2 * W), unit: 'gh', cwd: CWD })
        release()
        await pendingAppend
        const rep = await run
        clearInterval(keepAlive)
        const after = (await readRetentionLog(logPath)).entries
        ok('logfault-c: an append parked in the rewrite window survives the rewrite (the write mutex)', () => {
          assert.equal(rep.removedLines, 4)
          assert.equal(after.length, 2)
          assert.ok(after.some((e) => e.id === liveId))
          assert.ok(after.some((e) => e.id === 'mnew'))
        })
        sweeper.dispose()
      } finally {
        offload.rewriteBarrier.fn = undefined
        rmSync(home, { recursive: true, force: true })
      }
    }
  }

  // -- layout: the plugin-level layout pin (the offload plane's home is the plugin home; the
  //         store root is the framework session store, a SIBLING of the
  //         plugin home, never under it; the constructor wires the layout
  //         through the single helper). The pure-ASCII pin of the two
  //         shipped plane files is covered by the strict ASCII gate at the
  //         top of this file (it scans the whole src/ tree).
  {
    const lay = offloadLayout((seg) => path.join('/h', seg))
    ok('layout-a: the layout resolves the plugin-home files under the plugin home', () => {
      assert.equal(lay.base, path.join('/h', OFFLOAD_HOME_BASE))
      assert.equal(lay.archive, path.join('/h', OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR))
      assert.equal(lay.log, path.join('/h', OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE))
    })
    ok('layout-a: the store root is the framework store, a sibling of the plugin home', () => {
      assert.equal(lay.storeRoot, path.join('/h', OFFLOAD_STORE_ROOT))
      assert.ok(!lay.storeRoot.startsWith(lay.base + path.sep))
    })
    const pluginSrc = readFileSync(path.join(root, 'src', 'plugin.ts'), 'utf8')
    ok('layout-b: the constructor wires the sweeper home through offloadLayout', () => {
      assert.ok(pluginSrc.includes('home: offloadLayout(resolveHome)'))
    })
    ok('layout-b: the constructor never re-derives the store root under the plugin home', () => {
      assert.ok(!pluginSrc.includes('OFFLOAD_STORE_ROOT'))
    })
  }
}

// selftest hygiene guard
{
  // The shipped tree is self-contained and decoupled from any design
  // document: the same pattern set applies to the test source (everything
  // above this marker), every shipped source file, and the shipped
  // skill/README (no doc pointers, no machine-specific paths, no line
  // pointers, no review-round or version-round tags, no review-finding
  // identifiers, no calendar dates, no CJK). A reader needs only this
  // package plus stable external authorities. This guard block is excluded
  // from its own scan. The set is FROZEN: closed token families only;
  // open-class failures belong to the review layer, not new patterns.
  const patterns = [
    ["design-doc section pointers", /design doc|design v\d|\u00a7\d/],
    ["machine-specific paths", /\/workspace\//],
    ["source line-number pointers", /L\d+[-\u2013\u2014]L?\d+/],
    ["review-round wrappers", /round-?\d+|review #\d/],
    ["project version-round tags", /\bv\d{2}\b/],
    ["review finding identifiers", /\b[RWV]\d{1,2}\b/],
    ["version-round identifiers", /\bv\d{2}[A-Za-z_]\w*/],
    ["calendar dates", /20\d{2}-\d{2}-\d{2}/],
    ["CJK characters", /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/],
  ]
  // Skill files ship into any profile agent context: they must be
  // deployment-agnostic (no literal host:port addresses - the curl recipes
  // use the <host>:<port> placeholder, derived from the webhook status
  // ingress block). Applied to skill/ files only (the README may show
  // concrete example values in configuration snippets).
  const skillOnlyPatterns = [
    ["literal host:port addresses", /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d\.)/],
  ]
  const raw = readFileSync(path.join(root, "test", "selftest.mjs"), "utf8")
  const sources = { "test/selftest.mjs": raw.slice(0, raw.indexOf("// selftest hygiene guard")) }
  for (const f of readdirSync(path.join(root, "src"))) {
    if (!f.endsWith(".ts")) continue
    sources["src/" + f] = readFileSync(path.join(root, "src", f), "utf8")
  }
  for (const f of readdirSync(path.join(root, "skill", "dsh-webhook-dispatcher"))) {
    sources["skill/dsh-webhook-dispatcher/" + f] = readFileSync(path.join(root, "skill", "dsh-webhook-dispatcher", f), "utf8")
  }
  sources["README.md"] = readFileSync(path.join(root, "README.md"), "utf8")
  for (const [file, code] of Object.entries(sources)) {
    for (const [label, re] of patterns) {
      ok("hygiene " + file + ": no " + label, () => {
        if (re.test(code)) throw new Error("pattern matched: " + re)
      })
    }
    if (file.startsWith("skill/")) {
      for (const [label, re] of skillOnlyPatterns) {
        ok("hygiene " + file + ": no " + label, () => {
          if (re.test(code)) throw new Error("pattern matched: " + re)
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
