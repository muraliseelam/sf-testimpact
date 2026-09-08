/**
 * The global symbol table built from every file's declarations (DESIGN.md 5.1, pass 2).
 *
 * Every lookup here is a hash-map hit. Nothing in this module compares declarations
 * pairwise: an O(n^2) step over 5,000 classes is not an acceptable implementation of a
 * lookup, and the performance posture in DESIGN.md 10 rules it out explicitly.
 */

import {
  DEFAULT_NAMESPACE,
  STANDARD_NAMESPACE,
  makeNodeKey,
  type DeclaredType,
  type FileFacts,
  type GraphNode,
  type NodeKey,
  type NodeKind,
} from '../types.js';

/** A declaration plus the file that owns it. */
export interface Symbol_ {
  readonly key: NodeKey;
  readonly name: string;
  readonly kind: NodeKind;
  readonly namespace: string;
  readonly declaredIn: string;
  readonly declaration: DeclaredType;
}

export interface SymbolTableOptions {
  /** Project namespace from sfdx-project.json. Defaults to `c` (the unmanaged alias). */
  readonly namespace?: string;
}

/**
 * Case-insensitive name index over all declared Apex types, SObjects, fields and friends.
 *
 * Apex is case-insensitive, so every key here is lowercased. Callers pass names as written;
 * normalisation happens inside.
 */
export class SymbolTable {
  readonly namespace: string;

  /** Lowercased type name (possibly dotted, e.g. `outer.inner`) -> symbol. */
  private readonly apexTypes = new Map<string, Symbol_>();
  /** Lowercased SObject name -> symbol. */
  private readonly sobjects = new Map<string, Symbol_>();
  /** Lowercased `object.field` -> symbol. */
  private readonly fields = new Map<string, Symbol_>();
  /** Lowercased bare field name -> every symbol with that field name, on any object. */
  private readonly fieldsByName = new Map<string, Symbol_[]>();
  /** Lowercased name -> symbol, for label / custompermission / flow / permset / ui. */
  private readonly byKind = new Map<NodeKind, Map<string, Symbol_>>();

  /**
   * Direct subtypes, keyed by lowercased supertype name. Built once during construction so
   * hierarchy widening is a map lookup rather than a scan (DESIGN.md 5.3).
   */
  private readonly subtypes = new Map<string, Symbol_[]>();

  constructor(files: readonly FileFacts[], options: SymbolTableOptions = {}) {
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;

    for (const file of files) {
      for (const declaration of file.declarations) {
        this.add(declaration, file.path);
      }
    }
    this.buildHierarchy();
  }

  private add(declaration: DeclaredType, declaredIn: string): void {
    const namespace = declaration.kind === 'sobject' || declaration.kind === 'field'
      ? namespaceForMetadata(declaration.name, this.namespace)
      : this.namespace;

    const symbol: Symbol_ = {
      key: makeNodeKey(declaration.kind, namespace, declaration.name),
      name: declaration.name,
      kind: declaration.kind,
      namespace,
      declaredIn,
      declaration,
    };
    const lower = declaration.name.toLowerCase();

    switch (declaration.kind) {
      case 'apex':
      case 'apexInner':
      case 'trigger':
        this.apexTypes.set(lower, symbol);
        break;
      case 'sobject':
        this.sobjects.set(lower, symbol);
        break;
      case 'field': {
        this.fields.set(lower, symbol);
        const bare = lower.slice(lower.lastIndexOf('.') + 1);
        const existing = this.fieldsByName.get(bare);
        if (existing === undefined) this.fieldsByName.set(bare, [symbol]);
        else existing.push(symbol);
        break;
      }
      default: {
        let bucket = this.byKind.get(declaration.kind);
        if (bucket === undefined) {
          bucket = new Map();
          this.byKind.set(declaration.kind, bucket);
        }
        bucket.set(lower, symbol);
      }
    }
  }

  private buildHierarchy(): void {
    for (const symbol of this.apexTypes.values()) {
      const parents = [
        ...(symbol.declaration.superType === null ? [] : [symbol.declaration.superType]),
        ...symbol.declaration.interfaces,
      ];
      for (const parent of parents) {
        const key = parent.toLowerCase();
        const bucket = this.subtypes.get(key);
        if (bucket === undefined) this.subtypes.set(key, [symbol]);
        else bucket.push(symbol);
      }
    }
  }

