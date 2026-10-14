/**
 * Static test discovery: source text -> describe/test tree ({@link ParsedFile}) using the bundled
 * `@babel/parser` (TypeScript, TSX, JS, JSX, Flow fallback). Pure; no 'vscode'; never executes code.
 *
 * Recognised constructs (mirroring jest-circus' globals, see jestAdapterInit.js in Jest 29/30):
 *  - roots `describe fdescribe xdescribe it fit xit test xtest`, also as `globals.it` member forms,
 *    `(0, _globals.it)(...)` sequence forms, `it!(...)` / `(it as any)(...)` TS wrappers, and
 *    `import { it as spec } from '@jest/globals'` aliases;
 *  - modifier chains `.only .skip .todo .failing .concurrent` in any circus-defined combination;
 *  - `.each` in both shapes: `X.each(table)(title, fn)` and `` X.each`table`(title, fn) ``;
 *  - `@jest-decorated` classes: `@Describe(name?)` on a class, `@Test(name?)` / `@It(name?)` on methods;
 *  - snapshot matcher call lines (`toMatchSnapshot`, `toMatchInlineSnapshot`,
 *    `toThrowErrorMatchingSnapshot`, `toThrowErrorMatchingInlineSnapshot`).
 *
 * Titles: string literal / expression-free template / numeric literal / constant-folded `'a' + 'b'`
 * are `static`; templates with `${}` are `template` (placeholder keeps the `${expr}` source text);
 * identifiers and other expressions are `dynamic` (identifier name or collapsed source text).
 *
 * Coordinates are 0-based lines and columns (VS Code convention). Syntax errors: Babel's
 * `errorRecovery` keeps the tree for recoverable errors (reported in `parseError`); unrecoverable
 * errors yield `nodes: []` plus `parseError` so the host can keep its last good tree.
 */
import { createHash } from 'crypto';
import { parse, type ParserOptions, type ParserPlugin } from '@babel/parser';
import type * as t from '@babel/types';
import type { ParsedFile, ParsedMode, ParsedNode, ParsedRange, TitleKind } from './testModel';

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

const DESCRIBE_ROOTS: ReadonlySet<string> = new Set(['describe', 'fdescribe', 'xdescribe']);
const TEST_ROOTS: ReadonlySet<string> = new Set(['it', 'fit', 'xit', 'test', 'xtest']);
const MODIFIERS: ReadonlySet<string> = new Set(['only', 'skip', 'todo', 'failing', 'concurrent', 'each']);
const SNAPSHOT_MATCHERS: ReadonlySet<string> = new Set([
  'toMatchSnapshot', 'toMatchInlineSnapshot', 'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot',
]);
/** Module specifiers whose named imports are Jest globals (`import { it as spec } from '@jest/globals'`). */
const GLOBALS_MODULES: ReadonlySet<string> = new Set(['@jest/globals']);
/** @jest-decorated decorator names. */
const DECORATOR_DESCRIBE = 'Describe';
const DECORATOR_TESTS: ReadonlySet<string> = new Set(['Test', 'It']);
/** AST keys that never contain child nodes we care about. */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  'type', 'loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'errors', 'tokens',
]);
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);
/** Max characters kept from a dynamic title's source text. */
const MAX_DYNAMIC_TITLE = 100;

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Parse `source` (the editor buffer or file content) of the test file at `path`. Never throws. */
export function parseTestFile(source: string, path: string): ParsedFile {
  const hash = sha1(source);
  const attempt = tryParse(source, pluginSetsFor(path, source));
  if (!attempt.ast) {
    return { path, nodes: [], snapshotLines: [], functionCount: 0, parseError: attempt.error, hash };
  }
  const ctx: WalkCtx = { source, aliases: new Map(), snapshotLines: new Set(), functionCount: 0 };
  const roots: ParsedNode[] = [];
  walk(attempt.ast.program, roots, ctx);
  assignDupIndexes(roots);
  const file: ParsedFile = {
    path,
    nodes: roots,
    snapshotLines: [...ctx.snapshotLines].sort((a, b) => a - b),
    functionCount: ctx.functionCount,
    hash,
  };
  if (attempt.error) file.parseError = attempt.error;
  return file;
}

