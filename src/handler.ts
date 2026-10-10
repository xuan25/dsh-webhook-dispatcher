// dsh-webhook-dispatcher: the webServer route handler. The framework router
// already matched the exact path; the handler owns the full rejection total
// order: method -> auth -> body budget -> queue. Each stage answers before
// the next is evaluated. Responses are JSON: an oversize POST body is
// drained (resume()) so the socket can be answered with a clean 413, and a
// request-stream error (a client abort mid-body) answers a plugin-side
// 400 bad_request - the one transport-level 400 outside the delivery
// contract (a transport event, not a content event; no ring entry). No
// stage can throw: the body read is fully exception-guarded.
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeliveryContent, DeliveryRequest, EndpointConfig } from './types.js'
import type { EndpointPipeline } from './pipeline.js'

/** The 429 Retry-After seconds (the caller-facing backoff). */
const RETRY_AFTER_SECONDS = 5

/** Constant-time token comparison (length-guarded). */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented === '') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The JSON response writer. */
function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

/** Read the POST body up to `budget` bytes; reports oversize without buffering beyond the budget. */
function readBody(req: IncomingMessage, budget: number): Promise<{ oversize: true } | { content: DeliveryContent }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    const finish = (result: { oversize: true } | { content: DeliveryContent }): void => {
      if (done) return
      done = true
      resolve(result)
    }
    const fail = (err: unknown): void => {
      if (done) return
      done = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > budget) {
        // Budget exceeded: stop buffering, drain the rest of the request so
        // the socket can be answered cleanly.
        req.resume()
        finish({ oversize: true })
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const header = req.headers['content-type']
      const content: DeliveryContent = {
        contentType: typeof header === 'string' ? header : 'unknown',
        bytes: total,
      }
      if (total > 0) content.content = raw.toString('utf8')
      finish({ content })
    })
    req.on('error', fail)
  })
}

/** Extract the presented token: X-Webhook-Token if present, else Authorization: Bearer. */
function presentedToken(req: IncomingMessage): string | undefined {
  const x = req.headers['x-webhook-token']
  const fromX = typeof x === 'string' ? x : undefined
  if (fromX !== undefined && fromX !== '') return fromX
  const auth = req.headers['authorization']
  const bearer = typeof auth === 'string' ? auth : undefined
  if (bearer !== undefined && bearer.startsWith('Bearer ')) {
    const value = bearer.slice('Bearer '.length)
    if (value !== '') return value
  }
  return undefined
}

/**
 * Build the handler for one endpoint route.
 * @param config the effective endpoint config.
 * @param pipeline the endpoint's dispatch pipeline (queue admission + outcome recording).
 * @returns the webServer route handler.
 */
export function createHandler(
  config: EndpointConfig,
  pipeline: EndpointPipeline,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''

    // Stage 4 (reached after the body stage for POST, immediately for GET):
    // queue admission (the pipeline decides accepted / queued / 429).
    const stageQueue = (m: string, body: DeliveryContent | null): void => {
      const request: DeliveryRequest = { method: m === 'GET' ? 'GET' : 'POST', content: body }
      const decision = pipeline.admit(request)
      if (decision.kind === 'rejected') {
        pipeline.record('rejected_queue_full', m)
        respondJson(
          res,
          429,
          { error: 'queue_full', message: `endpoint "${config.id}" queue is at its cap (${config.maxQueue}); retry later` },
          { 'retry-after': String(RETRY_AFTER_SECONDS) },
        )
        return
      }
      pipeline.record(decision.kind === 'accepted' ? 'accepted' : 'queued', m)
      respondJson(res, 202, { status: decision.kind, queueDepth: pipeline.statusView().queueDepth })
    }

    // Stage 1: the method gate (before auth, before any body read).
    if (method !== 'GET' && method !== 'POST') {
      pipeline.record('rejected_method_not_allowed', method)
      respondJson(res, 405, { error: 'method_not_allowed', message: `${method} is not allowed on ${config.path}; use GET or POST` }, { allow: 'GET, POST' })
      return
    }

    // Stage 2: token auth (before the body read; open endpoints skip it).
    if (config.auth !== '') {
      const expected = process.env[config.auth]
      if (expected === undefined || expected === '') {
        // Fail-closed at request time as well: the token is re-read from
        // the env on every request, so a runtime env change (a rotation, or
        // the value being unset) is observed per request - an endpoint whose
        // auth env is empty answers 401 instead of silently opening (the
        // constructor already rejects an unset/empty env at boot).
        pipeline.record('rejected_unauthorized', method)
        respondJson(res, 401, { error: 'unauthorized', message: `endpoint auth env "${config.auth}" is not set` })
        return
      }
      if (!tokenMatches(expected, presentedToken(req))) {
        pipeline.record('rejected_unauthorized', method)
        respondJson(res, 401, { error: 'unauthorized', message: 'missing or invalid token' })
        return
      }
    }

    // Stage 3: the body budget (GET carries no body; an empty POST body is
    // a no-content delivery, not an error).
    if (method === 'POST') {
      void readBody(req, config.maxBodyBytes)
        .then((result) => {
          if ('oversize' in result) {
            pipeline.record('rejected_body_too_large', method)
            respondJson(res, 413, { error: 'body_too_large', message: `body exceeds ${config.maxBodyBytes} bytes` })
            return
          }
          stageQueue(method, result.content)
        })
        .catch(() => {
          if (!res.headersSent) {
            respondJson(res, 400, { error: 'bad_request', message: 'request body read failed' })
          } else {
            res.end()
          }
        })
      return
    }
    stageQueue(method, null)
  }
}
