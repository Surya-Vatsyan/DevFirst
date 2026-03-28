'use strict';

const INPUT_SIGNAL_REGEX = /\b(req(?:uest)?\.(?:body|query|params|headers)|body|query|params|user(?:Input|Data)?|input|payload)\b/i;
const LOG_CALL_REGEX = /\b(?:console|logger)\.(?:log|info|warn|error|debug)\s*\(([\s\S]*?)\)/gi;
const QUERY_CALL_REGEX = /\b(?:query|execute|raw)\s*\(([\s\S]*?)\)/gi;
const SQL_VARIABLE_ASSIGNMENT_REGEX =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*(?:SELECT|INSERT|UPDATE|DELETE)[^;\n]*/gi;
const TAINT_DIRECT_ASSIGNMENT_REGEX =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(req(?:uest)?\.(body|query|params)\b[^;\n]*)/gi;
const TAINT_DESTRUCTURE_ASSIGNMENT_REGEX = /\b(?:const|let|var)\s*{\s*([^}]+)\s*}\s*=\s*(req(?:uest)?\.(body|query|params)\b)/i;
const TAINT_ALIAS_ASSIGNMENT_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/gi;

const SECRET_ASSIGNMENT_PATTERNS = [
  {
    regex: /\b(?:const|let|var)?\s*[\w$.]*API[_-]?KEY[\w$.]*\s*[:=]\s*["'`][^"'`\n]{8,}["'`]/i,
    message: 'Possible hardcoded API key detected.',
    severity: 'high',
    confidence: 'high',
    suggestion: 'Move API keys to environment variables or secret manager.',
    context: 'Detected literal secret-like value assigned in source code.'
  },
  {
    regex: /\b(?:const|let|var)?\s*[\w$.]*(?:JWT[_-]?SECRET|SECRET)[\w$.]*\s*[:=]\s*["'`][^"'`\n]{6,}["'`]/i,
    message: 'Possible hardcoded secret detected.',
    severity: 'high',
    confidence: 'high',
    suggestion: 'Store secrets outside source code and rotate exposed values.',
    context: 'Detected literal secret-like value assigned in source code.'
  },
  {
    regex: /\bmongodb:\/\/[^"'\s`]+/i,
    message: 'MongoDB connection string appears hardcoded.',
    severity: 'medium',
    confidence: 'medium',
    suggestion: 'Use environment-based connection strings and avoid embedding credentials.',
    context: 'Detected connection string literal in source code.'
  },
  {
    regex: /\bpassword\b\s*[:=]\s*["'`][^"'`\n]{4,}["'`]/i,
    message: 'Hardcoded password assignment detected.',
    severity: 'high',
    confidence: 'high',
    suggestion: 'Remove hardcoded passwords and use secrets management.',
    context: 'Detected literal password-like value assigned in source code.'
  }
];

const PLACEHOLDER_SECRET_REGEX = /\b(example|sample|dummy|changeme|your[_-]?(api[_-]?key|secret|password))(?:_here)?\b/i;
const VALID_IDENTIFIER_REGEX = /^[A-Za-z_$][\w$]*$/;

const normalizeLineNumber = (line) => (Number.isInteger(line) && line > 0 ? line : -1);

const buildLineStartOffsets = (fileContent) => {
  const lineStartOffsets = [0];

  for (let index = 0; index < fileContent.length; index += 1) {
    if (fileContent[index] === '\n') {
      lineStartOffsets.push(index + 1);
    }
  }

  return lineStartOffsets;
};

const createLineNumberResolver = (fileContent) => {
  const lineStartOffsets = buildLineStartOffsets(fileContent);

  return (matchIndex) => {
    if (!Number.isInteger(matchIndex) || matchIndex < 0) {
      return -1;
    }

    let left = 0;
    let right = lineStartOffsets.length - 1;
    let bestIndex = 0;

    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      if (lineStartOffsets[middle] <= matchIndex) {
        bestIndex = middle;
        left = middle + 1;
      } else {
        right = middle - 1;
      }
    }

    return bestIndex + 1;
  };
};

const buildFinding = ({ severity, confidence, filePath, line, message, context, suggestion }) => ({
  type: 'security',
  severity,
  confidence,
  file: filePath,
  line: normalizeLineNumber(line),
  message,
  context,
  suggestion
});

const shouldIgnoreLikelyPlaceholder = (line) => {
  if (!line || typeof line !== 'string') {
    return true;
  }

  if (line.includes('process.env')) {
    return true;
  }

  return PLACEHOLDER_SECRET_REGEX.test(line);
};

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeSourceAccessor = (sourceValue) => {
  if (typeof sourceValue !== 'string') {
    return null;
  }

  const normalized = sourceValue.toLowerCase();
  if (normalized.includes('.body')) {
    return 'req.body';
  }

  if (normalized.includes('.query')) {
    return 'req.query';
  }

  if (normalized.includes('.params')) {
    return 'req.params';
  }

  return null;
};

const extractVariableNameFromDestructureToken = (token) => {
  if (typeof token !== 'string') {
    return null;
  }

  let normalized = token.replace(/=.*/, '').trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('...')) {
    normalized = normalized.slice(3).trim();
  }

  if (!normalized) {
    return null;
  }

  if (normalized.includes(':')) {
    const parts = normalized.split(':');
    normalized = parts[parts.length - 1].trim();
  }

  return VALID_IDENTIFIER_REGEX.test(normalized) ? normalized : null;
};

const extractTaintedVariables = (lines) => {
  const taintedVariableMap = new Map();

  for (const line of lines) {
    if (!line || isCommentLine(line)) {
      continue;
    }

    let directMatch = TAINT_DIRECT_ASSIGNMENT_REGEX.exec(line);
    while (directMatch) {
      const variableName = directMatch[1];
      const sourceAccessor = normalizeSourceAccessor(directMatch[2]);
      if (sourceAccessor) {
        taintedVariableMap.set(variableName, sourceAccessor);
      }

      directMatch = TAINT_DIRECT_ASSIGNMENT_REGEX.exec(line);
    }
    TAINT_DIRECT_ASSIGNMENT_REGEX.lastIndex = 0;

    const destructureMatch = line.match(TAINT_DESTRUCTURE_ASSIGNMENT_REGEX);
    if (destructureMatch) {
      const destructuredVariables = destructureMatch[1].split(',');
      const sourceAccessor = normalizeSourceAccessor(destructureMatch[2]);

      if (sourceAccessor) {
        for (const destructuredVariable of destructuredVariables) {
          const variableName = extractVariableNameFromDestructureToken(destructuredVariable);
          if (variableName) {
            taintedVariableMap.set(variableName, sourceAccessor);
          }
        }
      }
    }

    let aliasMatch = TAINT_ALIAS_ASSIGNMENT_REGEX.exec(line);
    while (aliasMatch) {
      const variableName = aliasMatch[1];
      const aliasSource = aliasMatch[2];
      if (taintedVariableMap.has(aliasSource) && variableName !== aliasSource) {
        taintedVariableMap.set(variableName, taintedVariableMap.get(aliasSource));
      }

      aliasMatch = TAINT_ALIAS_ASSIGNMENT_REGEX.exec(line);
    }
    TAINT_ALIAS_ASSIGNMENT_REGEX.lastIndex = 0;
  }

  return taintedVariableMap;
};

const getTaintFlow = (text, taintedVariableMap) => {
  if (typeof text !== 'string' || !text.trim() || !(taintedVariableMap instanceof Map) || taintedVariableMap.size === 0) {
    return null;
  }

  for (const [variableName, sourceAccessor] of taintedVariableMap.entries()) {
    const variableRegex = new RegExp(`\\b${escapeRegex(variableName)}\\b`);
    if (variableRegex.test(text)) {
      return {
        variableName,
        sourceAccessor
      };
    }
  }

  return null;
};

const getMappedFlow = (text, mappedFlowMap) => {
  if (typeof text !== 'string' || !text.trim() || !(mappedFlowMap instanceof Map) || mappedFlowMap.size === 0) {
    return null;
  }

  for (const [variableName, flowDetails] of mappedFlowMap.entries()) {
    const variableRegex = new RegExp(`\\b${escapeRegex(variableName)}\\b`);
    if (variableRegex.test(text)) {
      return {
        sqlVariable: variableName,
        ...flowDetails
      };
    }
  }

  return null;
};

const detectHardcodedSecrets = (lines, filePath, dedupeKeys) => {
  const findings = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line || isCommentLine(line) || shouldIgnoreLikelyPlaceholder(line)) {
      continue;
    }

    for (const pattern of SECRET_ASSIGNMENT_PATTERNS) {
      if (!pattern.regex.test(line)) {
        continue;
      }

      const dedupeKey = `secret:${pattern.message}:${line.trim()}`;
      if (dedupeKeys.has(dedupeKey)) {
        continue;
      }

      dedupeKeys.add(dedupeKey);
      findings.push(
        buildFinding({
          severity: pattern.severity,
          confidence: pattern.confidence,
          filePath,
          line: lineIndex + 1,
          message: pattern.message,
          context: pattern.context,
          suggestion: pattern.suggestion
        })
      );
    }
  }

  return findings;
};

const detectSqlInjectionRisks = (fileContent, filePath, dedupeKeys, taintedVariableMap, getLineNumberForIndex) => {
  const findings = [];
  const sqlFlowVariableMap = new Map();

  let assignmentMatch = SQL_VARIABLE_ASSIGNMENT_REGEX.exec(fileContent);
  while (assignmentMatch) {
    const assignmentLine = typeof assignmentMatch[0] === 'string' ? assignmentMatch[0] : '';
    const queryVariableName = typeof assignmentMatch[1] === 'string' ? assignmentMatch[1] : '';
    const hasConcatenation = assignmentLine.includes('+');
    const hasTemplateInterpolation = /\$\{[^}]+\}/.test(assignmentLine);
    const hasInputSignal = INPUT_SIGNAL_REGEX.test(assignmentLine);
    const taintFlow = getTaintFlow(assignmentLine, taintedVariableMap);
    const isDynamicQuery = hasConcatenation || hasTemplateInterpolation;

    if (isDynamicQuery && (hasInputSignal || taintFlow)) {
      if (queryVariableName) {
        sqlFlowVariableMap.set(queryVariableName, {
          variableName: taintFlow ? taintFlow.variableName : null,
          sourceAccessor: taintFlow ? taintFlow.sourceAccessor : hasInputSignal ? 'request input' : null
        });
      }

      const dedupeKey = `sqli-assignment:${assignmentLine.trim()}`;
      if (!dedupeKeys.has(dedupeKey)) {
        dedupeKeys.add(dedupeKey);

        const context = taintFlow
          ? `Tainted variable "${taintFlow.variableName}" from ${taintFlow.sourceAccessor} flows into SQL query construction.`
          : 'SQL query string is being built dynamically with request-derived input.';

        findings.push(
          buildFinding({
            severity: 'high',
            confidence: taintFlow ? 'high' : 'medium',
            filePath,
            line: getLineNumberForIndex(assignmentMatch.index),
            message: 'Potential SQL injection risk: query string built from input data.',
            context,
            suggestion: 'Use parameterized placeholders instead of building SQL with input.'
          })
        );
      }
    }

    assignmentMatch = SQL_VARIABLE_ASSIGNMENT_REGEX.exec(fileContent);
  }
  SQL_VARIABLE_ASSIGNMENT_REGEX.lastIndex = 0;

  let match = QUERY_CALL_REGEX.exec(fileContent);
  while (match) {
    const callArgs = typeof match[1] === 'string' ? match[1] : '';
    const hasConcatenation = callArgs.includes('+');
    const hasTemplateInterpolation = /\$\{[^}]+\}/.test(callArgs);
    const hasInputSignal = INPUT_SIGNAL_REGEX.test(callArgs);
    const taintFlow = getTaintFlow(callArgs, taintedVariableMap);
    const sqlFlow = getMappedFlow(callArgs, sqlFlowVariableMap);
    const isDynamicQuery = hasConcatenation || hasTemplateInterpolation;

    if ((isDynamicQuery && (hasInputSignal || taintFlow)) || sqlFlow) {
      const dedupeKey = `sqli:${callArgs.trim()}`;
      if (!dedupeKeys.has(dedupeKey)) {
        dedupeKeys.add(dedupeKey);

        let context = 'Dynamic SQL query appears to include request-derived input.';
        let confidence = 'medium';

        if (taintFlow) {
          context = `Tainted variable "${taintFlow.variableName}" from ${taintFlow.sourceAccessor} flows into SQL query.`;
          confidence = 'high';
        } else if (sqlFlow) {
          if (sqlFlow.variableName && sqlFlow.sourceAccessor) {
            context = `Tainted variable "${sqlFlow.variableName}" from ${sqlFlow.sourceAccessor} flows into SQL query variable "${sqlFlow.sqlVariable}" and then into query execution.`;
            confidence = 'high';
          } else {
            context = `Dynamic SQL variable "${sqlFlow.sqlVariable}" flows into query execution.`;
            confidence = 'medium';
          }
        }

        findings.push(
          buildFinding({
            severity: 'high',
            confidence,
            filePath,
            line: getLineNumberForIndex(match.index),
            message: 'Potential SQL injection risk: dynamic query with input data.',
            context,
            suggestion: 'Use parameterized queries or prepared statements.'
          })
        );
      }
    }

    match = QUERY_CALL_REGEX.exec(fileContent);
  }
  QUERY_CALL_REGEX.lastIndex = 0;

  return findings;
};

const isLikelyDynamicDomAssignment = (line) => {
  const assignmentMatch = line.match(/(?:innerHTML|outerHTML)\s*=\s*(.+)/i);
  if (!assignmentMatch || !assignmentMatch[1]) {
    return false;
  }

  const rhs = assignmentMatch[1].trim();
  if (!rhs) {
    return false;
  }

  if (/^["'`][^$]*["'`]\s*;?$/.test(rhs)) {
    return false;
  }

  return true;
};

const detectXssRisks = (lines, filePath, dedupeKeys, taintedVariableMap) => {
  const findings = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line || isCommentLine(line)) {
      continue;
    }

    if (/\bdangerouslySetInnerHTML\b/i.test(line)) {
      const dedupeKey = `xss:dangerouslySetInnerHTML:${line.trim()}`;
      if (!dedupeKeys.has(dedupeKey)) {
        dedupeKeys.add(dedupeKey);
        const taintFlow = getTaintFlow(line, taintedVariableMap);
        const context = taintFlow
          ? `Tainted variable "${taintFlow.variableName}" from ${taintFlow.sourceAccessor} flows into dangerouslySetInnerHTML.`
          : 'dangerouslySetInnerHTML can introduce XSS if HTML is not sanitized.';

        findings.push(
          buildFinding({
            severity: 'high',
            confidence: taintFlow ? 'high' : 'medium',
            filePath,
            line: lineIndex + 1,
            message: 'dangerouslySetInnerHTML usage may allow XSS.',
            context,
            suggestion: 'Sanitize HTML with a trusted sanitizer before rendering.'
          })
        );
      }
    }

    if (/\b(?:innerHTML|outerHTML)\b/i.test(line) && isLikelyDynamicDomAssignment(line)) {
      const dedupeKey = `xss:dom-assignment:${line.trim()}`;
      if (!dedupeKeys.has(dedupeKey)) {
        dedupeKeys.add(dedupeKey);
        const taintFlow = getTaintFlow(line, taintedVariableMap);
        const context = taintFlow
          ? `Tainted variable "${taintFlow.variableName}" from ${taintFlow.sourceAccessor} flows into HTML assignment.`
          : 'Dynamic HTML assignment can render untrusted input and trigger XSS.';

        findings.push(
          buildFinding({
            severity: 'high',
            confidence: taintFlow ? 'high' : 'medium',
            filePath,
            line: lineIndex + 1,
            message: 'Dynamic HTML assignment detected; possible XSS vector.',
            context,
            suggestion: 'Prefer textContent or sanitize untrusted HTML inputs.'
          })
        );
      }
    }

    if (/\b(?:insertAdjacentHTML|document\.write)\s*\(/i.test(line)) {
      const dedupeKey = `xss:direct-dom-injection:${line.trim()}`;
      if (!dedupeKeys.has(dedupeKey)) {
        dedupeKeys.add(dedupeKey);
        const taintFlow = getTaintFlow(line, taintedVariableMap);
        const context = taintFlow
          ? `Tainted variable "${taintFlow.variableName}" from ${taintFlow.sourceAccessor} flows into direct DOM injection.`
          : 'Direct HTML injection APIs can introduce XSS when content is untrusted.';

        findings.push(
          buildFinding({
            severity: taintFlow ? 'high' : 'medium',
            confidence: taintFlow ? 'high' : 'medium',
            filePath,
            line: lineIndex + 1,
            message: 'Direct DOM HTML injection API usage detected.',
            context,
            suggestion: 'Avoid direct HTML injection with unsanitized data.'
          })
        );
      }
    }
  }

  return findings;
};

const detectInsecureLogging = (fileContent, filePath, dedupeKeys, taintedVariableMap, getLineNumberForIndex) => {
  const findings = [];
  let match = LOG_CALL_REGEX.exec(fileContent);

  while (match) {
    const callArgs = typeof match[1] === 'string' ? match[1] : '';
    const normalizedArgs = callArgs.replace(/\s+/g, ' ').trim();
    const logsWholeRequest =
      /^\s*(?:req|request)\s*$/.test(normalizedArgs) ||
      /\bJSON\.stringify\s*\(\s*(?:req|request)\s*\)/.test(callArgs);
    const logsSensitiveFields = /\b(password|token|authorization|api[_-]?key|secret)\b/i.test(callArgs);
    const taintFlow = getTaintFlow(callArgs, taintedVariableMap);

    if (logsWholeRequest || logsSensitiveFields || taintFlow) {
      const dedupeKey = `log:${normalizedArgs}`;
      if (!dedupeKeys.has(dedupeKey)) {
        dedupeKeys.add(dedupeKey);

        const message = taintFlow
          ? 'Potential insecure logging of tainted user input.'
          : logsSensitiveFields
            ? 'Potential insecure logging of sensitive credential data.'
            : 'Potential insecure logging: full request object logged.';

        const severity = taintFlow ? 'high' : logsSensitiveFields ? 'high' : 'medium';
        const confidence = taintFlow || logsSensitiveFields ? 'high' : 'medium';
        const context = taintFlow
          ? `Tainted variable "${taintFlow.variableName}" from ${taintFlow.sourceAccessor} flows into logs.`
          : logsSensitiveFields
            ? 'Logging statement appears to include sensitive authentication data.'
            : 'Logging full request objects can expose sensitive user details.';

        findings.push(
          buildFinding({
            severity,
            confidence,
            filePath,
            line: getLineNumberForIndex(match.index),
            message,
            context,
            suggestion: 'Log only minimal, non-sensitive fields and redact secrets.'
          })
        );
      }
    }

    match = LOG_CALL_REGEX.exec(fileContent);
  }
  LOG_CALL_REGEX.lastIndex = 0;

  return findings;
};

const scanFile = ({ filePath, fileContent }) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return [];
  }

  if (typeof fileContent !== 'string' || fileContent.length === 0) {
    return [];
  }

  const lines = fileContent.split(/\r?\n/);
  const dedupeKeys = new Set();
  const taintedVariableMap = extractTaintedVariables(lines);
  const getLineNumberForIndex = createLineNumberResolver(fileContent);

  return [
    ...detectHardcodedSecrets(lines, filePath, dedupeKeys),
    ...detectSqlInjectionRisks(fileContent, filePath, dedupeKeys, taintedVariableMap, getLineNumberForIndex),
    ...detectXssRisks(lines, filePath, dedupeKeys, taintedVariableMap),
    ...detectInsecureLogging(fileContent, filePath, dedupeKeys, taintedVariableMap, getLineNumberForIndex)
  ];
};

module.exports = {
  scanFile
};
