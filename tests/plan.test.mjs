import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyPlan, confirm, describePlan, makePlan, rewriteHistory } from '../lib/plan.mjs'
import { slugOf } from '../lib/paths.mjs'
import { listSessions } from '../lib/sessions.mjs'
import { fakeTrash, makeWorld } from './fixture.mjs'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'
const D = 'dddddddd-4444-4444-8444-444444444444'

const world = async () => {
  const w = await makeWorld()
  const t = fakeTrash(w.trashDir)
  return { w, t, ctx: { claudeDir: w.claudeDir, platform: process.platform, trash: t.trash } }
}
const there = path => stat(path).then(() => true, () => false)
const rows = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))

test('deleting says what goes, and goes to the trash only with the code the preview gave', async () => {
  const { w, t, ctx } = await world()
  try {
    const f = await w.folder('f')
    const { file, dir } = await w.session(A, { cwds: [f], side: true })
    await w.state(A)
    const other = await w.session(B, { cwds: [f] })

    const plan = await makePlan({ kind: 'delete', ids: [A.slice(0, 8)] }, ctx)
    assert.equal(plan.ok, true)
    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0].paths.length, 4, 'transcript, side folder, file history, session env')
    assert.match(describePlan(plan), /1 session to send to the trash/)
    assert.equal(plan.code.length, 10)
    assert.equal(plan.code, (await makePlan({ kind: 'delete', ids: [A] }, ctx)).code, 'the same request gives the same code')

    // Nothing was touched by looking.
    assert.equal(await there(file), true)
    assert.equal(t.sent.length, 0)

    const wrong = await confirm({ kind: 'delete', ids: [A] }, 'deadbeef00', ctx)
    assert.equal(wrong.ok, false)
    assert.match(wrong.error, /Things changed/)
    assert.equal((await confirm({ kind: 'delete', ids: [A] }, '', ctx)).ok, false)
    assert.equal(await there(file), true)

    const done = await confirm({ kind: 'delete', ids: [A] }, plan.code, ctx)
    assert.equal(done.ok, true)
    assert.equal(await there(file), false)
    assert.equal(await there(join(dir, A)), false)
    assert.equal(await there(join(w.claudeDir, 'file-history', A)), false)
    assert.equal(await there(join(w.claudeDir, 'session-env', A)), false)
    assert.equal(await there(other.file), true, 'another session stays')
  } finally {
    await w.cleanup()
  }
})

test('a session that changed after the preview needs a new preview', async () => {
  const { w, ctx } = await world()
  try {
    const f = await w.folder('f')
    const { file } = await w.session(A, { cwds: [f] })
    const plan = await makePlan({ kind: 'delete', ids: [A] }, ctx)
    await appendFile(file, '{"type":"assistant","text":"one more row"}\n')
    const result = await confirm({ kind: 'delete', ids: [A] }, plan.code, ctx)
    assert.equal(result.ok, false)
    assert.match(result.error, /Things changed/)
    assert.equal(await there(file), true)
  } finally {
    await w.cleanup()
  }
})

test('a session that is running, or an id that fits nothing, stops the plan', async () => {
  const { w, ctx } = await world()
  try {
    const f = await w.folder('f')
    await w.session(A, { cwds: [f] })
    await w.session(B, { cwds: [f] })
    await w.process(process.pid, A)
    const blocked = await makePlan({ kind: 'delete', ids: [A, B] }, ctx)
    assert.equal(blocked.ok, false)
    assert.match(blocked.items.find(i => i.id === A).problems[0], /running Claude Code/)
    assert.match(describePlan(blocked), /cannot: it is open/)
    const refused = await confirm({ kind: 'delete', ids: [A, B] }, blocked.code, ctx)
    assert.equal(refused.ok, false)
    assert.equal(refused.results.length, 0, 'not even the one that could go')
    assert.match((await makePlan({ kind: 'delete', ids: ['ffffffff'] }, ctx)).error, /No session starts/)
  } finally {
    await w.cleanup()
  }
})

test('pruning takes the orphans only: not a session whose folder is there, not one with no folder recorded', async () => {
  const { w, ctx } = await world()
  try {
    const here = await w.folder('here')
    const gone1 = await w.folder('gone1', { real: false })
    const gone2 = await w.folder('gone2', { real: false })
    await w.session(A, { cwds: [here] })
    await w.session(B, { cwds: [gone1] })
    await w.session(C, { cwds: [gone2], side: true })
    await w.session(D, { cwds: [] })
    const plan = await makePlan({ kind: 'prune' }, ctx)
    assert.deepEqual(plan.items.map(i => i.id).sort(), [B, C])
    const done = await confirm({ kind: 'prune' }, plan.code, ctx)
    assert.equal(done.ok, true)
    assert.deepEqual((await listSessions(ctx)).map(s => s.id).sort(), [A, D])
    assert.match((await makePlan({ kind: 'prune' }, ctx)).error, /no orphan/)
  } finally {
    await w.cleanup()
  }
})

