'use strict';

const SEVERITY_VALUES = new Set(['low', 'medium', 'high']);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const DEFAULT_CONTEXT = 'No taint flow context available.';
const DEFAULT_SUGGESTION = 'Review and remediate this issue.';
const DEFAULT_MESSAGE = 'Issue detected.';
const DEFAULT_IMPACT = 'Potential security impact should be reviewed.';
const DEFAULT_FILE = 'unknown';

const normalizeSeverity = (value) => {
  if (typeof value !== 'string') {
    return 'low';
  }

  const normalized = value.toLowerCase();
  return SEVERITY_VALUES.has(normalized) ? normalized : 'low';
};

const normalizeConfidence = (value) => {
  if (typeof value !== 'string') {
    return 'low';
  }

  const normalized = value.toLowerCase();
  return CONFIDENCE_VALUES.has(normalized) ? normalized : 'low';
};

const normalizeLineNumber = (value) => (Number.isInteger(value) && value > 0 ? value : -1);

const injectFunctionContext = (context, functionName) => {
  const resolvedFunctionName = typeof functionName === 'string' && functionName.trim().length > 0 ? functionName : 'global';
  if (resolvedFunctionName === 'global') {
    return context;
  }

  const normalizedContext = typeof context === 'string' && context.trim().length > 0 ? context : DEFAULT_CONTEXT;
  const functionTag = `function '${resolvedFunctionName}'`;
  if (normalizedContext.includes(functionTag)) {
    return normalizedContext;
  }

  if (normalizedContext.includes(' flows ')) {
    return normalizedContext.replace(' flows ', ` flows inside ${functionTag} `);
  }

  return `${normalizedContext} inside ${functionTag}.`;
};

const extractCodeSnippet = (fileContent, lineNumber) => {
  if (typeof fileContent !== 'string' || fileContent.length === 0) {
    return '';
  }

  const normalizedLine = normalizeLineNumber(lineNumber);
  if (normalizedLine < 0) {
    return '';
  }

  const lines = fileContent.split(/\r?\n/);
  if (lines.length === 0) {
    return '';
  }

  const targetIndex = Math.min(lines.length - 1, Math.max(0, normalizedLine - 1));
  const startIndex = Math.max(0, targetIndex - 2);
  const endIndex = Math.min(lines.length - 1, targetIndex + 2);
  const snippetLines = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    snippetLines.push(`${index + 1}: ${lines[index]}`);
  }

  return snippetLines.join('\n');
};

const resolveFindingImpact = (finding) => {
  const findingValue = finding && typeof finding === 'object' ? finding : {};
  if (typeof findingValue.impact === 'string' && findingValue.impact.trim().length > 0) {
    return findingValue.impact;
  }

  const message = typeof findingValue.message === 'string' ? findingValue.message.toLowerCase() : '';
  const context = typeof findingValue.context === 'string' ? findingValue.context.toLowerCase() : '';
  const combinedText = `${message} ${context}`;

  if (combinedText.includes('sql injection')) {
    return 'Attacker can read or modify database data';
  }

  if (
    combinedText.includes('xss') ||
    combinedText.includes('dangerouslysetinnerhtml') ||
    combinedText.includes('innerhtml') ||
    combinedText.includes('outerhtml') ||
    combinedText.includes('dom injection')
  ) {
    return "Attacker can execute malicious scripts in user's browser";
  }

  if (combinedText.includes('logging') && (combinedText.includes('sensitive') || combinedText.includes('tainted'))) {
    return 'Sensitive user data may be exposed in logs';
  }

  return DEFAULT_IMPACT;
};

const normalizeFinding = (finding = {}) => {
  const normalized = finding && typeof finding === 'object' && !Array.isArray(finding) ? finding : {};

  return {
    ...normalized,
    severity: normalizeSeverity(normalized.severity),
    confidence: normalizeConfidence(normalized.confidence),
    file:
      typeof normalized.file === 'string' && normalized.file.trim().length > 0
        ? normalized.file
        : DEFAULT_FILE,
    line: normalizeLineNumber(normalized.line),
    functionName:
      typeof normalized.functionName === 'string' && normalized.functionName.trim().length > 0
        ? normalized.functionName
        : 'global',
    message:
      typeof normalized.message === 'string' && normalized.message.trim().length > 0
        ? normalized.message
        : DEFAULT_MESSAGE,
    context:
      typeof normalized.context === 'string' && normalized.context.trim().length > 0 ? normalized.context : DEFAULT_CONTEXT,
    impact: resolveFindingImpact(normalized),
    suggestion:
      typeof normalized.suggestion === 'string' && normalized.suggestion.trim().length > 0
        ? normalized.suggestion
        : DEFAULT_SUGGESTION,
    codeSnippet: typeof normalized.codeSnippet === 'string' ? normalized.codeSnippet : ''
  };
};

const impact = resolveFindingImpact;
const codeSnippet = extractCodeSnippet;

module.exports = {
  DEFAULT_CONTEXT,
  DEFAULT_FILE,
  normalizeSeverity,
  normalizeConfidence,
  normalizeLineNumber,
  injectFunctionContext,
  extractCodeSnippet,
  codeSnippet,
  resolveFindingImpact,
  impact,
  normalizeFinding
};
