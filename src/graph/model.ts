/**
 * The in-memory impact graph, plus the two indexes the query needs.
 *
 * Reverse adjacency is stored as CSR (compressed sparse row) arrays and built lazily on
 * first use, in O(V+E). It is never persisted: rebuilding is cheaper than parsing a second
 * copy off disk.
 */

import {
  type FileFacts,
  type GraphEdge,
  type GraphNode,
  type NodeKey,
  type NodeKind,
  type TaintDomain,
  type TaintRecord,
  type UnresolvedRef,
} from '../types.js';

export interface IndexedFile {
  readonly path: string;
  /** sha256 of the raw bytes, used to skip unchanged files on re-index. */
  readonly hash: string;
  readonly parsedOk: boolean;
  /** Extractor identity, e.g. `apex@1`. A change invalidates the whole index. */
  readonly extractor: string;
}

export interface ProjectInfo {
  readonly root: string;
  readonly sourcePaths: readonly string[];
  readonly namespace: string;
}

export interface GraphGenerator {
  readonly toolVersion: string;
  readonly apexParserVersion: string;
  readonly formatVersion: number;
}

/**
 * Reverse adjacency in CSR form.
 *
 * `dependents[offsets[i] .. offsets[i+1]]` are the dense indices of nodes that depend on
 * node `i` — that is, the nodes reached by walking edges backwards.
 */
export interface ReverseAdjacency {
  readonly offsets: Int32Array;
  readonly dependents: Int32Array;
}

export interface ImpactGraphInit {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly taints: readonly TaintRecord[];
  readonly unresolved: readonly UnresolvedRef[];
  readonly files: readonly IndexedFile[];
  readonly facts: readonly FileFacts[];
  readonly project: ProjectInfo;
  readonly generator: GraphGenerator;
  readonly createdAt: string;
}

/**
 * Which taint domains a change to a node of this kind can activate (DESIGN.md 6.2).
 *
 * An SObject change activates `fieldAny` as well as `sobjectAny`, and a field change
 * activates both too: dynamic SOQL reads fields, and dynamic field access happens on
 * objects. Activating both is the conservative reading, and conservative is the only
 * direction we are allowed to be wrong in.
 */
export function domainsOf(kind: NodeKind): readonly TaintDomain[] {
  switch (kind) {
    case 'apex':
    case 'apexInner':
    case 'trigger':
      return ['apexType'];
    case 'sobject':
    case 'field':
      return ['sobjectAny', 'fieldAny'];
    case 'staticresource':
      // A test that names its resource at runtime (`Test.loadData(t, resourceName)`) cannot
      // be linked to a specific bundle, so it is tainted `resourceAny`. Without this case
      // that taint would never activate and the test would be silently skipped when the
      // resource it actually loads changes.
      return ['resourceAny'];
    default:
      return [];
  }
}

export class ImpactGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly taints: readonly TaintRecord[];
  readonly unresolved: readonly UnresolvedRef[];
  readonly files: readonly IndexedFile[];
  /** Per-file extractor output, kept so incremental re-index can re-resolve globally. */
  readonly facts: readonly FileFacts[];
  readonly project: ProjectInfo;
  readonly generator: GraphGenerator;
  readonly createdAt: string;

  private readonly indexByKey: Map<NodeKey, number>;
  private readonly byDeclaringFile: Map<string, NodeKey[]>;
  private readonly taintsByDomain: Map<TaintDomain, NodeKey[]>;
  private reverse: ReverseAdjacency | null = null;

  constructor(init: ImpactGraphInit) {
    this.nodes = init.nodes;
    this.edges = init.edges;
    this.taints = init.taints;
    this.unresolved = init.unresolved;
    this.files = init.files;
    this.facts = init.facts;
    this.project = init.project;
    this.generator = init.generator;
    this.createdAt = init.createdAt;

    this.indexByKey = new Map();
    this.byDeclaringFile = new Map();
    for (const [i, node] of this.nodes.entries()) {
      this.indexByKey.set(node.key, i);
      if (node.declaredIn === null) continue;
      const bucket = this.byDeclaringFile.get(node.declaredIn);
      if (bucket === undefined) this.byDeclaringFile.set(node.declaredIn, [node.key]);
      else bucket.push(node.key);
    }

    this.taintsByDomain = new Map();
    for (const taint of this.taints) {
      const bucket = this.taintsByDomain.get(taint.domain);
      if (bucket === undefined) this.taintsByDomain.set(taint.domain, [taint.node]);
      else if (!bucket.includes(taint.node)) bucket.push(taint.node);
    }
  }

  indexOf(key: NodeKey): number | undefined {
    return this.indexByKey.get(key);
  }

  nodeAt(index: number): GraphNode | undefined {
    return this.nodes[index];
  }

  nodeByKey(key: NodeKey): GraphNode | undefined {
    const index = this.indexByKey.get(key);
    return index === undefined ? undefined : this.nodes[index];
  }

  /** Nodes declared by a file. Empty for a path the index does not know. */
  nodesDeclaredIn(path: string): readonly NodeKey[] {
    return this.byDeclaringFile.get(path) ?? [];
  }

  hasFile(path: string): boolean {
    return this.files.some((f) => f.path === path);
  }

  fileAt(path: string): IndexedFile | undefined {
    return this.files.find((f) => f.path === path);
  }

  /** Nodes carrying a taint in this domain (DESIGN.md 6.2). */
  taintedIn(domain: TaintDomain): readonly NodeKey[] {
    return this.taintsByDomain.get(domain) ?? [];
  }

  taintsOn(key: NodeKey): readonly TaintRecord[] {
    return this.taints.filter((t) => t.node === key);
  }

  /**
   * Reverse adjacency, built on first use in O(V+E).
   *
   * Two passes: count in-degree per target to fill the offset table, then place each
   * source. This is the standard CSR construction and allocates exactly two typed arrays
   * rather than a Map of arrays, which matters at 200k edges.
   */
  reverseAdjacency(): ReverseAdjacency {
    if (this.reverse !== null) return this.reverse;

    const n = this.nodes.length;
    const counts = new Int32Array(n);
    const pairs: Array<[number, number]> = [];

    for (const edge of this.edges) {
      const from = this.indexByKey.get(edge.from);
      const to = this.indexByKey.get(edge.to);
      // An edge to or from a node that is not in the graph would corrupt the offsets. The
      // resolver never produces one, but a hand-edited or truncated graph.json could.
      if (from === undefined || to === undefined) continue;
      counts[to] = (counts[to] ?? 0) + 1;
      pairs.push([to, from]);
    }

    const offsets = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) offsets[i + 1] = (offsets[i] ?? 0) + (counts[i] ?? 0);

    const dependents = new Int32Array(pairs.length);
    const cursor = Int32Array.from(offsets.subarray(0, n));
    for (const [to, from] of pairs) {
      const at = cursor[to] ?? 0;
      dependents[at] = from;
      cursor[to] = at + 1;
    }

    this.reverse = { offsets, dependents };
    return this.reverse;
  }

  /** Dense indices of the nodes that depend on `index`. */
  dependentsOf(index: number): Int32Array {
    const { offsets, dependents } = this.reverseAdjacency();
    return dependents.subarray(offsets[index] ?? 0, offsets[index + 1] ?? 0);
  }
}
