/**
 * Live-comment probes (`expr //?`, `/*?*\/`, `//? $.expr`, `//?.` timing) as a transformer wrapper.
 *
 * `wrapTransformer(inner, deps)` returns a Jest SyncTransformer/AsyncTransformer-shaped object
 * that delegates to the project's own transformer (babel-jest, ts-jest, ...) and, ONLY for files
 * that contain live markers, runs a second Babel pass over the inner output:
 *
 *   babelCore.transformSync(innerCode, {filename, babelrc:false, configFile:false,
 *     sourceMaps:'both', inputSourceMap: innerMap, retainLines:true, plugins:[probePlugin]})
 *
 * The plugin collects the nodes ending right before each marker (same or next line, only whitespace,
 * `;` or `,` in between), tries them outermost-first and replaces the first wrappable expression with
 *   `globalThis.__hj_v("<abs file>", <line 1-based>, <col 0-based>, (expr))`
 * (line/col = the marker comment's position in the ORIGINAL source). `const x = expr; //?` wraps
 * the init, `return expr; //?` the argument, `expr; //?` / `a.b //?` / `await p //?` the whole
 * expression, `key: value, //?` the value; `function f(){} //?` logs `f` after the declaration.
 * `//? currentPage.url` after a statement evaluates that independent expression after the statement.
 * Nothing wrappable (e.g. `if (x) { //?`) skips the marker. A prelude installs a no-op `__hj_v` when the environment wrapper
 * did not (CLI / Debug runs), so instrumented code never throws.
 *
 * Marker positions in the transformed code are found by pairing `?` comments in the transformed
 * AST with the original markers in order (babel-jest and ts-jest preserve comments). When the
 * counts differ (a transformer dropped comments), the original expression start is mapped through
 * the inner source map with @jridgewell/trace-mapping when `deps.traceMapping` is provided;
 * otherwise those markers are skipped. Any failure in the probe pass degrades to the inner result.
 *
 * Cache keys: files with markers get `sha1(innerKey + '|hj' + probeVersion + '|' + sha1(markers))`;
 * files without markers return the inner key unchanged (byte-for-byte cache reuse with plain
 * Jest). When the inner transformer has no getCacheKey, marker files use Jest's default key
 * inputs (content, configString, instrument flag, filename) plus the probe suffix so a plain-Jest
 * cache entry of the same content is never served for an instrumented file.
 *
 * Worker-side; no Jest/Babel imports (all resolved by the caller and injected through `deps`).
 */
import { createHash } from 'crypto';
import * as path from 'path';

export const PROBE_GLOBAL = '__hj_v';
export const DEFAULT_PROBE_VERSION = '2';

/** `//?` not preceded by `:`, `/` or a word char (URLs, `///?`), followed by a modifier/space/EOL; or `/*? ... *\/`. */
const LIVE_MARKER_RE = /(?<![:\w/])\/\/\?(?=[\s.?+$]|$)|\/\*\?[.?+]?(?:\s[\s\S]*?)?\*\//m;
/** Comment value (after `//` or between `/*` and `*\/`): `?`, modifier, optional `$`-expression. */
const MARKER_VALUE_RE = /^\?([.?+])?(?:(?:\s+|(?=\$))([\s\S]*?))?\s*$/;

export type MarkerKind = 'value' | 'timing' | 'proxy' | 'expand';

export interface LiveMarker {
  /** 1-based line of the comment start in the original source. */
  line: number;
  /** 0-based column of the comment start in the original source. */
  column: number;
  /** Character offset of the comment start/end in the original source. */
  start: number;
  end: number;
  kind: MarkerKind;
  commentKind: 'line' | 'block';
  /** Code after the marker; `$` references the preceding value, otherwise it runs after the statement. */
  expression?: string;
  /** An independent expression evaluated after the preceding statement (no `$` reference). */
  standalone?: boolean;
  /** Start/end of the expression the marker targets, in original coordinates (for source-map pairing). */
  targetStart?: { line: number; column: number };
  targetEnd?: { line: number; column: number };
}

export interface ProbeDeps {
  /** The project's `@babel/core` (chain-resolved from @jest/transform). */
  babelCore: any;
  /** `@babel/parser` (the bundled one or the chain's). */
  babelParser: any;
  /** Optional `convert-source-map` (unused when Babel can read the inline map itself). */
  convertSourceMap?: any;
  /** Optional `@jridgewell/trace-mapping` for the comment-dropping fallback. */
  traceMapping?: any;
  probeVersion: string;
  /** Diagnostics sink (degraded cases are logged, never thrown). */
  log?: (message: string) => void;
}

