/**
 * Replay a real session log through the redo turn-location logic, so the
 * arithmetic is checked against actual data rather than a fabricated shape.
 *
 * Usage: node verify-real.mjs <session-dir> [turnNumber]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { locateTurn, surfaceRange } from '../src/redo/turn.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressAll (file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(starts[k], end)))
    } catch {}
  }
  return Buffer.concat(parts).toString('utf8')
}

const dir = process.argv[2]
const wantTurn = process.argv[3] === undefined ? undefined : Number(process.argv[3])
if (dir === undefined) {
  console.error('usage: node verify-real.mjs <session-dir> [turnNumber]')
  process.exit(2)
}

const events = []
for (const line of decompressAll(join(dir, 'session.v4.jsonl.zstd')).split('\n')) {
  if (!line) continue
  try {
    events.push(JSON.parse(line))
  } catch {}
}

// The live surface set: every surface event minus whatever a later replacement
// shadowed. This mirrors what session.surface.nodes holds at runtime.
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const surfaceEvents = events.filter((event) => SURFACE.has(event.type) && event.surfaceOp !== undefined)
const shadowed = new Set()
for (const event of surfaceEvents) {
  const op = event.surfaceOp
  if (op !== null && typeof op === 'object' && op.op === 'replace') {
    for (const other of surfaceEvents) {
      if (other.seq >= op.startSeq && other.seq <= op.endSeq) shadowed.add(other.seq)
    }
  }
}
const nodes = surfaceEvents.filter((event) => !shadowed.has(event.seq)).map((event) => event.seq)

const bySeq = new Map(events.map((event) => [event.seq, event]))
const session = {
  ownEvents: () => events,
  eventAt: (seq) => bySeq.get(seq),
  surface: { nodes },
}

console.log('surface nodes:', nodes.length)

// Pick a completed turn to exercise.
const turns = []
let open = null
for (const event of events) {
  if (event.type === 'turn/start') open = { turn: event.data.turn, start: event.seq, end: null }
  if (event.type === 'turn/end' && open !== null && event.data.turn === open.turn) {
    open.end = event.seq
    turns.push(open)
    open = null
  }
}
const target = wantTurn === undefined ? turns.filter(t => t.end !== null).slice(-2)[0] : turns.find(t => t.turn === wantTurn)
if (target === undefined) {
  console.log('no such completed turn')
  process.exit(0)
}

// Find the user message that opens it.
const opener = events.find((event) =>
  event.type === 'user/message' && event.seq >= target.start && event.seq <= target.end)
if (opener === undefined) {
  console.log(`turn ${target.turn}: no user message inside`)
  process.exit(0)
}

console.log(`\nturn ${target.turn}  log ${target.start}..${target.end}`)
console.log('opener seq:', opener.seq, '| rpcId:', opener.data?.source?.rpcId)

try {
  const located = locateTurn(session, opener.seq)
  console.log('locateTurn ->', JSON.stringify({ turn: located.turn, startSeq: located.startSeq, endSeq: located.endSeq }))
  const range = surfaceRange(session, located.startSeq, located.endSeq)
  console.log('surfaceRange ->', JSON.stringify(range))
  const inside = nodes.filter((seq) => seq >= range.start && seq <= range.end)
  console.log('nodes covered:', inside.length, 'of', nodes.length)
} catch (error) {
  console.log('FAILED:', error.code, '-', error.message)
}
