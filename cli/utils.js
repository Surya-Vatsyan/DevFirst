'use strict';

const SEVERITY_PRIORITY = {
  high: 3,
  medium: 2,
  low: 1
};

const CONFIDENCE_PRIORITY = {
  high: 3,
  medium: 2,
  low: 1
};

const MAX_PRINTED_GROUPED_ISSUES = 5;
const MAX_PRINTED_GROUP_LOCATIONS = 3;
const UNKNOWN_FILE = 'unknown';
const DEFAULT_MESSAGE = 'Issue detected.';
const DEFAULT_SUGGESTION = 'Review and remediate this issue.';
const DEFAULT_REASON = 'Review this issue and validate runtime behavior.';

const printUsage = () => {
  process.stdout.write('Usage: devguard scan <path>\n');
  process.stdout.write('Example: devguard scan .\n');
};

const normalizeSeverity = (severity) => {
  if (typeof severity !== 'string') {
    return 'low';
  }

  const normalized = severity.toLowerCase();
  return SEVERITY_PRIORITY[normalized] ? normalized : 'low';
};

const normalizeConfidence = (confidence) => {
  if (typeof confidence !== 'string') {
    return 'low';
  }

  const normalized = confidence.toLowerCase();
  return CONFIDENCE_PRIORITY[normalized] ? normalized : 'low';
};

const normalizeLine = (line) => {
  if (Number.isInteger(line) && line > 0) {
    return line;
  }

  return -1;
};

const formatFileLocation = (file, line) => {
  if (line > 0) {
    return `${file}:${line}`;
  }

  return `${file} (line unknown)`;
};

module.exports = {
  SEVERITY_PRIORITY,
  CONFIDENCE_PRIORITY,
  MAX_PRINTED_GROUPED_ISSUES,
  MAX_PRINTED_GROUP_LOCATIONS,
  UNKNOWN_FILE,
  DEFAULT_MESSAGE,
  DEFAULT_SUGGESTION,
  DEFAULT_REASON,
  printUsage,
  normalizeSeverity,
  normalizeConfidence,
  normalizeLine,
  formatFileLocation
};
