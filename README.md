# Keeper

A desktop app for viewing and editing GitHub `CODEOWNERS` files — browse a
repository, see who owns each file and directory, edit ownership visually, and
preview file contents, all in one window.

## Installation

**From source**

```bash
git clone https://github.com/wmarshall484/Keeper.git
cd Keeper
npm install
npm start
```

**Prebuilt** — download the macOS `.dmg`, Windows `.exe`, or Linux
`.AppImage`/`.deb` from the
[Releases](https://github.com/wmarshall484/Keeper/releases) page.

> macOS builds are unsigned. After dragging Keeper to Applications, run
> `xattr -cr /Applications/Keeper.app` once to clear Gatekeeper, then open it.

On launch, pick a repository (or pass a path on the command line). Keeper looks
for `CODEOWNERS` in `/`, `/.github/`, or `/docs/`.

## Features

- **Three panes** — a Monaco `CODEOWNERS` editor, a file browser showing each
  file's owning team(s), and an ownership chart with a read-only file preview.
- **Click to inspect** — clicking a file highlights its matching rule in the
  editor and previews its contents with syntax highlighting.
- **Visual editing** — right-click a file (or a Cmd/Shift-click multi-selection)
  and tick checkboxes to assign one or more teams at once; add new teams or
  clear owners.
- **Ownership stats** — per-directory breakdown by team; toggle it off to give
  the preview the full pane.
- **Ruby files only** — restrict the navigator and stats to Ruby files.
- **Accurate & fast** — `.gitignore`-aware, with correct `CODEOWNERS` glob
  matching (including `dir/**`) and an indexed matcher tuned for large repos.
- **Dark, VS Code-style interface.**

## License

MIT
