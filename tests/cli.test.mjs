import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HELP, run, tokenize } from '../lib/cli.mjs'
import { slugOf } from '../lib/paths.mjs'
import { fakeTrash, makeWorld } from './fixture.mjs'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const there = path => stat(path).then(() => true, () => false)

const world = async () => {
  const w = await makeWorld()
  const t = fakeTrash(w.trashDir)
  return { w, t, ctx: { claudeDir: w.claudeDir, platform: process.platform, trash: t.trash } }
}

test('words keep what is inside double quotes, and a backslash is only a backslash', () => {
  assert.deepEqual(tokenize('move aaaa "D:\\My Projects\\x y" yes 123'), ['move', 'aaaa', 'D:\\My Projects\\x y', 'yes', '123'])
  assert.deepEqual(tokenize('  list   a  b '), ['list', 'a', 'b'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(undefined), [])
})

test('/sessions list shows the sessions with what matters, and a filter', async () => {
  const { w, ctx } = await world()
  try {
    const here = await w.folder('here')
    const gone = await w.folder('gone', { real: false })
    await w.session(A, { cwds: [here], prompt: 'Fix the login page' })
    await w.session(B, { cwds: [gone], prompt: 'Old project work' })
    await w.process(process.pid, A)
    const all = await run('list', ctx)
    assert.match(all, /2 sessions, 1 orphan:/)
    assert.match(all, /aaaaaaaa .*\[open now\] Fix the login page/)
    assert.match(all, /bbbbbbbb .*\[orphan\] Old project work/)
    assert.match(await run('list login', ctx), /1 session,.*\n.*Fix the login page/s)
    assert.equal(await run('list nothing-like-this', ctx), 'No session matches.')
  } finally {
    await w.cleanup()
  }
})

test('/sessions open hands the plugin an address for VS Code, and the command for a terminal', async () => {
  const { w, ctx } = await world()
  try {
    const here = await w.folder('here')
    await w.session(A, { cwds: [here] })
    const out = await run('open aaaa', ctx)
    assert.match(out, new RegExp(`^OPEN vscode://anthropic.claude-code/open\\?session=${A}\\n`))
    assert.match(out, new RegExp(`claude --resume ${A}`))
    assert.match(await run('open zzzz', ctx), /No session starts/)
    assert.match(await run('open', ctx), /first 4 characters/)
  } finally {
    await w.cleanup()
  }
})

test('/sessions prune shows the orphans first and only repeating it with the code sends them to the trash', async () => {
  const { w, t, ctx } = await world()
  try {
    const gone = await w.folder('gone', { real: false })
    const here = await w.folder('here')
    const { file } = await w.session(A, { cwds: [gone] })
    await w.session(B, { cwds: [here] })
    assert.match(await run('orphans', ctx), /1 orphan .*, their folder is gone/)

    const preview = await run('prune', ctx)
    assert.match(preview, /1 session to send to the trash/)
    const code = /\/sessions prune yes ([0-9a-f]{10})/.exec(preview)?.[1]
    assert.ok(code, 'the preview says what to type to go on')
    assert.equal(await there(file), true, 'the preview deleted nothing')
    assert.equal(t.sent.length, 0)

    assert.match(await run('prune yes 0000000000', ctx), /Things changed/)
    assert.equal(await there(file), true)
    assert.match(await run(`prune yes ${code}`, ctx), /Done: 1 session\./)
    assert.equal(await there(file), false)
    assert.match(await run('prune', ctx), /no orphan/)
    assert.match(await run('orphans', ctx), /No orphan session/)
  } finally {
    await w.cleanup()
  }
})

test('/sessions delete previews with the exact command to confirm, ids by their start', async () => {
  const { w, ctx } = await world()
  try {
    const f = await w.folder('f')
    const { file } = await w.session(A, { cwds: [f] })
    const preview = await run('delete aaaa', ctx)
    assert.match(preview, /^1 session to send to the trash/)
    assert.match(preview, /To send them to the trash \(you can put them back from there\): \/sessions delete aaaa yes [0-9a-f]{10}/)
    const code = /yes ([0-9a-f]{10})/.exec(preview)[1]
    assert.match(await run(`delete aaaa yes ${code}`, ctx), /Done: 1 session\./)
    assert.equal(await there(file), false)
    assert.equal(await run('delete', ctx), 'Usage: /sessions delete <id>...')
    assert.match(await run('delete ffff', ctx), /No session starts/)
  } finally {
    await w.cleanup()
  }
})

test('/sessions move and move-project preview, then move, with folders that have spaces', async () => {
  const { w, ctx } = await world()
  try {
    const from = await w.folder('old project')
    const to = await w.folder('new project')
    const other = await w.folder('other')
    await w.session(A, { cwds: [from] })
    await w.session(B, { cwds: [other] })

    const preview = await run(`move aaaa "${to}"`, ctx)
    assert.match(preview, /1 session to move/)
    const confirmLine = /To move them: (\/sessions move aaaa "[^"]+" yes [0-9a-f]{10})/.exec(preview)?.[1]
    assert.ok(confirmLine, `the confirm command keeps the quotes: ${preview}`)
    const done = await run(confirmLine.replace('/sessions ', ''), ctx)
    assert.match(done, /Done: 1 session\./)
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(to), `${A}.jsonl`)), true)

    // The whole project that moved from `to` to a third folder.
    const third = await w.folder('third')
    const p = await run(`move-project "${to}" "${third}"`, ctx)
    const line = /(move-project .* yes [0-9a-f]{10})/.exec(p)[1]
    assert.match(await run(line, ctx), /Done: 1 session\./)
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(third), `${A}.jsonl`)), true)
    assert.equal(await there(join(w.claudeDir, 'projects', slugOf(other), `${B}.jsonl`)), true, 'another project stays')

    assert.equal(await run('move aaaa', ctx), 'Usage: /sessions move <id>... <folder>')
    assert.equal(await run('move-project a', ctx), 'Usage: /sessions move-project <old folder> <new folder>')
    assert.match(await run(`move aaaa "${join(w.work, 'nowhere')}"`, ctx), /does not exist/)
  } finally {
    await w.cleanup()
  }
})

test('anything else is the help, which lists every command', async () => {
  const { w, ctx } = await world()
  try {
    assert.equal(await run('wat', ctx), HELP)
    for (const verb of ['list', 'open', 'orphans', 'prune', 'delete', 'move', 'move-project']) assert.match(HELP, new RegExp(`/sessions ${verb}`))
  } finally {
    await w.cleanup()
  }
})
