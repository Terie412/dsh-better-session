/**
 * Redo one turn: replace its history with a stand-in, then re-ask.
 *
 * The flow, in order:
 *
 * 1. locate the completed turn owning a user message,
 * 2. read its surface span and decide whether a model summary is worth it,
 * 3. append one replacement message that shadows the old turn,
 * 4. admit the author's edited text as a fresh prompt.
 *
 * Step 3 is the only one that changes history, and it is a single append: a
 * redo either lands whole or leaves the session untouched.
 *
 * @module dsh-better-session/redo/flow
 */
import { commitReplacement, standInText, validateSpan } from './commit.js'
import { buildSummaryPrompt, locateTurn, surfaceRange, redoError } from './turn.js'

/**
 * Characters of turn text below which a model summary is pointless.
 *
 * A summary of a very short turn tends to be no shorter than the turn itself,
 * so it costs a request and buys nothing. The operator stays well under any
 * context limit and is trivially cheap to keep.
 */
const SUMMARY_MIN_CHARS = 600

/** Upper bound on the summary request, so a redo cannot stall on a slow model. */
const SUMMARY_TIMEOUT_MS = 45000

/**
 * Read the plain text of one turn's messages.
 * @param session - the live Session.
 * @param shadowedSeqs - the turn's surface nodes.
 * @returns the concatenated prose and whether it came out empty.
 */
export function turnText (session, shadowedSeqs) {
  const lines = []
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'user/message') {
      const text = (event.data.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.trim() !== '') lines.push(text)
    } else if (event.type === 'assistant/message') {
      const text = (event.data.message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.trim() !== '') lines.push(text)
    }
  }
  return lines.join('\n\n')
}

/**
 * Ask the session's own model for a compact summary of one turn.
 *
 * Returns `undefined` rather than throwing when the summarizer is unavailable
 * or fails: a redo must still work, falling back to the cheaper stand-in. The
 * failure is reported to the caller for the UI notice.
 * @param ctx - Host plugin context.
 * @param agent - the live Agent, whose route the summary borrows.
 * @param session - the live Session.
 * @param shadowedSeqs - the turn's surface nodes.
 * @param signal - cancellation.
 * @returns `{ summary }` or `{ failure }`.
 */
export async function summarizeTurn (ctx, agent, session, shadowedSeqs, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { failure: 'no-llm' }
  }
  const selection = agent.modelSelection ?? agent.options ?? {}
  const provider = selection.provider
  const model = selection.model
  if (typeof provider !== 'string' || typeof model !== 'string') {
    return { failure: 'no-route' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let text = ''
    const stream = llm.stream({
      provider,
      model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildSummaryPrompt(session, shadowedSeqs) }],
      }],
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'finish') break
    }
    const summary = text.trim()
    return summary === '' ? { failure: 'empty' } : { summary }
  } catch (error) {
    return { failure: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Resolve which log position a redo request names.
 *
 * The Client can supply a sequence directly, but the row props it receives
 * carry only the message `source`, which is `{ kind, rpcId, clientTimeZone }` —
 * no id and no position. The `rpcId` is the submission's own identity, so the
 * authoritative lookup happens here, over the log, instead of in the browser.
 * @param session - the live Session.
 * @param request - `{ messageSeq?, rpcId? }`.
 * @returns the message's sequence number.
 */
export function resolveMessageSeq (session, request) {
  const direct = Number(request?.messageSeq)
  if (Number.isSafeInteger(direct) && direct >= 0) return direct

  const rpcId = typeof request?.rpcId === 'string' ? request.rpcId : ''
  if (rpcId === '') {
    throw redoError(400, 'no-target', 'either messageSeq or rpcId is required')
  }
  for (const event of session.ownEvents()) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.rpcId === rpcId) return event.seq
  }
  throw redoError(404, 'message-not-found', 'that message is not in this session log')
}

/**
 * Perform one redo.
 *
 * Serialized by the caller per session: two concurrent redos of the same turn
 * would each try to replace an overlapping span, and the second append would
 * be refused after the first had already changed history.
 * @param ctx - Host plugin context.
 * @param agent - the live Agent owning the Session.
 * @param request - `{ messageSeq? , rpcId?, text? }`, where `text` is the edited message.
 * @param signal - cancellation.
 * @returns the committed record plus how the stand-in was produced.
 */
export async function redoTurn (ctx, agent, request, signal) {
  const session = agent.session
  if (session === undefined) throw redoError(400, 'no-session', 'that agent has no session')
  const seq = resolveMessageSeq(session, request)

  const located = locateTurn(session, seq)
  const range = surfaceRange(session, located.startSeq, located.endSeq)
  const span = validateSpan(session, range.start, range.end)

  // The edited text: the author's new wording, or the original when only a
  // plain redo was asked for.
  const edited = typeof request?.text === 'string' ? request.text.trim() : ''
  const nextText = edited !== '' ? edited : (located.userText ?? '').trim()
  if (nextText === '') throw redoError(400, 'empty-text', 'there is no message to send again')

  const original = turnText(session, span.shadowedSeqs)
  let mode = 'notice'
  let note
  let summary
  if ([...original].length >= SUMMARY_MIN_CHARS) {
    const attempt = await summarizeTurn(ctx, agent, session, span.shadowedSeqs, signal)
    if (attempt.summary !== undefined) {
      summary = attempt.summary
      mode = 'summary'
    } else {
      note = attempt.failure
    }
  } else {
    note = 'too-short'
  }

  const text = standInText({ summary, originalText: original })
  const redoId = `redo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const shadowedTokenCount = Math.ceil(original.length / 4)
  const committed = commitReplacement(session, {
    start: range.start,
    end: range.end,
    shadowedSeqs: span.shadowedSeqs,
    text,
    redoId,
    shadowedTokenCount,
  })

  // The durable barrier matters: the replacement must be on disk before the
  // follow-up prompt runs, or a crash would resume a session whose history
  // claims the old turn is still current.
  //
  // `ctx.get` rather than `ctx.sessions`: this plugin declares only the route
  // carrier as a hard dependency, so the property form would throw. Flushing is
  // best effort in a profile without persistence, which is exactly what the
  // optional lookup expresses.
  const sessions = ctx.get('sessions')
  if (typeof sessions?.flush === 'function') await sessions.flush(session)

  return {
    turn: located.turn,
    mode,
    ...(note === undefined ? {} : { note }),
    ...committed,
    nextText,
  }
}
