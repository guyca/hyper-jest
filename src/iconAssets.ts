/**
 * Generates the gutter icon SVGs (Wallaby-like 11x11 rounded squares, hollow variants for stale
 * data, a camera for snapshot lines, a split square for partial coverage) into a directory and
 * returns their absolute paths. `gutterIconPath` accepts absolute paths, so this module needs no
 * 'vscode' import and is unit-testable with a temp directory.
 *
 * File names embed a hash of the colours, so a colour change produces new paths (VS Code caches
 * gutter icons by URI) and `ensure()` is idempotent per colour set.
 */
import { createHash } from 'crypto';
import { mkdir, writeFile, access } from 'fs/promises';
import * as path from 'path';
import type { LineState } from './core/resultModel';
import type { GutterColors } from './core/settingsModel';

export type DeclarationState = 'declPassed' | 'declFailed' | 'declSkipped' | 'declUnknown';
export type IconState = LineState | DeclarationState;

export const LINE_STATES: LineState[] = ['errorSource', 'errorPath', 'partiallyCovered', 'covered', 'notCovered'];
export const DECLARATION_STATES: DeclarationState[] = ['declPassed', 'declFailed', 'declSkipped', 'declUnknown'];

/** Colour used for test declarations without a result (Wallaby's not-covered grey). */
export const DECLARATION_UNKNOWN_COLOR = '#9d9d9d';
export const DECLARATION_SKIPPED_COLOR = '#c8c8c8';

export interface IconVariant { state: IconState; hollow: boolean; snapshot: boolean; }

export function colorFor(state: IconState, colors: GutterColors): string {
  switch (state) {
    case 'declPassed': return colors.covered;
    case 'declFailed': return colors.errorSource;
    case 'declSkipped': return DECLARATION_SKIPPED_COLOR;
    case 'declUnknown': return DECLARATION_UNKNOWN_COLOR;
    default: return colors[state];
  }
}

const CAMERA_PATH = 'm 13.5,5.25 v 7.071429 C 13.5,12.972098 13.038098,13.5 12.46875,13.5 H 3.53125 C 2.9619018,13.5 2.5,12.972098 2.5,12.321429 V 5.25 C 2.5,4.5993304 2.9619018,4.0714286 3.53125,4.0714286 H 5.421875 L 5.6861206,3.2636161 C 5.8365357,2.8044643 6.2210937,2.5 6.6507812,2.5 h 2.6962772 c 0.4296873,0 0.8142946,0.3044643 0.9646606,0.7636161 l 0.266406,0.8078125 H 12.46875 C 13.038098,4.0714286 13.5,4.5993304 13.5,5.25 Z M 10.578125,8.7857143 C 10.578125,7.1602674 9.4222908,5.8392857 8,5.8392857 c -1.4222411,0 -2.578125,1.3209817 -2.578125,2.9464286 0,1.6254467 1.1558839,2.9464277 2.578125,2.9464277 1.4222908,0 2.578125,-1.320981 2.578125,-2.9464277 z m -0.6875,0 c 0,1.190849 -0.8486201,2.1607147 -1.890625,2.1607147 -1.0420044,0 -1.890625,-0.9698657 -1.890625,-2.1607147 0,-1.1908487 0.8486206,-2.1607148 1.890625,-2.1607148 1.0420049,0 1.890625,0.9698661 1.890625,2.1607148 z';

/**
 * Renders one icon as a 16x16 SVG with an 11x11 rounded square (2.5 px inset, 2.5 px radius) like
 * Wallaby's `images/*.svg`. Hollow = 1 px outline only. Partial coverage splits the square
 * diagonally into the partial colour (top-left) and the covered colour (bottom-right).
 */
export function renderIconSvg(variant: IconVariant, colors: GutterColors): string {
  const color = colorFor(variant.state, colors);
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="16px" height="16px" viewBox="0 0 16 16">';
  const tail = '</svg>';
  if (variant.snapshot) {
    const style = variant.hollow ? `fill:none;stroke:${color};stroke-width:1` : `fill:${color}`;
    return `${head}<path style="${style}" d="${CAMERA_PATH}"/>${tail}`;
  }
  if (variant.state === 'partiallyCovered' && !variant.hollow) {
    // Two triangles clipped to the rounded square.
    return `${head}<defs><clipPath id="c"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" ry="2.5"/></clipPath></defs>` +
      `<g clip-path="url(#c)"><polygon points="2.5,2.5 13.5,2.5 2.5,13.5" fill="${color}"/>` +
      `<polygon points="13.5,2.5 13.5,13.5 2.5,13.5" fill="${colors.covered}"/></g>${tail}`;
  }
  if (variant.hollow) {
    return `${head}<rect x="3" y="3" width="10" height="10" rx="2.5" ry="2.5" style="fill:none;stroke:${color};stroke-width:1"/>${tail}`;
  }
  return `${head}<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" ry="2.5" style="fill:${color}"/>${tail}`;
}

export function iconFileName(variant: IconVariant, colorHash: string): string {
  return `${variant.state}${variant.hollow ? '.hollow' : ''}${variant.snapshot ? '.snapshot' : ''}.${colorHash}.svg`;
}

export function colorHash(colors: GutterColors): string {
  return createHash('sha1').update(JSON.stringify([colors.covered, colors.partiallyCovered, colors.notCovered, colors.errorPath, colors.errorSource])).digest('hex').slice(0, 8);
}

/** Every variant that gets a file: line states x hollow x snapshot, declaration states x hollow. */
export function allVariants(): IconVariant[] {
  const out: IconVariant[] = [];
  for (const state of LINE_STATES) for (const hollow of [false, true]) for (const snapshot of [false, true]) out.push({ state, hollow, snapshot });
  for (const state of DECLARATION_STATES) for (const hollow of [false, true]) out.push({ state, hollow, snapshot: false });
  return out;
}

export class IconAssets {
  private colors: GutterColors;
  private hash: string;
  private ready: Promise<void> | undefined;

  /** @param dir absolute directory (e.g. `<globalStorageUri.fsPath>/icons`); created on demand. */
  constructor(private readonly dir: string, colors: GutterColors) {
    this.colors = { ...colors };
    this.hash = colorHash(colors);
  }

  get currentColors(): GutterColors { return this.colors; }
  get colorKey(): string { return this.hash; }

  /** Writes any missing icon file for the current colours. Safe to call repeatedly. */
  ensure(): Promise<void> {
    if (!this.ready) this.ready = this.write().catch(err => { this.ready = undefined; throw err; });
    return this.ready;
  }

  /** Switches colours; returns true when they changed (callers then recreate decoration types). */
  setColors(colors: GutterColors): boolean {
    const hash = colorHash(colors);
    if (hash === this.hash) return false;
    this.colors = { ...colors };
    this.hash = hash;
    this.ready = undefined;
    return true;
  }

  /** Absolute path of the icon for a variant (exists after `ensure()` resolved). */
  pathFor(state: IconState, hollow: boolean, snapshot = false): string {
    return path.join(this.dir, iconFileName({ state, hollow, snapshot }, this.hash));
  }

  private async write(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await Promise.all(allVariants().map(async v => {
      const file = path.join(this.dir, iconFileName(v, this.hash));
      if (await exists(file)) return;
      await writeFile(file, renderIconSvg(v, this.colors), 'utf8');
    }));
  }
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}
