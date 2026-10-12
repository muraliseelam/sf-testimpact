/**
 * The jsforce-backed `CoverageClient`.
 *
 * **This is the only module in the tool that touches an org**, and it is imported lazily by
 * the deploy command behind `--verify-coverage`. `index` and `analyze` never load it, so
 * they never open a connection and cannot be made to by configuration. Enforcing that with
 * a dynamic import rather than a comment is the point.
 */

import { type CoverageClient, type CoverageRow } from './coverage.js';

/** One page of a Tooling API query. `done` is false when `nextRecordsUrl` has more. */
export interface ToolingQueryResult {
  readonly records: unknown[];
  readonly done?: boolean;
  readonly nextRecordsUrl?: string;
}

/** The slice of a jsforce connection we use. Kept narrow so it is trivially mockable. */
export interface ToolingQueryable {
  tooling: {
    query(soql: string): Promise<ToolingQueryResult>;
    /** Fetches the next page of a query. A real connection has it; a mock may not. */
    queryMore?(nextRecordsUrl: string): Promise<ToolingQueryResult>;
  };
}

interface CoverageRecord {
  readonly NumLinesCovered?: number;
  readonly NumLinesUncovered?: number;
  readonly ApexClassOrTrigger?: { readonly Name?: string };
}

interface ApexClassRecord {
  readonly Name?: string;
  readonly Body?: string;
}

/**
 * What marks an Apex class as a test class, applied to the class body.
 *
 * `@IsTest` in any casing at the start of a line, or a `testMethod` modifier at the start of
 * a declaration line. Anchoring to the line start is what keeps a *comment* from counting:
 * on the first live run the unanchored form flagged apex-recipes' `ConnectApiWrapper`, whose
 * doc comment says "unless used in test methods marked `@isTest(SeeAllData=true)`", as an
 * org-only test class. With the anchor the marker finds exactly the 68 classes the graph
 * considers tests on that repository.
 */
const TEST_CLASS_MARKER = /^\s*@istest\b|^\s*(?:\w+\s+)*testmethod\b/im;

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
      // annotation appearing in the body. The body cannot be FILTERED on, though: the first
      // run of this command against a real org failed with "field 'Body' can not be filtered
      // in a query call" (the query used `WHERE Body LIKE '%@isTest%'`, and shipped that way
      // in 1.2.0). So the bodies are fetched and the marker is applied here.
      //
      // Managed-package classes are left out: `RunLocalTests` does not run them, so they
      // cannot contribute coverage under either test level and are not drift.
      //
      // The result is paged. A page is at most 2,000 records, and an org of the size this
      // tool is for has more classes than that; stopping at the first page would silently
      // under-report org-only tests, which is the one direction this check must not err in.
      const names: string[] = [];
      let page = await connection.tooling.query(
        "SELECT Name, Body FROM ApexClass WHERE ManageableState = 'unmanaged'",
      );
      for (;;) {
        for (const record of page.records) {
          if (!isRecord(record)) continue;
          const { Name, Body } = record as ApexClassRecord;
          if (Name === undefined || typeof Body !== 'string') continue;
          if (TEST_CLASS_MARKER.test(Body)) names.push(Name);
        }
        if (page.done !== false) break;
        if (page.nextRecordsUrl === undefined || connection.tooling.queryMore === undefined) {
          throw new Error(
            'The org has more Apex classes than one Tooling API page holds and the next page ' +
              'could not be fetched, so the list of org-only test classes would be incomplete.',
          );
        }
        page = await connection.tooling.queryMore(page.nextRecordsUrl);
      }
      return names;
    },
  };
}
