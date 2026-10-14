import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The engine target is deliberately independent of the Jest running HyperJest's own tests. */
export const jestPackageDir = fs.realpathSync(process.env.HYPERJEST_JEST_PACKAGE ?? path.resolve(__dirname, '../../node_modules/jest'));
export const jestVersion: string = JSON.parse(fs.readFileSync(path.join(jestPackageDir, 'package.json'), 'utf8')).version;
export const jestNodeModules = path.dirname(jestPackageDir);

export function copyRuntimeFixture(source: string, name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hyperjest-${name}-`)));
  fs.cpSync(source, dir, { recursive: true, filter: src => path.basename(src) !== 'node_modules' });
  fs.symlinkSync(jestNodeModules, path.join(dir, 'node_modules'), 'junction');
  return dir;
}
