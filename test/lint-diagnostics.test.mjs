// The contract these tests protect: whatever linter a driver wraps, the output
// esp prints must be parseable by the problem matcher every consumer already
// has in .vscode/tasks.json. If that breaks, VS Code silently stops showing
// inline lint squiggles - silently, because a build that lints fine and a build
// whose output nothing can parse look identical on the console.
//
// So the regexes below are copied verbatim from tasks.json rather than
// imported. A test that shared a constant with the thing it checks would pass
// even if both drifted together.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countBySeverity, renderStylish } from '../src/lint-diagnostics.js';

const FILE_PATTERN = /^([^\s].*)$/;
const PROBLEM_PATTERN = /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.*?)(?:\s{2,}(\S+))?\s*$/;

// VS Code strips ANSI escapes before running a problem matcher, so the colored
// stream has to parse identically once stripped. This is that strip step.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_PATTERN = /\u001b\[[0-9;]*m/gu;
const stripAnsi = text => text.replace(ANSI_PATTERN, '');

// Colorless by default so these assertions do not depend on whether the test
// runner's stdout happens to be a terminal. Color is covered explicitly below.
const render = diagnostics => renderStylish(diagnostics, { color: false });

/**
 * Run the rendered output through the problem matcher the way VS Code does:
 * pattern[0] starts a file, pattern[1] loops over that file's problems.
 */
function parseAsProblemMatcher(output) {
  const parsed = [];
  let currentFile = null;
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const problem = PROBLEM_PATTERN.exec(line);
    if (problem && currentFile) {
      parsed.push({
        file: currentFile,
        line: Number(problem[1]),
        column: Number(problem[2]),
        severity: problem[3],
        message: problem[4],
        code: problem[5],
      });
      continue;
    }
    const file = FILE_PATTERN.exec(line);
    if (file) currentFile = file[1];
  }
  return parsed;
}

const diagnostic = (over = {}) => ({
  filePath: '/abs/project/src/a.js',
  line: 3,
  column: 7,
  severity: 'error',
  message: 'Something is wrong.',
  ruleId: 'no-thing',
  ...over,
});

