const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

// --- Worker State ---
let workerId;
let localDeque = []; // Double-ended queue for tasks: [{path, taskId}, ...]
let sharedStateView; // Int32Array view on the SharedArrayBuffer
let numWorkers;
let isShuttingDown = false;
let currentTaskId = null; // Track the current task ID for partial results

// --- Codeowners Data ---
let codeownersTrie;
let complexPatterns;
let projectRoot;
let gitignorePatterns;

// --- Trie Deserialization ---
class TrieNode {
  constructor(data) {
    this.children = new Map();
    this.owners = data.owners || null;
    this.pattern = data.pattern || null;
    this.priority = data.priority !== undefined ? data.priority : -1;

    if (data.children) {
      for (const [key, childData] of Object.entries(data.children)) {
        this.children.set(key, new TrieNode(childData));
      }
    }
  }
}

function searchTrie(root, pathSegments) {
  let node = root;
  let bestMatch = null;
  let bestPriority = -1;

  for (const segment of pathSegments) {
    if (!node.children.has(segment)) break;
    node = node.children.get(segment);
    if (node.owners && node.priority > bestPriority) {
      bestMatch = node.owners;
      bestPriority = node.priority;
    }
  }
  return { owners: bestMatch, priority: bestPriority };
}

// --- Main Message Handler ---
parentPort.on('message', (message) => {
  switch (message.type) {
    case 'init':
      initialize(message);
      break;
    case 'update-patterns':
      // Update patterns when CODEOWNERS changes
      console.log(`[Worker ${workerId}] Updating patterns`);
      if (message.projectRoot) {
        projectRoot = message.projectRoot;
      }
      if (message.codeownersTrie) {
        codeownersTrie = new TrieNode(message.codeownersTrie);
      }
      complexPatterns = message.complexPatterns || [];
      gitignorePatterns = message.gitignorePatterns || [];
      break;
    case 'shutdown':
      isShuttingDown = true;
      break;
    case 'new-task':
      console.log(`[Worker ${workerId}] Received new root task: ${message.path} (taskId: ${message.taskId})`);
      currentTaskId = message.taskId; // Update current task ID
      localDeque.push({ path: message.path, taskId: message.taskId });
      // Kick off the work loop if not already running
      if (Atomics.load(sharedStateView, workerId) === 0) {
        workLoop();
      }
      break;
    case 'steal-request':
      handleStealRequest(message.thiefId);
      break;
    case 'stolen-task':
      if (message.task) {
        console.log(`[Worker ${workerId}] Successfully stole task: ${message.task.path} (taskId: ${message.task.taskId})`);
        localDeque.push(message.task);
      }
      // Continue workloop whether steal was successful or not
      workLoop();
      break;
  }
});

// --- Initialization ---
function initialize(data) {
  workerId = data.workerId;
  // Create a typed array view over the shared buffer
  sharedStateView = new Int32Array(data.sharedState);
  numWorkers = data.numWorkers;
  projectRoot = data.projectRoot;
  gitignorePatterns = data.gitignorePatterns;
  complexPatterns = data.complexPatterns;
  codeownersTrie = new TrieNode(data.codeownersTrie);
  console.log(`[Worker ${workerId}] Initialized.`);
}

// --- Main Work Loop ---
async function workLoop() {
  if (isShuttingDown) return;

  // Set state to busy
  Atomics.store(sharedStateView, workerId, 1);

  while (localDeque.length > 0) {
    const task = localDeque.shift(); // Act like a queue (FIFO)
    if (task && task.path) {
      await processDirectory(task.path, task.taskId);
    }
  }

  // My deque is empty, I'm now idle and will try to steal
  Atomics.store(sharedStateView, workerId, 0);
  console.log(`[Worker ${workerId}] Idle, attempting to steal.`);
  stealWork();
}

