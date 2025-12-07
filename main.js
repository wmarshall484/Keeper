const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const process = require('process');
const fs = require('fs');
const { minimatch } = require('minimatch');
const { Worker } = require('worker_threads');

// Set the app name for macOS menu bar (must be before app.ready)
if (process.platform === 'darwin') {
  app.name = 'Keeper';
}

// Get the initial directory from command line args
// In packaged apps, process.argv[1] is the first user arg
// In dev mode, process.argv[2] is the first user arg
let initialDirectory;
let needsDirectorySelection = false;

// Debug: log all arguments
console.log('All process.argv:', process.argv);
console.log('app.isPackaged:', app.isPackaged);

if (app.isPackaged) {
  // Packaged app: argv[0] is the executable, argv[1] is the first user arg
  initialDirectory = process.argv[1];
} else {
  // Dev mode: argv[0] is electron, argv[1] is main.js, argv[2] is first user arg
  initialDirectory = process.argv[2];
}

// Check if no directory was provided or if it doesn't exist
if (!initialDirectory || !fs.existsSync(initialDirectory)) {
  needsDirectorySelection = true;
  initialDirectory = null;
  console.log('No valid directory provided, will prompt user');
} else {
  // Resolve to absolute path
  initialDirectory = path.resolve(initialDirectory);
  console.log('Resolved initialDirectory:', initialDirectory);
}

let currentDirectory = initialDirectory;
let projectRoot = initialDirectory && initialDirectory.endsWith('co_electron_app') ? path.dirname(initialDirectory) : initialDirectory;

console.log('projectRoot:', projectRoot);
console.log('needsDirectorySelection:', needsDirectorySelection);

let codeowners = null;
let codeownersFound = false;
let gitignorePatterns = [];
let mainWindow;
let ownerCache = new Map(); // Cache for file→owner lookups
let codeownersTrie = null; // Trie for fast pattern matching
let complexPatterns = []; // Patterns with wildcards that need minimatch
let statsCache = new Map(); // Cache for directory→stats lookups
let currentPrefetcher = null; // Current background prefetch operation
let activeComputations = new Map(); // Track in-progress computations by directory path (stores Worker instances)
let activeWorkers = new Map(); // Track active worker threads

// TrieNode class for efficient path-based pattern matching
class TrieNode {
  constructor() {
    this.children = new Map(); // path segment → TrieNode
    this.owners = null; // owners at this node (if a rule matches here)
    this.pattern = null; // original pattern for this node
    this.priority = -1; // rule priority (higher = later in file = wins)
  }
}

// Build trie from parsed CODEOWNERS rules
function buildCodeownersTrie(rules) {
  const root = new TrieNode();
  const complex = [];

  // Rules are already reversed (index 0 = last rule in original file)
  // We assign priority where higher number = later in original file = wins
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const priority = rules.length - i - 1; // Invert: index 0 gets highest priority
    const pattern = rule.pattern;

    // Check if pattern is "simple" (no wildcards except trailing /**)
    const isSimple = !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[');
    const isDirectoryPattern = pattern.endsWith('**');

    if (isSimple || isDirectoryPattern) {
      // Simple path-based pattern - add to trie
      let cleanPattern = pattern;
      if (cleanPattern.endsWith('**')) {
        cleanPattern = cleanPattern.slice(0, -2); // Remove trailing **
      }
      if (cleanPattern.endsWith('/')) {
        cleanPattern = cleanPattern.slice(0, -1); // Remove trailing /
      }

      const segments = cleanPattern.split('/').filter(s => s !== '');
      let node = root;

      for (const segment of segments) {
        if (!node.children.has(segment)) {
          node.children.set(segment, new TrieNode());
        }
        node = node.children.get(segment);
      }

      // Store owners and priority at this node
      node.owners = rule.owners;
      node.pattern = rule.pattern;
      node.priority = priority;
    } else {
      // Complex pattern with wildcards - needs minimatch
      complex.push({ ...rule, priority });
    }
  }

  return { root, complex };
}

// Search trie for matching owner
function searchTrie(root, pathSegments) {
  let node = root;
  let bestMatch = null;
  let bestPriority = -1;

  for (const segment of pathSegments) {
    if (!node.children.has(segment)) {
      break;
    }
    node = node.children.get(segment);
    if (node.owners && node.priority > bestPriority) {
      bestMatch = node.owners;
      bestPriority = node.priority;
    }
  }

  return { owners: bestMatch, priority: bestPriority };
}

