// The real Recycle Bin, with a file and a folder made for the test. It leaves two small items in the bin, so it runs only when
// asked (SESSION_MANAGER_REAL_TRASH=1) or on CI, and only on Windows: the other systems are tried with stand-ins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendToTrash } from '../lib/trash.mjs'

const real = process.platform === 'win32' && (process.env.SESSION_MANAGER_REAL_TRASH === '1' || process.env.CI === 'true')
const there = path => stat(path).then(() => true, () => false)

const inRecycleBin = name =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.Name }`], { encoding: 'utf8' })
    .split(/\r?\n/)
    .includes(name)

test('the Recycle Bin receives a file and a folder, with names that are not safe in a command line', { skip: !real, timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-manager-trash-"))
  const tag = `smtrash${Date.now()}`
  const file = join(dir, `${tag} file's & (odd).txt`)
  const folder = join(dir, `${tag} folder $x`)
  await writeFile(file, 'x')
  await mkdir(folder)
  await writeFile(join(folder, 'inner.txt'), 'y')
  // Asked for on a machine with a Recycle Bin: the items must be in it. On CI the runner may have none, or one set to delete for
  // good: then the call has to refuse before it deletes anything, which is the point of the check.
  const strict = process.env.SESSION_MANAGER_REAL_TRASH === '1'
  try {
    await sendToTrash([file, folder])
  } catch (error) {
    assert.equal(strict, false, `a machine with a Recycle Bin must take them: ${error.message}`)
    assert.match(error.message, /Recycle Bin|nothing was deleted/)
    assert.equal(await there(file), true, 'refused: the file is still there')
    assert.equal(await there(folder), true, 'refused: so is the folder')
    return
  }
  assert.equal(await there(file), false)
  assert.equal(await there(folder), false)
  if (strict) {
    assert.equal(inRecycleBin(`${tag} file's & (odd).txt`), true, 'the file is in the Recycle Bin, not deleted for good')
    assert.equal(inRecycleBin(`${tag} folder $x`), true, 'so is the folder')
  }
})

test('a path that is not there stops nothing, and an empty list does nothing', { skip: !real, timeout: 60000 }, async () => {
  await sendToTrash([])
  await sendToTrash([join(tmpdir(), 'session-manager-not-there-xyz')])
})