/** Jest TransformedSource (string results are legacy but still normalised). */
export interface TransformedSourceLike { code: string; map?: unknown }

/** Fast pre-check (no parsing): true when the text may contain a live marker. */
export function hasLiveMarkers(source: string): boolean {
  return typeof source === 'string' && LIVE_MARKER_RE.test(source);
}

/** Parses a comment's value; undefined when it is not a live marker. */
export function parseMarkerValue(value: string): { kind: MarkerKind; expression?: string } | undefined {
  const m = MARKER_VALUE_RE.exec(value);
  if (!m) return undefined;
  const kind: MarkerKind = m[1] === '.' ? 'timing' : m[1] === '?' ? 'proxy' : m[1] === '+' ? 'expand' : 'value';
  const expression = m[2]?.trim();
  return expression ? { kind, expression } : { kind };
}

interface CommentLike { type: 'CommentLine' | 'CommentBlock'; value: string; start: number; end: number; loc: { start: { line: number; column: number } } }

function parserPluginSets(filename: string): unknown[][] {
  const ext = path.extname(filename).toLowerCase();
  const isTS = ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';
  if (isTS) {
    const jsx = ext === '.tsx' ? ['jsx'] : [];
    return [
      ['typescript', ...jsx, 'decorators-legacy'],
      // Babel 8: decorator plugin options (e.g. decoratorsBeforeExport) were removed.
      ['typescript', 'jsx', 'decorators'],
    ];
  }
  return [
    ['jsx', 'flow', 'decorators-legacy'],
    ['jsx', 'typescript', 'decorators-legacy'],
    ['jsx'],
  ];
}

function parseWithFallbacks(babelParser: any, source: string, filename: string): any | undefined {
  for (const plugins of parserPluginSets(filename)) {
    try {
      return babelParser.parse(source, {
        sourceType: 'unambiguous',
        plugins,
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowSuperOutsideMethod: true,
        allowUndeclaredExports: true,
        attachComment: false,
        tokens: false,
      });
    } catch {
      /* try the next plugin set */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Generic AST walking over @babel/parser output (no @babel/traverse needed on the original source)
// ---------------------------------------------------------------------------------------------

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'extra', 'tokens', 'errors']);

interface RawNode { type: string; start: number; end: number; loc: { start: { line: number; column: number }; end: { line: number; column: number } }; [k: string]: any }

function walk(node: any, visit: (node: RawNode, parent: RawNode | undefined, key: string | undefined) => void, parent?: RawNode, key?: string): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent, key);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node as RawNode, parent, key);
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, visit, node as RawNode, k);
  }
}

const GAP_RE = /^[\s;,]*$/;
const NON_CANDIDATE_TYPES = new Set(['File', 'Program', 'TemplateElement', 'Directive', 'DirectiveLiteral', 'InterpreterDirective', 'JSXText']);

function immediatelyFollows(endLine: number, startLine: number): boolean {
  return startLine === endLine || startLine === endLine + 1;
}

function isProbeStatement(type: string): boolean {
  return type !== 'BlockStatement' && type !== 'EmptyStatement' && (type.endsWith('Statement') || type.endsWith('Declaration'));
}

/** The nearest complete statement before a trailing or immediately following comment. */
function findRawStatement(ast: any, source: string, comment: CommentLike): RawNode | undefined {
  let best: RawNode | undefined;
  walk(ast, node => {
    if (!node.loc || !isProbeStatement(node.type) || node.end > comment.start) return;
    if (!immediatelyFollows(node.loc.end.line, comment.loc.start.line)) return;
    if (!GAP_RE.test(source.slice(node.end, comment.start))) return;
    if (!best || node.end > best.end || (node.end === best.end && node.start < best.start)) best = node;
  });
  return best;
}

