import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findSession, folderState, listSessions, orphansOf, readHead } from '../lib/sessions.mjs'
import { makeWorld } from './fixture.mjs'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'
const D = 'dddddddd-4444-4444-8444-444444444444'

test('every session is listed with its folder, title, size and whether its folder is still there', async () => {
  const w = await makeWorld()
  try {
    const here = await w.folder('here')
    const gone = await w.folder('gone', { real: false })
    await w.session(A, { cwds: [here], prompt: 'Fix the login page', side: true })
    await w.session(B, { cwds: [gone], prompt: 'Old project' })
    await w.session(C, { cwds: [] })
    const list = await listSessions({ claudeDir: w.claudeDir })
    assert.equal(list.length, 3)
    const byId = Object.fromEntries(list.map(s => [s.id, s]))
    assert.equal(byId[A].folderState, 'exists')
    assert.equal(byId[A].title, 'Fix the login page')
    assert.equal(byId[A].branch, 'main')
    assert.ok(byId[A].sideDir, 'its side folder is found')
    assert.ok(byId[A].bytes > byId[B].bytes, 'the side folder counts in the size')
    assert.equal(byId[B].folderState, 'missing')
    // No folder recorded: unknown, never an orphan.
    assert.equal(byId[C].folderState, 'unknown')
    assert.deepEqual(orphansOf(list).map(s => s.id), [B])
  } finally {
    await w.cleanup()
  }
})

test('the folder of a session is the first one it recorded, not one it went into later', async () => {
  const w = await makeWorld()
  try {
    const home = await w.folder('home')
    const later = await w.folder('later', { real: false })
    await w.session(A, { cwds: [home, later, later] })
    const [one] = await listSessions({ claudeDir: w.claudeDir })
    assert.equal(one.folder, home)
    assert.equal(one.folderState, 'exists')
    assert.deepEqual(orphansOf([one]), [])
  } finally {
    await w.cleanup()
  }
})

test('the latest session comes first, and a title skips what the engine adds', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('f')
    await w.session(A, { cwds: [f], prompt: '<command-name>/clear</command-name>', more: [{ type: 'user', message: { role: 'user', content: 'The real first prompt' } }], mtime: Date.now() - 5000 })
    await w.session(B, { cwds: [f], prompt: 'x'.repeat(300), mtime: Date.now() })
    const list = await listSessions({ claudeDir: w.claudeDir })
    assert.deepEqual(list.map(s => s.id), [B, A])
    assert.equal(list[0].title.length, 120)
    assert.ok(list[0].title.endsWith('…'))
    assert.equal(list[1].title, 'The real first prompt')
  } finally {
    await w.cleanup()
  }
})

test('a title is the words of the person, without the tags an IDE or a browser put before them', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('f')
    const wrapped = [{ type: 'text', text: '<browser_instruction>Chrome automation guidelines</browser_instruction>' }, { type: 'text', text: 'the real question, after the wrapper' }]
    await w.session(A, { cwds: [], more: [{ type: 'user', cwd: f, message: { role: 'user', content: wrapped } }] })
    await w.session(B, { cwds: [], more: [{ type: 'user', cwd: f, message: { role: 'user', content: '<command-message>init</command-message> <command-name>/init</command-name>' } }, { type: 'user', cwd: f, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Please analyze this codebase' }] } }] })
    await w.session(C, { cwds: [], more: [{ type: 'user', cwd: f, message: { role: 'user', content: '<ide_opened_file>The user opened a.ts</ide_opened_file>fix the bug in a.ts' } }] })
    const list = await listSessions({ claudeDir: w.claudeDir })
    const title = id => list.find(s => s.id === id).title
    assert.equal(title(A), 'the real question, after the wrapper')
    assert.equal(title(B), '/init')
    assert.equal(title(C), 'fix the bug in a.ts')
  } finally {
    await w.cleanup()
  }
})

test('a session is in use while its process lives', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('f')
    await w.session(A, { cwds: [f] })
    await w.session(B, { cwds: [f] })
    await w.session(C, { cwds: [f] })
    await w.process(process.pid, A) // this test process is alive
    await w.process(2_000_000_000, B) // a process that is not
    const list = await listSessions({ claudeDir: w.claudeDir })
    const inUse = Object.fromEntries(list.map(s => [s.id, s.inUse]))
    assert.deepEqual(inUse, { [A]: true, [B]: false, [C]: false })
  } finally {
    await w.cleanup()
  }
})

test('a transcript that is broken or empty does not stop the list', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('f')
    const { dir } = await w.session(A, { cwds: [f] })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, `${B}.jsonl`), '{"type": broken\nnot json at all\n')
    await writeFile(join(dir, `${C}.jsonl`), '')
    const list = await listSessions({ claudeDir: w.claudeDir })
    assert.equal(list.length, 3)
    assert.equal(list.find(s => s.id === B).folderState, 'unknown')
    assert.equal(list.find(s => s.id === C).folderState, 'unknown')
    assert.deepEqual(orphansOf(list), [])
  } finally {
    await w.cleanup()
  }
})

test('a folder on a drive that is not there is unknown, not an orphan', async () => {
  // Only Windows has drive letters: a drive no machine has stands for an unplugged one.
  if (process.platform !== 'win32') return
  const free = 'QRSTUVWXYZ'.split('').find(letter => !existsSync(`${letter}:\\`))
  assert.ok(free, 'a free drive letter')
  assert.equal(await folderState(`${free}:\\Projects\\x`), 'unknown')
})

test('a session is found by the start of its id, and a vague start is refused', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('f')
    await w.session(A, { cwds: [f] })
    await w.session('aaaabbbb-0000-4000-8000-000000000000', { cwds: [f] })
    const list = await listSessions({ claudeDir: w.claudeDir })
    assert.equal(findSession(list, 'aaaaaaaa').session.id, A)
    assert.match(findSession(list, 'aaaa').error, /fits 2 sessions/)
    assert.match(findSession(list, 'aa').error, /first 4 characters/)
    assert.match(findSession(list, 'ffff').error, /No session starts/)
  } finally {
    await w.cleanup()
  }
})

test('only the start of a big transcript is read', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('f')
    const filler = Array.from({ length: 400 }, (_, i) => ({ type: 'assistant', n: i, text: 'x'.repeat(2000) }))
    const { file } = await w.session(A, { cwds: [f], more: filler })
    const rows = await readHead(file, 64 * 1024)
    assert.ok(rows.length < 40, 'a small chunk gives few rows')
    assert.ok(rows.every(r => typeof r === 'object'), 'a cut row is dropped, not half read')
    assert.equal(rows.find(r => r.cwd).cwd, f)
  } finally {
    await w.cleanup()
  }
})
