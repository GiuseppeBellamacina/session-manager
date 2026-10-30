// Sending to the system's trash, never deleting for good. The paths reach the tool as data (a JSON list on its input or
// one argument each), never as part of a command line to read. Where no trash can be reached the call fails: it does not
// fall back to deleting.
import { execFile } from 'node:child_process'

// On Windows a file sent to the Recycle Bin is deleted for good, with no word, when the drive has no bin (a removable or a
// network drive) or the bin is set to "do not move files to the Recycle Bin". So every drive is checked before anything goes.
const WINDOWS = String.raw`
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Test-Bin($p) {
  $drive = [IO.Path]::GetPathRoot($p).TrimEnd('\')
  $vol = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $drive + "'") -ErrorAction SilentlyContinue
  if (-not $vol -or $vol.DriveType -ne 3) { throw ('there is no Recycle Bin on ' + $drive + ': nothing was deleted') }
  $id = $vol.DeviceID -replace '^\\\\\?\\Volume', '' -replace '\\$', ''
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $id
  $nuke = (Get-ItemProperty -Path $key -Name NukeOnDelete -ErrorAction SilentlyContinue).NukeOnDelete
  if ($nuke -eq 1) { throw ('the Recycle Bin of ' + $drive + ' is set to delete for good: nothing was deleted') }
}
foreach ($p in $paths) { Test-Bin $p }
foreach ($p in $paths) {
  # AllDialogs: an item too big for the Recycle Bin makes Windows ask, instead of deleting it for good without a word.
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') }
  elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'AllDialogs', 'SendToRecycleBin', 'ThrowException') }
}
`

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
