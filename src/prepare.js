// The runner behind a project's `scripts/prepare.mjs`.
//
// `prepare` is an awkward lifecycle hook: it fires on local `npm install` and
// on publish, but also when someone installs the project as a *git* dependency,
// where npm builds it from a temp clone. The steps projects want there — render
// launch.json, build a dist bundle, point git at a hooks dir — are developer
// conveniences. None is worth failing an install over, least of all somebody
// else's.
//
// So every step runs as its own child process and every failure is a warning.
// A child process is a hard boundary: a step that dies on import (esbuild's
// platform binary missing in a consumer's temp build, say) is contained here
// instead of taking the install down with it. A broken step surfaces the next
// time its command is run directly, which is where the fix belongs.
//
// Steps are data so a project's prepare.mjs stays a list rather than a chain of
// shell operators in package.json — each entry keeps its own error handling,
// carries a label, and can be commented. Nothing is run through a shell, so
// behavior does not vary by platform.
//
//   import { runPrepareSteps } from '@graysonlang/esp/prepare';
//
//   runPrepareSteps([
//     { label: 'build dist', command: 'npm', args: ['run', 'dist'] },
//     { label: 'sync launch.json', args: ['./scripts/build.mjs', '--sync-launch'] },
//   ]);
//
// Import it dynamically and catch — see the README. `prepare` still runs under
// `npm install --omit=dev`, where esp is not installed, and a bare top-level
// import would fail the very install this is meant not to disturb.

import { spawnSync } from 'node:child_process';

/**
 * @typedef {object} PrepareStep
 * @property {string} label      Named in any warning, so a failure says which step.
 * @property {string} [command]  Defaults to the Node running this script.
 * @property {string[]} [args]
 * @property {string} [hint]     Appended to the warning when this step fails.
 *   Worth setting on a load-bearing step — one whose output a git install has no
 *   other way to obtain — so the warning says how to recover rather than only
 *   that something went wrong.
 */

/**
 * @typedef {object} PrepareResult
 * @property {string[]} completed  Labels that exited 0.
 * @property {string[]} warned     Labels that failed; each produced a warning.
 */

/**
 * Run each step in order, warning on failure and never throwing.
 * @param {PrepareStep[]} steps
 * @param {object} [options]
 * @param {Pick<Console, 'warn'>} [options.logger]
 * @returns {PrepareResult}
 */
export function runPrepareSteps(steps, { logger = console } = {}) {
  /** @type {PrepareResult} */
  const result = { completed: [], warned: [] };
  if (!Array.isArray(steps)) {
    throw new TypeError('runPrepareSteps expects an array of steps.');
  }

  for (const step of steps) {
    const { label, command = process.execPath, args = [], hint } = step ?? {};
    if (!label) {
      throw new TypeError('Each prepare step needs a `label`.');
    }
    const withHint = message => (hint ? `${message}\n  ${hint}` : message);

    try {
      // npm and git resolve through a shim on Windows, which only runs via the
      // shell. Node is spawned by absolute path and never needs one, so the
      // common case stays shell-free.
      const shell = process.platform === 'win32' && command !== process.execPath;
      const { status, signal, error } = spawnSync(command, args, { stdio: 'inherit', shell });
      if (error) throw error;
      if (status === 0) {
        result.completed.push(label);
      } else {
        result.warned.push(label);
        logger.warn(withHint(`prepare: ${label} exited with ${status ?? signal}`));
      }
    } catch (error) {
      // Could not even spawn — a missing executable, most often.
      result.warned.push(label);
      logger.warn(withHint(`prepare: ${label} skipped (${error.message})`));
    }
  }

  return result;
}

export default runPrepareSteps;
