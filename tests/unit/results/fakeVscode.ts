/**
 * Minimal in-memory stand-in for the 'vscode' API surface used by HyperJest's UI modules.
 * Tests install it with `jest.mock('vscode', () => require('./fakeVscode'))`, which overrides the
 * throwing mock from jest.config's moduleNameMapper for that test file only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (a instanceof Position && b instanceof Position) { this.start = a; this.end = b; }
    else { this.start = new Position(a as number, b as number); this.end = new Position(c ?? (a as number), d ?? (b as number)); }
  }
  get isEmpty(): boolean { return this.start.line === this.end.line && this.start.character === this.end.character; }
  get isSingleLine(): boolean { return this.start.line === this.end.line; }
}

export class Location {
  constructor(public readonly uri: Uri, public readonly range: Range | Position) {}
}

export class Uri {
  private constructor(public readonly scheme: string, public readonly path: string, public readonly query = '') {}
  get fsPath(): string { return this.path; }
  static file(p: string): Uri { return new Uri('file', p); }
  static parse(value: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):(?:\/\/)?([^?]*)(?:\?(.*))?$/i.exec(value);
    if (!m) throw new Error(`bad uri ${value}`);
    return new Uri(m[1], m[2], m[3] ?? '');
  }
  static joinPath(base: Uri, ...segs: string[]): Uri { return new Uri(base.scheme, [base.path, ...segs].join('/')); }
  with(change: { path?: string; query?: string }): Uri { return new Uri(this.scheme, change.path ?? this.path, change.query ?? this.query); }
  toString(): string { return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`; }
}

export class ThemeColor { constructor(public readonly id: string) {} }
export class ThemeIcon { constructor(public readonly id: string) {} }

export class MarkdownString {
  isTrusted: boolean | { readonly enabledCommands: readonly string[] } | undefined;
  supportHtml: boolean | undefined;
  constructor(public value = '', public supportThemeIcons?: boolean) {}
  appendMarkdown(v: string): this { this.value += v; return this; }
  appendText(v: string): this { this.value += v; return this; }
  appendCodeblock(v: string, lang = ''): this { this.value += `\n\`\`\`${lang}\n${v}\n\`\`\`\n`; return this; }
}

/** Like VS Code's Hover: `contents` is always an array (a single MarkdownString is wrapped). */
export class Hover {
  contents: any[];
  constructor(contents: any, public range?: Range) { this.contents = Array.isArray(contents) ? contents : [contents]; }
}

export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export class DiagnosticRelatedInformation { constructor(public location: Location, public message: string) {} }
export class Diagnostic {
  source?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(public range: Range, public message: string, public severity: DiagnosticSeverity = DiagnosticSeverity.Error) {}
}

export enum DecorationRangeBehavior { OpenOpen = 0, ClosedClosed = 1, OpenClosed = 2, ClosedOpen = 3 }
export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }
export enum TestRunProfileKind { Run = 1, Debug = 2, Coverage = 3 }

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void { this.fn(); }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(e: T): void { for (const l of [...this.listeners]) l(e); }
  dispose(): void { this.listeners.clear(); }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (l: () => void) => this.emitter.event(l),
  };
  cancel(): void { this.token.isCancellationRequested = true; this.emitter.fire(); }
  dispose(): void { this.emitter.dispose(); }
}

export class CodeLens { constructor(public range: Range, public command?: any) {} }

export class TestTag { constructor(public readonly id: string) {} }

export class TestMessageStackFrame { constructor(public label: string, public uri?: Uri, public position?: Position) {} }

export class TestMessage {
  expectedOutput?: string;
  actualOutput?: string;
  location?: Location;
  stackTrace?: TestMessageStackFrame[];
  constructor(public message: string | MarkdownString) {}
  static diff(message: string | MarkdownString, expected: string, actual: string): TestMessage {
    const m = new TestMessage(message);
    m.expectedOutput = expected;
    m.actualOutput = actual;
    return m;
  }
}

export class TestRunRequest {
  constructor(public readonly include?: readonly any[], public readonly exclude?: readonly any[], public readonly profile?: any, public readonly continuous?: boolean) {}
}

export class TestCoverageCount { constructor(public covered: number, public total: number) {} }
export class FileCoverage {
  constructor(public uri: Uri, public statementCoverage: TestCoverageCount, public branchCoverage?: TestCoverageCount, public declarationCoverage?: TestCoverageCount, public includesTests?: any[]) {}
}
export class StatementCoverage { constructor(public executed: number | boolean, public location: Position | Range, public branches: BranchCoverage[] = []) {} }
export class BranchCoverage { constructor(public executed: number | boolean, public location?: Position | Range, public label?: string) {} }
export class DeclarationCoverage { constructor(public name: string, public executed: number | boolean, public location: Position | Range) {} }

