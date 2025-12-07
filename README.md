# Keeper

A visual desktop application for managing and editing GitHub CODEOWNERS files.

## Description

Keeper is an Electron-based GUI tool that makes it easy to work with CODEOWNERS files at scale. Instead of manually editing patterns and searching through directories, Keeper provides a three-pane interface that lets you visualize ownership, edit rules, and assign owners interactively.

### Key Features

- **Visual File Browser**: Navigate your repository with ownership information displayed for every file and directory
- **Integrated CODEOWNERS Editor**: Edit your CODEOWNERS file directly with Monaco Editor (the editor that powers VS Code)
- **Ownership Statistics**: See at-a-glance charts showing code ownership distribution by percentage and file count
- **Interactive Assignment**: Right-click any file or folder to assign or remove owners
- **Rule Highlighting**: Click any file to automatically highlight the matching CODEOWNERS rule
- **Smart Pattern Matching**: Optimized with trie data structures for fast pattern matching on large repositories
- **Gitignore Support**: Automatically respects `.gitignore` patterns
- **Background Processing**: Worker threads ensure the UI stays responsive even on large codebases

## Installation

### Via npm (recommended)

```bash
npm install -g @wmarshall484/keeper
```

### From GitHub Releases

Download the latest release for your platform:

**https://github.com/wmarshall484/Keeper/releases**

- **macOS**: Download the `.dmg` or `.zip` file
- **Windows**: Download the `.exe` installer or portable version
- **Linux**: Download the `.AppImage` or `.deb` package

### Build from Source

```bash
git clone https://github.com/wmarshall484/Keeper.git
cd Keeper
npm install
npm start
```

## Usage

### Command Line

Launch Keeper with a repository path:

```bash
keeper /path/to/your/repo
```

Or use a relative path:

```bash
keeper .
keeper ../another-repo
```

If no path is provided, Keeper will prompt you to select a directory.

### Interface Overview

Keeper displays a three-pane interface:

1. **Left Pane - CODEOWNERS Editor**
   - Edit your CODEOWNERS file directly
   - Save changes with `Ctrl+S` (or `Cmd+S` on macOS)
   - Syntax highlighting and line numbers

2. **Middle Pane - File Browser**
   - Navigate directories by double-clicking folders
   - See owner tags for every file and folder
   - Click any file to highlight its matching CODEOWNERS rule
   - Use the "Up" button to navigate to parent directories

3. **Right Pane - Ownership Statistics**
   - Bar chart showing ownership distribution
   - Percentages and file counts for each owner
   - Automatically updates as you navigate

### Assigning Owners

**Right-click** any file or directory to:
- Select from existing owners
- Add a new owner (e.g., `@username` or `@org/team`)
- Remove ownership rules

Changes are automatically written to your CODEOWNERS file.

### Keyboard Shortcuts

- `Cmd+O` / `Ctrl+O`: Open a different repository
- `Cmd+S` / `Ctrl+S`: Save CODEOWNERS file (when editor is focused)
- `Cmd+R` / `Ctrl+R`: Reload the application

### CODEOWNERS File Location

Keeper automatically searches for CODEOWNERS files in standard locations:
- `/CODEOWNERS`
- `/.github/CODEOWNERS`
- `/docs/CODEOWNERS`

## How It Works

Keeper parses your CODEOWNERS file and builds an optimized data structure for fast lookups:
- **Simple patterns** (no wildcards) are stored in a trie for O(n) lookups
- **Complex patterns** (with wildcards like `*.js` or `**/test/**`) use minimatch
- **Worker threads** calculate ownership statistics in the background without blocking the UI
- **Caching** ensures responsive navigation even in large repositories

## Repository

https://github.com/wmarshall484/Keeper

## License

MIT

## Author

Will Marshall (wmarshall484@gmail.com)
