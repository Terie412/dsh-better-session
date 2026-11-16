import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { installCompletionFeed } from './completion.js'

class Response extends EventEmitter {
  frames = []
  writableLength = 0
  writableEnded = false
  destroyed = false
  writable = true
  writeHead (status, headers) { this.status = status; this.headers = headers }
  write (frame) { this.frames.push(frame); return this.writable }
  end () { this.writableEnded = true }
  destroy () { this.destroyed = true }
}

function harness (t, { fence = () => true, goalService = true } = {}) {
  const session = { id: 'session-root', header: {} }
  const agent = { session }
  let goal
  let readError = false
  let live = true
  let route
  let disposed
  const listeners = new Set()
  const services = {
    agents: { get: id => live && id === session.id ? agent : undefined },
    goals: goalService ? { get: value => {
      assert.equal(value, agent)
      if (readError) throw new Error('invalid goal state')
      return goal
    } } : undefined,
    webServer: { register: value => {
      assert.equal(value.path, '/better-session/completions')
      route = value
      return () => { route = undefined }
    } },
  }
  installCompletionFeed({
    get: name => services[name],
    effect: install => { disposed = install() },
    on: (name, listener) => {
      assert.equal(name, 'session/event')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }, fence)
  t.after(() => disposed())
  const connect = (method = 'GET') => {
    const req = Object.assign(new EventEmitter(), { method })
    const res = new Response()
    route.handler(req, res)
    return { req, res }
  }
  const emit = (type, data, target = session) => {
    for (const listener of listeners) listener(target, { type, data })
  }
  return {
    session, connect, emit,
    start: turn => emit('turn/start', { turn }),
    end: (turn, kind = 'completed') => emit('turn/end', { turn, reason: { kind } }),
    goal: value => { goal = value },
    readError: value => { readError = value },
    live: value => { live = value },
    dispose: () => disposed(),
    listeners,
  }
}

const completions = res => res.frames.filter(frame => frame.startsWith('data: '))
const valueOf = frame => JSON.parse(frame.split('data: ')[1].trim())

test('broadcasts a live root completion once, without content or history replay', t => {
  const h = harness(t)
  const a = h.connect().res
  const b = h.connect().res
  h.end(1) // stored/repair closer, without a live start
  h.start(2)
  h.end(2)
  h.end(2)
  assert.equal(completions(a).length, 1)
  assert.deepEqual(valueOf(completions(a)[0]), {
    id: 'session-root:2', sessionId: 'session-root', kind: 'turn',
  })
  assert.deepEqual(completions(a), completions(b))
  assert.equal(completions(h.connect().res).length, 0)
})

test('excludes subagents and every non-completed ending', t => {
  const h = harness(t)
  const { res } = h.connect()
  const child = { id: 'session-child', header: { origin: 'subagent' } }
  h.emit('turn/start', { turn: 1 }, child)
  h.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, child)
  for (const [i, reason] of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted', 'forked'].entries()) {
    h.start(i + 1)
    h.end(i + 1, reason)
  }
  assert.equal(completions(res).length, 0)
})

test('suppresses active, paused, blocked, disarmed and exhausted goal rounds', t => {
  const h = harness(t)
  const { res } = h.connect()
  for (const [i, phase] of ['active', 'paused', 'blocked'].entries()) {
    h.goal({ id: 'g', phase, activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 3 })
    h.start(i)
    h.end(i)
  }
  assert.equal(completions(res).length, 0)
})

test('notifies goal completion only after its successful turn ends', t => {
  const h = harness(t)
  const { res } = h.connect()
  h.goal({ id: 'g', phase: 'active' })
  h.start(1)
  h.goal({ id: 'g', phase: 'complete' })
  h.emit('goal/change', { operation: 'complete', goal: { id: 'g', phase: 'complete' } })
  assert.equal(completions(res).length, 0)
  h.end(1)
  assert.equal(valueOf(completions(res)[0]).kind, 'goal')
  h.start(2)
  h.end(2)
  assert.equal(valueOf(completions(res)[1]).kind, 'turn') // old completed goal is not a new completion
})

test('handles goal created and completed within one turn, but not failed final replies', t => {
  const h = harness(t)
  const { res } = h.connect()
  for (const [turn, ending] of [[1, 'error'], [2, 'aborted'], [3, 'completed']]) {
    h.goal(undefined)
    h.start(turn)
    h.goal({ id: `g${turn}`, phase: 'active' })
    h.emit('goal/change', { operation: 'create', goal: { id: `g${turn}`, phase: 'active' } })
    h.goal({ id: `g${turn}`, phase: 'complete' })
    h.emit('goal/change', { operation: 'complete', goal: { id: `g${turn}`, phase: 'complete' } })
    h.end(turn, ending)
  }
  assert.equal(completions(res).length, 1)
  assert.equal(valueOf(completions(res)[0]).kind, 'goal')
})

test('clearing an unfinished goal or unreadable goal state fails closed', t => {
  const h = harness(t)
  const { res } = h.connect()
  h.goal({ id: 'g', phase: 'active' })
  h.start(1)
  h.goal(undefined)
  h.emit('goal/change', { operation: 'clear' })
  h.end(1)
  h.readError(true)
  h.start(2)
  h.readError(false)
  h.end(2)
  h.start(3)
  h.live(false)
  h.end(3)
  assert.equal(completions(res).length, 0)
})

test('works without optional goal service', t => {
  const h = harness(t, { goalService: false })
  const { res } = h.connect()
  h.start(1); h.end(1)
  assert.equal(completions(res).length, 1)
})

test('requires an explicit successful fence and GET, limits concurrent connections', t => {
  for (const fence of [undefined, () => false, () => undefined, () => { throw new Error('denied') }]) {
    const h = harness(t, { fence: fence === undefined ? null : fence })
    assert.equal(h.connect().res.status, 403)
  }
  const h = harness(t)
  assert.equal(h.connect('POST').res.status, 405)
  const connections = Array.from({ length: 16 }, () => h.connect())
  assert.ok(connections.every(({ res }) => res.status === 200))
  assert.equal(h.connect().res.status, 503)
  connections[0].res.emit('close')
  assert.equal(h.connect().res.status, 200)
})

test('drops slow clients, cleans listeners on disconnect, and closes on disposal', t => {
  const h = harness(t)
  const slow = h.connect()
  const buffered = h.connect()
  const disconnected = h.connect()
  const healthy = h.connect()
  slow.res.writable = false
  buffered.res.writableLength = 100_000
  disconnected.req.emit('aborted')
  h.start(1); h.end(1)
  assert.equal(slow.res.destroyed, true)
  assert.equal(buffered.res.destroyed, true)
  assert.equal(disconnected.res.writableEnded, true)
  assert.equal(disconnected.res.listenerCount('close'), 0)
  assert.equal(completions(healthy.res).length, 1)
  h.dispose()
  assert.equal(healthy.res.writableEnded, true)
  assert.equal(healthy.req.listenerCount('aborted'), 0)
  assert.equal(h.listeners.size, 0)
})

test('sends bounded heartbeat comments without completion replay', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = harness(t)
  const { res } = h.connect()
  t.mock.timers.tick(30_000)
  assert.ok(res.frames.includes(': heartbeat\n\n'))
  assert.equal(completions(res).length, 0)
  h.dispose()
  const count = res.frames.length
  t.mock.timers.tick(60_000)
  assert.equal(res.frames.length, count)
})
