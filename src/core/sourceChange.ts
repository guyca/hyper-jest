/** Conservative function-body change analysis against the exact source of a coverage revision. */
import { parse } from '@babel/parser';
import { pluginSetsFor } from './testParser';
import { diffLines } from './textDiff';
import type { CoverageMeta } from './resultModel';

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const IGNORED = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'errors', 'tokens']);
interface Node { type: string; start: number; end: number; body?: Node; loc: { start: { line: number; column: number }; end: { line: number; column: number } }; [key: string]: any }

function syntax(text: string, path: string): Node | undefined {
  for (const plugins of pluginSetsFor(path, text)) {
    try { return parse(text, { sourceType: 'unambiguous', plugins, allowReturnOutsideFunction: true }).program as unknown as Node; } catch { /* next syntax */ }
  }
  return undefined;
}

/** Ignore positions/formatting and function bodies, keeping all names, signatures and exports. */
function shape(value: any): any {
  if (Array.isArray(value)) return value.map(shape);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) {
    if (IGNORED.has(k)) continue;
    out[k] = k === 'body' && FUNCTIONS.has(value.type) ? { type: value.body?.type } : shape(value[k]);
  }
  return out;
}

function functions(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (FUNCTIONS.has(v.type)) out.push(v);
    for (const k of Object.keys(v)) if (!IGNORED.has(k)) visit(v[k]);
  };
  visit(root);
  return out;
}

function lineOffsets(text: string): number[] {
  const out = [0];
  const re = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push(match.index + match[0].length);
  out.push(text.length);
  return out;
}

function containsBody(fn: Node, start: number, end: number): boolean {
  if (!fn.body) return false;
  const block = fn.body.type === 'BlockStatement';
  return start >= fn.body.start + (block ? 1 : 0) && end <= fn.body.end - (block ? 1 : 0);
}

/** null means broad selection; an empty set proves no change to this revision. */
export function changedFunctions(path: string, text: string, meta: CoverageMeta): Set<number> | null {
  const old = meta.sourceText;
  if (old === undefined || !meta.originalCoordinates || !meta.fnEndLine) return null;
  if (old === text) return new Set();
  const before = syntax(old, path), after = syntax(text, path);
  if (!before || !after || JSON.stringify(shape(before)) !== JSON.stringify(shape(after))) return null;
  const a = functions(before), b = functions(after);
  if (a.length !== b.length || a.some((fn, i) => JSON.stringify(shape(fn)) !== JSON.stringify(shape(b[i])))) return null;
  const oldOffsets = lineOffsets(old), newOffsets = lineOffsets(text);
  const owners = new Set<number>();
  for (const h of diffLines(old, text)) {
    let x = oldOffsets[h.oldStart] ?? old.length, y = newOffsets[h.start] ?? text.length;
    let xe = oldOffsets[h.oldEnd] ?? old.length, ye = newOffsets[h.end] ?? text.length;
    // Refine a line hunk to changed characters: permits one-line arrows/empty bodies without
    // mistaking a declaration or adjacent statement on the same line for a body edit.
    while (x < xe && y < ye && old[x] === text[y]) { x++; y++; }
    while (xe > x && ye > y && old[xe - 1] === text[ye - 1]) { xe--; ye--; }
    if (x === xe && y === ye) continue;
    let owner = -1;
    for (let i = 0; i < a.length; i++) {
      if (!containsBody(a[i], x, xe) || !containsBody(b[i], y, ye)) continue;
      if (owner < 0 || a[i].end - a[i].start < a[owner].end - a[owner].start) owner = i;
    }
    if (owner < 0) return null;
    owners.add(owner);
  }
  // A whitespace-only line-ending change is harmless, but an unclassified text difference isn't.
  if (!owners.size) return null;
  const ids = new Set<number>();
  for (let i = 0; i < a.length; i++) {
    const fn = a[i];
    if (![...owners].some(o => a[o].start <= fn.start && fn.end <= a[o].end)) continue;
    const matches: number[] = [];
    const bodyEnd = fn.body!.loc.end;
    for (let id = 0; id < meta.fnDeclLine.length; id++) {
      const line = meta.fnDeclLine[id], end = meta.fnEndLine[id];
      const col = meta.fnDeclColumn?.[id], endCol = meta.fnEndColumn?.[id];
      if (line < fn.loc.start.line || line > fn.body!.loc.start.line || end !== bodyEnd.line) continue;
      if (col !== undefined && ((line === fn.loc.start.line && col < fn.loc.start.column) || (line === fn.body!.loc.start.line && col > fn.body!.loc.start.column))) continue;
      if (endCol !== undefined && endCol !== bodyEnd.column) continue;
      matches.push(id);
    }
    if (matches.length !== 1) return null;
    ids.add(matches[0]);
  }
  return ids;
}

/** Map statements only through unchanged lines and unique full ranges; never guess IDs. */
export function statementProjection(before: CoverageMeta, after: CoverageMeta): Map<number, number> {
  const out = new Map<number, number>();
  if (before === after || (before.revision && before.revision === after.revision) || (!before.revision && !after.revision && before.hash === after.hash)) {
    before.stmtStartLine.forEach((_, id) => { if (id < after.stmtStartLine.length) out.set(id, id); });
    return out;
  }
  if (before.sourceText === undefined || after.sourceText === undefined || !before.originalCoordinates || !after.originalCoordinates) return out;
  const hunks = diffLines(before.sourceText, after.sourceText);
  for (let id = 0; id < before.stmtStartLine.length; id++) {
    const start = before.stmtStartLine[id] - 1, end = before.stmtEndLine[id] - 1;
    if (hunks.some(h => h.oldStart <= end && h.oldEnd > start || h.oldStart === h.oldEnd && h.oldStart > start && h.oldStart <= end)) continue;
    const offset = hunks.filter(h => h.oldEnd <= start).reduce((n, h) => n + h.end - h.start - (h.oldEnd - h.oldStart), 0);
    const candidates: number[] = [];
    for (let next = 0; next < after.stmtStartLine.length; next++) {
      if (after.stmtStartLine[next] !== start + offset + 1 || after.stmtEndLine[next] !== end + offset + 1) continue;
      if (before.stmtStartColumn?.[id] !== after.stmtStartColumn?.[next] || before.stmtEndColumn?.[id] !== after.stmtEndColumn?.[next]) continue;
      candidates.push(next);
    }
    if (candidates.length === 1) out.set(id, candidates[0]);
  }
  return out;
}

/** Unchanged line coordinates for projecting auxiliary coverage (branches/shared functions). */
export function unchangedLines(before: CoverageMeta, after: CoverageMeta): ((line: number) => number | undefined) | undefined {
  if (before.sourceText === undefined || after.sourceText === undefined || !before.originalCoordinates || !after.originalCoordinates) return undefined;
  const hunks = diffLines(before.sourceText, after.sourceText);
  return line => {
    const index = line - 1;
    if (hunks.some(h => h.oldStart <= index && index < h.oldEnd)) return undefined;
    return line + hunks.filter(h => h.oldEnd <= index).reduce((n, h) => n + h.end - h.start - (h.oldEnd - h.oldStart), 0);
  };
}