function referencesProbeValue(expression: string, babelParser: any): boolean {
  try {
    const ast = babelParser.parseExpression(expression, { plugins: ['jsx', 'typescript'] });
    let found = false;
    walk(ast, (node, parent, key) => {
      if (node.type !== 'Identifier' || node.name !== '$') return;
      if (parent && key === 'property' && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && !parent.computed) return;
      if (parent && key === 'key' && (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && !parent.computed) return;
      found = true;
    });
    return found;
  } catch {
    return expression.includes('$');
  }
}

/** Among raw nodes, the one ending closest before `commentStart` (innermost on ties). */
function findRawTarget(ast: any, source: string, comment: CommentLike): RawNode | undefined {
  let best: RawNode | undefined;
  walk(ast, node => {
    if (NON_CANDIDATE_TYPES.has(node.type) || !node.loc) return;
    if (!immediatelyFollows(node.loc.end.line, comment.loc.start.line) || node.end > comment.start) return;
    if (!GAP_RE.test(source.slice(node.end, comment.start))) return;
    if (!best || node.end > best.end || (node.end === best.end && node.start >= best.start)) best = node;
  });
  return best;
}

/** Resolves a raw candidate to the expression that will be wrapped (mirrors the Babel-path logic). */
function resolveRawExpression(node: RawNode | undefined): RawNode | undefined {
  let cur = node;
  for (let i = 0; cur && i < 5; i++) {
    switch (cur.type) {
      case 'ExpressionStatement': cur = cur.expression; continue;
      case 'VariableDeclaration': cur = cur.declarations[cur.declarations.length - 1]; continue;
      case 'VariableDeclarator': cur = cur.init ?? undefined; continue;
      case 'ReturnStatement': case 'ThrowStatement': cur = cur.argument ?? undefined; continue;
      case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': cur = cur.declaration ?? undefined; continue;
      default: return cur;
    }
  }
  return cur;
}

/**
 * Finds live markers in the original source using @babel/parser's comment list (so `//?` inside
 * strings/regexes is ignored). Also records each marker's target expression start for the
 * source-map fallback. Returns [] when the source cannot be parsed at all.
 */
export function findLiveMarkers(source: string, filename: string, babelParser: any): LiveMarker[] {
  if (!hasLiveMarkers(source)) return [];
  const ast = parseWithFallbacks(babelParser, source, filename);
  if (!ast) return [];
  const comments: CommentLike[] = ast.comments ?? [];
  const markers: LiveMarker[] = [];
  for (const c of comments) {
    const parsed = parseMarkerValue(c.value);
    if (!parsed) continue;
    const marker: LiveMarker = {
      line: c.loc.start.line,
      column: c.loc.start.column,
      start: c.start,
      end: c.end,
      kind: parsed.kind,
      commentKind: c.type === 'CommentBlock' ? 'block' : 'line',
    };
    if (parsed.expression) marker.expression = parsed.expression;
    const statement = parsed.expression && !referencesProbeValue(parsed.expression, babelParser) ? findRawStatement(ast, source, c) : undefined;
    if (statement) marker.standalone = true;
    const target = statement ?? resolveRawExpression(findRawTarget(ast, source, c));
    if (target?.loc) {
      marker.targetStart = { line: target.loc.start.line, column: target.loc.start.column };
      marker.targetEnd = { line: target.loc.end.line, column: target.loc.end.column };
    }
    markers.push(marker);
  }
  return markers;
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Stable digest of marker positions/kinds/expressions (part of the cache key). */
export function markersHash(markers: readonly LiveMarker[]): string {
  return sha1(markers.map(m => `${m.line}:${m.column}:${m.kind}:${m.commentKind}:${m.expression ?? ''}`).join('\n'));
}

// ---------------------------------------------------------------------------------------------
// Babel plugin over the transformed code
// ---------------------------------------------------------------------------------------------

interface Anchor {
  marker: LiveMarker;
  mode: 'endsBefore' | 'afterStatement' | 'startsAt';
  line: number;
  column: number;
  /** For endsBefore: the transformed comment's start offset. */
  offset: number;
  /**
   * For startsAt: generated position of the first mapping at/after the ORIGINAL target end
   * (LEAST_UPPER_BOUND). Candidates must end at or before it; without it the outermost wins.
   */
  endBound?: { line: number; column: number };
}

interface Candidate { path: any; start: number; end: number; endLine: number; endColumn: number }

function endsWithinBound(c: Candidate, bound: { line: number; column: number } | undefined): boolean {
  if (!bound) return true;
  return c.endLine < bound.line || (c.endLine === bound.line && c.endColumn <= bound.column);
}

interface PluginContext {
  filename: string;
  markers: LiveMarker[];
  innerMap?: Record<string, unknown>;
  deps: ProbeDeps;
  /** Filled by the plugin for diagnostics/tests. */
  stats: { wrapped: number; skipped: number; mode: 'comments' | 'sourceMap' | 'none' };
}

function isSafeExpressionPosition(p: any): boolean {
  const parent = p.parentPath;
  if (!parent) return false;
  const key = p.key;
  const listKey = p.listKey;
  if (parent.isImportDeclaration() || parent.isExportAllDeclaration()) return false;
  if (parent.isExportNamedDeclaration() && key === 'source') return false;
  if (parent.isVariableDeclarator() && key === 'id') return false;
  if ((parent.isObjectProperty() || parent.isClassProperty() || parent.isClassMethod() || parent.isObjectMethod() || parent.isClassPrivateProperty() || parent.isClassAccessorProperty?.()) && key === 'key') return false;
  if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && key === 'property' && !parent.node.computed) return false;
  if (parent.isFunction() && (listKey === 'params' || key === 'id')) return false;
  if (parent.isCatchClause() && key === 'param') return false;
  if ((parent.isCallExpression() || parent.isNewExpression() || parent.isOptionalCallExpression()) && key === 'callee') return false;
  if (parent.isTaggedTemplateExpression() && key === 'tag') return false;
  if ((parent.isLabeledStatement() || parent.isBreakStatement() || parent.isContinueStatement()) && key === 'label') return false;
  if (parent.isAssignmentExpression() && key === 'left') return false;
  if (parent.isUpdateExpression()) return false;
  if ((parent.isForInStatement() || parent.isForOfStatement()) && key === 'left') return false;
  if (parent.isPattern() || parent.isRestElement()) return !(parent.isAssignmentPattern() && key === 'left') && !parent.isRestElement() && key === 'right';
  if (parent.isObjectProperty() && key === 'value' && parent.parentPath?.isObjectPattern()) return false;
  if (parent.isImportSpecifier() || parent.isExportSpecifier() || parent.isImportDefaultSpecifier() || parent.isImportNamespaceSpecifier()) return false;
  if (parent.isJSXAttribute() || parent.isJSXOpeningElement() || parent.isJSXClosingElement() || parent.isJSXMemberExpression()) return false;
  if (parent.isMetaProperty() || parent.isPrivateName()) return false;
  if (parent.isClassDeclaration() || parent.isClassExpression()) return key === 'superClass';
  if (p.isSuper() || p.isJSXIdentifier?.()) return false;
  return true;
}

type Resolved = { kind: 'expr'; path: any } | { kind: 'decl'; path: any; name: string };

function resolveWrappable(start: any): Resolved | undefined {
  let cur = start;
  for (let i = 0; cur && i < 6; i++) {
    if (cur.isExpressionStatement()) { cur = cur.get('expression'); continue; }
    if (cur.isVariableDeclaration()) {
      const decls = cur.get('declarations');
      const last = decls[decls.length - 1];
      if (!last || !last.node.init) return undefined;
      cur = last.get('init');
      continue;
    }
    if (cur.isVariableDeclarator()) {
      if (!cur.node.init) return undefined;
      cur = cur.get('init');
      continue;
    }
    if (cur.isReturnStatement() || cur.isThrowStatement()) {
      if (!cur.node.argument) return undefined;
      cur = cur.get('argument');
      continue;
    }
    if (cur.isExportNamedDeclaration() || cur.isExportDefaultDeclaration()) {
      const decl = cur.get('declaration');
      if (!decl.node) return undefined;
      if (decl.isExpression()) { cur = decl; continue; }
      if (decl.isVariableDeclaration()) { cur = decl; continue; }
      if ((decl.isFunctionDeclaration() || decl.isClassDeclaration()) && decl.node.id) return { kind: 'decl', path: cur, name: decl.node.id.name };
      return undefined;
    }
    if (cur.isFunctionDeclaration() || cur.isClassDeclaration()) {
      return cur.node.id ? { kind: 'decl', path: cur, name: cur.node.id.name } : undefined;
    }
    if ((cur.isObjectProperty() || cur.isClassProperty()) && cur.node.value) { cur = cur.get('value'); continue; }
    if (cur.isIdentifier() && cur.parentPath?.isVariableDeclarator() && cur.key === 'id') { cur = cur.parentPath; continue; }
    if (cur.isExpression()) return isSafeExpressionPosition(cur) ? { kind: 'expr', path: cur } : undefined;
    return undefined;
  }
  return undefined;
}

/** Replaces `$` identifiers (not property names) in an accessor expression AST with `__hj_t`. */
function bindDollar(node: any, t: any): void {
  walk(node, (n, parent, key) => {
    if (n.type !== 'Identifier' || n.name !== '$') return;
    if (parent && key === 'property' && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && !parent.computed) return;
    if (parent && key === 'key' && (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && !parent.computed) return;
    n.name = '__hj_t';
  });
  void t;
}

function buildProbeCall(t: any, filename: string, marker: LiveMarker, valueExpr: any): any {
  return t.callExpression(
    t.memberExpression(t.identifier('globalThis'), t.identifier(PROBE_GLOBAL)),
    [t.stringLiteral(filename), t.numericLiteral(marker.line), t.numericLiteral(marker.column), valueExpr],
  );
}

/** `Date.now()` */
function nowCall(t: any): any {
  return t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now')), []);
}

/**
 * Builds the replacement for `expr`:
 * - value:   globalThis.__hj_v(file, L, C, (expr))
 * - $-expr:  ((__hj_t) => (globalThis.__hj_v(file, L, C, <expr with $=__hj_t>), __hj_t))(expr)
 * - timing:  ((__hj_t0) => (__hj_t) => (globalThis.__hj_v(file, L, C, Date.now() - __hj_t0 + ' ms'), __hj_t))(Date.now())(expr)
 * Arrow IIFEs keep `await`/`yield` inside `expr` legal (the argument is evaluated in the outer scope).
 */
function buildReplacement(t: any, babelParser: any, filename: string, marker: LiveMarker, expr: any, log?: (m: string) => void): any {
  if (marker.kind === 'timing') {
    const t0 = t.identifier('__hj_t0');
    const tv = t.identifier('__hj_t');
    const elapsed = t.binaryExpression('+', t.binaryExpression('-', nowCall(t), t0), t.stringLiteral(' ms'));
    const inner = t.arrowFunctionExpression([tv], t.sequenceExpression([buildProbeCall(t, filename, marker, elapsed), tv]));
    const outer = t.arrowFunctionExpression([t0], inner);
    return t.callExpression(t.callExpression(outer, [nowCall(t)]), [expr]);
  }
  if (marker.expression) {
    try {
      const accessor = babelParser.parseExpression(marker.expression, { plugins: ['jsx', 'typescript'] });
      bindDollar(accessor, t);
      const tv = t.identifier('__hj_t');
      const arrow = t.arrowFunctionExpression([tv], t.sequenceExpression([buildProbeCall(t, filename, marker, accessor), t.identifier('__hj_t')]));
      return t.callExpression(arrow, [expr]);
    } catch (err) {
      log?.(`probe: cannot parse live-comment expression "${marker.expression}" at ${filename}:${marker.line}: ${(err as Error).message}`);
    }
  }
  return buildProbeCall(t, filename, marker, expr);
}

function preludeStatement(t: any): any {
  // if (typeof globalThis.__hj_v !== "function") globalThis.__hj_v = function (f, l, c, v) { return v; };
  const member = () => t.memberExpression(t.identifier('globalThis'), t.identifier(PROBE_GLOBAL));
  const noop = t.functionExpression(null, [t.identifier('f'), t.identifier('l'), t.identifier('c'), t.identifier('v')], t.blockStatement([t.returnStatement(t.identifier('v'))]));
  return t.ifStatement(
    t.binaryExpression('!==', t.unaryExpression('typeof', member()), t.stringLiteral('function')),
    t.expressionStatement(t.assignmentExpression('=', member(), noop)),
  );
}

function findSourceName(tracer: any, filename: string): string | undefined {
  const sources: Array<string | null> = tracer?.sources ?? [];
  const base = path.basename(filename);
  return (
    sources.find(s => s === filename) ??
    sources.find(s => !!s && path.resolve(path.dirname(filename), s) === filename) ??
    sources.find(s => !!s && path.basename(s) === base) ??
    sources.find(s => !!s) ??
    undefined
  ) as string | undefined;
}

function computeAnchors(ctx: PluginContext, fileComments: CommentLike[], code: string): Anchor[] {
  const transformedMarkers = fileComments.filter(c => parseMarkerValue(c.value));
  if (transformedMarkers.length === ctx.markers.length && transformedMarkers.length > 0) {
    ctx.stats.mode = 'comments';
    return transformedMarkers.map((c, i) => ({ marker: ctx.markers[i], mode: ctx.markers[i].standalone ? 'afterStatement' : 'endsBefore', line: c.loc.start.line, column: c.loc.start.column, offset: c.start }));
  }
  const tm = ctx.deps.traceMapping;
  if (ctx.innerMap && tm?.TraceMap && typeof tm.generatedPositionFor === 'function') {
    try {
      const tracer = new tm.TraceMap(ctx.innerMap as any);
      const source = findSourceName(tracer, ctx.filename);
      if (source) {
        ctx.stats.mode = 'sourceMap';
        const anchors: Anchor[] = [];
        for (const marker of ctx.markers) {
          if (!marker.targetStart) continue;
          const gen = tm.generatedPositionFor(tracer, { source, line: marker.targetStart.line, column: marker.targetStart.column });
          if (gen && typeof gen.line === 'number' && typeof gen.column === 'number') {
            const anchor: Anchor = { marker, mode: 'startsAt', line: gen.line, column: gen.column, offset: -1 };
            if (marker.targetEnd) {
              const genEnd = tm.generatedPositionFor(tracer, { source, line: marker.targetEnd.line, column: marker.targetEnd.column, bias: tm.LEAST_UPPER_BOUND });
              if (genEnd && typeof genEnd.line === 'number' && typeof genEnd.column === 'number') anchor.endBound = { line: genEnd.line, column: genEnd.column };
            }
            anchors.push(anchor);
          }
        }
        return anchors;
      }
    } catch (err) {
      ctx.deps.log?.(`probe: source-map fallback failed for ${ctx.filename}: ${(err as Error).message}`);
    }
  }
  ctx.stats.mode = 'none';
  ctx.deps.log?.(`probe: ${ctx.filename}: ${transformedMarkers.length} marker comment(s) survived the transform for ${ctx.markers.length} marker(s) and no source map fallback is available; live comments skipped`);
  void code;
  return [];
}

/** The Babel plugin factory; `ctx` is per-file. */
export function createProbePlugin(ctx: PluginContext): (babel: any) => any {
  return (babel: any) => {
    const t = babel.types;
    return {
      name: 'hyperjest-probes',
      visitor: {
        Program(programPath: any, state: any) {
          const code: string = state.file.code ?? '';
          const fileComments: CommentLike[] = programPath.parent?.comments ?? [];
          const anchors = computeAnchors(ctx, fileComments, code);
          /** Per anchor: candidate nodes in preference order (outermost first); the first wrappable one wins. */
          const candidates: Candidate[][] = anchors.map(() => []);

          if (anchors.length) {
            programPath.traverse({
              enter(p: any) {
                const node = p.node;
                const loc = node.loc;
                if (!loc || NON_CANDIDATE_TYPES.has(node.type)) return;
                const cand: Candidate = { path: p, start: node.start, end: node.end, endLine: loc.end.line, endColumn: loc.end.column };
                anchors.forEach((a, i) => {
                  const list = candidates[i];
                  if (a.mode === 'endsBefore' || a.mode === 'afterStatement') {
                    // Nodes ending closest before the comment on its line; pre-order traversal keeps the
                    // outermost first among nodes sharing that end (`a.b //?` -> MemberExpression before `b`).
                    if (!immediatelyFollows(loc.end.line, a.line) || typeof node.end !== 'number' || node.end > a.offset) return;
                    if (a.mode === 'afterStatement' && !isProbeStatement(node.type)) return;
                    if (!GAP_RE.test(code.slice(node.end, a.offset))) return;
                    if (!list.length || node.end > list[0].end) list.splice(0, list.length, cand);
                    else if (node.end === list[0].end) list.push(cand);
                  } else if (loc.start.line === a.line && loc.start.column === a.column && (a.marker.standalone ? isProbeStatement(node.type) : (p.isExpression() || p.isVariableDeclarator() || p.isFunctionDeclaration() || p.isClassDeclaration()))) {
                    list.push(cand); // enter order: outermost first
                  }
                });
              },
            });
          }

          const jobs: Array<{ resolved?: Resolved; statement?: any; marker: LiveMarker; start: number }> = [];
          candidates.forEach((cands, i) => {
            const anchor = anchors[i];
            // startsAt: candidates ending within the mapped end bound first (outermost first), the rest as fallback.
            const ordered = anchor.mode === 'startsAt'
              ? [...cands.filter(c => endsWithinBound(c, anchor.endBound)), ...cands.filter(c => !endsWithinBound(c, anchor.endBound))]
              : cands;
            if (anchor.marker.standalone) {
              const statement = ordered.find(c => isProbeStatement(c.path.node.type));
              if (!statement) { ctx.stats.skipped++; return; }
              jobs.push({ statement: statement.path, marker: anchor.marker, start: statement.start });
              return;
            }
            let resolved: Resolved | undefined;
            for (const c of ordered) {
              resolved = resolveWrappable(c.path);
              if (resolved) break;
            }
            if (!resolved) { ctx.stats.skipped++; return; }
            jobs.push({ resolved, marker: anchor.marker, start: resolved.path.node.start ?? ordered[0].start });
          });
          // innermost/later targets first so nested markers keep valid paths
          jobs.sort((x, y) => y.start - x.start || y.marker.start - x.marker.start);
          const done = new WeakSet<object>();
          for (const job of jobs) {
            const { resolved, marker, statement } = job;
            const target = statement ?? resolved?.path;
            if (!target || (!statement && done.has(target.node))) { ctx.stats.skipped++; continue; }
            if (!statement) done.add(target.node);
            if (statement) {
              try {
                const expression = ctx.deps.babelParser.parseExpression(marker.expression, { plugins: ['jsx', 'typescript'] });
                statement.insertAfter(t.expressionStatement(buildProbeCall(t, ctx.filename, marker, expression)));
              } catch (err) {
                ctx.deps.log?.(`probe: cannot parse live-comment expression "${marker.expression}" at ${ctx.filename}:${marker.line}: ${(err as Error).message}`);
                ctx.stats.skipped++;
                continue;
              }
            } else if (resolved?.kind === 'expr') {
              resolved.path.replaceWith(buildReplacement(t, ctx.deps.babelParser, ctx.filename, marker, resolved.path.node, ctx.deps.log));
            } else if (resolved?.kind === 'decl') {
              resolved.path.insertAfter(t.expressionStatement(buildProbeCall(t, ctx.filename, marker, t.identifier(resolved.name))));
            }
            ctx.stats.wrapped++;
          }
          if (ctx.stats.wrapped > 0) programPath.unshiftContainer('body', preludeStatement(t));
          programPath.stop();
        },
      },
    };
  };
}

function normaliseMap(map: unknown): Record<string, unknown> | undefined {
  if (!map) return undefined;
  if (typeof map === 'string') {
    try { return JSON.parse(map) as Record<string, unknown>; } catch { return undefined; }
  }
  return typeof map === 'object' ? (map as Record<string, unknown>) : undefined;
}

export interface InstrumentInput {
  /** The inner transformer's output. */
  code: string;
  map?: unknown;
  /** The original source (as Jest read it: overlay content when applicable). */
  source: string;
  filename: string;
  deps: ProbeDeps;
  /** Pre-computed markers (otherwise found from `source`). */
  markers?: LiveMarker[];
}

export interface InstrumentResult { code: string; map?: unknown; wrapped: number; skipped: number; mode: 'comments' | 'sourceMap' | 'none' }

/**
 * Runs the probe pass over transformed code. Returns undefined when nothing was instrumented
 * (no markers, or every marker was skipped) so callers can keep the inner result object.
 */
export function instrumentWithProbes(input: InstrumentInput): InstrumentResult | undefined {
  const markers = input.markers ?? findLiveMarkers(input.source, input.filename, input.deps.babelParser);
  if (!markers.length) return undefined;
  const innerMap = normaliseMap(input.map);
  const ctx: PluginContext = { filename: input.filename, markers, innerMap, deps: input.deps, stats: { wrapped: 0, skipped: 0, mode: 'none' } };
  const result = input.deps.babelCore.transformSync(input.code, {
    filename: input.filename,
    code: true,
    ast: false,
    babelrc: false,
    configFile: false,
    browserslistConfigFile: false,
    sourceMaps: 'both',
    ...(innerMap ? { inputSourceMap: innerMap } : {}),
    sourceType: 'unambiguous',
    compact: false,
    retainLines: true,
    comments: true,
    highlightCode: false,
    cloneInputAst: false,
    parserOpts: {
      plugins: ['jsx'],
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    },
    plugins: [createProbePlugin(ctx)],
  });
  if (!result || typeof result.code !== 'string' || ctx.stats.wrapped === 0) return undefined;
  return { code: result.code, map: result.map ?? undefined, wrapped: ctx.stats.wrapped, skipped: ctx.stats.skipped, mode: ctx.stats.mode };
}

// ---------------------------------------------------------------------------------------------
// Transformer wrapper
// ---------------------------------------------------------------------------------------------

interface TransformOptionsLike { configString?: string; instrument?: boolean; [k: string]: unknown }

function normaliseResult(result: unknown): TransformedSourceLike | undefined {
  if (typeof result === 'string') return { code: result };
  if (result && typeof result === 'object' && typeof (result as TransformedSourceLike).code === 'string') return result as TransformedSourceLike;
  return undefined;
}

/** Jest's default cache-key inputs (29.7 ScriptTransformer._getCacheKey / 30.5.2 index.js:169). */
function defaultJestKey(sourceText: string, sourcePath: string, options: TransformOptionsLike | undefined): string {
  return sha1(`${sourceText}\0${options?.configString ?? ''}\0${options?.instrument ? 'instrument' : ''}\0${sourcePath}`);
}

/**
 * Wraps a Jest transformer object. Only `process`, `processAsync`, `getCacheKey`,
 * `getCacheKeyAsync` and `canInstrument` are exposed (what @jest/transform reads); each method is
 * present only when the inner has the corresponding one (`getCacheKey` is always present so marker
 * files never share a cache entry with plain Jest). Files without markers pass through untouched:
 * the inner result object is returned by identity.
 */
export function wrapTransformer(inner: any, deps: ProbeDeps): any {
  if (!inner || typeof inner !== 'object') return inner;
  if ((inner as { __hjProbeWrapped?: boolean }).__hjProbeWrapped) return inner;
  const probeVersion = deps.probeVersion ?? DEFAULT_PROBE_VERSION;

  const markersOf = (sourceText: string, sourcePath: string): LiveMarker[] =>
    hasLiveMarkers(sourceText) ? findLiveMarkers(sourceText, sourcePath, deps.babelParser) : [];

  const instrument = (raw: unknown, sourceText: string, sourcePath: string, markers: LiveMarker[]): unknown => {
    const normalised = normaliseResult(raw);
    if (!normalised) return raw;
    try {
      const out = instrumentWithProbes({ code: normalised.code, map: normalised.map, source: sourceText, filename: sourcePath, deps, markers });
      if (!out) return raw;
      deps.log?.(`probe: ${sourcePath}: wrapped ${out.wrapped} marker(s) via ${out.mode}${out.skipped ? `, skipped ${out.skipped}` : ''}`);
      return out.map !== undefined ? { code: out.code, map: out.map } : { code: out.code };
    } catch (err) {
      deps.log?.(`probe: ${sourcePath}: instrumentation failed, using the plain transform: ${(err as Error).stack ?? err}`);
      return raw;
    }
  };

  const cacheKeyFor = (innerKey: unknown, sourceText: string, sourcePath: string, options: TransformOptionsLike | undefined): string | undefined => {
    const markers = markersOf(sourceText, sourcePath);
    if (!markers.length) return innerKey == null ? undefined : String(innerKey);
    const base = innerKey == null ? defaultJestKey(sourceText, sourcePath, options) : String(innerKey);
    return sha1(`${base}|hj${probeVersion}|${markersHash(markers)}`);
  };

  const wrapper: Record<string, unknown> = { __hjProbeWrapped: true };
  if ('canInstrument' in inner) wrapper.canInstrument = inner.canInstrument;

  if (typeof inner.process === 'function') {
    wrapper.process = (sourceText: string, sourcePath: string, options: TransformOptionsLike) => {
      const markers = markersOf(sourceText, sourcePath);
      const result = inner.process(sourceText, sourcePath, options);
      return markers.length ? instrument(result, sourceText, sourcePath, markers) : result;
    };
  }
  if (typeof inner.processAsync === 'function') {
    wrapper.processAsync = async (sourceText: string, sourcePath: string, options: TransformOptionsLike) => {
      const markers = markersOf(sourceText, sourcePath);
      const result = await inner.processAsync(sourceText, sourcePath, options);
      return markers.length ? instrument(result, sourceText, sourcePath, markers) : result;
    };
  }
  wrapper.getCacheKey = (sourceText: string, sourcePath: string, options: TransformOptionsLike) => {
    const innerKey = typeof inner.getCacheKey === 'function' ? inner.getCacheKey(sourceText, sourcePath, options) : undefined;
    return cacheKeyFor(innerKey, sourceText, sourcePath, options);
  };
  if (typeof inner.getCacheKeyAsync === 'function') {
    wrapper.getCacheKeyAsync = async (sourceText: string, sourcePath: string, options: TransformOptionsLike) => {
      const innerKey = await inner.getCacheKeyAsync(sourceText, sourcePath, options);
      return cacheKeyFor(innerKey, sourceText, sourcePath, options);
    };
  }
  return wrapper;
}
