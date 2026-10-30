// Sending to the system's trash, never deleting for good. The paths reach the tool as data (a JSON list on its input or
// one argument each), never as part of a command line to read. Where no trash can be reached the call fails: it does not
// fall back to deleting.
import { execFile } from 'node:child_process'

const WINDOWS = [
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  'foreach ($p in $paths) {',
  // AllDialogs: an item too big for the Recycle Bin makes Windows ask, instead of deleting it for good without a word.
  "  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') }",
  "  elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') }",
  '}',
].join('\n')

const MAC = 'on run argv\ntell application "Finder"\nrepeat with p in argv\ndelete (POSIX file (p as text))\nend repeat\nend tell\nend run'

const run = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => (error ? reject(new Error((stderr || stdout || error.message).trim())) : resolve(stdout)))
    if (input !== undefined) child.stdin.end(input)
  })

/** Sends each path to the trash. Rejects (and the caller stops) if any could not go. */
export async function sendToTrash(paths, platform = process.platform) {
  if (paths.length === 0) return
  if (platform === 'win32') {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS], JSON.stringify(paths))
    return
  }
  if (platform === 'darwin') {
    await run('osascript', ['-e', MAC, ...paths])
    return
  }
  await run('gio', ['trash', '--', ...paths]).catch(error => {
    throw new Error(`there is no trash to send them to (gio trash failed: ${error.message}). Nothing was deleted.`)
  })
}
