/**
 * Statically parsed shape of a test file (from @babel/parser) and the reconciliation contract
 * between parsed nodes and runtime results. Pure; no 'vscode'.
 *
 * Coordinates: parsed ranges are 0-based lines and columns (VS Code convention).
 * Runtime `location` values in protocol.ts are 1-based (Jest convention).
 */
export interface ParsedRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type ParsedNodeKind = 'describe' | 'test';
export type ParsedMode = 'default' | 'only' | 'skip' | 'todo' | 'failing';
/** How confidently the title is known statically. */
export type TitleKind = 'static' | 'template' | 'dynamic';

export interface ParsedNode {
  kind: ParsedNodeKind;
  /** Best-effort title; for template/dynamic titles a readable placeholder (e.g. `renders ${name}`). */
  title: string;
  titleKind: TitleKind;
  mode: ParsedMode;
  /** `test.each` / `describe.each` / `it.each` tables expand at runtime into N rows. */
  each: boolean;
  concurrent: boolean;
  /** Range of the whole call expression. */
  range: ParsedRange;
  /** Range of the name argument (used for the gutter/declaration line). */
  nameRange: ParsedRange;
  children: ParsedNode[];
  /** 0-based index among siblings with the same kind+title (Wallaby's `name #N`). */
  dupIndex: number;
}

export interface ParsedFile {
  path: string;
  nodes: ParsedNode[];
  /** 0-based lines containing toMatchSnapshot / toMatchInlineSnapshot / toThrowErrorMatchingSnapshot calls. */
  snapshotLines: number[];
  /** Number of function declarations/expressions (used by changeAnalyzer to detect structural edits). */
  functionCount: number;
  parseError?: { message: string; line: number; column: number };
  /** sha1 of the parsed source. */
  hash: string;
}

/** Stable test-item id used by the Test Explorer and the result store. */
export function parsedNodeId(projectId: string, relPath: string, ancestry: ParsedNode[], node: ParsedNode): string {
  const segs = [...ancestry, node].map(n => `${n.kind}:${n.title}${n.dupIndex ? `#${n.dupIndex}` : ''}`);
  return [projectId, relPath, ...segs].join('\0');
}