// Serialize trie for passing to worker thread
function serializeTrie(node) {
  const obj = {
    owners: node.owners,
    pattern: node.pattern,
    priority: node.priority,
    children: {}
  };

  for (const [key, childNode] of node.children.entries()) {
    obj.children[key] = serializeTrie(childNode);
  }

  return obj;
}

function findAndParseGitignore(baseDir) {
  const gitignorePath = path.join(baseDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    return [];
  }

  const content = fs.readFileSync(gitignorePath, 'utf-8');
  const patterns = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(pattern => {
      // Handle negation patterns
      if (pattern.startsWith('!')) {
        return { pattern: pattern.substring(1), negate: true };
      }
      return { pattern, negate: false };
    });

  return patterns;
}

function isIgnored(filePath, baseDir, patterns) {
  if (patterns.length === 0) {
    return false;
  }

  let relativePath = path.relative(baseDir, filePath);

  // Check if any pattern matches
  let ignored = false;
  for (const { pattern, negate } of patterns) {
    const matches = minimatch(relativePath, pattern, { dot: true }) ||
                    minimatch(relativePath + '/', pattern, { dot: true }) ||
                    minimatch(path.basename(filePath), pattern, { dot: true });

    if (matches) {
      ignored = !negate;
    }
  }

  return ignored;
}

function findAndParseCodeowners(baseDir) {
  const possiblePaths = [
    path.join(baseDir, 'CODEOWNERS'),
    path.join(baseDir, '.github', 'CODEOWNERS'),
    path.join(baseDir, 'docs', 'CODEOWNERS'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
          const lines = content.split('\n');
          const parsedWithLines = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            if (trimmedLine === '' || trimmedLine.startsWith('#')) {
              continue;
            }
      
            let [pattern, ...owners] = trimmedLine.split(/\s+/);
            owners = owners.map(o => o.toLowerCase());
      
            if (pattern.startsWith('/')) {
              pattern = pattern.substring(1);
            }
            if (pattern.endsWith('/')) {
              pattern += '**';
            }
      
            parsedWithLines.push({
              pattern,
              owners,
              lineNumber: i + 1,
              lineContent: trimmedLine
            });
          }
          const parsed = parsedWithLines.reverse(); // Last match wins, so we reverse for easier iteration

      codeownersFound = true;

      // Build trie and separate complex patterns for optimization
      const { root, complex } = buildCodeownersTrie(parsed);
      codeownersTrie = root;
      complexPatterns = complex;

      // Clear caches when CODEOWNERS is reloaded
      ownerCache.clear();
      statsCache.clear();

      // Terminate all active worker threads since they're now stale
      for (const [dir, worker] of activeWorkers.entries()) {
        worker.terminate();
      }
      activeWorkers.clear();
      activeComputations.clear();

      console.log(`CODEOWNERS optimization: ${parsed.length - complex.length} simple patterns in trie, ${complex.length} complex patterns need minimatch`);

      return parsed;
    }
  }
  codeownersFound = false;
  codeownersTrie = null;
  complexPatterns = [];
  ownerCache.clear();
  statsCache.clear();
  return null;
}

