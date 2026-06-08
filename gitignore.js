// Precompiled .gitignore matching.
//
// The naive approach calls minimatch(str, pattern) per pattern per entry, which
// recompiles the glob into a regex on every single call. Walking a large repo
// (tens of thousands of entries x dozens of patterns) turns into millions of
// regex compilations and dominates indexing time.
//
// Two optimizations, both preserving the original semantics exactly:
//   1. Compile each pattern into a reusable Minimatch once.
//   2. Build one combined regex of the *positive* patterns as a pre-filter.
//      Most paths match no pattern at all, and a path can only be *ignored* by a
//      positive pattern (negations only re-include), so if the combined regex
//      matches nothing the path is definitely not ignored and we skip the whole
//      per-pattern loop. Only paths that hit the pre-filter run the exact
//      ordered loop (which handles negation and last-match-wins).

const path = require('path');
const { Minimatch } = require('minimatch');

// Compile parsed gitignore patterns ({ pattern, negate }) into a reusable
// matcher. Call once per pattern set, then reuse for every path.
function compileIgnore(patterns) {
  const list = patterns || [];
  const rules = list.map(({ pattern, negate }) => ({
    mm: new Minimatch(pattern, { dot: true }),
    negate,
  }));

  // Combined regex of positive patterns, used only as a fast pre-filter. If any
  // positive pattern can't be turned into a regex, leave it null so we always
  // fall back to the exact loop (a missing positive in the pre-filter would be
  // an unsound false-negative).
  const sources = [];
  let flags = '';
  let allCompilable = true;
  for (const { pattern, negate } of list) {
    if (negate) continue;
    const re = new Minimatch(pattern, { dot: true }).makeRe();
    if (!re) { allCompilable = false; break; }
    sources.push(`(?:${re.source})`);
    flags = re.flags.replace('g', ''); // .test() must be stateless
  }
  const positiveRe = allCompilable && sources.length ? new RegExp(sources.join('|'), flags) : null;

  return { rules, positiveRe };
}

// Whether a path is ignored. Mirrors the original semantics exactly: each
// pattern is tested against the relative path, the relative path with a
// trailing slash (so directory patterns match), and the basename (so a bare
// name matches at any depth); later matches win, and `!` negation re-includes.
function isIgnored(filePath, baseDir, compiled) {
  const rules = compiled && compiled.rules;
  if (!rules || rules.length === 0) {
    return false;
  }
  const rel = path.relative(baseDir, filePath);
  const relSlash = rel + '/';
  const base = path.basename(filePath);

  // Fast path: if no positive pattern matches any variant, it can't be ignored.
  const re = compiled.positiveRe;
  if (re && !(re.test(rel) || re.test(relSlash) || re.test(base))) {
    return false;
  }

  let ignored = false;
  for (const { mm, negate } of rules) {
    if (mm.match(rel) || mm.match(relSlash) || mm.match(base)) {
      ignored = !negate;
    }
  }
  return ignored;
}

module.exports = { compileIgnore, isIgnored };
