import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply, inject } from './index.js'

// Exercise the real route against isolated files, never the user's DSH home.
async function harness (t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'better-session-delete-test-'))
  const id = 'session-test-123'
  const dir = join(home, 'sessions', 'workspace', id)
  const cache = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  await mkdir(dir, { recursive: true })
  await mkdir(join(cache, '..'), { recursive: true })
  await writeFile(join(dir, 'log.jsonl'), 'test log')
  await writeFile(join(dir, 'session.lock'), '')
  await writeFile(cache, '{}')
  t.after(async () => {
    const target = resolve(home)
    assert.equal(target.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')), true)
    assert.equal(target.includes('better-session-delete-test-'), true)
    await rm(target, { recursive: true, force: true })
  })
  const archived = new Set()
  const events = []
  const calls = []
  let locked = false
  let live = options.live === true
  const assertProtected = async () => {
    assert.equal(locked || (archived.has(id) && !(await exists(join(dir, 'log.jsonl')))), true)
  }
  const workspace = {
    sessionIds: [id],
    async detachSession (sessionId) {
      await assertProtected()
      if (options.detachError) throw new Error('detach failed')
      calls.push('detach')
      this.sessionIds = this.sessionIds.filter(value => value !== sessionId)
    },
  }
  const services = {
    sessions: { get: () => live ? { id } : undefined },
    workspaceRegistry: {
      async archiveSession (sessionId, settings) {
        assert.deepEqual(settings, { stopActivity: true })
        if (options.stopError) throw new Error('stop failed')
        calls.push('archive')
        archived.add(sessionId)
      },
      async unpinSession () { await assertProtected(); calls.push('unpin') },
      list: () => [workspace],
      async unarchiveSession (sessionId) {
        await assertProtected()
        assert.equal(live, false)
        calls.push('unarchive')
        archived.delete(sessionId)
      },
    },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    sessionPersistence: {
      async open (sessionId, access) {
        assert.equal(sessionId, id)
        assert.equal(access, 'write')
        if (options.busy) throw new Error('already owned')
        if (!(await exists(join(dir, 'log.jsonl')))) {
          const error = new Error('not found')
          error.name = 'SessionPersistenceNotFoundError'
          throw error
        }
        locked = true
        calls.push('lock')
        if (options.liveDuringOpen) live = true
        return { async close () {
          locked = false
          calls.push('close')
          if (options.closeError) throw new Error('close failed')
        } }
      },
      async stat () { return await exists(join(dir, 'log.jsonl')) ? { header: { id } } : undefined },
    },
  }
  let route
  const ctx = {
    get: name => services[name],
    emit: (...args) => events.push(args),
    effect: setup => setup(),
    on: () => () => {},
    webServer: { register: value => { route = value; return () => {} } },
  }
  services.webServer = ctx.webServer
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { apply(ctx) } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  async function request (ids = [id], confirm = true) {
    let status
    let body
    await route.handler(Object.assign(Readable.from([Buffer.from(JSON.stringify({ method: 'delete', sessionIds: ids, confirm }))]), { method: 'POST' }), {
      writeHead: value => { status = value },
      end: value => { body = JSON.parse(value) },
    })
    return { status, body, result: body.value?.results[0] }
  }
  return { id, dir, cache, archived, events, calls, workspace, request, services }
}

const exists = path => stat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})

test('requires lifecycle services rather than falling back to unsafe rm', () => {
  for (const name of ['sessions', 'workspaceRegistry', 'sessionPersistence']) assert.ok(inject.includes(name))
})

test('live Session stays archived with log/cache and group intact; never reports success', async t => {
  const h = await harness(t, { live: true })
  const { result } = await h.request()
  assert.equal(result.deleted, false)
  assert.equal(result.code, 'session-loaded')
  assert.equal(h.archived.has(h.id), true)
  assert.equal(await exists(join(h.dir, 'log.jsonl')), true)
  assert.equal(await exists(h.cache), true)
  assert.deepEqual(h.workspace.sessionIds, [h.id])
  assert.deepEqual(h.calls, ['archive'])
  assert.deepEqual(h.events, [])
})

