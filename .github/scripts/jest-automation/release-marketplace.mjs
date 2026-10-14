import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions, EXTENSION_ID, inspectVsix } from './release.mjs';
import { releaseRequest } from './release-http.mjs';

const run = promisify(execFile);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const PACKAGE_ASSET = 'Microsoft.VisualStudio.Services.VSIXPackage';

export class Marketplace {
  constructor({ directory, fetcher = fetch, wait = sleep, publishCommand = null, runner = run }) {
    this.directory = directory; this.fetcher = fetcher; this.wait = wait; this.publishCommand = publishCommand; this.runner = runner;
  }
  async versions(validated = false) {
    const data = await releaseRequest('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }], pageNumber: 1, pageSize: 1 }],
        assetTypes: [PACKAGE_ASSET], flags: 1 | 2 | 16 | 128 | (validated ? 32 : 0),
      }),
    }, {
      label: 'Marketplace version lookup', fetcher: this.fetcher, wait: this.wait, timeout: 60_000, retry: true,
    });
    if (!Array.isArray(data.results)) throw new Error('Marketplace returned an invalid query response.');
    const extension = data.results.flatMap(result => result.extensions ?? []).find(item =>
      `${item.publisher?.publisherName}.${item.extensionName}`.toLowerCase() === EXTENSION_ID.toLowerCase());
    return extension?.versions ?? [];
  }
  async version(version) { return (await this.versions()).find(item => item.version === version); }
  async latestVersion() {
    return (await this.versions()).map(item => item.version).filter(version => /^\d+\.\d+\.\d+$/.test(version))
      .sort(compareVersions).at(-1) ?? null;
  }
  async publish(filename) {
    if (this.publishCommand) return this.publishCommand(filename);
    // Invoke only the pinned publisher tool; no extension scripts run with OIDC access.
    const environment = Object.fromEntries(['PATH', 'HOME', 'AZURE_CONFIG_DIR', 'AZURE_TENANT_ID', 'NODE_EXTRA_CA_CERTS', 'CI'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    // out/main.js exports the CLI function; only the bin wrapper invokes it.
    const vsce = path.resolve(process.env.VSCE_ENTRY ?? 'node_modules/@vscode/vsce/vsce');
    try {
      const { stdout } = await this.runner(process.execPath, [vsce, 'publish', '--azure-credential', '--packagePath', filename], { env: environment, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 });
      console.log(stdout);
    } catch {
      throw new Error('Marketplace publication failed. Verify the federated identity and its Contributor access to publisher GuyCarmeli; the reserved artifact is retained.');
    }
  }
  async verify(candidate, expected) {
    // Allow eight minutes for asynchronous Marketplace validation, including
    // first-publication scanning. A timeout leaves the draft for retry.
    for (let attempt = 0; attempt < 49; attempt++) {
      const version = (await this.versions(true)).find(item => item.version === candidate.version && (!item.targetPlatform || item.targetPlatform === 'universal'));
      if (version) {
        const uri = version.files?.find(file => file.assetType === PACKAGE_ASSET)?.source ?? `${version.assetUri}/${PACKAGE_ASSET}`;
        const url = new URL(uri);
        if (url.protocol !== 'https:' || !(url.hostname === 'marketplace.visualstudio.com' || url.hostname.endsWith('.vsassets.io') || url.hostname.endsWith('.gallerycdn.vsassets.io'))) {
          throw new Error('Marketplace returned an unexpected VSIX download host.');
        }
        const bytes = await releaseRequest(url, {}, {
          label: 'Published VSIX download', fetcher: this.fetcher, wait: this.wait, retry: true,
          decode: async response => Buffer.from(await response.arrayBuffer()),
        });
        const destination = path.join(this.directory, 'marketplace-verification.vsix');
        await writeFile(destination, bytes);
        const actual = await inspectVsix(destination, candidate);
        if (actual.payloadHash !== expected.payloadHash) throw new Error(`Marketplace version ${candidate.version} contains different extension files; refusing to claim this release.`);
        return;
      }
      if (attempt < 48) await this.wait(10_000);
    }
    throw new Error(`Marketplace has not finished validating ${candidate.version}. Retry this workflow; it will reuse the same VSIX and verify before creating the public GitHub release.`);
  }
}
