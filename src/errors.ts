/**
 * Typed errors.
 *
 * Every error names the offending file or component and says what the user should do about
 * it. An error message that does not identify the input that caused it forces the reader to
 * reproduce the failure to understand it, which is a poor trade for the two lines it saves.
 */

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_UNREADABLE'
  | 'PROJECT_NOT_FOUND'
  | 'EXTRACTOR_FAILED'
  | 'GRAPH_STALE'
  | 'GRAPH_CORRUPT'
  | 'GIT_FAILED';

export class TestImpactError extends Error {
  readonly code: ErrorCode;
  /** The file or component this error is about, if there is one. */
  readonly subject: string | undefined;
  /** What the user can do next. Printed after the message. */
  readonly remedy: string | undefined;
  /**
   * The remedy, in the shape `sf` actually renders.
   *
   * `remedy` and `format()` existed from the start, but nothing called `format()`:
   * `@salesforce/sf-plugins-core` builds both its human output and its `--json` payload from
   * the thrown error's `actions`. So every remedy in this codebase was written, carried
   * through, and then silently dropped before it reached a user. Populating `actions` is
   * what makes them visible; it is deliberately derived here rather than at each throw site
   * so no future error can forget to do it.
   */
  readonly actions: string[] | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { subject?: string; remedy?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TestImpactError';
    this.code = code;
    this.subject = options.subject;
    this.remedy = options.remedy;
    this.actions = options.remedy === undefined ? undefined : [options.remedy];
  }

  /** Multi-line rendering for the CLI: what happened, where, and what to do. */
  format(): string {
    const lines = [`${this.code}: ${this.message}`];
    if (this.subject !== undefined) lines.push(`  in: ${this.subject}`);
    if (this.remedy !== undefined) lines.push(`  fix: ${this.remedy}`);
    return lines.join('\n');
  }
}

export class ConfigError extends TestImpactError {
  constructor(message: string, options: { subject?: string; remedy?: string; cause?: unknown } = {}) {
    super('CONFIG_INVALID', message, options);
    this.name = 'ConfigError';
  }
}

/**
 * An extractor threw on a file it should have handled.
 *
 * This is never swallowed. Depending on context it becomes either a hard failure of
 * `index`, or a `PARSE_FAILED` node that forces a full test run when the file changes —
 * but it is always surfaced, because a silently skipped file is a silently missing edge.
 */
export class ExtractorError extends TestImpactError {
  constructor(extractor: string, file: string, cause: unknown) {
    super('EXTRACTOR_FAILED', `The ${extractor} extractor failed on this file.`, {
      subject: file,
      remedy:
        'This is a bug in sf-testimpact. Please report it with the file contents if you can share them. ' +
        'Until then, add the file to `excludeFromImpact` only if you are certain no test depends on it.',
      cause,
    });
    this.name = 'ExtractorError';
  }
}
