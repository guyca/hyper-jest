/**
 * Decide how much of an edited test file must re-run: a single test (the edit stayed strictly
 * inside one test body and nothing structural changed), the whole file, or "structural" (test or
 * describe names/counts changed, so item ids and results must be re-mapped). Pure; no 'vscode'.
 *
 * Mirrors Wallaby's `lastSingleChangeTest` / `lastChangeIsComplex` / `numberOfFunctionsChanged`
 * eligibility (see research: affected-tests findings, section A).
 */
import type { ParsedFile, ParsedNode } from './testModel';
import type { LineChange } from './textDiff';
import { fullNameOfNode, hasStaticFullName, walkTests, type NodeWithAncestry } from './testIds';

export type WholeFileReason =
  | 'parseError'
  | 'noLineChanges'
  | 'functionCountChanged'
  | 'outsideTestBody'
  | 'multipleTests'
  | 'dynamicName'
  | 'noTests';

export type StructuralReason = 'treeChanged';

export type ChangeAnalysis =
  | { kind: 'singleTest'; fullNames: string[]; node: ParsedNode; ancestry: ParsedNode[] }
  | { kind: 'wholeFile'; reason: WholeFileReason }
  | { kind: 'structural'; reason: StructuralReason };

/**
 * Compare the parse of the previous text with the parse of the current text given the line hunks
 * that transform one into the other (from {@link import('./textDiff').diffLines}, new-text coordinates).
 */
export function analyzeChange(oldParsed: ParsedFile, newParsed: ParsedFile, changes: readonly LineChange[]): ChangeAnalysis {
  if (newParsed.parseError || oldParsed.parseError) return { kind: 'wholeFile', reason: 'parseError' };
  if (structureSignature(oldParsed) !== structureSignature(newParsed)) return { kind: 'structural', reason: 'treeChanged' };
  if (oldParsed.functionCount !== newParsed.functionCount) return { kind: 'wholeFile', reason: 'functionCountChanged' };
  if (changes.length === 0) return { kind: 'wholeFile', reason: 'noLineChanges' };

  const tests = walkTests(newParsed);
  if (tests.length === 0) return { kind: 'wholeFile', reason: 'noTests' };

  // Every hunk must land strictly inside the same (innermost) test body.
  let owner: NodeWithAncestry | null = null;
  for (const change of changes) {
    const inner = innermostTestContaining(tests, change);
    if (!inner) return { kind: 'wholeFile', reason: 'outsideTestBody' };
    if (owner && owner.node !== inner.node) return { kind: 'wholeFile', reason: 'multipleTests' };
    owner = inner;
  }
  if (!owner) return { kind: 'wholeFile', reason: 'outsideTestBody' };
  if (!hasStaticFullName(owner.ancestry, owner.node)) return { kind: 'wholeFile', reason: 'dynamicName' };
  return { kind: 'singleTest', fullNames: [fullNameOfNode(owner.ancestry, owner.node)], node: owner.node, ancestry: owner.ancestry };
}

/**
 * Order-sensitive shape of the tree: kind, title, title kind, mode, each-ness and depth of every
 * node. Equal signatures mean item ids and full names are unchanged. Exported for tests.
 */
export function structureSignature(parsed: ParsedFile): string {
  const parts: string[] = [];
  const visit = (nodes: ParsedNode[], depth: number) => {
    for (const n of nodes) {
      parts.push(`${depth}\u001f${n.kind}\u001f${n.title}\u001f${n.titleKind}\u001f${n.mode}\u001f${n.each ? 1 : 0}`);
      if (n.children.length > 0) visit(n.children, depth + 1);
    }
  };
  visit(parsed.nodes, 0);
  return parts.join('\n');
}

/**
 * The deepest test whose body strictly contains the hunk. Insertions/replacements must sit on
 * lines after the declaration line and before the closing line; a pure deletion (empty new range)
 * is judged by its join point, which may touch the declaration/closing lines from the inside.
 */
function innermostTestContaining(tests: readonly NodeWithAncestry[], change: LineChange): NodeWithAncestry | null {
  let best: NodeWithAncestry | null = null;
  for (const entry of tests) {
    const { startLine, endLine } = entry.node.range;
    const inside = change.start === change.end
      ? startLine < change.start && change.start <= endLine
      : startLine < change.start && change.end - 1 < endLine;
    if (!inside) continue;
    if (!best || entry.ancestry.length > best.ancestry.length) best = entry;
  }
  return best;
}
