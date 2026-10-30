import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openInTerminal, parseRequest, start } from '../server/sessions-server.mjs'
import { fakeTrash, makeWorld } from './fixture.mjs'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const there = path => stat(path).then(() => true, () => false)

async function running(setup) {
  const w = await makeWorld()
  const t = fakeTrash(w.trashDir)
  const page = join(w.root, 'page.html')
  await writeFile(page, '<title>Sessions</title>')
  const ctx = { claudeDir: w.claudeDir, platform: process.platform, trash: t.trash }
  const extra = (await setup?.(w, ctx)) ?? {}
  const lines = []
  const { server, url } = await start({ page, ctx: { ...ctx, ...extra.ctx }, log: l => lines.push(l), idleMs: 600_000, terminal: extra.terminal })
  const origin = new URL(url).origin
  const post = (route, body, headers = { Origin: origin, 'X-Session-Manager': '1' }) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const json = async r => r.json()
  const stop = async () => {
    server.close()
    await w.cleanup()
  }
  return { w, t, url, origin, post, json, lines, stop, server }
}

test('the page and the list need the secret path and the right host', async () => {
  const s = await running(async w => {
    const f = await w.folder('f')
    await w.session(A, { cwds: [f] })
  })
  try {
    const page = await fetch(s.url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Sessions/)
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
    assert.equal((await fetch(s.url.replace(/\/[^/]+\/$/, '/wrong/'))).status, 404)
    const host = await new Promise(resolve => {
      const u = new URL(s.url)
      httpRequest({ host: '127.0.0.1', port: u.port, path: u.pathname, headers: { Host: 'evil.example' } }, res => resolve(res.statusCode)).end()
    })
    assert.equal(host, 403, 'a name that is not 127.0.0.1:port')
    const list = await s.json(await fetch(s.url + 'api/sessions'))
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].id, A)
    assert.equal('file' in list.sessions[0], false, 'no path of the disk reaches the page')
    assert.equal(list.orphans, 0)
  } finally {
    await s.stop()
  }
})

test('a write needs the page it came from, and the header a form on another site cannot send', async () => {
  const s = await running()
  try {
    const body = { kind: 'prune' }
    assert.equal((await s.post('api/preview', body, {})).status, 403)
    assert.equal((await s.post('api/preview', body, { Origin: 'https://evil.example', 'X-Session-Manager': '1' })).status, 403)
    assert.equal((await s.post('api/preview', body, { Origin: s.origin })).status, 403)
    assert.equal((await s.post('api/preview', body)).status, 200)
  } finally {
    await s.stop()
  }
})

test('a request is only one of the four kinds, with ids that look like ids', () => {
  assert.deepEqual(parseRequest({ kind: 'prune' }), { kind: 'prune' })
  assert.deepEqual(parseRequest({ kind: 'delete', ids: [A] }), { kind: 'delete', ids: [A] })
  assert.deepEqual(parseRequest({ kind: 'move', ids: [A], to: 'D:\\x' }), { kind: 'move', ids: [A], to: 'D:\\x' })
  assert.deepEqual(parseRequest({ kind: 'move-project', from: 'D:\\a', to: 'D:\\b', extra: 'ignored' }), { kind: 'move-project', from: 'D:\\a', to: 'D:\\b' })
  for (const bad of [null, 'prune', {}, { kind: 'rm' }, { kind: 'delete' }, { kind: 'delete', ids: [] }, { kind: 'delete', ids: ['../x'] }, { kind: 'delete', ids: [1] }, { kind: 'move', ids: [A] }, { kind: 'move-project', to: 'D:\\b' }, { kind: 'move', ids: [A], to: 'x\0y' }, { kind: 'move', ids: [A], to: 5 }]) {
    assert.equal(parseRequest(bad), undefined, JSON.stringify(bad))
  }
})

test('bodies that are not requests are refused', async () => {
  const s = await running()
  try {
    assert.equal((await s.post('api/preview', 'not json')).status, 400)
    assert.equal((await s.post('api/preview', { kind: 'format c:' })).status, 400)
    assert.equal((await s.post('api/apply', { request: { kind: 'prune' } })).status, 400, 'no code')
    assert.equal((await s.post('api/preview', 'x'.repeat(70_000))).status, 413)
    assert.equal((await s.post('api/unknown', {})).status, 404)
  } finally {
    await s.stop()
  }
})

