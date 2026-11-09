/**
 * Replace one turn's history with a single stand-in message.
 *
 * A redo does not delete anything: the session log is append-only. It appends
 * ONE `user/message` carrying `{ op: 'replace', startSeq, endSeq }`, which
 * shadows the old turn in the derived model history while leaving every logged
 * event intact. That is the whole write.
 *
 * Two deliberate choices:
 *
 * - **No `compaction/*` events.** A fake compaction transaction would be read
 *   by the same code that renders and audits real ones, so an ordinary redo
 *   would masquerade as automatic condensation. The replacement carries its own
 *   source marker instead, and nothing else in the log claims to be a
 *   compaction.
 * - **Balanced edges are re-derived here.** A span may only start or end where
 *   no tool call awaits its result, or the derived message list would hold an
 *   orphaned call. Turn boundaries always satisfy this; validating anyway keeps
 *   a caller from aiming at an arbitrary message.
 *
 * @module dsh-better-session/redo/commit
 */
import { redoError } from './turn.js'

/**
 * Source kind stamped on a redo stand-in message, so a reader can tell an
 * ordinary turn from a rewritten one without consulting compaction state.
 */
export const REDO_SOURCE_KIND = 'redo-checkpoint'

/**
 * Whether the cut immediately before one surface node is tool-pairing balanced.
 *
 * Recomputes the balance instead of importing the shipped helper: this module
 * runs from a profile plugin, and depending on `@deepseek-ai/dsh-compaction` at
 * runtime would tie the plugin to one exact DSH build.
 *
 * A cut is expressed as "how many leading nodes stay on the left" — `count`.
 * The shipped helpers phrase the same thing as before/after one node; both are
 * one number here, which keeps the two call sites from disagreeing.
 * @param session - the live Session.
 * @param nodes - the current surface nodes.
 * @param count - number of leading nodes the cut leaves to the left.
 * @returns whether no unanswered tool call crosses that cut.
 */
export function balancedAtCount (session, nodes, count) {
  let pending = 0
  for (let position = 0; position < count; position += 1) {
    const event = session.eventAt(nodes[position])
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      for (const block of event.data.message?.content ?? []) {
        if (block?.type === 'tool-call') pending += 1
      }
    } else if (event.type === 'tool/result') {
      pending -= 1
      if (pending < 0) return false
    }
  }
  return pending === 0
}

/**
 * Whether the cut immediately before one surface node is balanced.
 *
 * "Before node i" leaves nodes `0..i-1` to the left, so the node itself and
 * everything after it stay right — that is what makes a span starting at `i`
 * safe only when the node at `i` is not mid-call.
 * @param session - the live Session.
 * @param nodes - the current surface nodes.
 * @param index - position of the boundary node.
 * @returns whether the cut before that node is balanced.
 */
export function balancedBefore (session, nodes, index) {
  return balancedAtCount(session, nodes, index)
}

/**
 * Whether the cut immediately after one surface node is balanced.
 * @param session - the live Session.
 * @param nodes - the current surface nodes.
 * @param index - position of the boundary node.
 * @returns whether the cut after that node is balanced.
 */
export function balancedAfter (session, nodes, index) {
  return balancedAtCount(session, nodes, index + 1)
}

/**
 * Validate one requested surface span before any asynchronous work.
 * @param session - the live Session.
 * @param start - inclusive first surface seq.
 * @param end - inclusive last surface seq.
 * @returns `{ nodes, startIdx, endIdx, shadowedSeqs }`.
 */
export function validateSpan (session, start, end) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw redoError(400, 'span-start', `surface seq ${start} is not in the current surface`)
  if (endIdx === -1) throw redoError(400, 'span-end', `surface seq ${end} is not in the current surface`)
  if (startIdx > endIdx) throw redoError(400, 'span-order', 'the span is reversed')
  if (!balancedBefore(session, nodes, startIdx)) {
    throw redoError(409, 'span-unbalanced', 'that span starts inside a tool call')
  }
  if (!balancedAfter(session, nodes, endIdx)) {
    throw redoError(409, 'span-unbalanced', 'that span ends inside a tool call, or its step is still open')
  }
  return { nodes, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/**
 * The stand-in text installed in place of a turn.
 *
 * A model-written summary when one was produced; otherwise a short fixed
 * notice followed by the turn's own words, which is cheaper than a model call
 * and honest about what happened.
 * @param params - `{ summary, originalText, reason }`.
 * @returns the message text.
 */
export function standInText (params) {
  const { summary, originalText } = params
  if (typeof summary === 'string' && summary.trim() !== '') {
    return `[Earlier turn, summarized]\n\n${summary.trim()}`
  }
  return `[Earlier turn, replaced — this is what it said]\n\n${String(originalText ?? '').trim()}`
}

/**
 * Append the replacing message.
 *
 * One synchronous append, so no other writer can observe an intermediate
 * state: either the turn is still present or the stand-in has replaced it.
 * @param session - the live Session.
 * @param params - the validated span, stand-in text and the redo identity.
 * @returns the committed record.
 */
export function commitReplacement (session, params) {
  const { start, end, shadowedSeqs, text, redoId, shadowedTokenCount } = params
  const event = session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text }],
    // The marker is what lets a reader tell a rewritten turn from an ordinary
    // one; it is deliberately NOT the compaction checkpoint marker.
    source: { kind: REDO_SOURCE_KIND, redoId },
  }, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [...shadowedSeqs],
  })
  return {
    redoId,
    seq: event.seq,
    replacedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  }
}
