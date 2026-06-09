const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { compileRules, ownersFor } = require('./codeowners');
const { compileIgnore, isIgnored } = require('./gitignore');

// Worker receives: dirPath, codeowners (raw rules), projectRoot, gitignorePatterns
const { dirPath, codeowners, projectRoot, gitignorePatterns, rubyOnly } = workerData;

// Compile the gitignore patterns once for the whole walk (instead of
// recompiling every glob on every entry).
const compiledIgnore = compileIgnore(gitignorePatterns);

// Whether a filename is a Ruby source file (for the "Ruby files only" filter).
function isRubyFile(name) {
  return /\.(rb|rake|gemspec|ru)$/i.test(name) ||
    ['Rakefile', 'Gemfile', 'Guardfile', 'Capfile'].includes(name);
}

function computeStats() {
  const { initialCache } = workerData;
  const ignoredDirs = ['.git', 'node_modules'];
  const allDirCounts = new Map();
  let itemsProcessed = 0;
  let lastProgressTime = Date.now();
  const progressCounts = {};
  let updateCounter = 0;

  // Compile the CODEOWNERS rules once, using the shared matcher so the stats
  // can never disagree with the file list or the editor highlight.
  const compiled = compileRules(codeowners || []);

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

      if (isIgnored(fullPath, projectRoot, compiledIgnore)) {
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
        if (rubyOnly && !isRubyFile(entry.name)) continue; // skip non-Ruby files when filtered
        let owners = ownersFor(path.relative(projectRoot, fullPath), compiled);
        if (!owners || owners.length === 0) {
          owners = ['<unset>'];
        }

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
