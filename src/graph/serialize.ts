/**
 * On-disk format for `.sf-testimpact/graph.json` (DESIGN.md 4.4).
 *
 * Columnar, with every repeated string interned into one table. Class names, file paths and
 * edge kinds repeat thousands of times in a real project; interning turns a 30-40 MB
 * document into a few megabytes and keeps `JSON.parse` inside the five-second incremental
 * budget.
 *
 * **What is stored, and why it differs from the sketch in DESIGN.md 4.4.**
 * The persisted artifact is the per-file *extractor facts*, not the resolved nodes and
 * edges. Resolution is then redone on load. This is deliberate: resolution is global, so a
 * newly added class can make a reference in an untouched file resolve for the first time,
 * and hierarchy widening changes edges out of every consumer of an interface whenever any
 * implementor is added. Patching a stored edge list correctly under those conditions needs
 * bookkeeping that is easy to get subtly wrong, and being subtly wrong here means a missing
 * edge and a missed test. Re-resolving from facts is complete by construction, and cheap:
 * parsing is ~95% of index cost, and resolution is hash-map lookups.
 */

import {
  type DeclaredType,
  type Diagnostic,
  type EntryPointKind,
  type FileFacts,
  type NodeKind,
  type Provenance,
  type RawReference,
  type RawReferenceKind,
  type RawTaint,
  type SourceLoc,
  type TaintDomain,
  type UnresolvedDisposition,
  type UnresolvedRef,
} from '../types.js';
import { type GraphGenerator, type IndexedFile, type ProjectInfo } from './model.js';

/** Index into the interned string table. -1 encodes absent. */
type StringRef = number;

/** [nameRef, kind, flags, superRef, interfaceRefs, testMethodRefs, entryPoints, line, col] */
type SerializedDeclaration = [
  StringRef,
  NodeKind,
  number,
  StringRef,
  StringRef[],
  StringRef[],
  EntryPointKind[],
  number,
  number,
];

/** [fromRef, textRef, kind, provenance, line, col] */
type SerializedReference = [StringRef, StringRef, RawReferenceKind, Provenance, number, number];

/** [fromRef, domain, causeRef, line, col, conditionalOnTypeRef] */
type SerializedTaint = [StringRef, TaintDomain, StringRef, number, number, StringRef];

/** [textRef, disposition, line, col] */
type SerializedUnresolved = [StringRef, UnresolvedDisposition, number, number];

/** [severity, messageRef, line, col] */
type SerializedDiagnostic = [0 | 1, StringRef, number, number];

interface SerializedFile {
  readonly p: StringRef;
  readonly h: string;
  readonly x: StringRef;
  readonly ok: 0 | 1;
  readonly d: SerializedDeclaration[];
  readonly r: SerializedReference[];
  readonly t: SerializedTaint[];
  readonly u: SerializedUnresolved[];
  readonly g: SerializedDiagnostic[];
}

export interface SerializedGraph {
  readonly formatVersion: number;
  readonly toolVersion: string;
  readonly generator: { readonly apexParser: string };
  readonly createdAt: string;
  readonly project: ProjectInfo;
  readonly strings: string[];
  readonly files: SerializedFile[];
}

class Interner {
  readonly strings: string[] = [];
  private readonly index = new Map<string, number>();

  ref(value: string): StringRef {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.strings.length;
    this.strings.push(value);
    this.index.set(value, next);
    return next;
  }

  /** -1 for absent, so optional fields cost one number rather than a key. */
  optional(value: string | null | undefined): StringRef {
    return value === null || value === undefined ? -1 : this.ref(value);
  }
}

export interface SerializeInput {
  readonly files: readonly IndexedFile[];
  readonly facts: readonly FileFacts[];
  readonly project: ProjectInfo;
  readonly generator: GraphGenerator;
  readonly createdAt: string;
}

