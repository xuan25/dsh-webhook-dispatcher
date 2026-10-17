// dsh-webhook-dispatcher: the trigger-session prompt template. Laid out
// static-first per the shared layering convention of the sibling trigger
// plugins: the label line (always line one: skill matching and
// trigger-session self-identification depend on it), the Policy block
// (omitted when the policy is empty) and the execution-rules pointer form
// the static layer; the content metadata (Content-Type / Bytes) and the
// fenced verbatim payload form the dynamic layer. Deterministic: a given
// (endpoint config, delivery content) yields byte-identical output
// (test-asserted; the acceptance chain byte-matches the first session
// message against it). The fence around the verbatim content is one
// backtick longer than the longest backtick run in the content (unbounded
// rule: the fence always wins - the content can never break out of its
// fence); the floor is three ticks (a one- or two-tick fence would also
// break a ```-fenced markdown block). A no-content delivery (a GET, or a
// POST with an empty body) replaces the whole content block with the single
// line `(no content)`; an empty policy omits the Policy block.
import type { DeliveryContent, EndpointConfig } from './types.js'

/** The minimum fence length (ticks). */
const FENCE_FLOOR = 3

/** The longest run of consecutive backtick characters in `content` (0 when absent). */
export function longestBacktickRun(content: string): number {
  let max = 0
  let run = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x60) {
      run += 1
      if (run > max) max = run
    } else {
      run = 0
    }
  }
  return max
}

/** The fence (backtick run) that safely wraps `content`. */
export function fenceFor(content: string): string {
  return '`'.repeat(Math.max(FENCE_FLOOR, longestBacktickRun(content) + 1))
}

/** True when the delivery carries no content (a GET, or a body-less POST). */
export function hasContent(content: DeliveryContent | null): boolean {
  return content !== null && content.content !== undefined
}

/**
 * Build the first-turn prompt of a trigger session.
 * @param config the effective endpoint config.
 * @param content the delivery payload (null = a no-content GET delivery).
 * @returns the prompt text (no trailing newline).
 */
export function buildPrompt(config: EndpointConfig, content: DeliveryContent | null): string {
  const lines: string[] = []
  lines.push(`<dsh-webhook-dispatcher> delivery from endpoint "${config.name}" (${config.path}):`)
  lines.push('')
  if (config.policy !== '') {
    lines.push('Policy:')
    lines.push(config.policy)
    lines.push('')
  }
  lines.push('Execution rules: see the "Trigger session" section of the dsh-webhook-dispatcher skill.')
  lines.push('')
  if (content !== null && content.content !== undefined) {
    const text = content.content
    lines.push(`Content-Type: ${content.contentType || 'unknown'}`)
    lines.push(`Bytes: ${content.bytes}`)
    lines.push('')
    const fence = fenceFor(text)
    lines.push(fence)
    lines.push(text)
    lines.push(fence)
  } else {
    lines.push('(no content)')
  }
  return lines.join('\n')
}