/**
 * Babel plugin sets to try for a path, most likely first. Exported for tests.
 * `decorators-legacy` is always on (it only changes parsing when `@` appears); files that still fail
 * and contain `@` are retried with the modern `decorators` proposal (Babel 8: bare plugin name —
 * `decoratorsBeforeExport` and other decorator options were removed).
 */
export function pluginSetsFor(path: string, source: string): ParserPlugin[][] {
  const ext = extensionOf(path);
  const sets: ParserPlugin[][] = [];
  switch (ext) {
    case 'ts': case 'mts': case 'cts':
      sets.push(['typescript'], ['typescript', 'jsx']);
      break;
    case 'tsx':
      sets.push(['typescript', 'jsx'], ['typescript']);
      break;
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      sets.push(['jsx'], ['jsx', 'flow'], ['typescript', 'jsx']);
      break;
    default:
      sets.push(['typescript', 'jsx'], ['typescript'], ['jsx', 'flow']);
  }
  const withDecorators = sets.map(s => [...s, 'decorators-legacy' as ParserPlugin]);
  if (source.includes('@')) {
    for (const s of sets) withDecorators.push([...s, 'decorators' as ParserPlugin]);
  }
  return withDecorators;
}

// ---------------------------------------------------------------------------------------------
// Parsing with fallbacks
// ---------------------------------------------------------------------------------------------

interface ParseAttempt {
  ast: t.File | null;
  error?: { message: string; line: number; column: number };
}

const BASE_OPTIONS: ParserOptions = {
  sourceType: 'unambiguous',
  errorRecovery: true,
  attachComment: false,
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowUndeclaredExports: true,
  allowNewTargetOutsideFunction: true,
  ranges: false,
  tokens: false,
};

function tryParse(source: string, pluginSets: ParserPlugin[][]): ParseAttempt {
  let firstError: ParseAttempt['error'];
  for (const plugins of pluginSets) {
    try {
      const ast = parse(source, { ...BASE_OPTIONS, plugins });
      const recovered = ast.errors && ast.errors.length > 0 ? toParseError(ast.errors[0]) : undefined;
      return recovered ? { ast, error: recovered } : { ast };
    } catch (err) {
      firstError ??= toParseError(err);
    }
  }
  return { ast: null, error: firstError ?? { message: 'Unknown parse error', line: 0, column: 0 } };
}

/** Normalise Babel's SyntaxError (thrown or recovered) into a 0-based `{message, line, column}`. */
function toParseError(err: unknown): { message: string; line: number; column: number } {
  const e = err as { message?: string; loc?: { line?: number; column?: number } };
  const rawMessage = typeof e?.message === 'string' ? e.message : String(err);
  const message = rawMessage.replace(/\s*\(\d+:\d+\)\s*$/, '');
  const line = Math.max(0, (e?.loc?.line ?? 1) - 1);
  const column = Math.max(0, e?.loc?.column ?? 0);
  return { message, line, column };
}

// ---------------------------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------------------------

interface WalkCtx {
  source: string;
  /** Local identifier -> Jest global name (from `@jest/globals` import aliases). */
  aliases: Map<string, string>;
  snapshotLines: Set<number>;
  functionCount: number;
}

type AnyNode = t.Node & Record<string, unknown>;

function walk(node: unknown, siblings: ParsedNode[], ctx: WalkCtx): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, siblings, ctx);
    return;
  }
  if (!node || typeof node !== 'object' || typeof (node as AnyNode).type !== 'string') return;
  const n = node as AnyNode;

  switch (n.type) {
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const call = n as unknown as t.CallExpression;
      recordSnapshotCall(call, ctx);
      const parsed = testCallToNode(call, ctx);
      if (parsed) {
        // Everything inside the call (table, title expressions, body) belongs to this node.
        const children: ParsedNode[] = [];
        walk(call.callee, children, ctx);
        walk(call.arguments, children, ctx);
        parsed.children = children;
        siblings.push(parsed);
        return;
      }
      break;
    }
    case 'ClassDeclaration':
    case 'ClassExpression': {
      const cls = n as unknown as t.Class;
      const parsed = decoratedClassToNode(cls, ctx);
      if (parsed) {
        const children: ParsedNode[] = [];
        walk(cls.decorators, children, ctx);
        walk(cls.body, children, ctx);
        parsed.children = children;
        siblings.push(parsed);
        return;
      }
      break;
    }
    case 'ClassMethod': {
      ctx.functionCount++;
      const method = n as unknown as t.ClassMethod;
      const parsed = decoratedMethodToNode(method, ctx);
      if (parsed) {
        const children: ParsedNode[] = [];
        walk(method.decorators, children, ctx);
        walk(method.params, children, ctx);
        walk(method.body, children, ctx);
        parsed.children = children;
        siblings.push(parsed);
        return;
      }
      break;
    }
    case 'ImportDeclaration':
      recordAliases(n as unknown as t.ImportDeclaration, ctx);
      return;
    default:
      if (FUNCTION_TYPES.has(n.type)) ctx.functionCount++;
  }

  for (const key in n) {
    if (SKIP_KEYS.has(key)) continue;
    const value = n[key];
    if (value && typeof value === 'object') walk(value, siblings, ctx);
  }
}

