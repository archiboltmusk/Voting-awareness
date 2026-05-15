/**
 * scripts/lib/logger.mjs
 * Step-summary logger for GitHub Actions and local console output.
 */

import { writeFileSync } from 'node:fs';

/**
 * Factory that creates a logger instance.
 *
 * Returns:
 *   { write(line), flush(), lines }
 *
 * - write(line): log a Markdown line to console (stripped) and accumulate it
 * - flush(): append all accumulated lines to $GITHUB_STEP_SUMMARY (if set)
 * - lines: the raw accumulated lines array
 */
export function createLogger() {
  const lines = [];

  function write(line) {
    lines.push(line);
    console.log(line.replace(/[*#`_]/g, '').trim());
  }

  function flush() {
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (path) {
      try {
        writeFileSync(path, lines.join('\n') + '\n', { flag: 'a' });
      } catch {
        /* silently ignore write failures */
      }
    }
  }

  return { write, flush, lines };
}
