/**
 * Tests for the redo-turn logic: turn location, span validation, stand-in text
 * and the committed record.
 *
 * Everything here runs against a fabricated Session, so the arithmetic that
 * decides WHICH messages get replaced is verified without a live agent.
 *
 * Usage: node test/redo.mjs
 */
import { commitReplacement, balancedAtCount, standInText, validateSpan } from '../src/redo/commit.js'
import { resolveMessageSeq, turnText } from '../src/redo/flow.js'
import { buildSummaryPrompt, locateTurn, surfaceRange } from '../src/redo/turn.js'

let failures = 0
function check (name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * Build a Session-like object that records appends.
 * @param events - the durable events.
 * @param nodes - the surface node seqs.
 */
function fakeSession (events, nodes) {
  const appended = []
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  let nextSeq = events.length === 0 ? 0 : Math.max(...events.map((e) => e.seq)) + 1
  return {
    appended,
    ownEvents: () => events,
    eventAt: (seq) => bySeq.get(seq),
    surface: { nodes },
    append (type, data, opts) {
      const event = { type, seq: nextSeq, data, ...opts }
      nextSeq += 1
      appended.push(event)
      return event
    },
  }
}

const turnStart = (seq, turn) => ({ type: 'turn/start', seq, data: { turn } })
const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, data: { turn } })
const userMsg = (seq, text) => ({
  type: 'user/message',
  seq,
  data: { role: 'user', content: [{ type: 'text', text }] },
})
const assistantMsg = (seq, text) => ({
  type: 'assistant/message',
  seq,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const toolCall = (seq) => ({
  type: 'assistant/message',
  seq,
  data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } },
})
const toolResult = (seq) => ({ type: 'tool/result', seq, data: { message: { role: 'tool', isError: false } } })

// ══ Turn location ══════════════════════════════════════════════════════════
console.log('locateTurn')
const twoTurns = [
  turnStart(1, 1), userMsg(2, 'first'), assistantMsg(3, 'ok'), turnEnd(4, 1),
  turnStart(5, 2), userMsg(6, 'second'), assistantMsg(7, 'sure'), turnEnd(8, 2),
]
const located = locateTurn(fakeSession(twoTurns, [2, 3, 6, 7]), 6)
check('finds the owning turn', located.turn === 2, JSON.stringify(located))
check('reports the turn start', located.startSeq === 5)
check('reports the turn end', located.endSeq === 8)
check('extracts the clicked message text', located.userText === 'second')

const first = locateTurn(fakeSession(twoTurns, [2, 3, 6, 7]), 2)
check('a click in turn 1 finds turn 1', first.turn === 1 && first.endSeq === 4)

let openError = null
try {
  locateTurn(fakeSession([turnStart(1, 1), userMsg(2, 'running'), assistantMsg(3, 'x')], [2, 3]), 2)
} catch (error) {
  openError = error
}
check('refuses a running turn', openError?.code === 'turn-open', String(openError?.code))

let noTurn = null
try {
  locateTurn(fakeSession([userMsg(0, 'orphan')], [0]), 0)
} catch (error) {
  noTurn = error
}
check('refuses a message with no turn', noTurn?.code === 'turn-not-found')

// ══ Surface range ══════════════════════════════════════════════════════════
console.log('\nsurfaceRange')
const range = surfaceRange(fakeSession(twoTurns, [2, 3, 6, 7]), 5, 8)
check('turn 2 starts at its first node', range.start === 6)
check('turn 2 ends at its last node', range.end === 7)
check('turn 1 is the earlier half', JSON.stringify(surfaceRange(fakeSession(twoTurns, [2, 3, 6, 7]), 1, 4)) === '{"start":2,"end":3}')
let emptyRange = null
try {
  surfaceRange(fakeSession(twoTurns, [2, 3]), 5, 8)
} catch (error) {
  emptyRange = error
}
check('refuses a turn with no surface nodes', emptyRange?.code === 'empty-range')

// ══ Balanced edges ═════════════════════════════════════════════════════════
console.log('\nbalanced edges')
const withTool = [userMsg(2, 'go'), toolCall(3), toolResult(4)]
const toolSession = fakeSession(withTool, [2, 3, 4])
check('cut before a user message is balanced', balancedAtCount(toolSession, [2, 3, 4], 0) === true)
check('cut between a call and its result is unbalanced', balancedAtCount(toolSession, [2, 3, 4], 2) === false)
check('cut after the result is balanced', balancedAtCount(toolSession, [2, 3, 4], 3) === true)

// A span ending on an unanswered tool call is refused: the derived history
// would carry a call whose result is outside the replaced range.
const openCall = [userMsg(2, 'go'), toolCall(3)]
let unbalanced = null
try {
  validateSpan(fakeSession(openCall, [2, 3]), 2, 3)
} catch (error) {
  unbalanced = error
}
check('span ending inside a tool call is refused', unbalanced?.code === 'span-unbalanced', String(unbalanced?.code))

let reversed = null
try {
  validateSpan(fakeSession(twoTurns, [2, 3, 6, 7]), 7, 2)
} catch (error) {
  reversed = error
}
check('reversed span is refused', reversed?.code === 'span-order')

let missing = null
try {
  validateSpan(fakeSession(twoTurns, [2, 3, 6, 7]), 99, 7)
} catch (error) {
  missing = error
}
check('span outside the surface is refused', missing?.code === 'span-start')