test('a session moves to another folder with its rows, its side folder and its history', async () => {
  const { w, t, ctx } = await world()
  try {
    const from = await w.folder('old')
    const sub = await w.folder('old/sub')
    const to = await w.folder('new')
    await w.folder('new/sub')
    await w.session(A, { cwds: [from, sub, from], side: true, more: [{ type: 'assistant', text: 'a reply' }] })
    await w.session(B, { cwds: [from] })
    await w.history([
      { display: 'first', project: from, sessionId: A },
      { display: 'other session', project: from, sessionId: B },
      { display: 'second', project: from, sessionId: A },
    ])
    const before = await listSessions(ctx)
    assert.equal(before.find(s => s.id === A).project, slugOf(from))

    const request = { kind: 'move', ids: [A], to }
    const plan = await makePlan(request, ctx)
    assert.equal(plan.ok, true, JSON.stringify(plan.items[0].problems))
    assert.equal(plan.items[0].toFolder, to)
    assert.match(describePlan(plan), /1 session to move/)
    const result = await confirm(request, plan.code, ctx)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.results[0].history, 'updated')

    const after = await listSessions(ctx)
    const moved = after.find(s => s.id === A)
    assert.equal(moved.project, slugOf(to))
    assert.equal(moved.folder, to)
    assert.equal(moved.folderState, 'exists')
    assert.ok(moved.sideDir, 'its side folder came along')
    // Rows: every cwd inside the old folder is in the new one, in the same place; the rest is as it was.
    const written = await rows(moved.file)
    assert.deepEqual(written.filter(r => r.cwd).map(r => r.cwd), [to, join(to, 'sub'), to])
    assert.equal(written.at(-1).text, 'a reply')
    assert.equal((await rows(join(moved.sideDir, 'subagents', 'agent-1.jsonl')))[0].type, 'user')
    // The old copy is in the trash, and the other session did not move.
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(from), `${A}.jsonl`)), false)
    assert.deepEqual(t.sent.map(p => p.endsWith(`${A}.jsonl`) || p.endsWith(A)), [true, true])
    assert.equal(after.find(s => s.id === B).project, slugOf(from))
    // History: the rows of that session follow it, those of another session stay.
    const history = await rows(join(w.claudeDir, 'history.jsonl'))
    assert.deepEqual(history.map(h => h.project), [to, from, to])
  } finally {
    await w.cleanup()
  }
})

test('a whole project moves, sessions that started in a folder inside it too, others stay', async () => {
  const { w, ctx } = await world()
  try {
    const x = await w.folder('x')
    const xs = await w.folder('x/src')
    const other = await w.folder('other')
    const y = await w.folder('y')
    await w.session(A, { cwds: [x] })
    await w.session(B, { cwds: [xs] })
    await w.session(C, { cwds: [other] })
    const request = { kind: 'move-project', from: x, to: y }
    const plan = await makePlan(request, ctx)
    assert.deepEqual(plan.items.map(i => i.id).sort(), [A, B])
    assert.equal((await confirm(request, plan.code, ctx)).ok, true)
    const folders = Object.fromEntries((await listSessions(ctx)).map(s => [s.id, s.folder]))
    assert.deepEqual(folders, { [A]: y, [B]: join(y, 'src'), [C]: other })
  } finally {
    await w.cleanup()
  }
})

test('a move that cannot be done says why: no folder, same folder, a session already there, a running one', async () => {
  const { w, ctx } = await world()
  try {
    const x = await w.folder('x')
    const y = await w.folder('y')
    await w.session(A, { cwds: [x] })
    await w.session(B, { cwds: [] })
    const noFolder = await makePlan({ kind: 'move', ids: [B], to: y }, ctx)
    assert.match(noFolder.items[0].problems.join(), /no folder recorded/)
    assert.match((await makePlan({ kind: 'move', ids: [A], to: x }, ctx)).items[0].problems.join(), /already in that folder/)
    assert.match((await makePlan({ kind: 'move', ids: [A], to: join(w.work, 'nowhere') }, ctx)).items[0].problems.join(), /does not exist/)
    assert.match((await makePlan({ kind: 'move', ids: [A], to: 'relative/path' }, ctx)).items[0].problems.join(), /full path/)
    // The same id in two project folders is two sessions with one name: the plan asks which, it does not choose.
    await w.session(A, { cwds: [y] })
    assert.match((await makePlan({ kind: 'move', ids: [A], to: y }, ctx)).error, /fits 2 sessions/)
    await w.process(process.pid, B)
    assert.match((await makePlan({ kind: 'move', ids: [B], to: y }, ctx)).items[0].problems.join(), /running Claude Code/)
  } finally {
    await w.cleanup()
  }
})

