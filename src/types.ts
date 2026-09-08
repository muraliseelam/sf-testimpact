/**
 * Core domain types for the impact graph.
 *
 * See docs/DESIGN.md section 4 for the schema these types implement, and section 6 for the
 * taint model. The governing rule throughout: over-approximate freely, under-approximate
 * never. Any type here that can express "we do not know" must degrade toward selecting
 * more tests, not fewer.
 */

/** The reserved namespace for platform types and standard objects (`Account`, `System`). */
export const STANDARD_NAMESPACE = 'standard';

/** Salesforce's alias for the unmanaged/default namespace. */
export const DEFAULT_NAMESPACE = 'c';

export type NodeKind =
  | 'apex'
  | 'apexInner'
  | 'trigger'
  | 'sobject'
  | 'field'
  | 'flow'
  | 'permset'
  | 'label'
  | 'custompermission'
  | 'staticresource';

export type EdgeKind =
  | 'extends'
  | 'implements'
  | 'refType'
  | 'soqlRead'
  | 'dml'
  | 'describe'
  | 'triggerOn'
  | 'memberOf'
  | 'formulaRef'
  | 'flowInvokes'
  | 'flowTouches'
  | 'grants'
  | 'labelRef'
  | 'permRef'
  | 'translates'
  | 'usesResource';

/**
 * How confidently an edge was derived (DESIGN.md section 4.3.1).
 *
 * This exists so `bench/` can recompute selection with a provenance class excluded and
 * report its marginal contribution. A heuristic we cannot measure is a heuristic we cannot
 * justify keeping.
 */
export type Provenance = 'ast' | 'xml' | 'regex' | 'widened';

/**
 * Why a type is reachable from outside this repository (DESIGN.md 6.3).
 *
 * Recorded per node rather than collapsed into a single boolean so that
 * `entryPointPolicy: widen` can widen within a category — "some other REST resource may
 * call into this subsystem" — instead of degrading to every entry point in the org, which
 * would make `widen` indistinguishable from `full`.
 */
export type EntryPointKind =
  | 'rest'
  | 'aura'
  | 'invocable'
  | 'future'
  | 'remote'
  | 'schedulable'
  | 'batchable'
  | 'queueable'
  | 'email'
  | 'trigger'
  | 'global';

/**
 * The region of the graph an unresolvable reference might point into (DESIGN.md 6.2).
 *
 * Taint is stored as a property of the tainted node rather than as edges to every node in
 * the domain: materialising those edges would be O(n^2), which our performance posture
 * rules out.
 */
export type TaintDomain = 'apexType' | 'sobjectAny' | 'fieldAny' | 'resourceAny';

/** Node flags. A bitmask so the on-disk form stays compact (DESIGN.md 4.2). */
export const NodeFlags = {
  NONE: 0,
  /** `@IsTest` class, or a class with a `testMethod` member. Eligible for selection. */
  IS_TEST: 1 << 0,
  /** `@IsTest(SeeAllData=true)` — depends on org data we cannot see, so it always runs. */
  SEE_ALL_DATA: 1 << 1,
  IS_ABSTRACT: 1 << 2,
  IS_INTERFACE: 1 << 3,
  /** `global` visibility — callers may live outside this repo. */
  IS_GLOBAL: 1 << 4,
  /** Reachable from outside the repo: @RestResource, @AuraEnabled, Schedulable, triggers. */
  ENTRY_POINT: 1 << 5,
  /** Namespace is neither the project's nor `standard`: a managed package, no source. */
  IS_EXTERNAL: 1 << 6,
  /** The extractor could not produce facts for the declaring file. Forces a full run. */
  PARSE_FAILED: 1 << 7,
} as const;

export type NodeFlag = (typeof NodeFlags)[keyof typeof NodeFlags];

export function hasFlag(flags: number, flag: NodeFlag): boolean {
  return (flags & flag) !== 0;
}

