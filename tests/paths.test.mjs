import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatLike, isInside, normalizePath, replacePrefix, samePlace, slugOf } from '../lib/paths.mjs'

const win = 'win32'

test('a project folder is named by the path with every non-alphanumeric character as a dash', () => {
  assert.equal(slugOf('D:\\Codici\\Workspace\\_Personali'), 'D--Codici-Workspace--Personali')
  assert.equal(slugOf('/home/me/my project'), '-home-me-my-project')
})

test('the three spellings of one Windows folder are one path', () => {
  for (const raw of ['D:\\Codici\\Workspace', 'd:\\Codici\\Workspace', '/d/Codici/Workspace', 'd:/Codici/Workspace', 'D:\\Codici\\Workspace\\']) {
    assert.equal(normalizePath(raw, win), 'D:\\Codici\\Workspace', raw)
  }
  assert.equal(normalizePath('/d', win), 'D:\\')
  assert.equal(normalizePath('D:\\', win), 'D:\\')
  assert.equal(normalizePath('D:', win), 'D:\\')
  assert.equal(normalizePath('', win), '')
  assert.equal(normalizePath(undefined, win), '')
  assert.equal(normalizePath('\\\\server\\share\\x\\', win), '\\\\server\\share\\x')
})

test('elsewhere a path only loses its trailing slash', () => {
  assert.equal(normalizePath('/home/me/proj/', 'linux'), '/home/me/proj')
  assert.equal(normalizePath('/', 'linux'), '/')
  assert.equal(normalizePath('/home/Me', 'darwin'), '/home/Me')
})

test('Windows folders are the same whatever the case, others are not', () => {
  assert.equal(samePlace('D:\\Codici', '/d/codici', win), true)
  assert.equal(samePlace('/home/Me', '/home/me', 'linux'), false)
})

test('a path is inside a folder only at a folder boundary', () => {
  assert.equal(isInside('D:\\a\\b', 'D:\\a', win), true)
  assert.equal(isInside('/d/a/b/c', 'D:\\a', win), true)
  assert.equal(isInside('D:\\a', 'D:\\a', win), true)
  assert.equal(isInside('D:\\ab', 'D:\\a', win), false)
  assert.equal(isInside('D:\\x', 'D:\\a', win), false)
  assert.equal(isInside('/home/me/projects', '/home/me/proj', 'linux'), false)
  assert.equal(isInside('/home/me/proj/src', '/home/me/proj', 'linux'), true)
})

test('moving a prefix keeps the style of each row', () => {
  const from = 'D:\\old\\proj'
  const to = 'E:\\new\\place\\proj'
  assert.equal(replacePrefix('D:\\old\\proj', from, to, win), 'E:\\new\\place\\proj')
  assert.equal(replacePrefix('D:\\old\\proj\\src\\x', from, to, win), 'E:\\new\\place\\proj\\src\\x')
  assert.equal(replacePrefix('d:\\old\\proj\\src', from, to, win), 'e:\\new\\place\\proj\\src')
  assert.equal(replacePrefix('/d/old/proj/src', from, to, win), '/e/new/place/proj/src')
  assert.equal(replacePrefix('d:/old/proj/src', from, to, win), 'e:/new/place/proj/src')
  // Outside the folder, or only sharing the start of a name: left alone.
  assert.equal(replacePrefix('D:\\old\\proj2\\x', from, to, win), 'D:\\old\\proj2\\x')
  assert.equal(replacePrefix('D:\\other', from, to, win), 'D:\\other')
  assert.equal(replacePrefix('/home/me/a/b', '/home/me/a', '/srv/a', 'linux'), '/srv/a/b')
  assert.equal(replacePrefix('/home/me/a', '/home/me/a', '/srv/a', 'linux'), '/srv/a')
})

test('the root of a drive moves as a prefix too', () => {
  assert.equal(replacePrefix('D:\\x\\y', 'D:\\x', 'D:\\', win), 'D:\\y')
  assert.equal(formatLike('/d/x', 'D:\\', win), '/d')
})
