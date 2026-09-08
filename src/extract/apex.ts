/**
 * Apex extractor: `.cls` and `.trigger` -> FileFacts.
 *
 * Pure. No I/O, no global state, no knowledge of any other file. Every name it produces is
 * raw text for the resolver to bind in pass 2 (DESIGN.md 5.1).
 *
 * The one rule that governs every decision here: **a reference we are unsure about is
 * emitted, not dropped.** Extra edges cost test minutes; missing edges cost incidents. The
 * single exception is documented at `isVariable` below, and it is sound.
 */

import {
  ApexErrorListener,
  ApexParseTreeWalker,
  ApexParserBaseListener,
  ApexParserFactory,
  // Imported as a value, not a type: the dotted-chain flattener needs `instanceof`.
  DotExpressionContext,
  type AnyIdContext,
  type BlockContext,
  type CatchClauseContext,
  type ClassDeclarationContext,
  type CompilationUnitContext,
  type ConstructorDeclarationContext,
  type CreatedNameContext,
  type DeleteStatementContext,
  type EnhancedForControlContext,
  type EnumDeclarationContext,
  type ExpressionContext,
  type FieldDeclarationContext,
  type FormalParameterContext,
  type ForStatementContext,
  type InterfaceDeclarationContext,
  type InsertStatementContext,
  type LocalVariableDeclarationContext,
  type MergeStatementContext,
  type MethodDeclarationContext,
  type ModifierContext,
  type PropertyDeclarationContext,
  type QueryContext,
  type SoslLiteralContext,
  type UndeleteStatementContext,
  type UpdateStatementContext,
  type UpsertStatementContext,
  type TriggerUnitContext,
  type TypeRefContext,
} from '@apexdevtools/apex-parser';

import {
  NodeFlags,
  UNKNOWN_OBJECT,
  type DeclaredType,
  type Diagnostic,
  type EntryPointKind,
  type FileFacts,
  type NodeKind,
  type RawReference,
  type RawTaint,
  type SourceLoc,
  type UnresolvedRef,
} from '../types.js';

/**
 * Extractor identity. **Bump this whenever extraction semantics change.**
 *
 * A graph built by a different identity is stale and forces a re-index (DESIGN.md 7.3).
 * Without it a parser or rule upgrade would silently mix old and new facts, which is the
 * one class of bug this project cannot afford.
 */
export const APEX_EXTRACTOR_ID = 'apex@1';

// ---------------------------------------------------------------------------------------
// Dynamic-construct tables (DESIGN.md 6.2)
// ---------------------------------------------------------------------------------------

/**
 * `<receiver>.<method>` forms whose target class is computed at runtime.
 *
 * The async-job entries below take an *instance* rather than a class name, and we cannot
 * tell a statically constructed `new AccountBatch()` from one obtained through
 * `Type.forName` without dataflow analysis we do not do. DESIGN.md 6.2 lists
 * `Database.executeBatch` "with a dynamically obtained instance" as an `apexType` trigger,
 * so the conservative branch is taken for all of them: over-selecting tests costs minutes,
 * missing one costs an incident.
 */
const DYNAMIC_APEX_CALLS: ReadonlyMap<string, string> = new Map([
  ['type.forname', 'Type.forName'],
  ['type.newinstance', 'Type.newInstance'],
  ['database.executebatch', 'Database.executeBatch'],
  ['system.enqueuejob', 'System.enqueueJob'],
  ['system.schedule', 'System.schedule'],
  ['system.schedulebatch', 'System.scheduleBatch'],
]);

/** `<receiver>.<method>` forms that may read any object or field. */
const DYNAMIC_SOQL_CALLS: ReadonlyMap<string, string> = new Map([
  ['database.query', 'Database.query'],
  ['database.querywithbinds', 'Database.queryWithBinds'],
  ['database.countquery', 'Database.countQuery'],
  ['database.countquerywithbinds', 'Database.countQueryWithBinds'],
  ['database.getquerylocator', 'Database.getQueryLocator'],
  ['database.getquerylocatorwithbinds', 'Database.getQueryLocatorWithBinds'],
  ['search.query', 'Search.query'],
  ['schema.getglobaldescribe', 'Schema.getGlobalDescribe'],
]);

/** Bare method names that are dynamic regardless of receiver. */
const DYNAMIC_BARE_METHODS: ReadonlyMap<string, { cause: string; domain: 'apexType' | 'sobjectAny' | 'fieldAny' }> =
  new Map([
    ['getglobaldescribe', { cause: 'Schema.getGlobalDescribe', domain: 'sobjectAny' }],
    ['newinstance', { cause: 'Type.newInstance', domain: 'apexType' }],
    ['getpopulatedfieldsasmap', { cause: 'SObject.getPopulatedFieldsAsMap', domain: 'fieldAny' }],
    // Reached through a variable holding the class, e.g. `Database.executeBatch(job)` where
    // `job` came from a factory, or a `db.executeBatch(...)` wrapper.
    ['executebatch', { cause: 'Database.executeBatch', domain: 'apexType' }],
    ['enqueuejob', { cause: 'System.enqueueJob', domain: 'apexType' }],
  ]);