// Compute ownership stats using Worker Thread
function computeOwnershipStatsAsync(dirPath, onProgress = null) {
  return new Promise((resolve, reject) => {
    // Serialize data for worker
    const workerData = {
      dirPath,
      codeowners,
      projectRoot,
      gitignorePatterns,
      codeownersTrie: codeownersTrie ? serializeTrie(codeownersTrie) : null,
      complexPatterns
    };

    const worker = new Worker(path.join(__dirname, 'stats-worker.js'), { workerData });

    activeWorkers.set(dirPath, worker);

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        if (onProgress) {
          onProgress(msg.data);
        }
      } else if (msg.type === 'complete') {
        // Cache all subdirectories from worker result
        const allDirCountsObj = msg.data;
        for (const [dir, ownerCounts] of Object.entries(allDirCountsObj)) {
          const total = Object.values(ownerCounts).reduce((sum, count) => sum + count, 0);
          if (total === 0) {
            statsCache.set(dir, []);
          } else {
            const percentages = Object.entries(ownerCounts).map(([owner, count]) => ({
              owner,
              percentage: (count / total) * 100,
              count
            }));
            statsCache.set(dir, percentages);
          }
        }

        activeWorkers.delete(dirPath);
        resolve(statsCache.get(dirPath) || []);
      } else if (msg.type === 'error') {
        activeWorkers.delete(dirPath);
        reject(new Error(msg.error));
      }
    });

    worker.on('error', (error) => {
      activeWorkers.delete(dirPath);
      reject(error);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        activeWorkers.delete(dirPath);
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}


// Background prefetcher for caching nearby directories
async function startBackgroundPrefetch(startDir) {
  // Cancel previous prefetcher if running
  if (currentPrefetcher) {
    currentPrefetcher.cancelled = true;
  }

  const prefetcher = { cancelled: false };
  currentPrefetcher = prefetcher;

  console.log(`Starting background prefetch from: ${startDir}`);

  const ignoredDirs = ['.git', 'node_modules'];
  const queue = [];
  let processed = 0;

  // Start by adding children of startDir (not startDir itself, as it's being computed by get-ownership-stats)
  try {
    const entries = fs.readdirSync(startDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !ignoredDirs.includes(entry.name)) {
        const fullPath = path.join(startDir, entry.name);
        if (!isIgnored(fullPath, projectRoot, gitignorePatterns)) {
          queue.push(fullPath);
        }
      }
    }
  } catch (err) {
    console.error(`Prefetch error reading start dir: ${err.message}`);
    return;
  }

  // BFS to find directories to prefetch
  while (queue.length > 0 && !prefetcher.cancelled) {
    const currentDir = queue.shift();

    // Skip if already cached or already being computed
    if (statsCache.has(currentDir) || activeComputations.has(currentDir) || activeWorkers.has(currentDir)) {
      // Still add children to queue for exploration
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !ignoredDirs.includes(entry.name)) {
            const fullPath = path.join(currentDir, entry.name);
            if (!isIgnored(fullPath, projectRoot, gitignorePatterns)) {
              queue.push(fullPath);
            }
          }
        }
      } catch (err) {
        // Skip if can't read
      }
      continue;
    }

    try {
      // Mark as computing
      activeComputations.set(currentDir, true);

      // Compute stats using worker thread (runs on separate OS thread - no blocking!)
      await computeOwnershipStatsAsync(currentDir, null);
      activeComputations.delete(currentDir);
      processed++;

      // Check for cancellation after each directory
      if (prefetcher.cancelled) {
        break;
      }

      // Add direct children to BFS queue
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !ignoredDirs.includes(entry.name)) {
          const fullPath = path.join(currentDir, entry.name);
          if (!isIgnored(fullPath, projectRoot, gitignorePatterns)) {
            queue.push(fullPath);
          }
        }
      }

    } catch (error) {
      console.error(`Prefetch error for ${currentDir}:`, error.message);
      activeComputations.delete(currentDir);
    }
  }

  if (!prefetcher.cancelled) {
    console.log(`Background prefetch completed. Processed ${processed} directories.`);
  } else {
    console.log(`Background prefetch cancelled after ${processed} directories.`);
  }
}