test('a move that fails before the end leaves the old session whole and the new one not there', async () => {
  const { w, t, ctx } = await world()
  try {
    const x = await w.folder('x')
    const y = await w.folder('y')
    // A row whose first "cwd" is not its own: rewriting it would change more than the folder, so the move stops.
    const tricky = { meta: { cwd: x }, cwd: x, type: 'user' }
    const { file } = await w.session(A, { cwds: [x], side: true, more: [tricky] })
    const original = await readFile(file, 'utf8')
    const plan = await makePlan({ kind: 'move', ids: [A], to: y }, ctx)
    const result = await confirm({ kind: 'move', ids: [A], to: y }, plan.code, ctx)
    assert.equal(result.ok, false)
    assert.match(result.results[0].message, /more than its folder/)
    assert.equal(await readFile(file, 'utf8'), original, 'the old transcript is as it was')
    assert.equal(t.sent.length, 0, 'nothing went to the trash')
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(y), `${A}.jsonl`)), false)
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(y), `${A}.jsonl.partial`)), false)
  } finally {
    await w.cleanup()
  }
})

test('if the old copy cannot go to the trash, the new one stays and the person is told the session is in both places', async () => {
  const w = await makeWorld()
  try {
    const x = await w.folder('x')
    const y = await w.folder('y')
    await w.session(A, { cwds: [x] })
    const ctx = { claudeDir: w.claudeDir, platform: process.platform, trash: async () => { throw new Error('the bin is full') } }
    const plan = await makePlan({ kind: 'move', ids: [A], to: y }, ctx)
    const result = await confirm({ kind: 'move', ids: [A], to: y }, plan.code, ctx)
    assert.equal(result.ok, false)
    assert.equal(result.results[0].partial, true)
    assert.match(result.results[0].message, /in both places/)
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(y), `${A}.jsonl`)), true)
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(x), `${A}.jsonl`)), true)
  } finally {
    await w.cleanup()
  }
})

test('a plan stops at the first session that fails', async () => {
  const w = await makeWorld()
  try {
    const f = await w.folder('f')
    await w.session(A, { cwds: [f] })
    await w.session(B, { cwds: [f] })
    let calls = 0
    const ctx = { claudeDir: w.claudeDir, platform: process.platform, trash: async () => { if (++calls === 1) throw new Error('locked') } }
    const plan = await makePlan({ kind: 'delete', ids: [A, B] }, ctx)
    const result = await applyPlan(plan, ctx)
    assert.equal(result.ok, false)
    assert.equal(result.results.length, 1)
    assert.equal(calls, 1)
  } finally {
    await w.cleanup()
  }
})

test('a history file that Claude Code is writing is left alone, and the move says so', async () => {
  const { w } = await world()
  try {
    const x = await w.folder('x')
    const y = await w.folder('y')
    const file = join(w.claudeDir, 'history.jsonl')
    await w.history([{ display: 'p', project: x, sessionId: A }])
    const original = await readFile(file, 'utf8')
    // A prompt is typed in another session while the history is being rewritten.
    const grown = await rewriteHistory(w.claudeDir, A, x, y, process.platform, () => appendFile(file, '{"display":"new","project":"z","sessionId":"s"}\n'))
    assert.equal(grown, 'skipped')
    assert.equal(await readFile(file, 'utf8'), original + '{"display":"new","project":"z","sessionId":"s"}\n', 'the new row is there, the old ones untouched')
    assert.equal(await there(`${file}.session-manager`), false, 'no leftover')
    // Quiet file: updated. Another session, or a folder that is not the one that moves: none.
    assert.equal(await rewriteHistory(w.claudeDir, A, x, y, process.platform), 'updated')
    assert.equal(await rewriteHistory(w.claudeDir, 'someone-else', x, y, process.platform), 'none')
    assert.equal(await rewriteHistory(join(w.claudeDir, 'nowhere'), A, x, y, process.platform), 'none')
  } finally {
    await w.cleanup()
  }
})

test('a project folder moved by hand: the file is already in the new folder, only its rows change', async () => {
  const { w, t, ctx } = await world()
  try {
    const x = join(w.work, 'old-name')
    const y = await w.folder('new-name')
    const { file } = await w.session(A, { cwds: [x], projectFolder: y })
    const before = await rows(file)
    const plan = await makePlan({ kind: 'move', ids: [A], to: y }, ctx)
    assert.equal(plan.ok, true, describePlan(plan))
    const done = await confirm({ kind: 'move', ids: [A], to: y }, plan.code, ctx)
    assert.equal(done.ok, true, JSON.stringify(done))
    const after = await rows(file)
    assert.equal(after.length, before.length)
    assert.equal(after.every(r => !r.cwd || r.cwd === y), true, 'every row now names the new folder')
    assert.equal(t.sent.length, 1, 'the old file went to the trash, not away for good')
    assert.equal((await listSessions({ claudeDir: w.claudeDir, platform: process.platform })).find(s => s.id === A).folder, y)
    assert.equal((await makePlan({ kind: 'move', ids: [A], to: y }, ctx)).items[0].problems.join(), 'it is already in that folder')
  } finally {
    await w.cleanup()
  }
})
