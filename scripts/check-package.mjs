import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const required = ['extension/package.json', 'extension/readme.md', 'extension/LICENSE.md',
  'extension/dist/extension.js', 'extension/dist/discoveryWorker.js',
  'extension/dist/worker/hyperjestWorker.cjs', 'extension/dist/worker/reporter.cjs',
  'extension/dist/worker/overlayPreload.cjs', 'extension/.github/media/icon.png'];

export function validateEntries(entries) {
  for (const path of required) if (!entries.includes(path)) throw new Error(`VSIX is missing ${path}`);
  for (const path of entries) {
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) throw new Error(`Unsafe archive path: ${path}`);
    if (/^extension\/(?:\.github\/(?:scripts|workflows)\/|(?:node_modules|src|tests|scripts|coverage|\.yarn|\.husky)\/)/.test(path)
      || /\.(?:map|pem|key)$/.test(path) || /(?:^|\/)\.env(?:\.|$)/.test(path)
      || /\/(?:AGENTS|CLAUDE)\.md$/.test(path)) throw new Error(`Unexpected development file: ${path}`);
  }
}

export function validateManifest(manifest, expected) {
  for (const field of ['name', 'publisher', 'version']) {
    if (manifest[field] !== expected[field]) throw new Error(`VSIX ${field} does not match source`);
  }
  if (manifest.name !== 'hyperjest' || manifest.publisher !== 'GuyCarmeli') throw new Error('Unexpected extension identity');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Release version must be stable semver');
  if (manifest.repository?.url !== 'https://github.com/guyca/hyper-jest.git') throw new Error('Missing repository metadata');
}

export function checkPackage(path = 'hyperjest.vsix') {
  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/);
  validateEntries(entries);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', path, 'extension/package.json'], { encoding: 'utf8' }));
  validateManifest(manifest, JSON.parse(readFileSync('package.json', 'utf8')));
  const readme = execFileSync('unzip', ['-p', path, 'extension/readme.md'], { encoding: 'utf8' });
  if (/!\[[^\]]*\]\((?!https:\/\/|data:)/.test(readme)) throw new Error('README images were not rewritten to HTTPS');
  console.log(`Verified ${path}: ${manifest.publisher}.${manifest.name} ${manifest.version}, ${entries.length} files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkPackage(process.argv[2]);