function getOwner(filePath, isDirectory, codeowners, baseDir) {
    if (!codeowners) { // Handle case where CODEOWNERS file was not found
        return '';
    }

    // Create cache key
    const cacheKey = filePath + (isDirectory ? '/' : '');

    // Check cache first
    if (ownerCache.has(cacheKey)) {
        return ownerCache.get(cacheKey);
    }

    let relativePath = path.relative(baseDir, filePath);
    if (isDirectory) {
        relativePath += '/';
    }

    let bestOwners = null;
    let bestPriority = -1;

    // Check trie for simple patterns
    if (codeownersTrie) {
        const segments = relativePath.split('/').filter(s => s !== '');
        const trieResult = searchTrie(codeownersTrie, segments);
        if (trieResult.owners && trieResult.priority > bestPriority) {
            bestOwners = trieResult.owners;
            bestPriority = trieResult.priority;
        }
    }

    // Check complex patterns - must check ALL to find highest priority match
    if (complexPatterns.length > 0) {
        for (const rule of complexPatterns) {
            if (rule.pattern === '*' || minimatch(relativePath, rule.pattern, { dot: true })) {
                if (rule.priority > bestPriority) {
                    bestOwners = rule.owners;
                    bestPriority = rule.priority;
                }
            }
        }
    }

    const result = bestOwners ? bestOwners.join(' ') : '';

    // Store in cache
    ownerCache.set(cacheKey, result);

    return result;
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Select Repository...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: 'Select Repository'
            });

            if (!result.canceled && result.filePaths.length > 0) {
              const selectedPath = result.filePaths[0];

              // Update the global variables
              initialDirectory = selectedPath;
              currentDirectory = selectedPath;
              projectRoot = selectedPath;
              needsDirectorySelection = false;

              // Reload CODEOWNERS and gitignore for the new directory
              codeowners = findAndParseCodeowners(projectRoot);
              codeownersFound = codeowners !== null;
              gitignorePatterns = findAndParseGitignore(projectRoot);

              // Notify renderer to reload
              if (mainWindow) {
                mainWindow.webContents.send('directory-changed');
              }
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  mainWindow.loadFile('index.html');
  // DevTools can be opened manually with View > Toggle Developer Tools if needed
}

