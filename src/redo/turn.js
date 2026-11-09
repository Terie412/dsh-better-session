/**
 * Redo one turn: replace its history with a summary, then re-ask.
 *
 * DSH's session log is append-only, so "editing" an old turn is expressed the
 * way the platform itself expresses it: a `replace` surface operation shadows
 * the old turn and installs one summary message in its place. The archive
 * keeps every event; the derived model history — and therefore the next
 * request — sees only the summary plus whatever is asked next.
 *
 * The two halves:
 *
 * 1. {@link summarizeRange} appends `compaction/summary` and a replacement
 *    `user/message` covering the turn's surface span. This mirrors the shipped
 *    compaction backend's commit exactly (same event pair, same
 *    `compactCheckpointSource` correlation, same balanced-edge rule), because
 *    that pair is what every downstream reader — transcript rendering, the
 *    model history fold, fork reconstruction — already understands.
 * 2. {@link sendEdited} admits the author's edited text as a fresh prompt.
 *
 * Balanced edges are the hard constraint: a span may only start or end where
 * no tool call is awaiting its result. Turn boundaries always satisfy this,
 * which is why a redo is scoped to a whole turn rather than an arbitrary
 * message.
 *
 * @module dsh-better-session/redo
 */

/** Surface events a turn can be made of. */
const USER = 'user/message'

/**
 * A rejection with an HTTP status and a stable machine code.
 * @param status - HTTP status code.
 * @param code - stable code.
 * @param message - human-readable text.
 * @returns the throwable error.
 */
export function redoError (status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/**
 * Locate the completed turn that owns one user message.
 *
 * The clicked message identifies its turn by position: the turn is the last
 * one that started at or before the message. An open turn is refused, because
 * rewriting history under a running turn would race the agent loop.
 * @param session - the live Session.
 * @param messageSeq - surface seq of the user message the author clicked.
 * @returns `{ turn, startSeq, endSeq, userText }`.
 */
export function locateTurn (session, messageSeq) {
  let turn = null
  let startSeq = null
  let endSeq = null
  let userText = null
  for (const event of session.ownEvents()) {
    if (event.type === 'turn/start' && event.seq <= messageSeq) {
      // Keep the latest start at or before the message: several turns exist,
      // and the message belongs to the last one that began before it.
      turn = event.data.turn
      startSeq = event.seq
      endSeq = null
    }
    if (event.type === 'turn/end' && turn !== null && event.data.turn === turn) {
      endSeq = event.seq
    }
    if (event.seq === messageSeq && event.type === USER) {
      const blocks = event.data.content ?? []
      userText = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    }
  }
  if (turn === null || startSeq === null) {
    throw redoError(400, 'turn-not-found', 'no turn starts at or before that message')
  }
  if (endSeq === null) {
    throw redoError(409, 'turn-open', 'that turn is still running')
  }
  return { turn, startSeq, endSeq, userText }
}

/**
 * The inclusive surface span one turn occupies.
 *
 * Compaction addresses surface nodes, not raw log positions, because an
 * earlier replacement can reorder them. The span runs from the first surface
 * node at or after the turn start to the last one at or before its end.
 * @param session - the live Session.
 * @param startSeq - the turn's `turn/start` seq.
 * @param endSeq - the turn's `turn/end` seq.
 * @returns `{ start, end }` inclusive surface seqs.
 */
export function surfaceRange (session, startSeq, endSeq) {
  // Positions, not numbers: a replacement appends a node whose seq is HIGHER
  // than the range it shadows while sitting EARLIER on the surface, so the node
  // list is not monotonic and comparing seqs would pick the wrong edges. The
  // turn owns the contiguous run of surface positions whose nodes were logged
  // inside it.
  const nodes = session.surface.nodes
  const inside = []
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index]
    if (seq >= startSeq && seq <= endSeq) inside.push({ index, seq })
  }
  if (inside.length === 0) {
    throw redoError(400, 'empty-range', 'that turn has no model-visible messages')
  }
  // The run must be contiguous; a gap means an earlier replacement already
  // removed part of this turn, and replacing across it would split that one.
  const first = inside[0]
  const last = inside[inside.length - 1]
  if (last.index - first.index !== inside.length - 1) {
    throw redoError(409, 'fragmented-turn', 'this turn was already partly replaced')
  }
  return { start: first.seq, end: last.seq }
}

/**
 * Frame the summary the way the shipped backend does, so every reader treats
 * it as an ordinary compaction checkpoint rather than unknown prose.
 * @param text - the model-written summary.
 * @returns the content blocks of the replacement user message.
 */
export function frameSummary (text) {
  return [{
    type: 'text',
    text: `The following is a summary of earlier conversation that has been condensed.\n\n${text}`,
  }]
}

/**
 * The prompt used to summarize one turn.
 * @param session - the live Session.
 * @param shadowedSeqs - the surface nodes being replaced.
 * @returns the message text handed to the summarizing model.
 */
export function buildSummaryPrompt (session, shadowedSeqs) {
  const lines = []
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === USER) {
      const text = (event.data.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.trim() !== '') lines.push(`User: ${text}`)
    } else if (event.type === 'assistant/message') {
      const text = (event.data.message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.trim() !== '') lines.push(`Assistant: ${text}`)
    } else if (event.type === 'assistant/message') {
      // Tool calls carry no prose, but their names explain what was attempted.
      const calls = (event.data.message?.content ?? [])
        .filter((block) => block?.type === 'tool-call')
        .map((block) => block.name)
      if (calls.length > 0) lines.push(`Tools called: ${calls.join(', ')}`)
    } else if (event.type === 'tool/result') {
      const failed = event.data.error !== undefined || event.data.message?.isError === true
      lines.push(failed ? 'A tool call failed.' : 'A tool call succeeded.')
    }
  }
  return [
    'Summarize the conversation excerpt below in at most 120 words.',
    'State what the user asked for, what was attempted, and what came of it, so that the work can be continued from this summary alone.',
    'Write plain prose. Do not add headings, preamble, or a closing offer to help.',
    '',
    'Excerpt:',
    lines.join('\n'),
  ].join('\n')
}
