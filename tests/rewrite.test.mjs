import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countRows, rewriteRow, rewriteTranscript } from '../lib/rewrite.mjs'

const win = 'win32'
const from = 'D:\\old\\proj'
const to = 'E:\\new\\proj'

test('only the folder of a row changes: every other byte stays', () => {
  const line = '{"parentUuid":null,"cwd":"D:\\\\old\\\\proj\\\\src","sessionId":"s1","message":{"role":"user","content":[{"type":"text","text":"héllo \\u003c tag"}]},"n":1.50}'
  const r = rewriteRow(line, from, to, win)
  assert.equal(r.changed, true)
  assert.equal(r.line, line.replace('D:\\\\old\\\\proj\\\\src', 'E:\\\\new\\\\proj\\\\src'))
  assert.equal(JSON.parse(r.line).cwd, 'E:\\new\\proj\\src')
})

test('a row keeps the style of its path, and a row outside the folder is left alone', () => {
  const msys = '{"cwd":"/d/old/proj/src","type":"user"}'
  assert.equal(rewriteRow(msys, from, to, win).line, '{"cwd":"/e/new/proj/src","type":"user"}')
  const other = '{"cwd":"D:\\\\elsewhere","type":"user"}'
  assert.deepEqual(rewriteRow(other, from, to, win), { line: other, changed: false })
  const sibling = '{"cwd":"D:\\\\old\\\\proj2","type":"user"}'
  assert.equal(rewriteRow(sibling, from, to, win).changed, false)
})

test('rows that are not rows of a session pass through as they are', () => {
  for (const line of ['', 'not json at all', '{"type":"assistant"}', '{"cwd":42}', '{"cwd": broken', '[1,2,3]']) {
    assert.deepEqual(rewriteRow(line, from, to, win), { line, changed: false }, line)
  }
})

test('a "cwd" inside the text of a message is text, not the folder of the row', () => {
  const inner = JSON.stringify({ type: 'user', cwd: 'D:\\old\\proj', message: { content: 'the file says {"cwd":"D:\\\\old\\\\proj"}' } })
  const r = rewriteRow(inner, from, to, win)
  assert.equal(JSON.parse(r.line).cwd, 'E:\\new\\proj')
  assert.equal(JSON.parse(r.line).message.content, 'the file says {"cwd":"D:\\\\old\\\\proj"}')
})

test('a row where the first "cwd" is not the row folder is refused, not half rewritten', () => {
  const tricky = '{"meta":{"cwd":"D:\\\\old\\\\proj"},"cwd":"D:\\\\old\\\\proj"}'
  assert.throws(() => rewriteRow(tricky, from, to, win), /more than its folder/)
})

test('a transcript is written again row by row, with its last row and its empty lines as they were', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-manager-rw-'))
  try {
    const rows = []
    for (let i = 0; i < 3000; i++) rows.push(JSON.stringify({ type: 'assistant', n: i, cwd: i % 2 ? 'D:\\old\\proj' : 'D:\\other', text: 'x'.repeat(500) }))
    const source = join(dir, 'a.jsonl')
    await writeFile(source, rows.join('\n') + '\n\n{"type":"user","cwd":"/d/old/proj"}')
    const dest = join(dir, 'b.jsonl')
    const { rows: count, changed } = await rewriteTranscript(source, dest, from, to, win)
    assert.equal(count, 3002)
    assert.equal(changed, 1501)
    assert.equal(await countRows(dest), 3002)
    const text = await readFile(dest, 'utf8')
    assert.ok(text.endsWith('{"type":"user","cwd":"/e/new/proj"}'), 'the last row has no newline, as before')
    assert.ok(text.includes('\n\n{"type"'), 'the empty line is kept')
    assert.equal(text.includes('D:\\\\old\\\\proj'), false)
    assert.equal(text.split('\n')[0].includes('D:\\\\other'), true, 'a row elsewhere is untouched')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
