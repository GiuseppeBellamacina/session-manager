# Changelog

## 0.1.0

The first version.

- A page (`/sessions`) with every Claude Code session on the computer, grouped by folder, in the style of omniboard: search, filters, light and dark.
- **Open** a session in VS Code (an address reported by users of the extension), in a terminal in its folder (Windows) or by copying the command.
- **Move** a session, several, or a whole project to another folder: the rows of the transcripts, the side folders and the prompt history follow, the new copy is checked before the old one goes to the trash.
- **Delete** sessions, or all the **orphans** (the folder is gone) at once, to the system's trash. A session with no folder recorded, on a drive that is away, or running now is never touched.
- Every change is previewed and done only with the code of the preview (`yes <code>`, or the confirmation window of the page); a changed disk invalidates the code.
- `/sessions list`, `open`, `orphans`, `prune`, `delete`, `move`, `move-project`.
- Windows, macOS (`osascript`) and Linux (`gio trash`). macOS and Linux are tested against stand-ins, not yet on real machines.
