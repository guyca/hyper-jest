/**
 * Reconciliation between the statically parsed test tree ({@link ParsedFile}) and runtime results
 * (`TestResultMsg`-like records), plus tree helpers shared by the Explorer, gutter and commands.
 * Pure; no 'vscode'.
 *
 * Matching passes, in order (plan: "Result -> UI mapping / Test Explorer"):
 *  1. structural: `ancestorTitles`/`title` walked down the static tree with exact titles; the k-th
 *     runtime duplicate goes to the k-th static duplicate (`dupOrdinal`);
 *  2. pattern structural: template (`${}`), dynamic and `.each` (`%s`, `$var`) titles matched by
 *     pattern; a node that already has a result, or an `.each` node, gets `row:<title>[#n]` children;
 *  3. location hint: `location.line - 1` landing on a static test's declaration, accepted only when
 *     the title is compatible;
 *  4. everything else is `runtimeOnly`, parented under the deepest matched static describe.
 *
 * Item ids follow {@link parsedNodeId}; runtime children append `row:<title>[#n]` (rows of an
 * `.each`/loop node) or `test:<title>[#n]` / `describe:<title>` (runtime-only items).
 */
import { parsedNodeId, type ParsedFile, type ParsedNode } from './testModel';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** The subset of `TestResultMsg` reconciliation needs. */
export interface RuntimeTestLike {
  fullName: string;
  ancestorTitles: string[];
  title: string;
  /** 1-based (Jest) call-site location or null. */
  location: { line: number; column: number } | null;
  testKey: string;
}

export type MatchKind = 'exact' | 'dupOrdinal' | 'locationHint' | 'eachRow' | 'runtimeOnly';

export interface ReconciledTest {
  testKey: string;
  kind: MatchKind;
  /** Stable Test Explorer item id for this runtime test. */
  nodeId: string;
  /**
   * `exact`/`dupOrdinal`/`locationHint`: the static test node.
   * `eachRow`: the static `.each`/loop node that owns the row.
   * `runtimeOnly`: null.
   */
  node: ParsedNode | null;
  /** Static describe ancestry of `node`, or of the deepest matched describe for runtime-only tests. */
  ancestry: ParsedNode[];
  /** Id of the item under which a runtime child (`eachRow`/`runtimeOnly`) is created; for direct matches, the node's own parent id. */
  parentId: string;
  /** `runtimeOnly`: runtime describe titles below the deepest matched static describe (intermediate items to create). */
  extraAncestors: string[];
  /**
   * `eachRow`: label for the row item. The runtime title, prefixed by the runtime titles of any
   * `.each`/template/dynamic describes on the path (so `describe.each` rows read `suite 1 inner`).
   */
  rowLabel?: string;
}

export interface ReconcileIds {
  projectId: string;
  relPath: string;
}

export interface NodeWithAncestry {
  node: ParsedNode;
  ancestry: ParsedNode[];
}

export interface UnreportedNode extends NodeWithAncestry {
  nodeId: string;
}

// ---------------------------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------------------------

/** Pre-order list of all nodes with their describe ancestry. */
export function walkNodes(parsed: ParsedFile): NodeWithAncestry[] {
  const out: NodeWithAncestry[] = [];
  const visit = (nodes: ParsedNode[], ancestry: ParsedNode[]) => {
    for (const node of nodes) {
      out.push({ node, ancestry });
      if (node.children.length > 0) visit(node.children, [...ancestry, node]);
    }
  };
  visit(parsed.nodes, []);
  return out;
}

/** Pre-order list of test nodes (kind 'test') with their ancestry. */
export function walkTests(parsed: ParsedFile): NodeWithAncestry[] {
  return walkNodes(parsed).filter(e => e.node.kind === 'test');
}

