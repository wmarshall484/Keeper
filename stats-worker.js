const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

// Worker receives: dirPath, codeowners, projectRoot, gitignorePatterns
const { dirPath, codeowners, projectRoot, gitignorePatterns, codeownersTrie, complexPatterns } = workerData;

// Recreate TrieNode class in worker
class TrieNode {
  constructor() {
    this.children = new Map();
    this.owners = null;
    this.pattern = null;
    this.priority = -1;
  }
}

// Deserialize trie from plain objects
function deserializeTrie(obj) {
  const node = new TrieNode();
  node.owners = obj.owners;
  node.pattern = obj.pattern;
  node.priority = obj.priority;

  if (obj.children) {
    for (const [key, childObj] of Object.entries(obj.children)) {
      node.children.set(key, deserializeTrie(childObj));
    }
  }

  return node;
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

function isIgnored(filePath, baseDir, patterns) {
  if (patterns.length === 0) {
    return false;
  }

  let relativePath = path.relative(baseDir, filePath);

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

function getOwner(filePath, isDirectory, codeowners, baseDir, trie, complexPatternsArr) {
  if (!codeowners) {
    return '';
  }

  let relativePath = path.relative(baseDir, filePath);
  if (isDirectory) {
    relativePath += '/';
  }

  let bestOwners = null;
  let bestPriority = -1;

  // Check trie for simple patterns
  if (trie) {
    const segments = relativePath.split('/').filter(s => s !== '');
    const trieResult = searchTrie(trie, segments);
    if (trieResult.owners && trieResult.priority > bestPriority) {
      bestOwners = trieResult.owners;
      bestPriority = trieResult.priority;
    }
  }

  // Check complex patterns
  if (complexPatternsArr && complexPatternsArr.length > 0) {
    for (const rule of complexPatternsArr) {
      if (rule.pattern === '*' || minimatch(relativePath, rule.pattern, { dot: true })) {
        if (rule.priority > bestPriority) {
          bestOwners = rule.owners;
          bestPriority = rule.priority;
        }
      }
    }
  }

  return bestOwners ? bestOwners.join(' ') : '';
}

function computeStats() {
  const { initialCache } = workerData;
  const ignoredDirs = ['.git', 'node_modules'];
  const allDirCounts = new Map();
  let itemsProcessed = 0;
  let lastProgressTime = Date.now();
  const progressCounts = {};
  let updateCounter = 0;

  // Deserialize trie
  const trie = codeownersTrie ? deserializeTrie(codeownersTrie) : null;

  function walk(currentDirPath) {
    // If the directory is already in the initial cache, use it and skip computation.
    if (initialCache && initialCache[currentDirPath]) {
      const cachedStatsArray = initialCache[currentDirPath];
      const counts = {};
      for (const item of cachedStatsArray) {
        counts[item.owner] = item.count;
      }
      allDirCounts.set(currentDirPath, counts);

      // ** NEW: Add the cached counts to the progressCounts to reflect this completed work.
      if (currentDirPath.startsWith(dirPath)) { // Check if it's under the top-level dir
        for (const [owner, count] of Object.entries(counts)) {
            progressCounts[owner] = (progressCounts[owner] || 0) + count;
        }
      }
      return; // Skip walking this directory
    }

    if (!allDirCounts.has(currentDirPath)) {
      allDirCounts.set(currentDirPath, {});
    }
    const currentCounts = allDirCounts.get(currentDirPath);

    const entries = fs.readdirSync(currentDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredDirs.includes(entry.name)) continue;

      const fullPath = path.join(currentDirPath, entry.name);

      if (isIgnored(fullPath, projectRoot, gitignorePatterns)) {
        continue;
      }

      itemsProcessed++;

      const isDirectory = entry.isDirectory();

      if (isDirectory) {
        // For directories, we only recurse and aggregate the results.
        walk(fullPath);
        const childCounts = allDirCounts.get(fullPath);
        if (childCounts) {
          // Send this completed subdirectory's stats back as a partial result
          parentPort.postMessage({ type: 'partial-result', data: { dir: fullPath, stats: childCounts } });

          for (const [childOwner, childCount] of Object.entries(childCounts)) {
            currentCounts[childOwner] = (currentCounts[childOwner] || 0) + childCount;
          }
        }
      } else {
        // For files, we find the owner(s) and increment the count for each one individually.
        const ownerString = getOwner(fullPath, isDirectory, codeowners, projectRoot, trie, complexPatterns);
        const owners = ownerString ? ownerString.split(' ') : ['<unset>'];

        for (const owner of owners) {
          if (owner) { // Ensure owner is not an empty string from splitting
            currentCounts[owner] = (currentCounts[owner] || 0) + 1;
            // Only update top-level progress with file counts from the current directory tree
            if (currentDirPath.startsWith(dirPath)) {
              progressCounts[owner] = (progressCounts[owner] || 0) + 1;
            }
          }
        }
      }

      // Send progress update every 200 items, but no more than every 250ms
      if (itemsProcessed % 200 === 0) {
        const now = Date.now();
        if ((now - lastProgressTime) >= 250) {
          lastProgressTime = now;
          const total = Object.values(progressCounts).reduce((sum, count) => sum + count, 0);
          if (total > 0) {
            const percentages = Object.entries(progressCounts).map(([owner, count]) => ({
              owner,
              percentage: (count / total) * 100,
              count
            }));
            parentPort.postMessage({ type: 'progress', data: percentages });
          }
        }
      }
    }
  }

  walk(dirPath);

  // Convert allDirCounts to serializable format for the final 'complete' message
  const allDirCountsObj = {};
  for (const [dir, counts] of allDirCounts.entries()) {
    allDirCountsObj[dir] = counts;
  }

  parentPort.postMessage({ type: 'complete', data: allDirCountsObj });
}

// Start computation
try {
  computeStats();
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
}
