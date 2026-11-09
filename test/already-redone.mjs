/**
 * Focused check: a turn whose nodes were already replaced by a stand-in.
 *
 * Kept separate from the main suite because the main file's shared fixtures
 * made this case hard to read; it builds its own session and asserts the two
 * outcomes that must stay distinguishable:
 *
 * - a turn replaced by a stand-in reports `already-redone`
 * - a turn that simply has no surface nodes reports `empty-range`
 *
 * Usage: node test/already-redone.mjs
 */
import { alreadyReplaced, surfaceRange } from '../src/redo/turn.js'

let failures = 0
function check (name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Build a session over a plain event list. */
function session (events, nodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    ownEvents: () => events,
    eventAt: (seq) => bySeq.get(seq),
    surface: { nodes },
  }
}

// Turn 1 occupies log 1..4; its surface nodes 2 and 3 were later shadowed by a
// stand-in appended at seq 9.
const events = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: 'asked' }] } },
  { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }] } } },
  { type: 'turn/end', seq: 4, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 9,
    data: { role: 'user', content: [{ type: 'text', text: 'stand-in' }], source: { kind: 'redo-checkpoint', redoId: 'r1' } },
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
  },
]

console.log('already-redone detection')
check('the replacement is recognised from the log', alreadyReplaced(session(events, [9]), 1, 4) === true)

let replaced = null
try {
  surfaceRange(session(events, [9]), 1, 4)
} catch (error) {
  replaced = error
}
check('the redone turn reports already-redone', replaced?.code === 'already-redone', String(replaced?.code))

// The same bounds in a session that was never replaced must NOT be called
// already-redone: nothing was rewritten, the turn just has no live nodes.
let plainEmpty = null
try {
  surfaceRange(session(events.slice(0, 4), [6, 7]), 1, 4)
} catch (error) {
  plainEmpty = error
}
check('an unreplaced empty range stays empty-range', plainEmpty?.code === 'empty-range', String(plainEmpty?.code))

// A replacement that touches only part of the turn also counts: replacing across
// it would split that earlier replacement.
check('partial overlap counts as replaced', alreadyReplaced(session(events, [9]), 1, 3) === true)
check('a disjoint replacement does not count', alreadyReplaced(session(events, [9]), 3, 4) === true)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
