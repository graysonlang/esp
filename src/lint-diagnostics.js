// The canonical diagnostic shape every lint driver normalizes to, plus the
// renderer that turns it into console output.
//
// The output format is deliberately ESLint's "stylish" layout, because that is
// what the problem matcher in every esp consumer's .vscode/tasks.json already
// parses:
//
//   pattern[0]  ^([^\s].*)$                          -> absolute file path
//   pattern[1]  ^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.*?)(?:\s{2,}(\S+))?\s*$
//
// Holding that shape is the whole reason a driver layer is worth having: swap
// the linter underneath and VS Code keeps showing inline squiggles with no
// change to tasks.json. Two constraints follow from the matcher and must not be
// broken casually:
//
//   - paths are absolute, since the matcher declares fileLocation "absolute"
//   - the rule id is separated from the message by AT LEAST two spaces, which
//     is how the matcher tells the two apart
//
// Output is colored when the terminal takes color. That costs nothing in the
// Problems panel because VS Code strips ANSI escapes before running a problem
// matcher over task output - the same reason its built-in $eslint-stylish
// matcher works against ESLint's own colored output. So the same stream reads
// well in the integrated terminal and still populates the panel.

/**
 * @typedef {object} LintDiagnostic
 * @property {string} filePath   Absolute path.
 * @property {number} line       1-based.
 * @property {number} column     1-based.
 * @property {'error' | 'warning' | 'info'} severity
 * @property {string} message    Single line; newlines are collapsed on render.
 * @property {string} [ruleId]   Rule/category id, if the linter reports one.
 */

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  underline: '\u001b[4m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const SEVERITY_COLOR = { error: ANSI.red, warning: ANSI.yellow, info: ANSI.cyan };

/**
 * Honors the NO_COLOR / FORCE_COLOR conventions, then falls back to whether
 * stdout is a terminal. A VS Code task runs on a pseudo-terminal, so this is on
 * there and off when the output is piped or captured.
 * @returns {boolean}
 */
function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  return Boolean(process.stdout?.isTTY);
}

// Shown when a linter reports a diagnostic with no message at all - biome does
// this for whole-file checks such as exceeding `files.maxSize`. Without it the
// message column is empty, and the matcher reads the rule id as the message,
// leaving the Problems panel with an entry labelled `check` and no code.
const NO_MESSAGE = '(no message)';

/**
 * Group diagnostics by file, in stable order: files alphabetically, then by
 * position within a file. Stable output keeps watch-mode rebuilds from
 * reshuffling the problems panel on every keystroke.
 * @param {LintDiagnostic[]} diagnostics
 * @returns {Map<string, LintDiagnostic[]>}
 */
function groupByFile(diagnostics) {
  /** @type {Map<string, LintDiagnostic[]>} */
  const byFile = new Map();
  for (const d of diagnostics) {
    let list = byFile.get(d.filePath);
    if (!list) {
      list = [];
      byFile.set(d.filePath, list);
    }
    list.push(d);
  }
  for (const list of byFile.values()) {
    list.sort(
      (a, b) =>
        a.line - b.line ||
        a.column - b.column ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
  }
  return new Map([...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Render diagnostics in ESLint's stylish format. Returns '' when there is
 * nothing to report, so callers can skip printing entirely.
 * @param {LintDiagnostic[]} diagnostics
 * @param {object} [options]
 * @param {boolean} [options.color]  Defaults to whether stdout takes color.
 * @returns {string}
 */
export function renderStylish(diagnostics, { color = supportsColor() } = {}) {
  if (diagnostics.length === 0) return '';

  /** Wrap in an escape only when coloring, so the uncolored path stays exact. */
  const paint = (code, text) => (color ? `${code}${text}${ANSI.reset}` : text);

  const lines = [];
  for (const [filePath, list] of groupByFile(diagnostics)) {
    lines.push(paint(ANSI.underline, filePath));

    // Pad the position and severity columns so the rule ids line up, matching
    // stylish. Padding is cosmetic - the matcher only needs the two-space gap.
    // Pad before painting, or the escapes would count toward the width.
    const positions = list.map(d => `${d.line}:${d.column}`);
    const posWidth = Math.max(...positions.map(p => p.length));
    const sevWidth = Math.max(...list.map(d => d.severity.length));

    list.forEach((d, i) => {
      // A multi-line message would look like a new file to pattern[0], so
      // collapse it. Biome's format diagnostics in particular are multi-line.
      // Runs of two or more spaces collapse too: the matcher splits the rule id
      // off on exactly that, so an inner double space in a message with no rule
      // id would make it invent one out of the last word.
      const message = d.message.replace(/\s+/gu, ' ').trim() || NO_MESSAGE;
      const position = paint(ANSI.dim, positions[i].padEnd(posWidth));
      const severity = paint(SEVERITY_COLOR[d.severity], d.severity.padEnd(sevWidth));
      const rule = d.ruleId ? `  ${paint(ANSI.dim, d.ruleId)}` : '';
      lines.push(`  ${position}  ${severity}  ${message}${rule}`);
    });

    lines.push('');
  }

  const { errors, warnings, infos } = countBySeverity(diagnostics);
  const plural = /** @param {number} n */ n => (n === 1 ? '' : 's');
  const parts = [`${errors} error${plural(errors)}`, `${warnings} warning${plural(warnings)}`];
  if (infos > 0) parts.push(`${infos} info`);
  const summary = `${diagnostics.length} problem${plural(diagnostics.length)} (${parts.join(', ')})`;
  lines.push(paint(ANSI.bold + (errors > 0 ? ANSI.red : ANSI.yellow), summary));

  return lines.join('\n');
}

/**
 * Counted as three buckets rather than "errors and everything else", because
 * `throwOnWarnings` gates on this: biome reports suggestions at `info`, and
 * folding those into warnings would fail a build over them.
 * @param {LintDiagnostic[]} diagnostics
 * @returns {{ errors: number, warnings: number, infos: number }}
 */
export function countBySeverity(diagnostics) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diagnostics) {
    if (d.severity === 'error') errors += 1;
    else if (d.severity === 'info') infos += 1;
    else warnings += 1;
  }
  return { errors, warnings, infos };
}
