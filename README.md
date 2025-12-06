# Keeper

A desktop application for managing and visualizing CODEOWNERS files. Easily browse your codebase, see who owns what, and assign ownership with a simple right-click interface.

## Features

- **Visual File Browser**: Navigate your codebase with an intuitive file explorer
- **Ownership Visualization**: Bar chart showing ownership distribution across your project
- **Right-Click Assignment**: Easily assign or change file/directory owners
- **Recursive Directory Ownership**: Assign entire directories with a single click
- **CODEOWNERS File Management**: Automatically reads and updates your CODEOWNERS file
- **Cross-Platform**: Works on macOS, Windows, and Linux
- **.gitignore Support**: Respects .gitignore patterns in ownership statistics

## Installation

### Option 1: Download Pre-built Binaries (Coming Soon)

Download the latest release for your platform from the [Releases page](https://github.com/yourusername/keeper/releases):

- **macOS**: Download the `.dmg` file
- **Windows**: Download the `.exe` installer or portable `.exe`
- **Linux**: Download the `.AppImage` or `.deb` file

### Option 2: Build from Source

#### Prerequisites

- Node.js (v18 or higher)
- npm

#### Steps

1. Clone the repository:
   ```bash
   cd co_electron_app
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run in development mode:
   ```bash
   npm start [path-to-repo]
   ```

4. Build for your platform:
   ```bash
   # Build for current platform
   npm run build

   # Build for specific platforms
   npm run build:mac      # macOS (DMG + ZIP)
   npm run build:win      # Windows (NSIS installer + portable)
   npm run build:linux    # Linux (AppImage + deb)

   # Build for all platforms
   npm run build:all
   ```

   Built applications will be in the `dist/` directory.

## Usage

### Installing the CLI Wrapper (Recommended)

For easy command-line usage with the packaged app:

1. Copy the `keeper` script to your PATH:
   ```bash
   cp keeper /usr/local/bin/keeper
   # or
   sudo cp keeper /usr/local/bin/keeper
   ```

2. Now you can use it from anywhere:
   ```bash
   keeper budgeter              # Relative path
   keeper /path/to/repo         # Absolute path
   keeper                       # Current directory
   ```

### Starting the Application

**Development mode:**
```bash
npm start /path/to/your/repo
```

**Packaged app with wrapper script:**
```bash
keeper budgeter              # Opens budgeter/ in current directory
keeper ../other-project      # Opens relative path
keeper /absolute/path        # Opens absolute path
keeper                       # Opens current directory
```

**Packaged app without wrapper:**
```bash
open -a Keeper --args "$PWD/budgeter"     # Must use absolute path
```

**GUI mode:**
- Double-click the Keeper app icon
- Drag and drop a folder onto the app icon

### Managing Ownership

1. **View Ownership**: Browse files and see current owners in the right column
2. **Assign Owner**: Right-click any file or directory and select an owner
3. **Add New Owner**: Right-click and choose "Add new owner..." to manually type an owner name
4. **Remove Owner**: Right-click and choose "Remove owner" to unset ownership
5. **View Stats**: Check the right panel for ownership distribution across the codebase

### CODEOWNERS File Location

The tool automatically searches for CODEOWNERS files in these locations:
- `/CODEOWNERS` (repository root)
- `/.github/CODEOWNERS`
- `/docs/CODEOWNERS`

### How Ownership Works

The tool follows GitHub's CODEOWNERS rules:
- **Last match wins**: If multiple patterns match a file, the last one in the file takes precedence
- **Directories**: Adding a trailing `/` to a path makes it apply recursively to all contents
- **Dotfiles**: Hidden files and directories (starting with `.`) are properly matched

## Development

### Project Structure

```
co_electron_app/
├── main.js           # Electron main process
├── renderer.js       # UI logic and event handlers
├── preload.js        # Secure IPC bridge
├── index.html        # Application UI
├── style.css         # Styling
├── package.json      # Dependencies and build config
└── README.md         # This file
```

### Technologies Used

- **Electron**: Desktop application framework
- **Node.js**: Runtime environment
- **minimatch**: Pattern matching for CODEOWNERS rules

## Building for Distribution

### Requirements for Building All Platforms

- **From macOS**: Can build for macOS, Windows, and Linux
- **From Windows**: Can build for Windows and Linux only
- **From Linux**: Can build for Linux and Windows only

### Creating Icons

Place icon files in the `build/` directory:
- `icon.png` - 1024x1024 PNG for all platforms

electron-builder will automatically generate the appropriate icon formats for each platform.

## Troubleshooting

### "CODEOWNERS file not found"

Make sure your repository has a CODEOWNERS file in one of the standard locations:
- Root directory: `/CODEOWNERS`
- GitHub directory: `/.github/CODEOWNERS`
- Docs directory: `/docs/CODEOWNERS`

### Ownership not updating after assignment

Try navigating to a different directory and back to refresh the view.

### App shows "Electron" in menu bar (development only)

This is normal in development mode. The correct name appears in packaged builds.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT License - see LICENSE file for details

## Support

For issues, questions, or suggestions, please open an issue on GitHub.
