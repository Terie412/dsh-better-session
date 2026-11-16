import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Exercise the shipped functions without rendering React or emulating a page.
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const policy = source.slice(source.indexOf('    function adjacentSessionId'), source.indexOf('    /** Drawer navigation'))
const install = source.slice(source.indexOf('    function installSessionNavigation'), source.indexOf('    // ── Client services'))
function harness (runtime = 'desktop', platform = 'windows') {
  const commands = []
  const fixed = []
  const actions = []
  let observer = null
  let disposed = 0
  const context = vm.createContext({
    t: key => key,
    resolveSessionNavigation: direction => () => actions.push(direction),
  })
  vm.runInContext(`${policy}\n${install}\nglobalThis.api = { adjacentSessionId, navigationDirection, installSessionNavigation }`, context)
  const shortcuts = {
    runtime, platform,
    register: command => { commands.push(command); return () => { disposed++ } },
    registerFixed: command => { fixed.push(command); return () => { disposed++ } },
    observeFixedInput: listener => { observer = listener; return () => { observer = null; disposed++ } },
  }
  return { api: context.api, context, commands, fixed, actions,
    start: () => context.api.installSessionNavigation({ get: name => { assert.equal(name, 'shortcuts'); return shortcuts } }),
    input: value => observer?.(value), disposed: () => disposed, shortcuts,
  }
}

test('adjacent navigation follows supplied sidebar order and never wraps', () => {
  const { api } = harness()
  const ids = ['pinned', 'manually-moved', 'ordinary', 'next-workspace']
  assert.equal(api.adjacentSessionId(ids, 'manually-moved', -1), 'pinned')
  assert.equal(api.adjacentSessionId(ids, 'manually-moved', 1), 'ordinary')
  assert.equal(api.adjacentSessionId(ids, 'ordinary', 1), 'next-workspace')
  assert.equal(api.adjacentSessionId(ids, 'pinned', -1), null)
  assert.equal(api.adjacentSessionId(ids, 'next-workspace', 1), null)
  assert.equal(api.adjacentSessionId(ids, 'hidden-current', 1), null)
  assert.equal(api.adjacentSessionId([], 'missing', -1), null)
})

test('matches only exact Alt arrows and protects composition/consumed input', () => {
  const { api } = harness()
  const gesture = { alt: true, code: 'ArrowLeft' }
  assert.equal(api.navigationDirection(gesture), -1)
  assert.equal(api.navigationDirection({ ...gesture, code: 'ArrowRight' }), 1)
  for (const patch of [{ alt: false }, { control: true }, { shift: true }, { meta: true },
    { composing: true }, { defaultPrevented: true }, { code: 'ArrowUp' }]) {
    assert.equal(api.navigationDirection({ ...gesture, ...patch }), 0)
  }
})

for (const platform of ['windows', 'macos']) {
  test(`Desktop ${platform} registers configurable native commands and cleans up`, () => {
    const h = harness('desktop', platform)
    const dispose = h.start()
    assert.equal(h.commands.length, 2)
    assert.equal(h.fixed.length, 0)
    assert.equal(h.commands[0].defaults[`desktop:${platform}`].code, 'ArrowLeft')
    assert.ok(h.commands[0].regions.includes('editable'))
    h.commands[0].resolve({ modal: null }).run()
    h.commands[1].resolve({ modal: 'sidebar' }).run()
    assert.deepEqual(h.actions, [-1, 1])
    assert.equal(h.commands[0].resolve({ modal: 'settings' }).status, 'blocked')
    dispose()
    assert.equal(h.disposed(), 2)
  })
}

for (const [runtime, platform] of [['web', 'windows'], ['web', 'macos'], ['web', 'linux'], ['desktop', 'linux']]) {
  test(`${runtime} ${platform} fixed shortcuts consume boundaries, protect modals and clean up`, () => {
    const h = harness(runtime, platform)
    const dispose = h.start()
    assert.equal(h.fixed.length, 2)
    assert.equal(h.commands.length, 0)
    let consumed = 0
    const input = (patch = {}) => h.input({ type: 'keydown', gesture: { alt: true, code: 'ArrowRight', ...patch },
      context: { modal: null }, consume: () => { consumed++ } })
    input()
    input({ repeat: true })
    input({ composing: true })
    input({ defaultPrevented: true })
    assert.equal(consumed, 2)
    assert.deepEqual(h.actions, [1])
    h.input({ type: 'keydown', gesture: { alt: true, code: 'ArrowLeft' }, context: { modal: 'settings' }, consume: () => { consumed++ } })
    assert.deepEqual(h.actions, [1])
    assert.equal(consumed, 3)
    // No active/visible current session still must not navigate browser history.
    h.context.resolveSessionNavigation = () => null
    input()
    assert.equal(consumed, 4)
    dispose()
    assert.equal(h.disposed(), 3)
    input()
    assert.equal(consumed, 4)
  })
}

test('partial registration failure releases already registered commands', () => {
  const h = harness()
  let count = 0
  const register = h.shortcuts.register
  h.shortcuts.register = command => {
    if (++count === 2) throw new Error('conflict')
    return register(command)
  }
  assert.throws(h.start, /conflict/)
  assert.equal(h.disposed(), 1)
})
