import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Test notification orchestration only; no React renderer or DOM emulation.
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('    const NOTIFY_KEY'), source.indexOf('    function notificationSettings'))
function harness (options = {}) {
  const state = { notificationsEnabled: false, notificationBusy: false }
  const storage = options.storage ?? new Map(options.saved ? [['dsh.better-session.notifications.v1', 'true']] : [])
  const streams = []
  const notifications = []
  const events = new Map()
  const opened = []
  let permissionRequests = 0
  let focused = 0
  class Notification {
    static permission = options.permission ?? 'granted'
    static async requestPermission () { permissionRequests++; return this.permission = options.grant ?? 'granted' }
    constructor (title, value) { this.title = title; this.value = value; this.closed = false; notifications.push(this) }
    close () { this.closed = true; this.onclose?.() }
  }
  class EventSource {
    constructor (url) { this.url = url; streams.push(this) }
    close () { this.closed = true }
    async message (value) { this.onmessage?.({ data: JSON.stringify(value) }); await new Promise(resolve => setImmediate(resolve)) }
  }
  const env = {
    snapshot: state, setState: value => Object.assign(state, value), t: key => key,
    setTimeout, clearTimeout, BroadcastChannel: options.BroadcastChannel,
    Notification: options.unsupported ? undefined : Notification, EventSource,
    hostUrl: path => `http://localhost/${path}`,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (options.storageError) throw new Error('blocked'); storage.set(key, value) } },
    navigator: { locks: { request: async (_name, run) => run() } },
    document: { visibilityState: options.hidden ? 'hidden' : 'visible', hasFocus: () => !options.unfocused },
    window: { focus: () => { focused++ }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
    archivedIdsNow: () => options.archived ? ['session-test'] : [],
    clientService: name => name === 'sessions' ? { list: { getSnapshot: () => ({ byId: { 'session-test': { id: 'session-test', title: 'Test session', retainedBy: { mainView: options.current ? 1 : 0 } } } }) } }
      : name === 'layout' ? { panelInfo: { getSnapshot: () => ({ activePanelId: options.panel ? 'settings' : null }) } }
        : { openSession: id => { opened.push(id) } },
  }
  const context = vm.createContext(env)
  vm.runInContext(`${code}\nglobalThis.stop = installCompletionNotifications();globalThis.api = notificationRuntime`, context)
  return { state, streams, notifications, opened, events, storage, Notification,
    api: context.api, stop: context.stop, focused: () => focused, permissionRequests: () => permissionRequests }
}
const completion = { id: 'session-test:1', sessionId: 'session-test', kind: 'turn' }

test('disabled by default; user enable authorizes and persists; test does not enable', async () => {
  const h = harness({ permission: 'default' })
  assert.equal(h.streams.length, 0)
  assert.equal(h.permissionRequests(), 0)
  await h.api.test()
  assert.equal(h.permissionRequests(), 1)
  assert.equal(h.notifications.length, 1)
  assert.equal(h.state.notificationsEnabled, false)
  await h.api.toggle()
  assert.equal(h.state.notificationsEnabled, true)
  assert.equal(h.streams.length, 1)
  assert.equal(h.storage.get('dsh.better-session.notifications.v1'), 'true')
  h.stop()
})

test('background completion is deduplicated; clicking navigates and closes', async () => {
  const h = harness({ saved: true })
  await h.streams[0].message(completion)
  await h.streams[0].message(completion)
  assert.equal(h.notifications.length, 1)
  assert.match(h.notifications[0].value.body, /Test session/)
  h.notifications[0].onclick()
  assert.deepEqual(h.opened, ['session-test'])
  assert.equal(h.focused(), 1)
  assert.equal(h.notifications[0].closed, true)
  h.stop()
})

for (const options of [{ current: true }, { archived: true }]) {
  test(`suppresses viewed/archived sessions: ${JSON.stringify(options)}`, async () => {
    const h = harness({ saved: true, ...options })
    await h.streams[0].message(completion)
    assert.equal(h.notifications.length, 0)
    h.stop()
  })
}

test('current session still notifies if window hidden or unfocused; goal copy differs', async () => {
  for (const options of [{ hidden: true }, { unfocused: true }]) {
    const h = harness({ saved: true, current: true, ...options })
    await h.streams[0].message({ ...completion, kind: 'goal' })
    assert.equal(h.notifications[0].title, 'DeepSeek Harness · notify.goal')
    h.stop()
  }
})

test('a selected global panel does not count as viewing the retained session', async () => {
  const h = harness({ saved: true, current: true, panel: true })
  await h.streams[0].message(completion)
  assert.equal(h.notifications.length, 1)
  h.stop()
})

test('focused second tab suppresses a hidden-first completion; pending wait is disposed', async () => {
  const channels = new Set()
  class Channel {
    constructor () { channels.add(this) }
    postMessage (data) { for (const other of channels) if (other !== this) queueMicrotask(() => other.onmessage?.({ data })) }
    close () { channels.delete(this) }
  }
  const storage = new Map([['dsh.better-session.notifications.v1', 'true']])
  const hidden = harness({ hidden: true, current: true, storage, BroadcastChannel: Channel })
  const focused = harness({ current: true, storage, BroadcastChannel: Channel })
  await hidden.streams[0].message(completion)
  await focused.streams[0].message(completion)
  await new Promise(resolve => setTimeout(resolve, 130))
  assert.equal(hidden.notifications.length + focused.notifications.length, 0)
  await hidden.streams[0].message({ ...completion, id: 'session-test:2' })
  hidden.stop()
  focused.stop()
  assert.equal(channels.size, 0)
})

test('denied and unsupported permissions fail explicitly without subscribing', async () => {
  for (const options of [{ permission: 'denied' }, { unsupported: true }]) {
    const h = harness(options)
    await h.api.toggle()
    assert.equal(h.state.notificationsEnabled, false)
    assert.equal(h.streams.length, 0)
    assert.ok(['notify.denied', 'notify.unsupported'].includes(h.state.notificationNotice))
    h.stop()
  }
})

test('preference write failure never claims enabled; disposal and disabling close resources', async () => {
  const bad = harness({ storageError: true })
  await bad.api.toggle()
  assert.equal(bad.state.notificationNotice, 'notify.saveFailed')
  assert.equal(bad.state.notificationsEnabled, false)
  bad.stop()
  const h = harness({ saved: true })
  await h.streams[0].message(completion)
  await h.api.toggle()
  assert.equal(h.streams[0].closed, true)
  assert.equal(h.notifications[0].closed, true)
  h.stop()
  assert.equal(h.events.size, 0)
})

test('connection status and malformed/late events do not create notifications', async () => {
  const h = harness({ saved: true })
  h.streams[0].onopen()
  assert.equal(h.state.notificationStatus, 'connected')
  h.streams[0].onerror()
  assert.equal(h.state.notificationStatus, 'disconnected')
  h.streams[0].onmessage({ data: 'invalid' })
  await h.streams[0].message({ ...completion, sessionId: '../bad' })
  h.stop()
  await h.streams[0].message(completion)
  assert.equal(h.notifications.length, 0)
})
