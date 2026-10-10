import { buildCoverageMeta } from '../../../src/worker/coverageDiff';
import { captureTransformedSource, resetSourceCapture } from '../../../src/worker/sourceCapture';

const { createInstrumenter } = require('istanbul-lib-instrument');
export const SOURCE = '/repo/src/math.js';
export function metadata(text: string, file = SOURCE) {
  const instrumenter = createInstrumenter();
  instrumenter.instrumentSync(text, file);
  resetSourceCapture();
  captureTransformedSource(file, { originalCode: text });
  return buildCoverageMeta(instrumenter.lastFileCoverage());
}
