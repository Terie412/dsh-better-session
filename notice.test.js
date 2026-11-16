import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('    /** One deadline per transient'), source.indexOf('    function subscribe'))
function harness () {
  let next = 0
  const timers = new Map()
  const cancelled = new Set()
  const context = vm.createContext({
    snapshot: { notice: null, notificationNotice: null, batchMode: true, notificationStatus: 'disconnected' },
    listeners: new Set(),
    setTimeout: (run, delay) => { const id = ++next; timers.set(id, { run, delay }); return id },
    clearTimeout: id => cancelled.add(id),
  })
  vm.runInContext(`${code}\nglobalThis.api = { setState, clearTransientNotices, read: () => snapshot }`, context)
  return { api: context.api, timers, cancelled, last: () => next, fire: id => timers.get(id).run() }
}

test('success expires after four seconds and errors after eight seconds', () => {
  for (const [kind, duration] of [['ok', 4000], ['error', 8000]]) {
    const h = harness()
    h.api.setState({ notice: { kind, scope: 'sidebar', text: 'result' } })
    assert.equal(h.timers.get(h.last()).delay, duration)
    h.fire(h.last())
    assert.equal(h.api.read().notice, null)
  }
})

test('identical new messages get a fresh deadline; stale callbacks cannot clear them', () => {
  const h = harness()
  const notice = { kind: 'error', text: 'same failure' }
  h.api.setState({ notice })
  const first = h.last()
  h.api.setState({ notice })
  const second = h.last()
  assert.ok(h.cancelled.has(first))
  h.fire(first)
  assert.equal(h.api.read().notice, notice)
  h.fire(second)
  assert.equal(h.api.read().notice, null)
})

test('batch/page/locale updates never renew the original deadline', () => {
  const h = harness()
  h.api.setState({ notice: { kind: 'error', text: 'failure', scope: 'sidebar' } })
  const timer = h.last()
  h.api.setState({ batchMode: false, revision: 2 })
  assert.equal(h.last(), timer)
  h.fire(timer)
  assert.equal(h.api.read().notice, null)
})

test('explicit clear invalidates old timer and a new message remains visible', () => {
  const h = harness()
  h.api.setState({ notice: { kind: 'error' } })
  const first = h.last()
  h.api.setState({ notice: null })
  h.api.setState({ notice: { kind: 'ok', text: 'new' } })
  h.fire(first)
  assert.equal(h.api.read().notice.text, 'new')
})

test('notification feedback expires independently without clearing persistent connection status', () => {
  const h = harness()
  h.api.setState({ notice: { kind: 'error' } })
  const action = h.last()
  h.api.setState({ notificationNotice: 'notify.sent' })
  const notification = h.last()
  assert.equal(h.timers.get(notification).delay, 4000)
  h.fire(notification)
  assert.equal(h.api.read().notificationNotice, null)
  assert.ok(h.api.read().notice)
  assert.equal(h.api.read().notificationStatus, 'disconnected')
  h.fire(action)
  assert.equal(h.api.read().notice, null)
})

test('unload clears feedback, cancels timers and invalidates pending callbacks', () => {
  const h = harness()
  h.api.setState({ notice: { kind: 'error' }, notificationNotice: 'notify.failed' })
  const ids = [...h.timers.keys()]
  h.api.clearTransientNotices()
  for (const id of ids) { assert.ok(h.cancelled.has(id)); h.fire(id) }
  assert.equal(h.api.read().notice, null)
  assert.equal(h.api.read().notificationNotice, null)
  const timerCount = h.timers.size
  h.api.setState({ notice: { kind: 'error', text: 'late async result' }, notificationNotice: 'notify.failed' })
  assert.equal(h.timers.size, timerCount)
  assert.equal(h.api.read().notice, null)
  assert.equal(h.api.read().notificationNotice, null)
})
