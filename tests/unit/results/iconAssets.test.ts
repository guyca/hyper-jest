import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { IconAssets, allVariants, colorFor, colorHash, iconFileName, renderIconSvg } from '../../../src/iconAssets';
import { DEFAULT_SETTINGS } from '../../../src/core/settingsModel';

const colors = DEFAULT_SETTINGS.colors;

describe('iconAssets', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'hj-icons-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('renders Wallaby-like 11x11 rounded squares, hollow outlines, cameras and a split partial icon', () => {
    expect(renderIconSvg({ state: 'covered', hollow: false, snapshot: false }, colors)).toContain('<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" ry="2.5" style="fill:#62b455"/>');
    expect(renderIconSvg({ state: 'errorSource', hollow: true, snapshot: false }, colors)).toContain('fill:none;stroke:#fe536a;stroke-width:1');
    expect(renderIconSvg({ state: 'errorPath', hollow: false, snapshot: true }, colors)).toMatch(/<path style="fill:#ffa0a0" d="m 13\.5,5\.25/);
    const partial = renderIconSvg({ state: 'partiallyCovered', hollow: false, snapshot: false }, colors);
    expect(partial).toContain('clip-path="url(#c)"');
    expect(partial).toContain('fill="#d2a032"');
    expect(partial).toContain('fill="#62b455"');
    expect(renderIconSvg({ state: 'declUnknown', hollow: false, snapshot: false }, colors)).toContain(colorFor('declUnknown', colors));
  });

  it('writes every variant once and returns stable paths that change with the colours', async () => {
    const icons = new IconAssets(dir, colors);
    await icons.ensure();
    await icons.ensure();
    const files = await readdir(dir);
    expect(files).toHaveLength(allVariants().length);
    const p = icons.pathFor('covered', false, false);
    expect(p).toBe(path.join(dir, iconFileName({ state: 'covered', hollow: false, snapshot: false }, colorHash(colors))));
    expect(await readFile(p, 'utf8')).toContain('#62b455');
    expect(icons.pathFor('covered', true, true)).toMatch(/covered\.hollow\.snapshot\.[0-9a-f]{8}\.svg$/);

    expect(icons.setColors(colors)).toBe(false);
    expect(icons.setColors({ ...colors, covered: '#00ff00' })).toBe(true);
    const p2 = icons.pathFor('covered', false, false);
    expect(p2).not.toBe(p);
    await icons.ensure();
    expect(await readFile(p2, 'utf8')).toContain('#00ff00');
    expect((await readdir(dir)).length).toBe(allVariants().length * 2);
  });
});