// ══ The committed append ═══════════════════════════════════════════════════
console.log('\ncommitReplacement')
const commitSession = fakeSession(twoTurns, [2, 3])
const committed = commitReplacement(commitSession, {
  start: 2,
  end: 3,
  shadowedSeqs: [2, 3],
  text: '[Earlier turn, summarized]\n\nsomething',
  redoId: 'redo-1',
  shadowedTokenCount: 12,
})
check('exactly one event is appended', commitSession.appended.length === 1, String(commitSession.appended.length))
const appended = commitSession.appended[0]
check('the appended event is a user message', appended.type === 'user/message')
check('it replaces the span', JSON.stringify(appended.surfaceOp) === '{"op":"replace","startSeq":2,"endSeq":3}')
check('it cites the shadowed nodes', JSON.stringify(appended.sourceEventSeqs) === '[2,3]')
check('its source is a redo marker, not a compaction one', appended.data.source.kind === 'redo-checkpoint', appended.data.source.kind)
check('no compaction events are fabricated', !commitSession.appended.some((e) => e.type.startsWith('compaction/')))
check('the returned record names the range', JSON.stringify(committed.replacedRange) === '{"start":2,"end":3}')

// ══ Stand-in text ══════════════════════════════════════════════════════════
console.log('\nstandInText')
check('a summary is labelled', standInText({ summary: 'did the thing' }).includes('[Earlier turn, summarized]'))
check('a summary keeps its body', standInText({ summary: 'did the thing' }).includes('did the thing'))
check('no summary falls back to the original', standInText({ originalText: 'the original words' }).includes('the original words'))
check('the fallback is labelled as replaced', standInText({ originalText: 'x' }).includes('[Earlier turn, replaced'))
check('a blank summary uses the fallback', standInText({ summary: '   ', originalText: 'x' }).includes('[Earlier turn, replaced'))

// ══ Turn text and prompt ═══════════════════════════════════════════════════
console.log('\nturnText')
const textSession = fakeSession(twoTurns, [2, 3])
const collected = turnText(textSession, [2, 3])
check('collects user then assistant text', collected === 'first\n\nok', JSON.stringify(collected))

console.log('\nbuildSummaryPrompt')
const prompt = buildSummaryPrompt(textSession, [2, 3])
check('asks for a summary', prompt.includes('Summarize'))
check('includes the user text', prompt.includes('first'))
check('includes the assistant text', prompt.includes('ok'))
check('caps the length', /120 words/.test(prompt))

// ══ Message targeting by rpcId ═════════════════════════════════════════════
// The Client only ever sees the message SOURCE, which is
// { kind, rpcId, clientTimeZone } — no id and no position. The Host resolves the
// submission identity against the log, so this lookup is the contract that keeps
// a redo from rewriting the wrong turn.
console.log('\nresolveMessageSeq')
const rpcSession = fakeSession([
  { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: 'a' }], source: { kind: 'user', rpcId: 'rpc-a' } } },
  { type: 'user/message', seq: 6, data: { role: 'user', content: [{ type: 'text', text: 'b' }], source: { kind: 'user', rpcId: 'rpc-b' } } },
], [2, 6])

check('an explicit seq is honoured', resolveMessageSeq(rpcSession, { messageSeq: 6 }) === 6)
check('rpcId resolves to its log position', resolveMessageSeq(rpcSession, { rpcId: 'rpc-b' }) === 6)
check('a different rpcId resolves differently', resolveMessageSeq(rpcSession, { rpcId: 'rpc-a' }) === 2)

let noTarget = null
try {
  resolveMessageSeq(rpcSession, {})
} catch (error) {
  noTarget = error
}
check('a request with neither field is refused', noTarget?.code === 'no-target', String(noTarget?.code))

let unknownRpc = null
try {
  resolveMessageSeq(rpcSession, { rpcId: 'rpc-nope' })
} catch (error) {
  unknownRpc = error
}
check('an unknown rpcId is refused, not guessed', unknownRpc?.code === 'message-not-found', String(unknownRpc?.code))

const bareSession = fakeSession([{ type: 'user/message', seq: 3, data: { role: 'user', content: [] } }], [3])
let bareMiss = null
try {
  resolveMessageSeq(bareSession, { rpcId: 'anything' })
} catch (error) {
  bareMiss = error
}
check('a message without a source is not matched', bareMiss?.code === 'message-not-found')

// A replacement appends a node whose seq is HIGHER than the range it shadows
// while sitting EARLIER on the surface, so the node list is not monotonic. A
// numeric comparison here would silently pick the wrong edges — this is the
// shape that made a real redo fail with "no model-visible messages".
const nonMonotonic = [2, 3, 500, 6, 7]
const replaced = surfaceRange(fakeSession(twoTurns, nonMonotonic), 5, 8)
check('non-monotonic surface still finds the right run', replaced.start === 6 && replaced.end === 7, JSON.stringify(replaced))

// A turn whose nodes are not contiguous was already partly replaced; replacing
// across the gap would split the earlier replacement. Turn 1 spans 1..4, and
// node 3 is missing while a later node still belongs to it.
let fragmented = null
try {
  surfaceRange(fakeSession(twoTurns, [2, 6, 3]), 1, 4)
} catch (error) {
  fragmented = error
}
check('a fragmented turn is refused', fragmented?.code === 'fragmented-turn', String(fragmented?.code))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)