app.whenReady().then(() => {
  // Create the application menu
  createMenu();

  // Only initialize if we have a valid project root
  if (projectRoot) {
    codeowners = findAndParseCodeowners(projectRoot);
    if (codeowners !== null) {
        codeownersFound = true;
    }
    gitignorePatterns = findAndParseGitignore(projectRoot);
  }
  
  ipcMain.handle('get-initial-directory', () => {
    return initialDirectory;
  });

  ipcMain.handle('get-debug-info', () => {
    return {
      argv: process.argv,
      isPackaged: app.isPackaged,
      initialDirectory,
      projectRoot,
      cwd: process.cwd()
    };
  });

  ipcMain.handle('get-rule-info', (event, filePath, isDirectory) => {
    if (!codeowners || !projectRoot) {
      return null;
    }

    let relativePath = path.relative(projectRoot, filePath);
    if (isDirectory) {
      relativePath += '/';
    }

    // Find the codeowners file path once, so we can return it
    const possiblePaths = [
      path.join(projectRoot, 'CODEOWNERS'),
      path.join(projectRoot, '.github', 'CODEOWNERS'),
      path.join(projectRoot, 'docs', 'CODEOWNERS'),
    ];
    const codeownersPath = possiblePaths.find(p => fs.existsSync(p));


    // Find which rule matches this file
    // Remember codeowners array is reversed, so first match wins
    for (const rule of codeowners) {
      let matches = (rule.pattern === '*') || minimatch(relativePath, rule.pattern, { dot: true });

      // If pattern is a directory (no wildcards, no trailing **), also check if file is inside it
      if (!matches && !rule.pattern.includes('*') && !rule.pattern.includes('?')) {
        matches = relativePath.startsWith(rule.pattern + '/');
      }

      if (matches) {
        // We found the rule, and it already has the line number!
        return {
          ...rule, // contains pattern, owners, lineNumber, lineContent
          filePath: codeownersPath,
          relativePath: codeownersPath ? path.relative(projectRoot, codeownersPath) : null
        };
      }
    }

    // No matching rule found
    return null;
  });

  ipcMain.handle('get-codeowners-content', () => {
    if (!projectRoot) {
      return { success: false, error: 'No project root set' };
    }

    const possiblePaths = [
      path.join(projectRoot, 'CODEOWNERS'),
      path.join(projectRoot, '.github', 'CODEOWNERS'),
      path.join(projectRoot, 'docs', 'CODEOWNERS'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8');
          return { success: true, content, filePath: p };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
    }

    return { success: false, error: 'CODEOWNERS file not found' };
  });

  ipcMain.handle('save-codeowners-content', (event, newContent) => {
    if (!projectRoot) {
      return { success: false, error: 'No project root set' };
    }

    const possiblePaths = [
      path.join(projectRoot, 'CODEOWNERS'),
      path.join(projectRoot, '.github', 'CODEOWNERS'),
      path.join(projectRoot, 'docs', 'CODEOWNERS'),
    ];

    let codeownersPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        codeownersPath = p;
        break;
      }
    }

    if (!codeownersPath) {
      return { success: false, error: 'CODEOWNERS file not found' };
    }

    try {
      fs.writeFileSync(codeownersPath, newContent, 'utf-8');

      // Reload codeowners
      codeowners = findAndParseCodeowners(projectRoot);
      codeownersFound = codeowners !== null;

      // Notify renderer to reload
      if (mainWindow) {
        mainWindow.webContents.send('directory-changed');
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('open-file-in-editor', async (event, filePath, lineNumber) => {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    // Try common editors with line number support
    const editors = [
      { cmd: 'code', args: (f, l) => `code -g "${f}:${l}"` }, // VS Code
      { cmd: 'code-insiders', args: (f, l) => `code-insiders -g "${f}:${l}"` },
      { cmd: 'subl', args: (f, l) => `subl "${f}:${l}"` }, // Sublime Text
      { cmd: 'atom', args: (f, l) => `atom "${f}:${l}"` }, // Atom
      { cmd: 'nova', args: (f, l) => `nova "${f}:${l}"` }, // Nova
    ];

    // Try each editor
    for (const editor of editors) {
      try {
        await execPromise(`which ${editor.cmd}`);
        // Editor found, open the file
        const cmd = editor.args(filePath, lineNumber);
        await execPromise(cmd);
        return { success: true, editor: editor.cmd };
      } catch (err) {
        // Editor not found, try next
        continue;
      }
    }

    // No supported editor found, just open the file with default app
    try {
      await shell.openPath(filePath);
      return { success: true, editor: 'default' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  
  ipcMain.handle('get-directory', () => {
    return currentDirectory;
  });

  ipcMain.handle('get-parent-directory', (event, p) => {
    return path.dirname(p);
  });

  ipcMain.handle('join-path', (event, ...parts) => {
    return path.join(...parts);
  });

  ipcMain.handle('needs-directory-selection', () => {
    return needsDirectorySelection;
  });

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Repository'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];

      // Update the global variables
      initialDirectory = selectedPath;
      currentDirectory = selectedPath;
      projectRoot = selectedPath;
      needsDirectorySelection = false;

      // Reload CODEOWNERS and gitignore for the new directory
      codeowners = findAndParseCodeowners(projectRoot);
      codeownersFound = codeowners !== null;
      gitignorePatterns = findAndParseGitignore(projectRoot);

      return { success: true, directory: selectedPath };
    }

    return { success: false };
  });
  
  ipcMain.handle('was-codeowners-found', () => {
    return codeownersFound;
  });

  ipcMain.handle('get-all-owners', () => {
    if (!codeowners) {
      return [];
    }
    const ownersSet = new Set();
    codeowners.forEach(rule => {
      rule.owners.forEach(owner => ownersSet.add(owner));
    });
    return Array.from(ownersSet).sort();
  });

  ipcMain.handle('assign-owner', async (event, filePath, owner, isDirectory) => {
    // Find the CODEOWNERS file
    const possiblePaths = [
      path.join(projectRoot, 'CODEOWNERS'),
      path.join(projectRoot, '.github', 'CODEOWNERS'),
      path.join(projectRoot, 'docs', 'CODEOWNERS'),
    ];

    let codeownersPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        codeownersPath = p;
        break;
      }
    }

    if (!codeownersPath) {
      throw new Error('CODEOWNERS file not found');
    }

    // Calculate the pattern to add
    let relativePath = path.relative(projectRoot, filePath);
    // For directories, add trailing slash for recursive ownership
    if (isDirectory && !relativePath.endsWith('/')) {
      relativePath += '/';
    }

    // Read the current CODEOWNERS file
    let content = fs.readFileSync(codeownersPath, 'utf-8');
    const lines = content.split('\n');

    // Remove any existing rule for this exact path
    const filteredLines = lines.filter((line, i) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return true;

      const [existingPattern] = trimmed.split(/\s+/);
      let normalizedPattern = existingPattern;
      if (normalizedPattern.startsWith('/')) {
        normalizedPattern = normalizedPattern.substring(1);
      }

      // Keep the line if it doesn't match our path
      return normalizedPattern !== relativePath;
    });

    // Add new rule at the end
    const newRule = `${relativePath} ${owner}`;
    if (content.endsWith('\n') || filteredLines[filteredLines.length - 1] === '') {
      filteredLines.push(newRule);
    } else {
      filteredLines.push('');
      filteredLines.push(newRule);
    }

    // Write back to file
    fs.writeFileSync(codeownersPath, filteredLines.join('\n'), 'utf-8');

    // Reload codeowners (this also clears caches)
    codeowners = findAndParseCodeowners(projectRoot);

    return { success: true };
  });

  ipcMain.handle('remove-owner', async (event, filePath, isDirectory) => {
    // Find the CODEOWNERS file
    const possiblePaths = [
      path.join(projectRoot, 'CODEOWNERS'),
      path.join(projectRoot, '.github', 'CODEOWNERS'),
      path.join(projectRoot, 'docs', 'CODEOWNERS'),
    ];

    let codeownersPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        codeownersPath = p;
        break;
      }
    }

    if (!codeownersPath) {
      throw new Error('CODEOWNERS file not found');
    }

    // Calculate the pattern to remove
    let relativePath = path.relative(projectRoot, filePath);
    // For directories, add trailing slash for recursive ownership
    if (isDirectory && !relativePath.endsWith('/')) {
      relativePath += '/';
    }

    // Read the current CODEOWNERS file
    let content = fs.readFileSync(codeownersPath, 'utf-8');
    const lines = content.split('\n');

    // Find and remove the matching rule
    const newLines = lines.filter((line, i) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return true;

      const [existingPattern] = trimmed.split(/\s+/);
      let normalizedPattern = existingPattern;
      if (normalizedPattern.startsWith('/')) {
        normalizedPattern = normalizedPattern.substring(1);
      }

      // Keep the line if it doesn't match
      return normalizedPattern !== relativePath;
    });

    // Write back to file
    fs.writeFileSync(codeownersPath, newLines.join('\n'), 'utf-8');

    // Reload codeowners
    codeowners = findAndParseCodeowners(projectRoot);

    return { success: true };
  });
  
  ipcMain.handle('get-ownership-stats', async (event, dirPath) => {
    if (!codeownersFound) {
        return [];
    }

    // Check cache first
    if (statsCache.has(dirPath)) {
        console.log(`Stats cache hit for: ${dirPath}`);
        return statsCache.get(dirPath);
    }

    // Check if already computing
    if (activeComputations.has(dirPath) || activeWorkers.has(dirPath)) {
        console.log(`Computation already in progress for: ${dirPath}`);
        return []; // Will receive updates via progress events
    }

    console.log(`Stats cache miss, starting worker thread for: ${dirPath}`);

    // Mark as computing
    activeComputations.set(dirPath, true);

    // Start computation in background using Worker Thread (don't await it)
    computeOwnershipStatsAsync(dirPath, (partialStats) => {
      // Send incremental update to renderer
      if (mainWindow) {
        mainWindow.webContents.send('stats-progress', dirPath, partialStats);
      }
    }).then(result => {
      // Send final update when complete
      if (mainWindow) {
        mainWindow.webContents.send('stats-progress', dirPath, result);
      }
      activeComputations.delete(dirPath);
      console.log(`Computation completed for: ${dirPath}`);
    }).catch(err => {
      console.error('Error computing stats:', err);
      activeComputations.delete(dirPath);
    });

    // Return empty array immediately - renderer will update via progress events
    return [];
  });

  ipcMain.on('navigate-to', (event, newPath) => {
    currentDirectory = newPath;
    if (mainWindow) {
        mainWindow.webContents.send('directory-changed');
    }

    // Start background prefetch from new directory
    if (codeownersFound) {
      startBackgroundPrefetch(newPath).catch(err => {
        console.error('Background prefetch error:', err);
      });
    }
  });

  ipcMain.handle('get-files', (event, dirPath) => {
    try {
      const files = fs.readdirSync(dirPath);
      return files.map(file => {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        const isDirectory = stats.isDirectory();
        return {
          name: file,
          isDirectory: isDirectory,
          owner: getOwner(filePath, isDirectory, codeowners, projectRoot),
        };
      });
    } catch (error) {
      console.error('Error reading directory:', error);
      return [];
    }
  });

  createWindow();

  // Start background prefetch from initial directory
  if (codeownersFound && currentDirectory) {
    startBackgroundPrefetch(currentDirectory).catch(err => {
      console.error('Initial background prefetch error:', err);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});



app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