// ---------------------------------------------------------------------------------------------
// Documents / editors
// ---------------------------------------------------------------------------------------------

export function makeDocument(fsPath: string, text: string, languageId = 'javascript'): any {
  const lines = text.split('\n');
  const uri = Uri.file(fsPath);
  return {
    uri,
    languageId,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (n: number) => {
      const t = lines[n] ?? '';
      const ws = t.length - t.trimStart().length;
      return { lineNumber: n, text: t, range: new Range(n, 0, n, t.length), firstNonWhitespaceCharacterIndex: ws, isEmptyOrWhitespace: t.trim().length === 0 };
    },
  };
}

export function makeEditor(document: any): any {
  const decorations = new Map<string, any[]>();
  return {
    document,
    decorations,
    setDecorations(type: any, ranges: any[]) { decorations.set(type.key, ranges); },
  };
}

// ---------------------------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------------------------

export const __state = {
  decorationTypes: [] as any[],
  statusBarItems: [] as any[],
  commands: [] as Array<{ command: string; args: any[] }>,
  config: new Map<string, any>(),
  textDocuments: [] as any[],
  shown: [] as any[],
  contentProviders: new Map<string, any>(),
  controllers: [] as any[],
  watchers: [] as any[],
  reset() {
    this.decorationTypes = [];
    this.statusBarItems = [];
    this.commands = [];
    this.config = new Map();
    this.textDocuments = [];
    this.shown = [];
    this.contentProviders = new Map();
    this.controllers = [];
    this.watchers = [];
  },
};

let typeCounter = 0;

export const window = {
  visibleTextEditors: [] as any[],
  activeTextEditor: undefined as any,
  createTextEditorDecorationType(options: any) {
    const t = { key: `type-${typeCounter++}`, options, disposed: false, dispose() { this.disposed = true; } };
    __state.decorationTypes.push(t);
    return t;
  },
  createStatusBarItem(id: string, alignment?: StatusBarAlignment, priority?: number) {
    const item: any = { id, alignment, priority, text: '', tooltip: undefined, backgroundColor: undefined, command: undefined, name: undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; } };
    __state.statusBarItems.push(item);
    return item;
  },
  async showTextDocument(doc: any, options?: any) { __state.shown.push({ doc, options }); return { document: doc }; },
};

export const workspace = {
  get textDocuments() { return __state.textDocuments; },
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, dflt?: T): T | undefined {
        const full = section ? `${section}.${key}` : key;
        return __state.config.has(full) ? __state.config.get(full) : dflt;
      },
    };
  },
  async openTextDocument(uri: Uri) {
    const provider = __state.contentProviders.get(uri.scheme);
    const text = provider ? await provider.provideTextDocumentContent(uri) : '';
    return makeDocument(uri.path, text, 'plaintext');
  },
  registerTextDocumentContentProvider(scheme: string, provider: any) {
    __state.contentProviders.set(scheme, provider);
    return new Disposable(() => __state.contentProviders.delete(scheme));
  },
  /** `__state.watchers[i].fire('change' | 'create' | 'delete', uri)` simulates a disk event. */
  createFileSystemWatcher(pattern: string) {
    const emitters = { change: new EventEmitter<Uri>(), create: new EventEmitter<Uri>(), delete: new EventEmitter<Uri>() };
    const watcher = {
      pattern,
      onDidChange: emitters.change.event, onDidCreate: emitters.create.event, onDidDelete: emitters.delete.event,
      fire: (kind: keyof typeof emitters, uri: Uri) => emitters[kind].fire(uri),
      dispose() { __state.watchers = __state.watchers.filter(w => w !== watcher); },
    };
    __state.watchers.push(watcher);
    return watcher;
  },
};

export const languages = {
  createDiagnosticCollection(name: string) {
    const map = new Map<string, Diagnostic[]>();
    return {
      name,
      map,
      set(uri: Uri, diags: Diagnostic[] | undefined) { if (diags) map.set(uri.fsPath, diags); else map.delete(uri.fsPath); },
      delete(uri: Uri) { map.delete(uri.fsPath); },
      clear() { map.clear(); },
      get(uri: Uri) { return map.get(uri.fsPath); },
      has(uri: Uri) { return map.has(uri.fsPath); },
      forEach(cb: (uri: Uri, d: Diagnostic[]) => void) { for (const [p, d] of map) cb(Uri.file(p), d); },
      dispose() { map.clear(); },
    };
  },
  registerHoverProvider(_selector: any, provider: any) { return new Disposable(() => void provider); },
  registerCodeLensProvider(_selector: any, provider: any) { return new Disposable(() => void provider); },
  async setTextDocumentLanguage(doc: any, languageId: string) { doc.languageId = languageId; return doc; },
};