function recordAliases(decl: t.ImportDeclaration, ctx: WalkCtx): void {
  if (!GLOBALS_MODULES.has(decl.source.value)) return;
  for (const spec of decl.specifiers) {
    if (spec.type !== 'ImportSpecifier') continue;
    const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
    if (imported !== spec.local.name && (DESCRIBE_ROOTS.has(imported) || TEST_ROOTS.has(imported))) {
      ctx.aliases.set(spec.local.name, imported);
    }
  }
}

function recordSnapshotCall(call: t.CallExpression, ctx: WalkCtx): void {
  const callee = call.callee;
  if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed
    && callee.property.type === 'Identifier' && SNAPSHOT_MATCHERS.has(callee.property.name) && callee.property.loc) {
    ctx.snapshotLines.add(callee.property.loc.start.line - 1);
  }
}

// ---------------------------------------------------------------------------------------------
// describe/it/test calls
// ---------------------------------------------------------------------------------------------

interface CalleeInfo {
  kind: 'describe' | 'test';
  root: string;
  mods: string[];
  each: boolean;
}

function testCallToNode(call: t.CallExpression, ctx: WalkCtx): ParsedNode | null {
  const info = analyzeCallee(call.callee, ctx.aliases);
  if (!info || call.arguments.length === 0 || !call.loc) return null;
  const titleArg = call.arguments[0];
  if (titleArg.type === 'ArgumentPlaceholder' || titleArg.type === 'SpreadElement' || !titleArg.loc) return null;
  const { title, titleKind } = titleOf(titleArg, ctx.source);
  return {
    kind: info.kind,
    title,
    titleKind,
    mode: modeOf(info.root, info.mods),
    each: info.each,
    concurrent: info.mods.includes('concurrent'),
    range: toRange(call.loc),
    nameRange: toRange(titleArg.loc),
    children: [],
    dupIndex: 0,
  };
}

/**
 * Classify a call's callee as a Jest describe/test chain. Handles `it`, `test.only`, `globals.it.skip`,
 * `(0, _globals.describe)`, `it!`, `(it as any)`, and the two `.each` shapes (where the callee itself is
 * the `X.each(table)` call or the `` X.each`table` `` tagged template).
 */
function analyzeCallee(
  callee: t.Expression | t.V8IntrinsicIdentifier | t.Super | t.Import,
  aliases: Map<string, string>,
): CalleeInfo | null {
  // Babel 8: CallExpression.callee includes Import (`import()`); never a Jest global.
  if (callee.type === 'Import') return null;
  const target = unwrapExpression(callee);
  let each = false;
  let chainNode: t.Node = target;
  if (target.type === 'CallExpression' || target.type === 'OptionalCallExpression') {
    chainNode = unwrapExpression(target.callee);
    each = true;
  } else if (target.type === 'TaggedTemplateExpression') {
    chainNode = unwrapExpression(target.tag);
    each = true;
  }
  const names = memberChain(chainNode);
  if (!names) return null;
  if (each) {
    if (names[names.length - 1] !== 'each') return null;
    names.pop();
  } else if (names.includes('each')) {
    return null; // bare `it.each(table)` without the `(title, fn)` application
  }
  if (aliases.size > 0 && aliases.has(names[0])) names[0] = aliases.get(names[0])!;
  return classifyChain(names, each);
}

