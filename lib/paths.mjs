// Paths as Claude Code writes them in a transcript. The same folder shows up as `D:\x`, `d:\x` and `/d/x` (Git Bash),
// so every comparison goes through one form. The platform is a parameter so the rules are tested on any system.
import { parse } from 'node:path'

/** How Claude Code names a project folder: the path with every character that is not a letter or a digit as a dash. */
export const slugOf = path => path.replace(/[^A-Za-z0-9]/g, '-')

const BS = String.fromCharCode(92)

/** One form for a path: `D:\x\y` on Windows (drive letter capital, backslashes, no trailing one), the plain path elsewhere. */
export function normalizePath(raw, platform = process.platform) {
  if (typeof raw !== 'string') return ''
  let p = raw.trim()
  if (p === '') return ''
  if (platform === 'win32') {
    const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p)
    if (msys) p = `${msys[1]}:${BS}${(msys[2] ?? '').split('/').join(BS)}`
    p = p.split('/').join(BS)
    if (/^[a-zA-Z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1)
    if (/^[A-Z]:\\+$/.test(p) || /^[A-Z]:$/.test(p)) return p.slice(0, 2) + BS
    while (p.length > 1 && p.endsWith(BS) && !p.endsWith(BS + BS)) p = p.slice(0, -1)
    return p
  }
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p
}

/** The same place, spelled differently? Windows paths do not care about case. */
export const samePlace = (a, b, platform = process.platform) => {
  const x = normalizePath(a, platform)
  const y = normalizePath(b, platform)
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** Is `path` the folder `base` or something inside it? */
export function isInside(path, base, platform = process.platform) {
  const sep = platform === 'win32' ? BS : '/'
  let p = normalizePath(path, platform)
  let b = normalizePath(base, platform)
  if (platform === 'win32') {
    p = p.toLowerCase()
    b = b.toLowerCase()
  }
  if (b === '') return false
  const root = b.endsWith(sep) ? b : b + sep
  return p === b || p.startsWith(root)
}

/** Writes `normal` in the style `raw` had: `/d/x` stays Git Bash style, `d:\x` keeps its small letter, `d:/x` its slashes. */
export function formatLike(raw, normal, platform = process.platform) {
  if (platform !== 'win32') return normal
  const drive = /^([A-Z]):(.*)$/.exec(normal)
  if (!drive) return normal
  const rest = drive[2]
  if (raw.startsWith('/')) return `/${drive[1].toLowerCase()}${rest.split(BS).join('/').replace(/^\/?$/, '')}`
  const letter = /^[a-z]:/.test(raw) ? drive[1].toLowerCase() : drive[1]
  const body = raw.includes('/') && !raw.includes(BS) ? rest.split(BS).join('/') : rest
  return `${letter}:${body}`
}

/** `raw`, a path of a transcript row, moved from `from` to `to`: only the prefix changes, and the row keeps its style. */
export function replacePrefix(raw, from, to, platform = process.platform) {
  if (!isInside(raw, from, platform)) return raw
  const sep = platform === 'win32' ? BS : '/'
  const rawNorm = normalizePath(raw, platform)
  const fromNorm = normalizePath(from, platform)
  const tail = rawNorm.slice(fromNorm.length).replace(new RegExp(`^${sep === BS ? BS + BS : '/'}`), '')
  const toNorm = normalizePath(to, platform)
  const joined = tail === '' ? toNorm : (toNorm.endsWith(sep) ? toNorm : toNorm + sep) + tail
  return formatLike(raw, joined, platform)
}

/** The root of a path (`D:\`, `/`): if it is not there, a missing folder may only be a drive that is not plugged in. */
export const rootOf = (path, platform = process.platform) => {
  const n = normalizePath(path, platform)
  return n === '' ? '' : parse(n).root
}
