// Shared CODEOWNERS parsing + matching.
//
// This module is the single source of truth for how a file path maps to its
// owner(s). It is used by both the main process (main.js) and the stats worker
// (stats-worker.js) so that the file list, the ownership chart, and the
// "highlight the matching rule" feature can never disagree.
//
// Matching follows GitHub's CODEOWNERS rules, which in turn follow most of the
// gitignore pattern rules:
//   - The LAST matching pattern in the file wins.
//   - A pattern with no slash (e.g. `README.md`, `*.js`, `build`) matches at
//     ANY depth.
//   - A pattern with a leading or internal slash (e.g. `/build`, `src/foo`) is
//     anchored to the repository root.
//   - A trailing-slash-only pattern (e.g. `build/`) matches a directory of that
//     name at any depth, plus everything under it.
//   - `*` and `**` are catch-alls that match everything.

const path = require('path');
const { Minimatch } = require('minimatch');

const MM_OPTS = { dot: true, nocomment: true, nonegate: true };

// Parse CODEOWNERS file content into rules, in file order.
// Each rule: { pattern, owners, lineNumber, lineContent }
function parseCodeowners(content) {
  const lines = content.split('\n');
  const rules = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }
    // Split on unescaped whitespace so that "\ " (escaped space) stays part of
    // the pattern.
    let [pattern, ...owners] = trimmedLine.split(/(?<!\\)\s+/);
    if (!pattern) {
      continue;
    }
    pattern = pattern.replace(/\\ /g, ' '); // unescape spaces
    owners = owners.map(o => o.toLowerCase());
    rules.push({ pattern, owners, lineNumber: i + 1, lineContent: trimmedLine });
  }
  return rules;
}

// Convert a single CODEOWNERS pattern into one or more minimatch glob strings.
// We test against repo-relative paths (forward slashes, no leading/trailing
// slash), so the returned globs are written to match that form.
function patternToGlobs(pattern) {
  // Catch-alls.
  if (pattern === '*' || pattern === '**') {
    return ['**'];
  }

  let p = pattern;
  const hadLeadingSlash = p.startsWith('/');
  if (hadLeadingSlash) {
    p = p.slice(1);
  }
  const dirOnly = p.endsWith('/');
  if (dirOnly) {
    p = p.slice(0, -1);
  }

  // Anchored to the repo root if there was a leading slash, or a slash anywhere
  // other than the (now-stripped) trailing one. Otherwise it floats and can
  // match at any depth.
  const anchored = hadLeadingSlash || p.includes('/');
  const base = anchored ? p : `**/${p}`;

  // Decide whether the rule should also own everything *underneath* a matched
  // entry (directory semantics). That holds for an explicit trailing slash, or
  // when the final segment names a concrete directory (no wildcard). Patterns
  // whose final segment is a wildcard (e.g. `docs/*`, `*.js`) match entries at
  // that single level only and must NOT spill into grandchildren.
  const lastSegment = p.slice(p.lastIndexOf('/') + 1);
  const lastIsWildcard = /[*?[\]]/.test(lastSegment);
  const ownsContents = dirOnly || !lastIsWildcard;

  return ownsContents ? [base, `${base}/**`] : [base];
}

// Literal (wildcard-free) path segments of a pattern. A path can only match a
// rule if every one of these literal segments appears in it, so they drive the
// candidate-pruning index below.
const WILD = /[*?[\]]/;
function literalSegments(pattern) {
  let p = pattern;
  if (p === '*' || p === '**') return [];
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p.split('/').filter(s => s && s !== '**' && !WILD.test(s));
}

// Compile parsed rules into a matcher: the precompiled rules plus a
// candidate-pruning index. Priority == file index, so a higher priority means
// later in the file, which means it wins.
//
// Testing every file against every rule is O(files x rules) and dominates
// indexing time on large repos (~675 rules x ~42k files measured at ~95% of the
// time). The index files each rule under its rarest literal segment; a path
// then only tests rules that share one of its segments, plus the few rules that
// have no literal segment at all. This is sound — a literal segment of a
// matching rule must appear in the matched path — so no possible match is
// skipped, and the exact Minimatch check still runs on every survivor.
function compileRules(rules) {
  const compiled = rules.map((rule, index) => ({
    pattern: rule.pattern,
    owners: rule.owners,
    lineNumber: rule.lineNumber,
    lineContent: rule.lineContent,
    priority: index,
    matchers: patternToGlobs(rule.pattern).map(g => new Minimatch(g, MM_OPTS)),
  }));

  // Count literal-segment frequency so each rule can be filed under its most
  // selective (rarest) segment, minimising false candidates.
  const freq = new Map();
  const ruleLiterals = compiled.map((rule) => {
    const segs = literalSegments(rule.pattern);
    for (const s of segs) freq.set(s, (freq.get(s) || 0) + 1);
    return segs;
  });

  const bySegment = new Map(); // literal segment -> rules filed under it
  const always = [];           // rules with no literal segment (test every path)
  compiled.forEach((rule, i) => {
    const segs = ruleLiterals[i];
    if (segs.length === 0) {
      always.push(rule);
      return;
    }
    let key = segs[0];
    for (const s of segs) {
      if (freq.get(s) < freq.get(key)) key = s;
    }
    let bucket = bySegment.get(key);
    if (!bucket) {
      bucket = [];
      bySegment.set(key, bucket);
    }
    bucket.push(rule);
  });

  return { rules: compiled, bySegment, always };
}

// Normalize a repo-relative path to the form the matchers expect:
// forward slashes, no leading/trailing slashes.
function normalizePath(relativePath) {
  return relativePath
    .split(path.sep).join('/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

// Return the winning compiled rule for a repo-relative path (last match in the
// file wins), or null if nothing matches. Uses the matcher index to test only
// candidate rules rather than all of them.
function ruleFor(relativePath, matcher) {
  if (!matcher || !matcher.rules) {
    return null;
  }
  const relPath = normalizePath(relativePath);
  const { bySegment, always } = matcher;
  let best = null;
  const seen = new Set();

  const consider = (rule) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    // A rule that can't outrank the current best can't change the result, so
    // skip its (relatively expensive) glob test entirely.
    if (best && rule.priority <= best.priority) return;
    if (rule.matchers.some(mm => mm.match(relPath))) {
      best = rule;
    }
  };

  for (const rule of always) consider(rule);
  if (relPath) {
    for (const segment of relPath.split('/')) {
      const bucket = bySegment.get(segment);
      if (bucket) {
        for (const rule of bucket) consider(rule);
      }
    }
  }
  return best;
}

// Return the owners array for a repo-relative path, or null if unowned.
function ownersFor(relativePath, compiledRules) {
  const rule = ruleFor(relativePath, compiledRules);
  return rule ? rule.owners : null;
}

// Escape a pattern for safe writing back to the CODEOWNERS file (spaces only,
// to mirror the parser's "\ " unescaping).
function escapePattern(pattern) {
  return pattern.replace(/ /g, '\\ ');
}

// Extract the normalized pattern from a raw CODEOWNERS line, mirroring the
// parser, for comparing against a target path (used by assign/remove dedup).
function linePattern(line) {
  const trimmed = line.trim();
  let [p] = trimmed.split(/(?<!\\)\s+/);
  if (!p) {
    return '';
  }
  p = p.replace(/\\ /g, ' ');
  if (p.startsWith('/')) {
    p = p.slice(1);
  }
  return p;
}

module.exports = {
  parseCodeowners,
  patternToGlobs,
  compileRules,
  ruleFor,
  ownersFor,
  normalizePath,
  escapePattern,
  linePattern,
};