function classifyChain(names: string[], each: boolean): CalleeInfo | null {
  // Allow at most one namespace segment before the root (`globals.it`, `jest.describe`).
  for (let i = 0; i < Math.min(2, names.length); i++) {
    const root = names[i];
    const isDescribe = DESCRIBE_ROOTS.has(root);
    if (!isDescribe && !TEST_ROOTS.has(root)) continue;
    const mods = names.slice(i + 1);
    if (!mods.every(m => MODIFIERS.has(m) && m !== 'each')) return null;
    if (isDescribe && (mods.includes('todo') || mods.includes('failing') || mods.includes('concurrent'))) return null;
    return { kind: isDescribe ? 'describe' : 'test', root, mods, each };
  }
  return null;
}

/** `a.b.c` -> ['a','b','c'] for non-computed identifier chains rooted at an identifier; null otherwise. */
function memberChain(node: t.Node): string[] | null {
  const names: string[] = [];
  let cur: t.Node = node;
  for (;;) {
    cur = unwrapExpression(cur as t.Expression);
    if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
      const prop = cur.property;
      if (cur.computed) {
        if (prop.type !== 'StringLiteral') return null;
        names.push(prop.value);
      } else if (prop.type === 'Identifier') {
        names.push(prop.name);
      } else {
        return null;
      }
      cur = cur.object;
      continue;
    }
    if (cur.type === 'Identifier') {
      names.push(cur.name);
      names.reverse();
      return names;
    }
    return null;
  }
}

/** Strip TS/paren/sequence wrappers that do not change what is being called. */
function unwrapExpression<T extends t.Node>(node: T): t.Node {
  let cur: t.Node = node;
  for (;;) {
    switch (cur.type) {
      case 'SequenceExpression': {
        const seq = cur as t.SequenceExpression;
        cur = seq.expressions[seq.expressions.length - 1];
        continue;
      }
      case 'ParenthesizedExpression':
      case 'TSNonNullExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
      case 'TSInstantiationExpression':
      case 'TypeCastExpression':
        cur = (cur as { expression: t.Node }).expression;
        continue;
      default:
        return cur;
    }
  }
}

function modeOf(root: string, mods: readonly string[]): ParsedMode {
  if (mods.includes('skip') || root.startsWith('x')) return 'skip';
  if (mods.includes('todo')) return 'todo';
  if (mods.includes('only') || root === 'fit' || root === 'fdescribe') return 'only';
  if (mods.includes('failing')) return 'failing';
  return 'default';
}

// ---------------------------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------------------------

function titleOf(arg: t.Node, source: string): { title: string; titleKind: TitleKind } {
  const node = unwrapExpression(arg);
  const folded = constantString(node, source);
  if (folded !== null) return { title: folded, titleKind: 'static' };
  if (node.type === 'TemplateLiteral') return { title: templatePlaceholder(node, source), titleKind: 'template' };
  if (node.type === 'Identifier') return { title: node.name, titleKind: 'dynamic' };
  return { title: sourceText(node, source), titleKind: 'dynamic' };
}

/** Constant-fold string/number literals, expression-free templates and `+` concatenations of them. */
function constantString(node: t.Node, source: string): string | null {
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'NumericLiteral':
      return String(node.value);
    case 'BigIntLiteral':
      // Babel 8: BigIntLiteral.value is bigint (was string in Babel 7).
      return String(node.value);
    case 'TemplateLiteral':
      if (node.expressions.length > 0) return null;
      return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? '';
    case 'BinaryExpression': {
      if (node.operator !== '+') return null;
      const left = constantString(unwrapExpression(node.left), source);
      if (left === null) return null;
      const right = constantString(unwrapExpression(node.right), source);
      return right === null ? null : left + right;
    }
    default:
      return null;
  }
}

/** `renders ${name} twice` -> "renders ${name} twice" (expression source kept verbatim). */
function templatePlaceholder(tpl: t.TemplateLiteral, source: string): string {
  let out = '';
  for (let i = 0; i < tpl.quasis.length; i++) {
    out += tpl.quasis[i].value.cooked ?? tpl.quasis[i].value.raw;
    if (i < tpl.expressions.length) out += '${' + sourceText(tpl.expressions[i], source) + '}';
  }
  return out;
}

