import compatibility from '../../scripts/jest-compatibility.json';

/** Exact fixture versions define the three majors covered by the compatibility suite. */
export const TESTED_JEST_MAJORS = compatibility.versions.map(version => Number(version.split('.')[0]));
export const MIN_SUPPORTED_JEST_MAJOR = Math.min(...TESTED_JEST_MAJORS);
export const TESTED_JEST_DESCRIPTION = TESTED_JEST_MAJORS.join(', ');
