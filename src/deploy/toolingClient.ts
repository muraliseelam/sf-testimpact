/**
 * The jsforce-backed `CoverageClient`.
 *
 * **This is the only module in the tool that touches an org**, and it is imported lazily by
 * the deploy command behind `--verify-coverage`. `index` and `analyze` never load it, so
 * they never open a connection and cannot be made to by configuration. Enforcing that with
 * a dynamic import rather than a comment is the point.
 */

import { type CoverageClient, type CoverageRow } from './coverage.js';

/** The slice of a jsforce connection we use. Kept narrow so it is trivially mockable. */
export interface ToolingQueryable {
  tooling: {
    query(soql: string): Promise<{ records: unknown[] }>;
  };
}

interface CoverageRecord {
  readonly NumLinesCovered?: number;
  readonly NumLinesUncovered?: number;
  readonly ApexClassOrTrigger?: { readonly Name?: string };
}

interface ApexClassRecord {
  readonly Name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Escapes a value for a SOQL string literal. */
function soqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Tooling API queries have a length limit, so long payloads are chunked.
 *
 * Fifty names per query keeps the statement comfortably short even for long class names,
 * and a large payload is exactly when this check matters most.
 */
const CHUNK_SIZE = 50;

export function createToolingCoverageClient(connection: ToolingQueryable): CoverageClient {
  return {
    async aggregateCoverage(names: readonly string[]): Promise<readonly CoverageRow[]> {
      const rows: CoverageRow[] = [];
      for (let i = 0; i < names.length; i += CHUNK_SIZE) {
        const chunk = names.slice(i, i + CHUNK_SIZE);
        const inList = chunk.map(soqlLiteral).join(', ');
        const result = await connection.tooling.query(
          'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered ' +
            `FROM ApexCodeCoverageAggregate WHERE ApexClassOrTrigger.Name IN (${inList})`,
        );
        for (const record of result.records) {
          if (!isRecord(record)) continue;
          const typed = record as CoverageRecord;
          const name = typed.ApexClassOrTrigger?.Name;
          if (name === undefined) continue;
          rows.push({
            name,
            linesCovered: typed.NumLinesCovered ?? 0,
            linesUncovered: typed.NumLinesUncovered ?? 0,
          });
        }
      }
      return rows;
    },

    async orgTestClasses(): Promise<readonly string[]> {
      // `SymbolTable` is not queryable in bulk, so test classes are identified by the
      // annotation appearing in the body. This over-selects slightly (a class merely
      // mentioning the word), which is the safe direction for a drift warning.
      const result = await connection.tooling.query(
        "SELECT Name FROM ApexClass WHERE Body LIKE '%@isTest%' OR Body LIKE '%testMethod%'",
      );
      const names: string[] = [];
      for (const record of result.records) {
        if (!isRecord(record)) continue;
        const name = (record as ApexClassRecord).Name;
        if (name !== undefined) names.push(name);
      }
      return names;
    },
  };
}