export function serializeGraph(input: SerializeInput): SerializedGraph {
  const pool = new Interner();
  const factsByPath = new Map(input.facts.map((f) => [f.path, f]));

  const files: SerializedFile[] = input.files.map((file) => {
    const facts = factsByPath.get(file.path);
    return {
      p: pool.ref(file.path),
      h: file.hash,
      x: pool.ref(file.extractor),
      ok: file.parsedOk ? 1 : 0,
      d: (facts?.declarations ?? []).map((d): SerializedDeclaration => [
        pool.ref(d.name),
        d.kind,
        d.flags,
        pool.optional(d.superType),
        d.interfaces.map((i) => pool.ref(i)),
        d.testMethods.map((m) => pool.ref(m)),
        [...d.entryPoints],
        d.loc.line,
        d.loc.column,
      ]),
      r: (facts?.references ?? []).map((r): SerializedReference => [
        pool.ref(r.from),
        pool.ref(r.text),
        r.kind,
        r.provenance,
        r.at.line,
        r.at.column,
      ]),
      t: (facts?.taints ?? []).map((t): SerializedTaint => [
        pool.ref(t.from),
        t.domain,
        pool.ref(t.cause),
        t.at.line,
        t.at.column,
        pool.optional(t.conditionalOnType),
      ]),
      u: (facts?.unresolved ?? []).map((u): SerializedUnresolved => [
        pool.ref(u.text),
        u.disposition,
        u.at.line,
        u.at.column,
      ]),
      g: (facts?.diagnostics ?? []).map((g): SerializedDiagnostic => [
        g.severity === 'error' ? 0 : 1,
        pool.ref(g.message),
        g.at.line,
        g.at.column,
      ]),
    };
  });

  return {
    formatVersion: input.generator.formatVersion,
    toolVersion: input.generator.toolVersion,
    generator: { apexParser: input.generator.apexParserVersion },
    createdAt: input.createdAt,
    project: input.project,
    strings: pool.strings,
    files,
  };
}

export interface DeserializedGraph {
  readonly files: IndexedFile[];
  readonly facts: FileFacts[];
  readonly project: ProjectInfo;
  readonly generator: GraphGenerator;
  readonly createdAt: string;
}

export function deserializeGraph(doc: SerializedGraph): DeserializedGraph {
  const pool = doc.strings;
  const str = (ref: StringRef): string => {
    const value = pool[ref];
    if (value === undefined) throw new Error(`string reference ${ref} is out of range`);
    return value;
  };
  const optional = (ref: StringRef): string | null => (ref === -1 ? null : str(ref));

  const files: IndexedFile[] = [];
  const facts: FileFacts[] = [];

  for (const file of doc.files) {
    const path = str(file.p);
    const extractor = str(file.x);
    const loc = (line: number, column: number): SourceLoc => ({ file: path, line, column });

    files.push({ path, hash: file.h, parsedOk: file.ok === 1, extractor });
    facts.push({
      path,
      extractor,
      parsedOk: file.ok === 1,
      declarations: file.d.map(
        ([name, kind, flags, superRef, ifaces, methods, entryPoints, line, col]): DeclaredType => ({
          name: str(name),
          kind,
          flags,
          superType: optional(superRef),
          interfaces: ifaces.map(str),
          testMethods: methods.map(str),
          entryPoints,
          loc: loc(line, col),
        }),
      ),
      references: file.r.map(([from, text, kind, provenance, line, col]): RawReference => ({
        from: str(from),
        text: str(text),
        kind,
        provenance,
        at: loc(line, col),
      })),
      taints: file.t.map(([from, domain, cause, line, col, conditional]): RawTaint => {
        const conditionalOnType = optional(conditional);
        return {
          from: str(from),
          domain,
          cause: str(cause),
          at: loc(line, col),
          ...(conditionalOnType === null ? {} : { conditionalOnType }),
        };
      }),
      unresolved: file.u.map(([text, disposition, line, col]): UnresolvedRef => ({
        text: str(text),
        disposition,
        at: loc(line, col),
        ownerFile: path,
      })),
      diagnostics: file.g.map(([severity, message, line, col]): Diagnostic => ({
        severity: severity === 0 ? 'error' : 'warning',
        message: str(message),
        at: loc(line, col),
      })),
    });
  }

  return {
    files,
    facts,
    project: doc.project,
    generator: {
      formatVersion: doc.formatVersion,
      toolVersion: doc.toolVersion,
      apexParserVersion: doc.generator.apexParser,
    },
    createdAt: doc.createdAt,
  };
}
