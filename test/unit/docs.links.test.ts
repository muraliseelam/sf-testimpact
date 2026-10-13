/**
 * Every relative link and anchor in the repository's Markdown resolves.
 *
 * The documentation cross-links heavily, and pages move: the README's measured sections went
 * to docs/benchmarks.md and docs/limitations.md. A link to a missing file, or to a heading that
 * was renamed, fails here instead of on GitHub. External URLs are not fetched; tests never
 * touch the network.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Generated, vendored or tool-owned trees whose Markdown is not this project's documentation. */
const SKIP = new Set([
  '.agents',
  '.git',
  '.sf',
  '.sfdx',
  '.sf-testimpact',
  'coverage',
  'lib',
  'node_modules',
  'test/fixtures',
]);

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIP.has(relative(ROOT, full).replaceAll('\\', '/'))) continue;
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * The anchor GitHub gives a heading: the rendered text, lower-cased, with everything but
 * letters, digits, connector punctuation, spaces and hyphens removed, and spaces turned into
 * hyphens. The same algorithm as github-slugger.
 */
function slug(heading: string): string {
  const rendered = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '');
  return rendered
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** The text with fenced code blocks blanked out, so line numbers still match the file. */
function withoutCodeBlocks(text: string): string {
  let inFence = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

const anchorCache = new Map<string, Set<string>>();

function anchorsOf(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached !== undefined) return cached;
  const prose = withoutCodeBlocks(readFileSync(file, 'utf8'));
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of prose.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const base = slug(heading[1] ?? '');
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const html of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(html[1] ?? '');
  }
  anchorCache.set(file, anchors);
  return anchors;
}

interface Link {
  readonly line: number;
  readonly target: string;
}

function linksIn(text: string): Link[] {
  // Inline code is removed first: a link written inside backticks is an example, not a link.
  const prose = withoutCodeBlocks(text).replace(/`[^`\n]*`/g, '');
  const links: Link[] = [];
  const lineAt = (index: number): number => prose.slice(0, index).split('\n').length;
  for (const m of prose.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    links.push({ line: lineAt(m.index), target: m[1] ?? '' });
  }
  for (const m of prose.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) {
    links.push({ line: lineAt(m.index), target: m[1] ?? '' });
  }
  return links;
}

/** Why the link is broken, or null when it resolves. External links are not checked. */
function problemWith(file: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const hash = target.indexOf('#');
  const pathPart = decodeURIComponent(hash < 0 ? target : target.slice(0, hash));
  const anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
  const dest =
    pathPart === ''
      ? file
      : pathPart.startsWith('/')
        ? join(ROOT, pathPart)
        : resolve(dirname(file), pathPart);
  if (!existsSync(dest)) return 'no such file';
  if (anchor === '' || statSync(dest).isDirectory() || !dest.endsWith('.md')) return null;
  return anchorsOf(dest).has(anchor) ? null : `no heading with anchor #${anchor}`;
}

describe('documentation links', () => {
  const files = markdownFiles(ROOT);

  it('finds the documentation', () => {
    const names = files.map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(names).toContain('README.md');
    expect(names).toContain('docs/README.md');
    expect(names).toContain('docs/commands.md');
  });

  it('resolves every relative link and anchor', () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const link of linksIn(readFileSync(file, 'utf8'))) {
        const problem = problemWith(file, link.target);
        if (problem !== null) {
          const name = relative(ROOT, file).replaceAll('\\', '/');
          broken.push(`${name}:${link.line} ${link.target} (${problem})`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('reports a missing file and a missing anchor, and leaves external links alone', () => {
    const readme = join(ROOT, 'README.md');
    expect(problemWith(readme, 'docs/no-such-page.md')).toBe('no such file');
    expect(problemWith(readme, 'docs/benchmarks.md#no-such-heading')).toBe(
      'no heading with anchor #no-such-heading',
    );
    expect(problemWith(readme, '#no-such-heading')).toBe('no heading with anchor #no-such-heading');
    expect(problemWith(readme, 'docs/benchmarks.md#selection-quality')).toBeNull();
    expect(problemWith(readme, 'https://example.com/missing#anywhere')).toBeNull();
  });

  it('finds inline and reference links, with their lines, and ignores links inside code', () => {
    const text = [
      'See [the page](a.md#part).',
      '```',
      '[not a link](b.md)',
      '```',
      'Inline `[nor this](c.md)` either, but [this one',
      'wraps](d.md "with a title").',
      '[ref]: e.md',
    ].join('\n');
    expect(linksIn(text)).toEqual([
      { line: 1, target: 'a.md#part' },
      { line: 5, target: 'd.md' },
      { line: 7, target: 'e.md' },
    ]);
  });

  it('computes anchors the way GitHub does', () => {
    expect(slug('`analyze --json`')).toBe('analyze---json');
    expect(slug("How is this different from Salesforce's `RunRelevantTests`?")).toBe(
      'how-is-this-different-from-salesforces-runrelevanttests',
    );
    expect(slug('C1. The incremental index is genuinely faster')).toBe(
      'c1-the-incremental-index-is-genuinely-faster',
    );
    expect(slug('Live org (2026-10-12)')).toBe('live-org-2026-10-12');
    expect(slug('5. Choose an entry-point policy')).toBe('5-choose-an-entry-point-policy');
    expect(slug('Coverage under `RunSpecifiedTests`')).toBe('coverage-under-runspecifiedtests');
  });

  it('numbers repeated headings the way GitHub does', () => {
    // docs/USER-TESTING.md has two "## Findings" sections.
    const anchors = anchorsOf(join(ROOT, 'docs', 'USER-TESTING.md'));
    expect(anchors.has('findings')).toBe(true);
    expect(anchors.has('findings-1')).toBe(true);
  });
});