describe('renderStylish', () => {
  it('returns empty output for no diagnostics, so callers can skip printing', () => {
    assert.equal(render([]), '');
  });

  it('emits output the tasks.json problem matcher can parse', () => {
    const parsed = parseAsProblemMatcher(render([diagnostic()]));
    assert.deepEqual(parsed, [
      {
        file: '/abs/project/src/a.js',
        line: 3,
        column: 7,
        severity: 'error',
        message: 'Something is wrong.',
        code: 'no-thing',
      },
    ]);
  });

  it('keeps the message and rule id separable when the message has single spaces', () => {
    // The matcher splits on two-or-more spaces. A message containing single
    // spaces must not bleed into the code capture.
    const [parsed] = parseAsProblemMatcher(
      render([diagnostic({ message: 'Expected 1 space but found 0.' })]),
    );
    assert.equal(parsed.message, 'Expected 1 space but found 0.');
    assert.equal(parsed.code, 'no-thing');
  });

  it('collapses multi-line messages, which would otherwise look like a new file', () => {
    // Biome's formatter diagnostics are multi-line. An embedded newline would
    // make pattern[0] treat the continuation as a file path and silently
    // reattach every later problem to the wrong file.
    const output = render([
      diagnostic({ message: 'Formatter would have printed:\n  const x = 1;' }),
    ]);
    const parsed = parseAsProblemMatcher(output);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].file, '/abs/project/src/a.js');
    assert.match(parsed[0].message, /Formatter would have printed: const x = 1;/u);
  });

  it('attributes problems to the right file when several are reported', () => {
    const parsed = parseAsProblemMatcher(
      render([
        diagnostic({ filePath: '/abs/project/src/b.js', line: 1, message: 'B one.' }),
        diagnostic({ filePath: '/abs/project/src/a.js', line: 9, message: 'A nine.' }),
        diagnostic({ filePath: '/abs/project/src/a.js', line: 2, message: 'A two.' }),
      ]),
    );
    assert.deepEqual(
      parsed.map(p => [p.file, p.line]),
      [
        ['/abs/project/src/a.js', 2],
        ['/abs/project/src/a.js', 9],
        ['/abs/project/src/b.js', 1],
      ],
      'files sorted, and positions sorted within a file',
    );
  });

  it('renders a diagnostic with no rule id', () => {
    const [parsed] = parseAsProblemMatcher(
      render([diagnostic({ ruleId: undefined, message: 'Parsing error.' })]),
    );
    assert.equal(parsed.message, 'Parsing error.');
    assert.equal(parsed.code, undefined);
  });

  it('carries all three severities the matcher recognizes', () => {
    const parsed = parseAsProblemMatcher(
      render([
        diagnostic({ severity: 'error', line: 1 }),
        diagnostic({ severity: 'warning', line: 2 }),
        diagnostic({ severity: 'info', line: 3 }),
      ]),
    );
    assert.deepEqual(
      parsed.map(p => p.severity),
      ['error', 'warning', 'info'],
    );
  });

  it('summarizes counts', () => {
    const output = render([
      diagnostic({ severity: 'error' }),
      diagnostic({ severity: 'warning', line: 4 }),
    ]);
    assert.match(output, /2 problems \(1 error, 1 warning\)/u);
  });

  it('breaks info out of the summary only when present', () => {
    const output = render([
      diagnostic({ severity: 'error' }),
      diagnostic({ severity: 'info', line: 4 }),
    ]);
    assert.match(output, /2 problems \(1 error, 0 warnings, 1 info\)/u);
  });

  it('substitutes a placeholder for an empty message', () => {
    // Biome emits message:"" for whole-file checks such as exceeding
    // files.maxSize. With the message column empty, the matcher reads the rule
    // id as the message and leaves the code empty — so the Problems panel
    // showed an entry titled `check` with no code.
    const [parsed] = parseAsProblemMatcher(render([diagnostic({ message: '', ruleId: 'check' })]));
    assert.equal(parsed.message, '(no message)');
    assert.equal(parsed.code, 'check', 'the rule id stays in the code column');
  });

  it('collapses inner double spaces, which would fake a rule id', () => {
    // The matcher splits the rule id off on two-or-more spaces. Left alone,
    // "Unexpected  token" with no rule id parsed as message "Unexpected" and
    // code "token".
    const [parsed] = parseAsProblemMatcher(
      render([diagnostic({ message: 'Unexpected  token', ruleId: undefined })]),
    );
    assert.equal(parsed.message, 'Unexpected token');
    assert.equal(parsed.code, undefined);
  });
});

describe('renderStylish color', () => {
  it('emits no escapes when color is off', () => {
    assert.doesNotMatch(render([diagnostic()]), ANSI_PATTERN);
  });

  it('emits escapes when color is on', () => {
    assert.match(renderStylish([diagnostic()], { color: true }), ANSI_PATTERN);
  });

  it('parses identically once VS Code strips the escapes', () => {
    // The whole point: one stream reads well in the terminal and still
    // populates the Problems panel, because VS Code strips ANSI before
    // matching. If these ever diverge, color has broken the panel.
    const diagnostics = [
      diagnostic({ severity: 'error', line: 1 }),
      diagnostic({ severity: 'warning', line: 2, ruleId: undefined }),
      diagnostic({ severity: 'info', line: 3, message: '' }),
      diagnostic({ filePath: '/abs/project/src/b.js', line: 40, column: 100 }),
    ];
    assert.deepEqual(
      parseAsProblemMatcher(stripAnsi(renderStylish(diagnostics, { color: true }))),
      parseAsProblemMatcher(renderStylish(diagnostics, { color: false })),
    );
  });

  it('keeps the file path parseable when underlined', () => {
    // pattern[0] is ^([^\s].*)$ — a leading escape is not whitespace, so the
    // path would still match but capture the escape along with it.
    const parsed = parseAsProblemMatcher(stripAnsi(renderStylish([diagnostic()], { color: true })));
    assert.equal(parsed[0].file, '/abs/project/src/a.js');
  });
});

describe('countBySeverity', () => {
  it('keeps info out of the warning count', () => {
    // throwOnWarnings gates on this, and biome reports suggestions at info.
    assert.deepEqual(
      countBySeverity([
        diagnostic({ severity: 'error' }),
        diagnostic({ severity: 'warning' }),
        diagnostic({ severity: 'info' }),
        diagnostic({ severity: 'info' }),
      ]),
      { errors: 1, warnings: 1, infos: 2 },
    );
  });
});
