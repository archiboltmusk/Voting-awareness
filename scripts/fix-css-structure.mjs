/**
 * fix-css-structure.mjs
 *
 * For every HTML file in public/:
 *   A. Move <link rel="stylesheet" href="/shared.css"> so it appears before
 *      the first <style> tag in <head>.
 *   B. Remove canonical design tokens from each page's inline :root {} block.
 *      Tokens removed: --ink, --paper, --aged, --muted, --accent, --bjp, --tmc,
 *      --gold, --watching, --announced, --in-progress, --delivered, --delayed,
 *      --broken, --evaded.
 *   C. If the :root {} block becomes empty (only whitespace), remove it entirely.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Canonical tokens that are now defined in shared.css :root {}
const CANONICAL_TOKENS = [
  'ink',
  'paper',
  'aged',
  'muted',
  'accent',
  'bjp',
  'tmc',
  'gold',
  'watching',
  'announced',
  'in-progress',
  'delivered',
  'delayed',
  'broken',
  'evaded',
];

// Regex to match a single canonical token declaration anywhere in CSS text.
// Works for both:
//   - separate-line format: "  --ink: #0a0804;\n"
//   - inline format:        "--ink:#0a0804;" (possibly surrounded by other declarations)
// Removes the token declaration including optional surrounding whitespace.
// The [\s]* at the end eats trailing whitespace/newlines left behind on an otherwise-empty line.
const TOKEN_INLINE_RE = new RegExp(
  `[ \\t]*--(${CANONICAL_TOKENS.join('|')})\\s*:[^;]+;[ \\t]*`,
  'g'
);

/**
 * Remove canonical token declarations from all :root {} blocks in a <style> section.
 * Returns the modified style block content.
 */
function removeCanonicalTokensFromRoot(styleContent) {
  // Match :root { ... } blocks
  return styleContent.replace(/:root\s*\{([^}]*)\}/g, (fullMatch, inner) => {
    // Remove each canonical token declaration wherever it appears (same-line or own-line)
    let cleaned = inner.replace(TOKEN_INLINE_RE, '');

    // Clean up any lines that are now empty (only whitespace) after token removal
    cleaned = cleaned.replace(/^[ \t]*\n/gm, '');

    // If only whitespace remains between braces, remove the whole block
    if (/^\s*$/.test(cleaned)) {
      return '';
    }
    return `:root {${cleaned}}`;
  });
}

/**
 * Process a single HTML file.
 * Returns { modified: boolean, changes: string[] }
 */
function processFile(filePath) {
  let content = readFileSync(filePath, 'utf8');
  const original = content;
  const changes = [];

  // ── A. Reorder stylesheet link ────────────────────────────────────────────
  const sharedLinkRe = /[ \t]*<link\s+rel="stylesheet"\s+href="\/shared\.css"[^>]*>[ \t]*\r?\n?/;
  const firstStyleTagPos = content.indexOf('<style');

  if (firstStyleTagPos !== -1) {
    const sharedMatch = sharedLinkRe.exec(content);
    if (sharedMatch) {
      const sharedLinkPos = sharedMatch.index;
      // Only reorder if shared.css link appears AFTER the first <style> tag
      if (sharedLinkPos > firstStyleTagPos) {
        // Remove the shared.css link from its current position
        const removedLink = sharedMatch[0].trimEnd(); // preserve the actual tag
        content = content.replace(sharedLinkRe, '');

        // Insert before the first <style> tag in the updated content
        // (position may have shifted slightly if the removed text was before the style tag,
        //  but since we confirmed it was AFTER the style tag, the style tag position is unchanged)
        const styleIdx = content.indexOf('<style');
        // Insert on its own line before <style>
        const insertLine = '<link rel="stylesheet" href="/shared.css">\n';
        content = content.slice(0, styleIdx) + insertLine + content.slice(styleIdx);
        changes.push('moved shared.css link before first <style> tag');
      }
    }
  }

  // ── B. Remove canonical tokens from :root {} in <style> blocks ───────────
  // Process each <style>...</style> block
  const styleBlockRe = /(<style[^>]*>)([\s\S]*?)(<\/style>)/g;
  const newContent = content.replace(styleBlockRe, (fullMatch, openTag, inner, closeTag) => {
    const cleaned = removeCanonicalTokensFromRoot(inner);
    if (cleaned !== inner) {
      changes.push('removed canonical tokens from :root {} in <style> block');
    }
    return openTag + cleaned + closeTag;
  });
  content = newContent;

  const modified = content !== original;
  if (modified) {
    writeFileSync(filePath, content, 'utf8');
  }

  return { modified, changes };
}

// ── Main ───────────────────────────────────────────────────────────────────
const htmlFiles = readdirSync(PUBLIC_DIR)
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map((f) => join(PUBLIC_DIR, f));

let totalModified = 0;

for (const filePath of htmlFiles) {
  const fileName = filePath.split('/').pop();
  const { modified, changes } = processFile(filePath);
  if (modified) {
    totalModified++;
    console.log(`MODIFIED  ${fileName}`);
    for (const c of changes) {
      console.log(`          · ${c}`);
    }
  } else {
    console.log(`unchanged ${fileName}`);
  }
}

console.log(`\nDone. ${totalModified}/${htmlFiles.length} files modified.`);