/** Innermost parsed node (test or describe) whose range contains the 0-based `line`, or null. */
export function findNodeAtLine(parsed: ParsedFile, line: number): NodeWithAncestry | null {
  let best: NodeWithAncestry | null = null;
  const visit = (nodes: ParsedNode[], ancestry: ParsedNode[]) => {
    for (const node of nodes) {
      if (line < node.range.startLine || line > node.range.endLine) continue;
      best = { node, ancestry };
      visit(node.children, [...ancestry, node]);
      return;
    }
  };
  visit(parsed.nodes, []);
  return best;
}

/** Innermost parsed *test* containing the line (walks up from the innermost node), or null. */
export function findTestAtLine(parsed: ParsedFile, line: number): NodeWithAncestry | null {
  const hit = findNodeAtLine(parsed, line);
  if (!hit) return null;
  if (hit.node.kind === 'test') return hit;
  for (let i = hit.ancestry.length - 1; i >= 0; i--) {
    if (hit.ancestry[i].kind === 'test') return { node: hit.ancestry[i], ancestry: hit.ancestry.slice(0, i) };
  }
  return null;
}

/** Jest full name: ancestor titles and the title joined by single spaces (see protocol.fullNameOf). */
export function fullNameOfNode(ancestry: readonly ParsedNode[], node: ParsedNode): string {
  return [...ancestry.map(a => a.title), node.title].join(' ');
}

/** True when the full name is known exactly at parse time (no template/dynamic/.each segment). */
export function hasStaticFullName(ancestry: readonly ParsedNode[], node: ParsedNode): boolean {
  return [...ancestry, node].every(n => n.titleKind === 'static' && !n.each);
}

/**
 * Full names of the leaf tests under `node` (the node itself when it is a test), for
 * `RunTestSelection.names`. `exact` is false when any name contains a template/dynamic/.each
 * segment, in which case callers should fall back to a whole-file run.
 */
export function testFullNames(ancestry: readonly ParsedNode[], node: ParsedNode): { names: string[]; exact: boolean } {
  const names: string[] = [];
  let exact = true;
  const visit = (n: ParsedNode, anc: ParsedNode[]) => {
    if (n.kind === 'test') {
      names.push(fullNameOfNode(anc, n));
      if (!hasStaticFullName(anc, n)) exact = false;
    }
    for (const c of n.children) visit(c, [...anc, n]);
  };
  visit(node, [...ancestry]);
  return { names, exact };
}

/** Id of a static node (wrapper around {@link parsedNodeId}). */
export function nodeIdOf(ids: ReconcileIds, ancestry: readonly ParsedNode[], node: ParsedNode): string {
  return parsedNodeId(ids.projectId, ids.relPath, [...ancestry], node);
}

/** Id prefix shared by every item of the file (`projectId\0relPath`). */
export function fileIdOf(ids: ReconcileIds): string {
  return [ids.projectId, ids.relPath].join('\0');
}

// ---------------------------------------------------------------------------------------------
// Title matching
// ---------------------------------------------------------------------------------------------