export const commands = {
  async executeCommand(command: string, ...args: any[]) { __state.commands.push({ command, args }); return undefined; },
  registerCommand(_command: string, _cb: any) { return new Disposable(() => undefined); },
};

export const env = { clipboard: { writeText: async (_t: string) => undefined } };

// ---------------------------------------------------------------------------------------------
// Testing API
// ---------------------------------------------------------------------------------------------

export class FakeTestItemCollection {
  private readonly map = new Map<string, any>();
  constructor(private readonly owner: any) {}
  get size(): number { return this.map.size; }
  replace(items: readonly any[]): void { this.map.clear(); for (const i of items) this.add(i); }
  add(item: any): void { item.parent = this.owner; this.map.set(item.id, item); }
  delete(id: string): void { this.map.delete(id); }
  get(id: string): any { return this.map.get(id); }
  forEach(cb: (item: any) => void): void { for (const i of [...this.map.values()]) cb(i); }
  [Symbol.iterator]() { return this.map.entries(); }
  all(): any[] { return [...this.map.values()]; }
}

export class FakeTestRun {
  events: Array<{ kind: string; id?: string; message?: any; duration?: number; output?: string; coverage?: any }> = [];
  ended = false;
  readonly token = new CancellationTokenSource().token;
  readonly onDidDispose = new EventEmitter<void>().event;
  constructor(public readonly request: TestRunRequest, public readonly name: string | undefined, public readonly isPersisted: boolean) {}
  enqueued(t: any) { this.events.push({ kind: 'enqueued', id: t.id }); }
  started(t: any) { this.events.push({ kind: 'started', id: t.id }); }
  skipped(t: any) { this.events.push({ kind: 'skipped', id: t.id }); }
  passed(t: any, duration?: number) { this.events.push({ kind: 'passed', id: t.id, duration }); }
  failed(t: any, message: any, duration?: number) { this.events.push({ kind: 'failed', id: t.id, message, duration }); }
  errored(t: any, message: any, duration?: number) { this.events.push({ kind: 'errored', id: t.id, message, duration }); }
  appendOutput(output: string) { this.events.push({ kind: 'output', output }); }
  addCoverage(coverage: any) { this.events.push({ kind: 'coverage', coverage }); }
  end() { this.ended = true; this.events.push({ kind: 'end' }); }
  of(kind: string) { return this.events.filter(e => e.kind === kind); }
}

export class FakeTestController {
  readonly items = new FakeTestItemCollection(undefined);
  readonly profiles: any[] = [];
  readonly runs: FakeTestRun[] = [];
  readonly invalidated: any[] = [];
  resolveHandler: any;
  refreshHandler: any;
  disposed = false;
  constructor(public readonly id: string, public label: string) {}
  createTestItem(id: string, label: string, uri?: Uri): any {
    const item: any = { id, label, uri, parent: undefined, range: undefined, description: undefined, sortText: undefined, error: undefined, canResolveChildren: false, busy: false, tags: [] };
    item.children = new FakeTestItemCollection(item);
    return item;
  }
  createRunProfile(label: string, kind: TestRunProfileKind, runHandler: any, isDefault = false, tag?: TestTag, supportsContinuousRun = false): any {
    const p: any = { label, kind, runHandler, isDefault, tag, supportsContinuousRun, loadDetailedCoverage: undefined, loadDetailedCoverageForTest: undefined, dispose() { /* noop */ } };
    this.profiles.push(p);
    return p;
  }
  createTestRun(request: TestRunRequest, name?: string, persist = true): FakeTestRun {
    const run = new FakeTestRun(request, name, persist);
    this.runs.push(run);
    return run;
  }
  invalidateTestResults(items?: any) { this.invalidated.push(items); }
  dispose() { this.disposed = true; }
}

export const tests = {
  createTestController(id: string, label: string) {
    const c = new FakeTestController(id, label);
    __state.controllers.push(c);
    return c;
  },
};

/** Finds a test item by id anywhere below a collection. */
export function findItem(collection: FakeTestItemCollection, id: string): any {
  for (const item of collection.all()) {
    if (item.id === id) return item;
    const found = findItem(item.children, id);
    if (found) return found;
  }
  return undefined;
}

/** All leaf/branch items below a collection (depth-first). */
export function allItems(collection: FakeTestItemCollection): any[] {
  const out: any[] = [];
  for (const item of collection.all()) { out.push(item); out.push(...allItems(item.children)); }
  return out;
}