// --- Directory Processing ---
// Check if a path is gitignored (checks the path itself and all parent segments)
function isIgnored(filePath) {
  if (gitignorePatterns.length === 0) return false;
  const relativePath = path.relative(projectRoot, filePath);
  const segments = relativePath.split(path.sep);

  // Check each path segment and cumulative path against patterns
  let currentPath = '';
  for (const segment of segments) {
    currentPath = currentPath ? path.join(currentPath, segment) : segment;

    let ignored = false;
    for (const { pattern, negate } of gitignorePatterns) {
      // Check if segment matches (e.g., ".venv" matches pattern ".venv")
      // or if the cumulative path matches
      const segmentMatches = minimatch(segment, pattern, { dot: true });
      const pathMatches = minimatch(currentPath, pattern, { dot: true }) ||
                          minimatch(currentPath + '/', pattern, { dot: true });

      if (segmentMatches || pathMatches) {
        ignored = !negate;
      }
    }
    if (ignored) return true;
  }
  return false;
}

function getOwner(filePath, isDirectory) {
    let relativePath = path.relative(projectRoot, filePath);
    if (isDirectory) relativePath += '/';

    let bestOwners = null;
    let bestPriority = -1;

    const segments = relativePath.split('/').filter(s => s !== '');
    const trieResult = searchTrie(codeownersTrie, segments);
    if (trieResult.owners && trieResult.priority > bestPriority) {
        bestOwners = trieResult.owners;
        bestPriority = trieResult.priority;
    }

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
    return bestOwners || [];
}

function processDirectory(dirPath, taskId) {
  console.log(`[Worker ${workerId}]--- Processing directory: ${dirPath} (taskId: ${taskId}) ---`);
  const ownerCounts = {};
  let fileCount = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (isIgnored(fullPath)) continue;

      // Only count FILES - main process handles directory dispatch
      if (entry.isFile()) {
          const owners = getOwner(fullPath, false);
          fileCount++;
          if (owners.length > 0) {
            owners.forEach(owner => {
              ownerCounts[owner] = (ownerCounts[owner] || 0) + 1;
            });
          } else {
            ownerCounts['<unset>'] = (ownerCounts['<unset>'] || 0) + 1;
          }
      }
    }
  } catch (err) {
    console.log(`[Worker ${workerId}] Error processing ${dirPath}: ${err.message}`);
    return;
  }

  console.log(`[Worker ${workerId}] Finished ${dirPath}. Found ${fileCount} files.`);

  // Post partial result back to the main thread (only if we found files)
  if (fileCount > 0) {
    const result = {
      type: 'partial-result',
      dir: dirPath,
      stats: ownerCounts,
      taskId,
    };
    parentPort.postMessage(result);
  }
}

// --- Work Stealing Logic ---
function stealWork() {
  if (isShuttingDown) return;

  // With only 1 worker, there's no one to steal from - just wait for new tasks
  if (numWorkers <= 1) {
    setTimeout(stealWork, 100);
    return;
  }

  const victimId = getVictimId();

  // If all others are idle, we might be done. The main thread confirms this.
  // We just wait for more work or shutdown.
  if (Atomics.load(sharedStateView, victimId) === 0) {
    setTimeout(stealWork, 100); // Poll again shortly
    return;
  }

  console.log(`[Worker ${workerId}] Attempting to steal from Worker ${victimId}`);
  parentPort.postMessage({ type: 'steal-request', victimId, thiefId: workerId });
}

function getVictimId() {
    let victimId = -1;
    do {
        victimId = Math.floor(Math.random() * numWorkers);
    } while (victimId === workerId && numWorkers > 1);
    return victimId;
}

function handleStealRequest(thiefId) {
  // A thief is requesting work from me.
  // I will give them a task from the BOTTOM of my deque.
  if (localDeque.length > 1) { // Only steal if there's spare work
    const stolenTask = localDeque.pop(); // Steal from the opposite end
    console.log(`[Worker ${workerId}] Giving task '${stolenTask}' to Worker ${thiefId}`);
    parentPort.postMessage({ type: 'stolen-task', task: stolenTask, thiefId });
  } else {
    // Not enough work to share
    parentPort.postMessage({ type: 'stolen-task', task: null, thiefId });
  }
}