function sourceText(node: t.Node, source: string): string {
  const start = node.start ?? 0;
  const end = node.end ?? start;
  const text = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return text.length > MAX_DYNAMIC_TITLE ? text.slice(0, MAX_DYNAMIC_TITLE - 1) + '…' : text;
}

// ---------------------------------------------------------------------------------------------
// @jest-decorated
// ---------------------------------------------------------------------------------------------

interface DecoratorInfo { name: string; mods: string[]; call: t.CallExpression | null; decorator: t.Decorator }

function decoratorsOf(decorators: t.Decorator[] | null | undefined, accepted: (name: string) => boolean): DecoratorInfo | null {
  if (!decorators) return null;
  for (const decorator of decorators) {
    const expr = unwrapExpression(decorator.expression);
    const call = expr.type === 'CallExpression' ? expr : null;
    const chain = memberChain(call ? call.callee : expr);
    if (!chain || !accepted(chain[0])) continue;
    const mods = chain.slice(1);
    if (!mods.every(m => MODIFIERS.has(m) && m !== 'each')) continue;
    return { name: chain[0], mods, call, decorator };
  }
  return null;
}

function decoratedClassToNode(cls: t.Class, ctx: WalkCtx): ParsedNode | null {
  const info = decoratorsOf(cls.decorators, name => name === DECORATOR_DESCRIBE);
  if (!info || !cls.loc) return null;
  const titleArg = info.call?.arguments[0];
  let title: string;
  let titleKind: TitleKind;
  let nameLoc: t.SourceLocation | null | undefined;
  if (titleArg && titleArg.type !== 'ArgumentPlaceholder' && titleArg.type !== 'SpreadElement') {
    ({ title, titleKind } = titleOf(titleArg, ctx.source));
    nameLoc = titleArg.loc;
  } else if (cls.id) {
    // @jest-decorated defaults the suite name to the class name (exact at runtime).
    title = cls.id.name;
    titleKind = 'static';
    nameLoc = cls.id.loc;
  } else {
    title = '';
    titleKind = 'dynamic';
    nameLoc = info.decorator.loc;
  }
  return {
    kind: 'describe', title, titleKind, mode: modeOf('describe', info.mods), each: false, concurrent: false,
    range: toRange(cls.loc), nameRange: toRange(nameLoc ?? cls.loc), children: [], dupIndex: 0,
  };
}

function decoratedMethodToNode(method: t.ClassMethod, ctx: WalkCtx): ParsedNode | null {
  const info = decoratorsOf(method.decorators, name => DECORATOR_TESTS.has(name));
  if (!info || !method.loc) return null;
  const titleArg = info.call?.arguments[0];
  let title: string;
  let titleKind: TitleKind;
  let nameLoc: t.SourceLocation | null | undefined;
  if (titleArg && titleArg.type !== 'ArgumentPlaceholder' && titleArg.type !== 'SpreadElement') {
    ({ title, titleKind } = titleOf(titleArg, ctx.source));
    nameLoc = titleArg.loc;
  } else {
    const key = method.key;
    if (key.type === 'Identifier') { title = key.name; titleKind = 'static'; }
    else if (key.type === 'StringLiteral') { title = key.value; titleKind = 'static'; }
    else { title = sourceText(key, ctx.source); titleKind = 'dynamic'; }
    nameLoc = key.loc;
  }
  return {
    kind: 'test', title, titleKind, mode: modeOf('test', info.mods), each: false,
    concurrent: info.mods.includes('concurrent'),
    range: toRange(method.loc), nameRange: toRange(nameLoc ?? method.loc), children: [], dupIndex: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function toRange(loc: t.SourceLocation): ParsedRange {
  return { startLine: loc.start.line - 1, startColumn: loc.start.column, endLine: loc.end.line - 1, endColumn: loc.end.column };
}

/** Assign `dupIndex` = k for the k-th sibling sharing kind+title (source order), recursively. */
function assignDupIndexes(nodes: ParsedNode[]): void {
  const seen = new Map<string, number>();
  for (const node of nodes) {
    const key = `${node.kind}\0${node.title}`;
    const k = seen.get(key) ?? 0;
    node.dupIndex = k;
    seen.set(key, k + 1);
    if (node.children.length > 0) assignDupIndexes(node.children);
  }
}

function extensionOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
