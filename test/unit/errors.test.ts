import { describe, expect, it } from 'vitest';
import { ConfigError, ExtractorError, TestImpactError } from '../../src/errors.js';

describe('TestImpactError', () => {
  it('carries its code, subject and remedy', () => {
    const error = new TestImpactError('GRAPH_STALE', 'The index is out of date.', {
      subject: '.sf-testimpact/graph.json',
      remedy: 'Run `sf testimpact index`.',
    });
    expect(error.code).toBe('GRAPH_STALE');
    expect(error.subject).toBe('.sf-testimpact/graph.json');
    expect(error.remedy).toBe('Run `sf testimpact index`.');
    expect(error).toBeInstanceOf(Error);
  });

  it('formats what happened, where, and what to do', () => {
    const formatted = new TestImpactError('GIT_FAILED', 'git diff failed.', {
      subject: 'main..HEAD',
      remedy: 'Check that both refs exist.',
    }).format();
    expect(formatted).toBe(
      ['GIT_FAILED: git diff failed.', '  in: main..HEAD', '  fix: Check that both refs exist.'].join('\n'),
    );
  });

  it('omits absent fields from the formatted output', () => {
    expect(new TestImpactError('GRAPH_CORRUPT', 'Unreadable.').format()).toBe('GRAPH_CORRUPT: Unreadable.');
  });

  it('preserves the underlying cause', () => {
    const cause = new Error('ENOENT');
    expect(new TestImpactError('CONFIG_UNREADABLE', 'Cannot read.', { cause }).cause).toBe(cause);
  });
});

describe('ConfigError', () => {
  it('is a TestImpactError with the CONFIG_INVALID code', () => {
    const error = new ConfigError('Bad key.', { subject: '.sf-testimpact.yml' });
    expect(error).toBeInstanceOf(TestImpactError);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.name).toBe('ConfigError');
  });
});

describe('ExtractorError', () => {
  it('names the extractor and the offending file', () => {
    // An error that does not identify its input forces the reader to reproduce the failure
    // just to understand it.
    const error = new ExtractorError('apex@1', 'force-app/classes/Odd.cls', new Error('boom'));
    expect(error.subject).toBe('force-app/classes/Odd.cls');
    expect(error.message).toContain('apex@1');
    expect(error.remedy).toMatch(/report it/i);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('warns against excluding the file as a workaround without certainty', () => {
    const error = new ExtractorError('apex@1', 'a.cls', 'boom');
    expect(error.remedy).toMatch(/excludeFromImpact/);
    expect(error.remedy).toMatch(/certain/);
  });
});
