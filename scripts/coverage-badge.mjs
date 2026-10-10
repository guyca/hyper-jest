import { readFile, writeFile } from 'node:fs/promises';

const summary = JSON.parse(await readFile(new URL('../coverage/coverage-summary.json', import.meta.url), 'utf8'));
const coverage = summary.total.lines.pct;
if (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage < 0 || coverage > 100) {
  throw new Error('Coverage summary must contain a line coverage percentage between 0 and 100.');
}
const label = `${coverage.toFixed(1)}%`;
const color = coverage >= 90 ? '#4c1' : coverage >= 80 ? '#97ca00' : coverage >= 70 ? '#a4a61d' : coverage >= 60 ? '#dfb317' : '#e05d44';
await writeFile(new URL('../media/coverage.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" width="125" height="20" role="img" aria-label="coverage: ${label}">
  <title>coverage: ${label}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="125" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)"><path fill="#555" d="M0 0h70v20H0z"/><path fill="${color}" d="M70 0h55v20H99z"/><path fill="url(#s)" d="M0 0h125v20H0z"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="35" y="15" fill="#010101" fill-opacity=".3">coverage</text><text x="35" y="14">coverage</text>
    <text x="97.5" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="97.5" y="14">${label}</text>
  </g>
</svg>
`);
console.log(`Updated coverage badge: ${label} line coverage`);