  /** An Apex class, interface, enum or trigger by (possibly dotted) name. */
  lookupApexType(name: string): Symbol_ | undefined {
    return this.apexTypes.get(name.toLowerCase());
  }

  lookupSObject(name: string): Symbol_ | undefined {
    return this.sobjects.get(name.toLowerCase());
  }

  lookupField(objectName: string, fieldName: string): Symbol_ | undefined {
    return this.fields.get(`${objectName}.${fieldName}`.toLowerCase());
  }

  /**
   * Every field with this API name, on any object.
   *
   * Used for relationship traversals such as `SELECT Owner.Custom__c`, where the owning
   * object is unknown. Widening to all matches over-selects; dropping the reference would
   * under-select, which is the failure we refuse to make.
   */
  lookupFieldsByName(fieldName: string): readonly Symbol_[] {
    return this.fieldsByName.get(fieldName.toLowerCase()) ?? [];
  }

  lookupByKind(kind: NodeKind, name: string): Symbol_ | undefined {
    return this.byKind.get(kind)?.get(name.toLowerCase());
  }

  /** Direct subclasses and implementors of a type. */
  directSubtypes(name: string): readonly Symbol_[] {
    return this.subtypes.get(name.toLowerCase()) ?? [];
  }

  /**
   * All transitive subtypes of a type.
   *
   * A cycle in the declared hierarchy is impossible in valid Apex but trivially producible
   * by a malformed file, so the walk carries a visited set rather than trusting the input.
   */
  allSubtypes(name: string): readonly Symbol_[] {
    const out: Symbol_[] = [];
    const seen = new Set<string>([name.toLowerCase()]);
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) break;
      for (const sub of this.directSubtypes(current)) {
        const key = sub.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(sub);
        queue.push(sub.name);
      }
    }
    return out;
  }

  /**
   * A symbol by its node key.
   *
   * Built eagerly so hierarchy widening is a map hit per edge rather than a scan per edge.
   * The scan version is O(E * V), which over 5,000 classes is exactly the quadratic
   * behaviour DESIGN.md 10 rules out.
   */
  lookupByNodeKey(key: NodeKey): Symbol_ | undefined {
    if (this.byNodeKey === null) {
      this.byNodeKey = new Map();
      for (const bucket of [this.apexTypes, this.sobjects, this.fields, ...this.byKind.values()]) {
        for (const symbol of bucket.values()) this.byNodeKey.set(symbol.key, symbol);
      }
    }
    return this.byNodeKey.get(key);
  }

  private byNodeKey: Map<NodeKey, Symbol_> | null = null;

  /** Turns a symbol into the graph node it declares. */
  toNode(symbol: Symbol_): GraphNode {
    const { testMethods, entryPoints } = symbol.declaration;
    return {
      key: symbol.key,
      kind: symbol.kind,
      namespace: symbol.namespace,
      name: symbol.name,
      declaredIn: symbol.declaredIn,
      flags: symbol.declaration.flags,
      ...(testMethods.length > 0 ? { testMethods: [...testMethods] } : {}),
      ...(entryPoints.length > 0 ? { entryPoints: [...entryPoints] } : {}),
    };
  }
}

/**
 * Which namespace an object or field belongs to.
 *
 * A custom object (`Invoice__c`) is the project's; a standard one (`Account`) is the
 * platform's. A custom *field* on a standard object still belongs to the project, because
 * the project's repository is what declares and changes it.
 */
export function namespaceForMetadata(name: string, projectNamespace: string): string {
  return isCustomApiName(name) ? projectNamespace : STANDARD_NAMESPACE;
}

/** Custom API names end in `__c`, `__e`, `__mdt`, `__b`, `__x`, `__kav`, or `__Share`. */
export function isCustomApiName(name: string): boolean {
  const last = name.slice(name.lastIndexOf('.') + 1);
  return /__(c|e|mdt|b|x|kav|share|history|feed)$/i.test(last);
}