/** Methods that read or write a field by name, when the receiver is an SObject. */
const DYNAMIC_FIELD_METHODS: ReadonlySet<string> = new Set(['get', 'put', 'getsobject', 'putsobject']);

/**
 * Annotations that make a type reachable from outside this repository (DESIGN.md 6.3),
 * mapped to the category that `entryPointPolicy: widen` widens within.
 */
const ENTRY_POINT_ANNOTATIONS: ReadonlyMap<string, EntryPointKind> = new Map([
  ['@restresource', 'rest'],
  ['@httpget', 'rest'],
  ['@httppost', 'rest'],
  ['@httpput', 'rest'],
  ['@httpdelete', 'rest'],
  ['@httppatch', 'rest'],
  ['@auraenabled', 'aura'],
  ['@invocablemethod', 'invocable'],
  ['@invocablevariable', 'invocable'],
  ['@future', 'future'],
  ['@remoteaction', 'remote'],
]);

/** Interfaces whose implementors are invoked by the platform, not by repository code. */
const ENTRY_POINT_INTERFACES: ReadonlyMap<string, EntryPointKind> = new Map([
  ['schedulable', 'schedulable'],
  ['database.schedulable', 'schedulable'],
  ['database.batchable', 'batchable'],
  ['queueable', 'queueable'],
  ['messaging.inboundemailhandler', 'email'],
]);

/** The entry-point category a modifier confers, if any. */
function entryPointOfModifier(modifier: string): EntryPointKind | undefined {
  const bare = modifier.split('(')[0] ?? modifier;
  if (bare === 'global') return 'global';
  return ENTRY_POINT_ANNOTATIONS.get(bare);
}

// ---------------------------------------------------------------------------------------
// ANTLR helpers
// ---------------------------------------------------------------------------------------

/**
 * ANTLR's generated TypeScript declares optional children as non-nullable, but the runtime
 * returns null when the child is absent. Every optional child access goes through this so
 * the lie is contained in one place instead of producing surprise null dereferences.
 */
function opt<T>(value: T): T | null {
  return value ?? null;
}

interface HasStart {
  readonly start: { readonly line: number; readonly column: number };
}

function locOf(file: string, ctx: HasStart): SourceLoc {
  return { file, line: ctx.start.line, column: ctx.start.column };
}

interface MaybeModifiers {
  modifier_list?: () => ModifierContext[];
  parentCtx?: MaybeModifiers | null;
}

function modifierTexts(ctx: MaybeModifiers | null | undefined): string[] {
  const list = ctx?.modifier_list?.();
  return list === undefined || list === null ? [] : list.map((m) => m.getText());
}

/**
 * Modifiers of a declaration live on its parent (`typeDeclaration`) for a top-level type and
 * on its grandparent (`classBodyDeclaration`) for a member. Both are checked because the
 * same declaration context appears in both positions.
 */
function declarationModifiers(ctx: { parentCtx: unknown }): string[] {
  // ANTLR types parentCtx as ParserRuleContext, which does not expose the generated
  // `modifier_list` accessor, so the shape is asserted once here.
  const parent = ctx.parentCtx as MaybeModifiers | null;
  const own = modifierTexts(parent);
  if (own.length > 0) return own;
  return modifierTexts(parent?.parentCtx ?? null);
}

/** Strips generic arguments: `List<Account>` -> `List`. */
function baseTypeName(text: string): string {
  const lt = text.indexOf('<');
  const bracket = text.indexOf('[');
  const end = Math.min(lt === -1 ? text.length : lt, bracket === -1 ? text.length : bracket);
  return text.slice(0, end);
}

/** The dotted name of a `typeRef`, without generic arguments: `Outer.Inner`, `List`. */
function typeRefName(ctx: TypeRefContext): string {
  return ctx
    .typeName_list()
    .map((n) => baseTypeName(n.getText()))
    .filter((n) => n.length > 0)
    .join('.');
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Apex methods on `Database` that perform DML (DESIGN.md 4.3, `dml` edge). */
const DATABASE_DML_METHODS: ReadonlySet<string> = new Set([
  'insert', 'insertimmediate', 'update', 'updateimmediate', 'upsert',
  'delete', 'deleteimmediate', 'undelete', 'merge', 'insertasync', 'updateasync',
]);

/**
 * The SObject a DML statement acts on, given a declared type.
 *
 * DML on a collection touches its ELEMENT type — `update contacts` where `contacts` is
 * `List<Contact>` is a dependency on Contact, not on List. Collections are unwrapped
 * repeatedly so `List<List<Account>>` still resolves to Account, and a Map yields its value
 * type, which is what `upsert someMap.values()` acts on.
 */
export function dmlTargetType(declaredType: string): string | null {
  let current = declaredType.trim();
  for (let depth = 0; depth < 8; depth++) {
    const generic = /^(list|set|map)\s*<(.+)>$/i.exec(current);
    if (generic === null) break;
    const args = splitTypeArguments(generic[2] ?? '');
    const last = args[args.length - 1];
    if (last === undefined) return null;
    current = last.trim();
  }
  const bare = current.replace(/\[\]$/, '').trim();
  return IDENTIFIER.test(bare) || /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(bare)
    ? bare
    : null;
}

/** Splits `String,Account` on top-level commas only, so nested generics survive. */
function splitTypeArguments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** The single-quoted argument of a call, when there is exactly one and it is a literal. */
function singleStringLiteralArg(callText: string): string | null {
  const match = /^[A-Za-z0-9_]+\('([^']*)'\)$/.exec(callText);
  return match?.[1] ?? null;
}