/** jest-each printf placeholders (`%$` is v30's 1-based row number). */
const EACH_PRINTF = /%[sdifjoOp#$]/y;
/** jest-each `$variable.path` / `$#` interpolation. */
const EACH_VAR = /\$(?:#|[A-Za-z_][\w]*(?:\.[\w]+)*)/y;

const patternCache = new WeakMap<ParsedNode, RegExp | null>();

/**
 * Regex a runtime title must match for a template/.each node, or null when the title is matched
 * by equality (static) or accepts anything (dynamic). Cached per node.
 */
export function titlePattern(node: ParsedNode): RegExp | null {
  if (patternCache.has(node)) return patternCache.get(node)!;
  const needsPattern = node.each || node.titleKind === 'template';
  const re = needsPattern ? buildTitleRegex(node.title, node.each, node.titleKind === 'template') : null;
  patternCache.set(node, re);
  return re;
}

function buildTitleRegex(title: string, each: boolean, template: boolean): RegExp {
  let out = '^';
  let i = 0;
  while (i < title.length) {
    const ch = title[i];
    if (template && ch === '$' && title[i + 1] === '{') {
      out += '(.*?)';
      i = findTemplateClose(title, i + 2);
      continue;
    }
    if (each && ch === '%') {
      if (title[i + 1] === '%') { out += '%'; i += 2; continue; }
      EACH_PRINTF.lastIndex = i;
      if (EACH_PRINTF.exec(title)) { out += '(.*?)'; i += 2; continue; }
    }
    if (each && ch === '$') {
      EACH_VAR.lastIndex = i;
      const m = EACH_VAR.exec(title);
      if (m) { out += '(.*?)'; i += m[0].length; continue; }
    }
    out += escapeRegExp(ch);
    i++;
  }
  return new RegExp(out + '$', 's');
}

/** Index just past the `}` closing a `${` opened at `from` (brace depth aware; falls back to end). */
function findTemplateClose(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a runtime title can belong to the node (equality, pattern, or anything for dynamic titles). */
export function titleMatches(node: ParsedNode, runtimeTitle: string): boolean {
  if (node.titleKind === 'dynamic' && !node.each) return true;
  const re = titlePattern(node);
  if (re) return re.test(runtimeTitle);
  return node.title === runtimeTitle;
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

interface StaticTest extends NodeWithAncestry {
  id: string;
  parentId: string;
  /** Results assigned directly to this node. */
  consumed: number;
  /** Row title -> number of rows created with it. */
  rows: Map<string, number>;
}

const KEY_SEP = '\u001f';
const KEY_TITLE_SEP = '\u001e';

/**
 * Map every runtime result (by `testKey`) to a static node or a runtime child item.
 * Results must be in Jest's definition order (depth-first) for duplicate ordinals to line up.
 */
export function reconcile(parsed: ParsedFile, results: readonly RuntimeTestLike[], ids: ReconcileIds): Map<string, ReconciledTest> {
  return reconcileInternal(parsed, results, ids).matches;
}

/**
 * Static test nodes that received no result and no rows. Meaningful only after an UNFILTERED run of
 * the file (with `-t`, deselected tests still report as pending, so this stays accurate there too,
 * but a run that errored before registration reports everything as unreported).
 */
export function unreportedNodes(parsed: ParsedFile, results: readonly RuntimeTestLike[], ids: ReconcileIds): UnreportedNode[] {
  const { statics } = reconcileInternal(parsed, results, ids);
  return statics.filter(s => s.consumed === 0 && s.rows.size === 0).map(s => ({ node: s.node, ancestry: s.ancestry, nodeId: s.id }));
}

function reconcileInternal(parsed: ParsedFile, results: readonly RuntimeTestLike[], ids: ReconcileIds) {
  const fileId = fileIdOf(ids);
  const statics: StaticTest[] = walkTests(parsed).map(({ node, ancestry }) => ({
    node, ancestry,
    id: nodeIdOf(ids, ancestry, node),
    parentId: ancestry.length ? nodeIdOf(ids, ancestry.slice(0, -1), ancestry[ancestry.length - 1]) : fileId,
    consumed: 0,
    rows: new Map(),
  }));
  const byNode = new Map<ParsedNode, StaticTest>(statics.map(s => [s.node, s]));

  // Index of fully static chains for pass 1.
  const byStaticKey = new Map<string, StaticTest[]>();
  for (const s of statics) {
    if (!hasStaticFullName(s.ancestry, s.node)) continue;
    const key = structuralKey(s.ancestry.map(a => a.title), s.node.title);
    const list = byStaticKey.get(key);
    if (list) list.push(s); else byStaticKey.set(key, [s]);
  }

  const matches = new Map<string, ReconciledTest>();
  const pending: RuntimeTestLike[] = [];

  // Pass 1: exact structural with duplicate ordinals.
  const ordinals = new Map<string, number>();
  for (const r of results) {
    const key = structuralKey(r.ancestorTitles, r.title);
    const list = byStaticKey.get(key);
    const k = ordinals.get(key) ?? 0;
    if (list && k < list.length) {
      ordinals.set(key, k + 1);
      const s = list[k];
      s.consumed++;
      matches.set(r.testKey, direct(r, s, k > 0 || list.length > 1 ? 'dupOrdinal' : 'exact'));
    } else {
      pending.push(r);
    }
  }

  // Pass 2: pattern structural (template / dynamic / .each / loop rows).
  const pending2: RuntimeTestLike[] = [];
  for (const r of pending) {
    const candidates: StaticTest[] = [];
    for (const siblings of matchDescribeChildren(parsed.nodes, r.ancestorTitles)) {
      for (const child of siblings) {
        if (child.kind !== 'test' || !titleMatches(child, r.title)) continue;
        const s = byNode.get(child);
        if (s) candidates.push(s);
      }
    }
    const picked = pickCandidate(candidates);
    if (!picked) { pending2.push(r); continue; }
    if (picked.asRow) matches.set(r.testKey, row(r, picked.entry));
    else { picked.entry.consumed++; matches.set(r.testKey, direct(r, picked.entry, 'exact')); }
  }

  // Pass 3: location hint (title-compatible only).
  const pending3: RuntimeTestLike[] = [];
  for (const r of pending2) {
    const line = r.location ? r.location.line - 1 : -1;
    let hit: StaticTest | null = null;
    if (line >= 0) {
      for (const s of statics) {
        const { range, nameRange } = s.node;
        if (line >= range.startLine && line <= Math.max(nameRange.startLine, range.startLine) && titleMatches(s.node, r.title)) {
          // Prefer the innermost (deepest) declaration starting on that line.
          if (!hit || s.ancestry.length > hit.ancestry.length) hit = s;
        }
      }
    }
    if (!hit) { pending3.push(r); continue; }
    if (mustBeRow(hit)) matches.set(r.testKey, row(r, hit));
    else { hit.consumed++; matches.set(r.testKey, direct(r, hit, 'locationHint')); }
  }

  // Pass 4: runtime-only items under the deepest matched describe.
  const runtimeOnlyOrdinals = new Map<string, number>();
  for (const r of pending3) {
    const { describe, ancestry, depth } = deepestDescribe(parsed.nodes, r.ancestorTitles);
    const parentId = describe ? nodeIdOf(ids, ancestry, describe) : fileId;
    const extra = r.ancestorTitles.slice(depth);
    const siblings = describe ? describe.children : parsed.nodes;
    // Offset past static siblings with the same title so ids never collide with parsed nodes.
    const staticSame = extra.length === 0 ? siblings.filter(c => c.kind === 'test' && c.title === r.title).length : 0;
    const ordKey = [parentId, ...extra, r.title].join('\0');
    const n = staticSame + (runtimeOnlyOrdinals.get(ordKey) ?? 0);
    runtimeOnlyOrdinals.set(ordKey, (runtimeOnlyOrdinals.get(ordKey) ?? 0) + 1);
    const segs = [...extra.map(t => `describe:${t}`), `test:${r.title}${n ? `#${n}` : ''}`];
    matches.set(r.testKey, {
      testKey: r.testKey,
      kind: 'runtimeOnly',
      nodeId: [parentId, ...segs].join('\0'),
      node: null,
      ancestry: describe ? [...ancestry, describe] : [],
      parentId,
      extraAncestors: extra,
    });
  }

  return { matches, statics };

  function direct(r: RuntimeTestLike, s: StaticTest, kind: MatchKind): ReconciledTest {
    return { testKey: r.testKey, kind, nodeId: s.id, node: s.node, ancestry: s.ancestry, parentId: s.parentId, extraAncestors: [] };
  }

  function row(r: RuntimeTestLike, s: StaticTest): ReconciledTest {
    const rowLabel = [...patternAncestorTitles(s.ancestry, r.ancestorTitles), r.title].join(' ');
    const n = s.rows.get(rowLabel) ?? 0;
    s.rows.set(rowLabel, n + 1);
    return {
      testKey: r.testKey,
      kind: 'eachRow',
      nodeId: `${s.id}\0row:${rowLabel}${n ? `#${n}` : ''}`,
      node: s.node,
      ancestry: s.ancestry,
      parentId: s.id,
      extraAncestors: [],
      rowLabel,
    };
  }
}

function structuralKey(ancestorTitles: readonly string[], title: string): string {
  return ancestorTitles.join(KEY_SEP) + KEY_TITLE_SEP + title;
}

/**
 * Choose among title-compatible static tests under the matched describes:
 *  1. a node that can still take a direct result (not `.each`, not under a `describe.each`, unconsumed)
 *     → direct match, static titles preferred over template/dynamic ones;
 *  2. a single remaining candidate (an `.each`/loop node or one that already has a result) → a row;
 *  3. several consumed candidates → ambiguous, leave for the next pass.
 */
function pickCandidate(candidates: StaticTest[]): { entry: StaticTest; asRow: boolean } | null {
  if (candidates.length === 0) return null;
  const free = candidates.filter(c => !mustBeRow(c));
  const freeStatic = free.find(c => c.node.titleKind === 'static');
  if (freeStatic) return { entry: freeStatic, asRow: false };
  if (free.length > 0) return { entry: free[0], asRow: false };
  if (candidates.length === 1) return { entry: candidates[0], asRow: true };
  const eachOnly = candidates.filter(c => c.node.each || c.ancestry.some(a => a.each));
  if (eachOnly.length === 1) return { entry: eachOnly[0], asRow: true };
  return null;
}

/** `.each` nodes, nodes under a `describe.each`, and nodes that already own a result only take rows. */
function mustBeRow(s: StaticTest): boolean {
  return s.node.each || s.consumed > 0 || s.ancestry.some(a => a.each);
}

/**
 * Runtime titles of the pattern-matched (`.each`/template/dynamic) describes on a static ancestry,
 * taken positionally from the result's `ancestorTitles` (only when the depths agree).
 */
function patternAncestorTitles(ancestry: readonly ParsedNode[], runtimeAncestors: readonly string[]): string[] {
  if (ancestry.length !== runtimeAncestors.length) return [];
  const out: string[] = [];
  for (let i = 0; i < ancestry.length; i++) {
    const a = ancestry[i];
    if (a.each || a.titleKind !== 'static') out.push(runtimeAncestors[i]);
  }
  return out;
}

/**
 * Children lists of every describe reachable by matching `titles` level by level (exact static
 * titles first, then pattern matches). For an empty `titles` this is the file's top level. Capped.
 */
function matchDescribeChildren(roots: ParsedNode[], titles: readonly string[]): ParsedNode[][] {
  const MAX = 64;
  let frontier: ParsedNode[][] = [roots];
  for (const title of titles) {
    const next: ParsedNode[][] = [];
    for (const children of frontier) {
      const exact = children.filter(c => c.kind === 'describe' && c.titleKind === 'static' && !c.each && c.title === title);
      const pool = exact.length > 0 ? exact : children.filter(c => c.kind === 'describe' && titleMatches(c, title));
      for (const d of pool) {
        next.push(d.children);
        if (next.length >= MAX) break;
      }
      if (next.length >= MAX) break;
    }
    if (next.length === 0) return [];
    frontier = next;
  }
  return frontier;
}

/** Deepest static describe chain matching a prefix of `titles`; `depth` = number of titles consumed. */
function deepestDescribe(roots: ParsedNode[], titles: readonly string[]): { describe: ParsedNode | null; ancestry: ParsedNode[]; depth: number } {
  let describe: ParsedNode | null = null;
  const ancestry: ParsedNode[] = [];
  let children = roots;
  let depth = 0;
  for (const title of titles) {
    const next = children.find(c => c.kind === 'describe' && c.titleKind === 'static' && !c.each && c.title === title)
      ?? children.find(c => c.kind === 'describe' && titleMatches(c, title));
    if (!next) break;
    if (describe) ancestry.push(describe);
    describe = next;
    children = next.children;
    depth++;
  }
  return { describe, ancestry, depth };
}