test('a change is previewed, then done with the code of the preview, and not otherwise', async () => {
  const s = await running(async w => {
    const f = await w.folder('f')
    const gone = await w.folder('gone', { real: false })
    await w.session(A, { cwds: [f] })
    await w.session(B, { cwds: [gone], side: true })
  })
  try {
    const preview = await s.json(await s.post('api/preview', { kind: 'prune' }))
    assert.equal(preview.ok, true)
    assert.deepEqual(preview.items.map(i => i.id), [B])
    assert.equal(preview.code.length, 10)
    assert.match(preview.text, /1 session to send to the trash/)
    assert.equal(s.t.sent.length, 0, 'the preview touched nothing')

    const wrong = await s.json(await s.post('api/apply', { request: { kind: 'prune' }, code: '0000000000' }))
    assert.equal(wrong.ok, false)
    assert.match(wrong.error, /Things changed/)
    assert.equal(s.t.sent.length, 0)

    const done = await s.json(await s.post('api/apply', { request: { kind: 'prune' }, code: preview.code }))
    assert.equal(done.ok, true)
    assert.ok(s.t.sent.length >= 1)
    const after = await s.json(await fetch(s.url + 'api/sessions'))
    assert.deepEqual(after.sessions.map(x => x.id), [A])
    assert.ok(s.lines.includes('APPLIED prune ok'))
  } finally {
    await s.stop()
  }
})

test('a session moves through the page, and the list shows it in its new folder', async () => {
  let to
  const s = await running(async w => {
    const from = await w.folder('from')
    to = await w.folder('to')
    await w.session(A, { cwds: [from] })
  })
  try {
    const request = { kind: 'move', ids: [A], to }
    const preview = await s.json(await s.post('api/preview', request))
    assert.equal(preview.ok, true, JSON.stringify(preview))
    assert.equal(preview.items[0].toFolder, to)
    const done = await s.json(await s.post('api/apply', { request, code: preview.code }))
    assert.equal(done.ok, true, JSON.stringify(done))
    const after = await s.json(await fetch(s.url + 'api/sessions'))
    assert.equal(after.sessions[0].folder, to)
    assert.equal(after.sessions[0].folderState, 'exists')
  } finally {
    await s.stop()
  }
})

test('two changes do not run at once', async () => {
  let release
  const hold = new Promise(resolve => (release = resolve))
  const s = await running(async w => {
    const gone = await w.folder('gone', { real: false })
    await w.session(A, { cwds: [gone] })
    return { ctx: { trash: async () => hold } }
  })
  try {
    const preview = await s.json(await s.post('api/preview', { kind: 'prune' }))
    const first = s.post('api/apply', { request: { kind: 'prune' }, code: preview.code })
    await new Promise(r => setTimeout(r, 100))
    assert.equal((await s.post('api/apply', { request: { kind: 'prune' }, code: preview.code })).status, 409)
    release()
    assert.equal((await first).status, 200)
  } finally {
    release()
    await s.stop()
  }
})

test('opening a session in a terminal goes through the server, and what cannot be opened is copied instead', async () => {
  const seen = []
  const s = await running(
    async w => {
      const f = await w.folder('f')
      await w.session(A, { cwds: [f] })
      return { terminal: async session => (seen.push(session.id), { ok: true }) }
    },
  )
  try {
    assert.deepEqual(await s.json(await s.post('api/open', { id: A })), { ok: true })
    assert.deepEqual(seen, [A])
    assert.equal((await s.post('api/open', { id: '../../x' })).status, 400)
    assert.equal((await s.post('api/open', { id: B })).status, 404)
  } finally {
    await s.stop()
  }
})

test('a terminal is opened only for a folder that is there and has nothing a command line could misread', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('plain folder')
    const calls = []
    const run = (file, args, options, callback) => (calls.push([file, args]), callback(null))
    const session = { id: A, folder: f }
    // Not Windows: the command is handed back to be copied.
    const mac = await openInTerminal(session, 'darwin', run)
    assert.equal(mac.ok, false)
    assert.match(mac.command, /claude --resume aaaaaaaa/)
    assert.equal(calls.length, 0)
    const opened = await openInTerminal(session, 'win32', run)
    assert.equal(opened.ok, true)
    assert.deepEqual(calls[0], ['cmd', ['/c', 'start', '', '/D', f, 'cmd', '/k', 'claude', '--resume', A]])
    for (const bad of ['D:\\a&calc', 'D:\\a|b', 'D:\\a"b', 'D:\\%PATH%', 'D:\\a;b']) {
      assert.equal((await openInTerminal({ id: A, folder: bad }, 'win32', run)).ok, false, bad)
    }
    assert.equal((await openInTerminal({ id: A, folder: join(w.work, 'gone') }, 'win32', run)).ok, false)
    assert.equal((await openInTerminal({ id: 'not an id', folder: f }, 'win32', run)).ok, false)
    assert.equal(calls.length, 1, 'nothing else was started')
    assert.equal(await there(f), true)
  } finally {
    await w.cleanup()
  }
})
