import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Packaging requires a Git commit.');
// Immutable links make Marketplace screenshots and documentation match this build.
execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package',
  '--no-dependencies', '--githubBranch', sha, '--out', 'hyperjest.vsix'], { stdio: 'inherit' });