export interface SourceLoc {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export function formatLoc(loc: SourceLoc): string {
  return `${loc.file}:${loc.line}:${loc.column}`;
}

/**
 * A node key is `<kind>:<namespace>.<normalised name>`.
 *
 * Apex is case-insensitive, so the name is lowercased exactly once — here. Normalising in
 * more than one place is how `AccountService` and `Accountservice` become two nodes and a
 * dependency silently disappears.
 */
export type NodeKey = string & { readonly __brand: 'NodeKey' };

export function makeNodeKey(kind: NodeKind, namespace: string, name: string): NodeKey {
  return `${kind}:${namespace.toLowerCase()}.${name.toLowerCase()}` as NodeKey;
}

export interface GraphNode {
  readonly key: NodeKey;
  readonly kind: NodeKind;
  readonly namespace: string;
  /** Display casing, as written in source. Never used for identity. */
  readonly name: string;
  /** Path of the file that declares this node; null for referenced-only nodes. */
  readonly declaredIn: string | null;
  readonly flags: number;
  readonly testMethods?: readonly string[];
  /** Present when ENTRY_POINT is set; the categories that made it one. */
  readonly entryPoints?: readonly EntryPointKind[];
}

export interface GraphEdge {
  readonly from: NodeKey;
  readonly to: NodeKey;
  readonly kind: EdgeKind;
  /**
   * The file whose extraction emitted this edge. Every edge is owned by exactly one file;
   * that invariant is what makes incremental re-indexing sound (DESIGN.md 4.4).
   */
  readonly ownerFile: string;
  readonly provenance: Provenance;
}

export interface TaintRecord {
  readonly node: NodeKey;
  readonly domain: TaintDomain;
  /** The construct responsible, e.g. `Type.forName`. Shown to users verbatim. */
  readonly cause: string;
  readonly at: SourceLoc;
  readonly ownerFile: string;
}

/**
 * Why a reference produced no edge.
 *
 * `ignored-local-variable` is the only disposition that intentionally drops a candidate,
 * and it is sound: the declaration of that variable is itself a type reference, so the
 * edge to its type is captured there instead. See `extract/apex.ts`.
 */
export type UnresolvedDisposition =
  | 'ignored-local-variable'
  | 'ignored-class-member'
  | 'external-symbol'
  | 'unknown';

export interface UnresolvedRef {
  readonly text: string;
  readonly at: SourceLoc;
  readonly disposition: UnresolvedDisposition;
  readonly ownerFile: string;
}

// ---------------------------------------------------------------------------------------
// Extractor output — the contract between `extract/` and `resolve/`
// ---------------------------------------------------------------------------------------

/**
 * A type declared by a file, with its references still unresolved.
 *
 * Extractors know nothing about other files, so everything here is raw text to be resolved
 * globally in pass 2 (DESIGN.md 5.1).
 */
export interface DeclaredType {
  /** Display name. Inner types are `Outer.Inner`. */
  readonly name: string;
  readonly kind: NodeKind;
  readonly flags: number;
  /** Raw `extends` name, if any. Resolved later. */
  readonly superType: string | null;
  /** Raw `implements` names. Resolved later. */
  readonly interfaces: readonly string[];
  readonly testMethods: readonly string[];
  readonly entryPoints: readonly EntryPointKind[];
  readonly loc: SourceLoc;
}

/** What kind of thing a raw reference points at, before resolution. */
export type RawReferenceKind =
  /** Apex-style ambiguous name: try every dotted prefix as a type, then an SObject. */
  | 'type'
  /** Strictly an Apex type name. Used by XML sources, which are never ambiguous. */
  | 'apexType'
  | 'soqlObject'
  | 'soqlField'
  | 'dmlObject'
  | 'triggerObject'
  /** An SObject named unambiguously by metadata. */
  | 'sobject'
  /** A field named unambiguously by metadata, as `Object.Field`. */
  | 'field'
  | 'label'
  | 'customPermission'
  | 'staticResource';

/**
 * Marker prefix for a field whose owning object we could not determine — a relationship
 * traversal such as `SELECT Owner.Custom__c`. Written as `*.Custom__c`.
 *
 * The resolver widens these to every object declaring a field of that name. Dropping them
 * instead would be an under-approximation, and resolving them properly needs relationship
 * metadata we do not model in v1.
 */
export const UNKNOWN_OBJECT = '*';

export interface RawReference {
  /** Display name of the declared type that contains this reference. */
  readonly from: string;
  /** The name as written, e.g. `ContactService` or `Account.Rating__c`. */
  readonly text: string;
  readonly kind: RawReferenceKind;
  readonly at: SourceLoc;
  readonly provenance: Provenance;
  /**
   * Edge kind to emit, when it differs from the default for this reference kind.
   *
   * A permission set and a Flow both point at an Apex class, but one is a `grants` edge and
   * the other a `flowInvokes`. The resolution strategy is identical; only the label differs.
   */
  readonly edgeKind?: EdgeKind;
}

export interface RawTaint {
  /** Display name of the declared type that contains the dynamic construct. */
  readonly from: string;
  readonly domain: TaintDomain;
  readonly cause: string;
  readonly at: SourceLoc;
  /**
   * Apply this taint only if the named type resolves to an SObject.
   *
   * `rec.get('Name')` is dynamic field access when `rec` is an SObject and an ordinary map
   * lookup when it is a `Map`. An extractor cannot tell them apart — it knows only the
   * declared type's spelling — so it defers the decision to the resolver, which has the
   * global symbol table. Tainting every `.get()` call unconditionally would taint nearly
   * every class in the org and make the tool useless.
   */
  readonly conditionalOnType?: string;
}

export interface Diagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly at: SourceLoc;
}

/**
 * Everything one file contributes to the graph.
 *
 * Extractors are pure functions `(path, contents) -> FileFacts`: no I/O, no global state,
 * no knowledge of any other file. That is what makes pass 1 parallelisable and the unit
 * tests real rather than ceremonial.
 */
export interface FileFacts {
  readonly path: string;
  /**
   * Extractor identity, e.g. `apex@1`. Bumped whenever extraction semantics change, so a
   * stale index is detected rather than silently mixing old and new facts (DESIGN.md 7.3).
   */
  readonly extractor: string;
  /** False means the file could not be parsed: a changed file with this set forces a full run. */
  readonly parsedOk: boolean;
  readonly declarations: readonly DeclaredType[];
  readonly references: readonly RawReference[];
  readonly taints: readonly RawTaint[];
  readonly unresolved: readonly UnresolvedRef[];
  readonly diagnostics: readonly Diagnostic[];
}