/**
 * The last single-quoted argument of a call, for forms whose resource name is not the only
 * argument: `Test.loadData(Account.sObjectType, 'TestData')`.
 */
function lastStringLiteralArg(callText: string): string | null {
  const matches = [...callText.matchAll(/'([^']*)'/g)];
  const last = matches[matches.length - 1];
  return last?.[1] ?? null;
}

/** The method name of a `dotMethodCall`, lowercased. `forName('A')` -> `forname`. */
function callName(callText: string): string {
  const match = /^([A-Za-z0-9_]+)\(/.exec(callText);
  return match?.[1]?.toLowerCase() ?? '';
}

// ---------------------------------------------------------------------------------------
// Pass 1: declarations
// ---------------------------------------------------------------------------------------

interface TypeInfo {
  readonly declaration: DeclaredType;
  /** Lowercased field and property names, used to reject member reads as type references. */
  readonly members: Set<string>;
}

class DeclarationCollector extends ApexParserBaseListener {
  readonly types = new Map<string, TypeInfo>();
  private readonly stack: string[] = [];

  constructor(private readonly file: string) {
    super();
  }

  private qualify(name: string): string {
    return this.stack.length === 0 ? name : `${this.stack.join('.')}.${name}`;
  }

  private record(
    name: string,
    kind: NodeKind,
    flags: number,
    superType: string | null,
    interfaces: readonly string[],
    entryPoints: readonly EntryPointKind[],
    ctx: HasStart,
  ): void {
    const qualified = this.qualify(name);
    this.types.set(qualified, {
      declaration: {
        name: qualified,
        kind,
        flags,
        superType,
        interfaces,
        testMethods: [],
        entryPoints,
        loc: locOf(this.file, ctx),
      },
      members: new Set<string>(),
    });
  }

  private currentType(): TypeInfo | undefined {
    return this.stack.length === 0 ? undefined : this.types.get(this.stack.join('.'));
  }

  enterClassDeclaration = (ctx: ClassDeclarationContext): void => {
    const mods = declarationModifiers(ctx).map((m) => m.toLowerCase());
    const superRef = opt(ctx.typeRef());
    const implementsList = opt(ctx.typeList());
    const interfaces =
      implementsList === null
        ? []
        : implementsList.typeRef_list().map((t) => typeRefName(t));

    let flags = NodeFlags.NONE;
    if (mods.some((m) => m.startsWith('@istest'))) flags |= NodeFlags.IS_TEST;
    if (mods.some((m) => m.replace(/\s+/g, '').includes('seealldata=true'))) {
      flags |= NodeFlags.SEE_ALL_DATA;
    }
    if (mods.includes('abstract')) flags |= NodeFlags.IS_ABSTRACT;
    if (mods.includes('global')) flags |= NodeFlags.IS_GLOBAL;

    const entryPoints = new Set<EntryPointKind>();
    for (const modifier of mods) {
      const found = entryPointOfModifier(modifier);
      if (found !== undefined) entryPoints.add(found);
    }
    for (const iface of interfaces) {
      const found = ENTRY_POINT_INTERFACES.get(iface.toLowerCase());
      if (found !== undefined) entryPoints.add(found);
    }
    if (entryPoints.size > 0) flags |= NodeFlags.ENTRY_POINT;

    const kind: NodeKind = this.stack.length === 0 ? 'apex' : 'apexInner';
    this.record(
      ctx.id().getText(),
      kind,
      flags,
      superRef === null ? null : typeRefName(superRef),
      interfaces,
      [...entryPoints],
      ctx,
    );
    this.stack.push(ctx.id().getText());
  };

  exitClassDeclaration = (): void => {
    this.stack.pop();
  };

  enterInterfaceDeclaration = (ctx: InterfaceDeclarationContext): void => {
    const mods = declarationModifiers(ctx).map((m) => m.toLowerCase());
    let flags: number = NodeFlags.IS_INTERFACE;
    if (mods.includes('global')) flags |= NodeFlags.IS_GLOBAL;
    const extendsList = opt(ctx.typeList());
    const interfaces = extendsList === null ? [] : extendsList.typeRef_list().map((t) => typeRefName(t));
    this.record(
      ctx.id().getText(),
      this.stack.length === 0 ? 'apex' : 'apexInner',
      flags,
      null,
      interfaces,
      [],
      ctx,
    );
    this.stack.push(ctx.id().getText());
  };

  exitInterfaceDeclaration = (): void => {
    this.stack.pop();
  };

  enterEnumDeclaration = (ctx: EnumDeclarationContext): void => {
    this.record(
      ctx.id().getText(),
      this.stack.length === 0 ? 'apex' : 'apexInner',
      NodeFlags.NONE,
      null,
      [],
      [],
      ctx,
    );
    this.stack.push(ctx.id().getText());
  };

  exitEnumDeclaration = (): void => {
    this.stack.pop();
  };

  enterTriggerUnit = (ctx: TriggerUnitContext): void => {
    const ids = ctx.id_list();
    const name = ids[0]?.getText() ?? '';
    // A trigger is invoked by the platform, never by repository code, so its inbound edges
    // are incomplete by definition.
    this.record(name, 'trigger', NodeFlags.ENTRY_POINT, null, [], ['trigger'], ctx);
    this.stack.push(name);
  };

  exitTriggerUnit = (): void => {
    this.stack.pop();
  };

  enterMethodDeclaration = (ctx: MethodDeclarationContext): void => {
    const info = this.currentType();
    if (info === undefined) return;
    const mods = declarationModifiers(ctx).map((m) => m.toLowerCase());

    const methodEntryPoints = mods
      .map((m) => entryPointOfModifier(m))
      .filter((k): k is EntryPointKind => k !== undefined);
    if (methodEntryPoints.length > 0) {
      // A method-level entry point makes the whole type externally reachable.
      this.types.set(info.declaration.name, {
        declaration: {
          ...info.declaration,
          flags: info.declaration.flags | NodeFlags.ENTRY_POINT,
          entryPoints: [...new Set([...info.declaration.entryPoints, ...methodEntryPoints])],
        },
        members: info.members,
      });
    }

    const isTestMethod = mods.includes('testmethod') || mods.some((m) => m.startsWith('@istest'));
    if (isTestMethod) {
      const updated: DeclaredType = {
        ...info.declaration,
        flags: info.declaration.flags | NodeFlags.IS_TEST,
        testMethods: [...info.declaration.testMethods, ctx.id().getText()],
      };
      this.types.set(info.declaration.name, { declaration: updated, members: info.members });
    }
  };

  enterFieldDeclaration = (ctx: FieldDeclarationContext): void => {
    const info = this.currentType();
    if (info === undefined) return;
    for (const d of ctx.variableDeclarators().variableDeclarator_list()) {
      info.members.add(d.id().getText().toLowerCase());
    }
  };

  enterPropertyDeclaration = (ctx: PropertyDeclarationContext): void => {
    const info = this.currentType();
    if (info === undefined) return;
    info.members.add(ctx.id().getText().toLowerCase());
  };
}

// ---------------------------------------------------------------------------------------
// Pass 2: references, with lexical scope tracking
// ---------------------------------------------------------------------------------------

class ReferenceCollector extends ApexParserBaseListener {
  readonly references: RawReference[] = [];
  readonly taints: RawTaint[] = [];
  readonly unresolved: UnresolvedRef[] = [];

  /**
   * Innermost-last. Maps a lowercased variable name to its declared type.
   *
   * `base` is the type with generic arguments stripped (`List<Contact>` -> `List`), which is
   * what the receiver checks want. `full` keeps the arguments, because a DML statement on a
   * collection depends on the ELEMENT type: `update contacts` touches Contact, not List.
   */
  private readonly scopes: Array<Map<string, { base: string; full: string }>> = [];
  private readonly typeStack: string[] = [];

  constructor(
    private readonly file: string,
    private readonly types: ReadonlyMap<string, TypeInfo>,
  ) {
    super();
  }

  private get currentTypeName(): string {
    return this.typeStack.length === 0 ? '' : this.typeStack.join('.');
  }

  private push(): void {
    this.scopes.push(new Map());
  }

  private pop(): void {
    this.scopes.pop();
  }

  private declare(name: string, base: string, full: string = base): void {
    this.scopes[this.scopes.length - 1]?.set(name.toLowerCase(), { base, full });
  }

  /**
   * The declared type of a name, if it is a variable in scope.
   *
   * **This is the only place the extractor drops a candidate reference, and it is sound:**
   * a variable's declaration is itself a type reference, so the edge to its type is already
   * captured there. `Baz b = ...; b.doIt();` yields the edge to `Baz` from the declaration,
   * not from the call. Scoping is lexical and walked in source order, so a variable declared
   * after a reference — or in a sibling block — correctly does not shadow it.
   */
  private variableType(name: string): string | null {
    return this.variableBinding(name)?.base ?? null;
  }

  /** The declared type of a variable in scope, with generic arguments intact. */
  private variableFullType(name: string): string | null {
    return this.variableBinding(name)?.full ?? null;
  }

  private variableBinding(name: string): { base: string; full: string } | undefined {
    const key = name.toLowerCase();
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]?.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Whether a name is a field or property of the enclosing type, or any type enclosing it. */
  private isClassMember(name: string): boolean {
    const key = name.toLowerCase();
    for (let i = this.typeStack.length; i > 0; i--) {
      const info = this.types.get(this.typeStack.slice(0, i).join('.'));
      if (info?.members.has(key) === true) return true;
    }
    return false;
  }

  private addReference(text: string, kind: RawReference['kind'], ctx: HasStart): void {
    if (text.length === 0) return;
    this.references.push({
      from: this.currentTypeName,
      text,
      kind,
      at: locOf(this.file, ctx),
      provenance: 'ast',
    });
  }

  private addTaint(
    domain: RawTaint['domain'],
    cause: string,
    ctx: HasStart,
    conditionalOnType?: string,
  ): void {
    this.taints.push({
      from: this.currentTypeName,
      domain,
      cause,
      at: locOf(this.file, ctx),
      ...(conditionalOnType === undefined ? {} : { conditionalOnType }),
    });
  }

  // -- scopes ---------------------------------------------------------------------------

  enterMethodDeclaration = (): void => this.push();
  exitMethodDeclaration = (): void => this.pop();
  enterConstructorDeclaration = (_ctx: ConstructorDeclarationContext): void => this.push();
  exitConstructorDeclaration = (): void => this.pop();
  enterBlock = (_ctx: BlockContext): void => this.push();
  exitBlock = (): void => this.pop();
  enterForStatement = (_ctx: ForStatementContext): void => this.push();
  exitForStatement = (): void => this.pop();

  enterCatchClause = (ctx: CatchClauseContext): void => {
    this.push();
    const exceptionType = ctx.qualifiedName().getText();
    // A catch clause names its exception type via `qualifiedName`, not `typeRef`, so
    // `enterTypeRef` never fires for it. Without this the edge to a custom exception class
    // is missing entirely, and changing that class would not select the tests that catch it.
    this.addReference(exceptionType, 'type', ctx);
    this.declare(ctx.id().getText(), exceptionType, exceptionType);
  };
  exitCatchClause = (): void => this.pop();

  enterFormalParameter = (ctx: FormalParameterContext): void => {
    this.declare(ctx.id().getText(), typeRefName(ctx.typeRef()), ctx.typeRef().getText());
  };

  enterLocalVariableDeclaration = (ctx: LocalVariableDeclarationContext): void => {
    const declaredType = typeRefName(ctx.typeRef());
    const fullType = ctx.typeRef().getText();
    for (const d of ctx.variableDeclarators().variableDeclarator_list()) {
      this.declare(d.id().getText(), declaredType, fullType);
    }
  };

  enterEnhancedForControl = (ctx: EnhancedForControlContext): void => {
    this.declare(ctx.id().getText(), typeRefName(ctx.typeRef()), ctx.typeRef().getText());
  };

  // -- type stack -----------------------------------------------------------------------

  enterClassDeclaration = (ctx: ClassDeclarationContext): void => {
    this.typeStack.push(ctx.id().getText());
    this.push();
  };
  exitClassDeclaration = (): void => {
    this.pop();
    this.typeStack.pop();
  };

  enterInterfaceDeclaration = (ctx: InterfaceDeclarationContext): void => {
    this.typeStack.push(ctx.id().getText());
    this.push();
  };
  exitInterfaceDeclaration = (): void => {
    this.pop();
    this.typeStack.pop();
  };

  enterEnumDeclaration = (ctx: EnumDeclarationContext): void => {
    this.typeStack.push(ctx.id().getText());
  };
  exitEnumDeclaration = (): void => {
    this.typeStack.pop();
  };

  enterTriggerUnit = (ctx: TriggerUnitContext): void => {
    const ids = ctx.id_list();
    this.typeStack.push(ids[0]?.getText() ?? '');
    this.push();
    const objectName = ids[1]?.getText();
    if (objectName !== undefined) this.addReference(objectName, 'triggerObject', ctx);
  };
  exitTriggerUnit = (): void => {
    this.pop();
    this.typeStack.pop();
  };

  // -- references -----------------------------------------------------------------------

  enterTypeRef = (ctx: TypeRefContext): void => {
    // Generic arguments are visited as their own typeRef contexts, so only the base name is
    // taken here: `List<Account>` yields `List` now and `Account` on the nested visit.
    this.addReference(typeRefName(ctx), 'type', ctx);
  };

  enterCreatedName = (ctx: CreatedNameContext): void => {
    const name = ctx
      .idCreatedNamePair_list()
      .map((p) => p.anyId().getText())
      .join('.');
    this.addReference(name, 'type', ctx);
  };

  enterDotExpression = (ctx: DotExpressionContext): void => {
    // Process only the outermost link of a dotted *chain*. A chain continues through the
    // parent's left spine (`a.b` inside `a.b.c`), so those are skipped — but a dotted
    // expression in an argument list is a separate chain and must be processed.
    //
    // Getting this wrong by counting nesting depth instead drops the `PricingService` edge
    // from `System.assertEquals(0, PricingService.rate(acct))`, which is the shape of
    // almost every Apex assertion, and with it most edges out of most test classes.
    const parent = ctx.parentCtx;
    if (parent instanceof DotExpressionContext && parent.expression() === ctx) return;
    this.handleDotted(ctx);
  };

  /** Flattens `a.b.c()` into segments `['a','b']` plus the trailing call text `c()`. */
  private flatten(ctx: DotExpressionContext): { segments: string[]; call: string | null } {
    const segments: string[] = [];
    let call: string | null = null;
    let node: ExpressionContext = ctx;

    while (node instanceof DotExpressionContext) {
      const dot = node;
      const method = opt(dot.dotMethodCall());
      const anyId: AnyIdContext | null = opt(dot.anyId());
      if (method !== null) {
        if (call === null) call = method.getText();
        else segments.unshift(''); // A call in the middle of a chain: stop attributing names.
      } else if (anyId !== null) {
        segments.unshift(anyId.getText());
      }
      node = dot.expression();
    }
    segments.unshift(node.getText());
    return { segments, call };
  }

  private handleDotted(ctx: DotExpressionContext): void {
    const { segments, call } = this.flatten(ctx);
    const head = segments[0];
    if (head === undefined || !IDENTIFIER.test(head)) return;

    const lowered = segments.map((s) => s.toLowerCase());
    const method = call === null ? '' : callName(call);
    const receiverType = this.variableType(head);

    // Custom labels: `System.Label.X` and `Label.X`.
    if (lowered[0] === 'system' && lowered[1] === 'label' && segments[2] !== undefined) {
      this.addReference(segments[2], 'label', ctx);
      return;
    }
    if (lowered[0] === 'label' && segments[1] !== undefined && receiverType === null) {
      this.addReference(segments[1], 'label', ctx);
      return;
    }

    // Describe: `Schema.SObjectType.Account`.
    if (lowered[0] === 'schema' && lowered[1] === 'sobjecttype' && segments[2] !== undefined) {
      this.addReference(segments[2], 'soqlObject', ctx);
      return;
    }

    // `Database.insert(records, false)` and friends are DML too (DESIGN.md 4.3 lists
    // "insert/update/delete/upsert, Database.*"). The operand is the first argument, so the
    // leading identifier is looked up in scope exactly as a bare statement operand would be.
    if (lowered[0] === 'database' && DATABASE_DML_METHODS.has(method) && call !== null) {
      const firstArg = /^[A-Za-z0-9_]+\(\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(call);
      const operand = firstArg?.[1];
      if (operand !== undefined) {
        const declared = this.variableFullType(operand);
        const target = declared === null ? null : dmlTargetType(declared);
        if (target !== null) this.addReference(target, 'dmlObject', ctx);
      }
      return;
    }

    // Static resources: `Test.loadData(Type, 'Resource')` seeds records from one and
    // `mock.setStaticResource('Resource')` serves a canned callout body from one. Both can
    // change a test's outcome, so both are real dependencies.
    if (lowered[0] === 'test' && method === 'loaddata' && call !== null) {
      const literal = lastStringLiteralArg(call);
      if (literal !== null) this.addReference(literal, 'staticResource', ctx);
      else this.addTaint('resourceAny', 'Test.loadData (computed resource name)', ctx);
      return;
    }
    if (method === 'setstaticresource' && call !== null) {
      const literal = lastStringLiteralArg(call);
      if (literal !== null) this.addReference(literal, 'staticResource', ctx);
      else this.addTaint('resourceAny', 'setStaticResource (computed resource name)', ctx);
      return;
    }

    // Custom permissions: a literal name resolves; anything computed does not.
    if (lowered[0] === 'featuremanagement' && method === 'checkpermission' && call !== null) {
      const literal = singleStringLiteralArg(call);
      if (literal !== null) this.addReference(literal, 'customPermission', ctx);
      else this.addTaint('apexType', 'FeatureManagement.checkPermission (computed name)', ctx);
      return;
    }

    // Dynamic constructs, by qualified receiver.
    const qualified = `${lowered[0] ?? ''}.${method}`;
    const dynamicApex = DYNAMIC_APEX_CALLS.get(qualified);
    if (dynamicApex !== undefined && receiverType === null) {
      this.addTaint('apexType', dynamicApex, ctx);
      return;
    }
    const dynamicSoql = DYNAMIC_SOQL_CALLS.get(qualified);
    if (dynamicSoql !== undefined && receiverType === null) {
      this.addTaint('sobjectAny', dynamicSoql, ctx);
      return;
    }

    // Dynamic constructs recognisable from the method name alone.
    const bare = DYNAMIC_BARE_METHODS.get(method);
    if (bare !== undefined) this.addTaint(bare.domain, bare.cause, ctx);

    // `Callable.call` dispatches to a class chosen at runtime.
    if (method === 'call' && receiverType?.toLowerCase() === 'callable') {
      this.addTaint('apexType', 'Callable.call', ctx);
    }

    // Field access by name is dynamic only when the receiver is an SObject; the resolver
    // decides, because only it knows what the declared type actually is.
    if (DYNAMIC_FIELD_METHODS.has(method) && receiverType !== null) {
      this.addTaint('fieldAny', `SObject.${method}(String)`, ctx, receiverType);
    }

    if (receiverType !== null) {
      this.unresolved.push({
        text: segments.join('.'),
        at: locOf(this.file, ctx),
        disposition: 'ignored-local-variable',
        ownerFile: this.file,
      });
      return;
    }
    if (this.isClassMember(head)) {
      this.unresolved.push({
        text: segments.join('.'),
        at: locOf(this.file, ctx),
        disposition: 'ignored-class-member',
        ownerFile: this.file,
      });
      return;
    }

    // A static reference. Which prefix names the type is ambiguous — `Outer.Inner.run()`
    // could be `Outer` or `Outer.Inner` — so the whole chain is handed to the resolver,
    // which emits an edge for every prefix that binds. Ambiguity widens; it never picks.
    const named = segments.filter((s) => s.length > 0 && IDENTIFIER.test(s));
    if (named.length > 0) this.addReference(named.join('.'), 'type', ctx);
  }

  // -- DML ------------------------------------------------------------------------------

  /**
   * DML statements (DESIGN.md 4.3, `dml` edge).
   *
   * Without this, `insert acct;` contributed nothing of its own and the object dependency
   * survived only incidentally — through the variable's declaration typeRef, or a SOQL query
   * that happened to name the same object. A class that receives records as a parameter and
   * only writes them had no edge to the object it writes at all.
   */
  private recordDml(expressions: readonly ExpressionContext[], ctx: HasStart): void {
    for (const expression of expressions) {
      const target = this.dmlTargetOf(expression);
      if (target !== null) this.addReference(target, 'dmlObject', ctx);
    }
  }

  /** Resolves a DML operand to the SObject it acts on, when that is knowable statically. */
  private dmlTargetOf(expression: ExpressionContext): string | null {
    const text = expression.getText();

    // `insert new Account(...)` / `insert new List<Account>{...}`
    const constructed = /^new([A-Za-z_][A-Za-z0-9_<>,.]*)/.exec(text);
    if (constructed !== null) return dmlTargetType(constructed[1] ?? '');

    // A plain variable: its declared type carries the object.
    if (IDENTIFIER.test(text)) {
      const declared = this.variableFullType(text);
      return declared === null ? null : dmlTargetType(declared);
    }

    // `someMap.values()`, `wrapper.records` and similar: fall back to the head identifier's
    // declared type, which is the closest thing to a target we can name without inference.
    const head = /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(text);
    if (head !== null) {
      const declared = this.variableFullType(head[1] ?? '');
      return declared === null ? null : dmlTargetType(declared);
    }
    return null;
  }

  enterInsertStatement = (ctx: InsertStatementContext): void => this.recordDml([ctx.expression()], ctx);
  enterUpdateStatement = (ctx: UpdateStatementContext): void => this.recordDml([ctx.expression()], ctx);
  enterDeleteStatement = (ctx: DeleteStatementContext): void => this.recordDml([ctx.expression()], ctx);
  enterUpsertStatement = (ctx: UpsertStatementContext): void => this.recordDml([ctx.expression()], ctx);
  enterUndeleteStatement = (ctx: UndeleteStatementContext): void => this.recordDml([ctx.expression()], ctx);
  enterMergeStatement = (ctx: MergeStatementContext): void => {
    // `merge master duplicate` names two operands; both objects are touched.
    this.recordDml(ctx.expression_list(), ctx);
  };

  // -- SOQL / SOSL ----------------------------------------------------------------------

  enterQuery = (ctx: QueryContext): void => {
    const fromList = opt(ctx.fromNameList());
    const objects =
      fromList === null
        ? []
        : fromList
            .fieldName_list()
            .map((f) => f.getText().split('.')[0] ?? '')
            .filter((n) => n.length > 0 && IDENTIFIER.test(n));

    for (const object of objects) this.addReference(object, 'soqlObject', ctx);

    const selectList = opt(ctx.selectList());
    if (selectList === null) return;

    const primaryObject = objects[0];
    for (const entry of selectList.selectEntry_list()) {
      const text = entry.getText();
      if (text.includes('(')) continue; // Aggregate function or subquery; handled elsewhere.
      const parts = text.split('.');
      const fieldName = parts[parts.length - 1];
      if (fieldName === undefined || !IDENTIFIER.test(fieldName)) continue;

      if (parts.length === 1 && primaryObject !== undefined) {
        this.addReference(`${primaryObject}.${fieldName}`, 'soqlField', ctx);
      } else {
        // A relationship traversal (`Owner.Custom__c`). We cannot name the owning object
        // without relationship metadata, so the resolver widens to every object that has a
        // field of this name. Dropping it would be an under-approximation.
        this.addReference(`${UNKNOWN_OBJECT}.${fieldName}`, 'soqlField', ctx);
      }
    }
  };

  enterSoslLiteral = (ctx: SoslLiteralContext): void => {
    // SOSL RETURNING clauses are not modelled in v1, so the safe reading of any SOSL is
    // "may read any object".
    this.addTaint('sobjectAny', 'SOSL FIND', ctx);
  };
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

class CollectingErrorListener extends ApexErrorListener {
  readonly errors: Array<{ line: number; column: number; message: string }> = [];
  apexSyntaxError(line: number, column: number, msg: string): void {
    this.errors.push({ line, column, message: msg });
  }
}

/** `force-app/.../classes/AccountService.cls` -> `AccountService`. */
function typeNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(cls|trigger)$/i, '');
}

/**
 * Facts for a file we could not parse.
 *
 * The node is still declared — its name comes from the filename, so references *to* it from
 * other files still resolve — but because we cannot see its outgoing references it is
 * tainted in every domain. That makes it impacted by any change, which is the proportionate
 * safe answer: if it is a test it always runs, and if it is not, its known dependents are
 * pulled in with it. Degrading the entire run to `RunLocalTests` is the caller's choice via
 * `taint.onParseError`, not something decided here.
 */
function unparseableFacts(
  path: string,
  kind: NodeKind,
  diagnostics: readonly Diagnostic[],
): FileFacts {
  const name = typeNameFromPath(path);
  const loc: SourceLoc = { file: path, line: 1, column: 0 };
  const cause = 'file could not be parsed';
  return {
    path,
    extractor: APEX_EXTRACTOR_ID,
    parsedOk: false,
    declarations: [
      {
        name,
        kind,
        flags: NodeFlags.PARSE_FAILED,
        superType: null,
        interfaces: [],
        testMethods: [],
        entryPoints: [],
        loc,
      },
    ],
    references: [],
    taints: (['apexType', 'sobjectAny', 'fieldAny'] as const).map((domain) => ({
      from: name,
      domain,
      cause,
      at: loc,
    })),
    unresolved: [],
    diagnostics,
  };
}

/**
 * Extract graph facts from one Apex source file.
 *
 * Never throws for malformed input: a file that cannot be parsed produces `parsedOk: false`
 * plus a fully tainted declaration, because a silently skipped file is a silently missing
 * edge. It may throw `ExtractorError` for genuine bugs, which the caller surfaces.
 *
 * @param path     Repository-relative path, used for node ownership and error messages.
 * @param contents Raw file contents.
 */
export function extractApex(path: string, contents: string): FileFacts {
  const isTrigger = /\.trigger$/i.test(path);
  const errorListener = new CollectingErrorListener();
  const { parser } = ApexParserFactory.createLexerAndParser(contents, errorListener);

  let tree: CompilationUnitContext | TriggerUnitContext;
  try {
    tree = isTrigger ? parser.triggerUnit() : parser.compilationUnit();
  } catch (cause) {
    return unparseableFacts(path, isTrigger ? 'trigger' : 'apex', [
      {
        severity: 'error',
        message: `Apex parser threw: ${cause instanceof Error ? cause.message : String(cause)}`,
        at: { file: path, line: 1, column: 0 },
      },
    ]);
  }

  const diagnostics: Diagnostic[] = errorListener.errors.map((e) => ({
    severity: 'error' as const,
    message: e.message,
    at: { file: path, line: e.line, column: e.column },
  }));

  if (diagnostics.length > 0) {
    return unparseableFacts(path, isTrigger ? 'trigger' : 'apex', diagnostics);
  }

  const declarations = new DeclarationCollector(path);
  ApexParseTreeWalker.DEFAULT.walk(declarations, tree);

  const references = new ReferenceCollector(path, declarations.types);
  ApexParseTreeWalker.DEFAULT.walk(references, tree);

  return {
    path,
    extractor: APEX_EXTRACTOR_ID,
    parsedOk: true,
    declarations: [...declarations.types.values()].map((t) => t.declaration),
    references: references.references,
    taints: references.taints,
    unresolved: references.unresolved,
    diagnostics,
  };
}