test('stop failure refuses all filesystem and registry cleanup', async t => {
  const h = await harness(t, { stopError: true })
  assert.equal((await h.request()).result.code, 'stop-failed')
  assert.equal(await exists(join(h.dir, 'log.jsonl')), true)
  assert.deepEqual(h.calls, [])
})

test('in-flight resume holding writer prevents deletion and unarchive', async t => {
  const h = await harness(t, { busy: true })
  assert.equal((await h.request()).result.code, 'session-busy')
  assert.equal(await exists(join(h.dir, 'log.jsonl')), true)
  assert.equal(h.archived.has(h.id), true)
  assert.deepEqual(h.calls, ['archive'])
})

test('Session appearing during lock acquisition is refused and writer released', async t => {
  const h = await harness(t, { liveDuringOpen: true })
  assert.equal((await h.request()).result.code, 'session-loaded')
  assert.equal(await exists(join(h.dir, 'log.jsonl')), true)
  assert.deepEqual(h.calls, ['archive', 'lock', 'close'])
})

test('cold Session removes logs/cache under writer exclusion then clears archive last', async t => {
  const h = await harness(t)
  const { status, result } = await h.request()
  assert.equal(status, 200)
  assert.equal(result.deleted, true)
  assert.equal(await exists(join(h.dir, 'log.jsonl')), false)
  assert.equal(await exists(h.cache), false)
  assert.equal(h.archived.has(h.id), false)
  assert.deepEqual(h.workspace.sessionIds, [])
  assert.deepEqual(h.calls, ['archive', 'lock', 'unpin', 'detach', 'unarchive', 'close'])
  assert.deepEqual(h.events, [['api-session/removed', h.id]])
})

test('cleanup failure stays archived and a missing-log retry clears references', async t => {
  const options = { detachError: true }
  const h = await harness(t, options)
  assert.equal((await h.request()).result.deleted, false)
  assert.equal(h.archived.has(h.id), true)
  assert.ok(!h.calls.includes('unarchive'))
  assert.equal(h.calls.at(-1), 'close')
  assert.deepEqual(h.events, [])
  options.detachError = false
  const retry = await h.request()
  assert.equal(retry.result.deleted, true)
  assert.equal(retry.result.removed, 0)
  assert.equal(h.archived.has(h.id), false)
  assert.deepEqual(h.workspace.sessionIds, [])
})

test('writer close failure is a per-item failure, not a batch HTTP error', async t => {
  const h = await harness(t, { closeError: true })
  const { status, body } = await h.request([h.id, '../invalid'])
  assert.equal(status, 200)
  assert.equal(body.value.results[0].code, 'close-failed')
  assert.equal(body.value.results[0].deleted, false)
  assert.equal(body.value.results[1].code, 'bad-id')
  assert.deepEqual(h.events, [])
})

test('session directory symlink cannot redirect deletion outside the root', async t => {
  const h = await harness(t)
  const outside = await mkdtemp(join(tmpdir(), 'better-session-delete-test-outside-'))
  const marker = join(outside, 'log.jsonl')
  await writeFile(marker, 'preserve')
  t.after(async () => {
    assert.ok(resolve(outside).startsWith(resolve(tmpdir())))
    assert.ok(outside.includes('better-session-delete-test-outside-'))
    await rm(outside, { recursive: true, force: true })
  })
  assert.ok(h.dir.endsWith(h.id))
  await rm(h.dir, { recursive: true })
  await symlink(outside, h.dir, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await h.request()).result.deleted, false)
  assert.equal(await exists(marker), true)
  assert.equal(h.archived.has(h.id), true)
})

test('missing or non-owner authentication refuses plugin API', async t => {
  const h = await harness(t)
  h.services.connection = undefined
  assert.equal((await h.request()).status, 403)
  h.services.connection = { admit: () => ({ peer: { principal: { kind: 'guest' } } }) }
  assert.equal((await h.request()).status, 403)
  assert.equal(await exists(join(h.dir, 'log.jsonl')), true)
})

test('unconfirmed requests and invalid ids cannot delete files', async t => {
  const h = await harness(t)
  assert.equal((await h.request([h.id], false)).status, 400)
  assert.equal((await h.request(['../escape'])).result.code, 'bad-id')
  assert.equal(await exists(join(h.dir, 'log.jsonl')), true)
  assert.deepEqual(h.calls, [])
})
