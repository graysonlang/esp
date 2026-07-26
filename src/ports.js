import crypto from 'node:crypto';
import net from 'node:net';

// Above the privileged range, below the OS ephemeral range, and clear of
// Chrome's ERR_UNSAFE_PORT blocklist (whose nearest entry is 10080).
export const SERVE_PORT_RANGE = { start: 8000, size: 900 };

// Leaves Chrome's 9222 and Node's 9229 inspector defaults unclaimed, so an
// explicit --debug-port=9222 still works for a one-off project.
export const DEBUG_PORT_RANGE = { start: 9300, size: 600 };

/**
 * Map a project identity to a stable port within `range`.
 *
 * The same identity always yields the same port, so a derived port can be
 * hardcoded into a launch.json or a bookmark the way a fixed one could. Two
 * unrelated projects landing on the same port is a hash collision, which
 * `resolvePort` scans past.
 */
export function derivePort(identity, range = SERVE_PORT_RANGE) {
  const digest = crypto.createHash('sha1').update(identity).digest();
  return range.start + (digest.readUInt32BE(0) % range.size);
}

export function isPortFree(port, host) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Return `port` if it is free, otherwise the next free port above it, wrapping
 * around within `range`.
 *
 * This only moves off the derived port when something is already listening —
 * a hash collision, or a second worktree of the same project — so the common
 * case stays deterministic across runs.
 */
export async function resolvePort(port, host, { range = SERVE_PORT_RANGE, attempts = 20 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const candidate = range.start + ((port - range.start + i) % range.size);
    if (await isPortFree(candidate, host)) return candidate;
  }
  throw new Error(`No free port found within ${attempts} of ${port}.`);
}
