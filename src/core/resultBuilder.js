'use strict';

const {
  normalizeFinding,
  normalizeSeverity,
  normalizeConfidence,
  normalizeLineNumber,
  DEFAULT_FILE
} = require('./findingEnricher');

const NODE_MODULES_DIRECTORY = 'node_modules';
const RUNTIME_FINDING_FILE = 'sandbox/runtime';
const DEFAULT_REASON = 'Review this finding and validate behavior.';
const INTERNAL_TOOL_FILE_PATHS = new Set([
  'src/core/analyzeproject.js',
  'src/services/securityscanner.js',
  'sandbox/executor.js',
  'cli/index.js'
]);
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
const EXECUTION_DECISION_VALUES = new Set(['executed', 'skipped', 'forced-execution']);
const EXECUTION_CONFIDENCE_VALUES = new Set(['high', 'medium']);

const buildDefaultSeveritySummary = () => ({
  high: 0,
  medium: 0,
  low: 0
});

const buildDefaultSummary = () => ({
  totalFiles: 0,
  issuesFound: 0,
  severity: buildDefaultSeveritySummary(),
  topRisksCount: 0
});

const buildDefaultExecution = () => ({
  attempted: false,
  success: false,
  decision: 'skipped',
  executionDecision: 'skipped',
  reason: 'Execution not attempted',
  error: '',
  confidence: 'medium',
  stdout: '',
  stderr: '',
  executionTime: 0,
  entryFile: null
});

const buildDefaultAiReport = () => ({
  summary: 'AI analysis not executed.',
  files: [],
  fixes: [],
  aiUsed: false,
  fallbackUsed: false,
  errors: []
});

const buildSeveritySummary = (findings) => {
  const severitySummary = buildDefaultSeveritySummary();

  for (const finding of findings) {
    const severity = normalizeSeverity(finding.severity);
    severitySummary[severity] += 1;
  }

  return severitySummary;
};

const sortFindingsByPriority = (findings) =>
  [...findings].sort((leftFinding, rightFinding) => {
    const leftSeverity = normalizeSeverity(leftFinding.severity);
    const rightSeverity = normalizeSeverity(rightFinding.severity);
    const severityDelta = SEVERITY_PRIORITY[rightSeverity] - SEVERITY_PRIORITY[leftSeverity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const leftConfidence = normalizeConfidence(leftFinding.confidence);
    const rightConfidence = normalizeConfidence(rightFinding.confidence);
    const confidenceDelta = CONFIDENCE_PRIORITY[rightConfidence] - CONFIDENCE_PRIORITY[leftConfidence];
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }

    const leftFile = typeof leftFinding.file === 'string' ? leftFinding.file : '';
    const rightFile = typeof rightFinding.file === 'string' ? rightFinding.file : '';
    const fileDelta = leftFile.localeCompare(rightFile);
    if (fileDelta !== 0) {
      return fileDelta;
    }

    const leftMessage = typeof leftFinding.message === 'string' ? leftFinding.message : '';
    const rightMessage = typeof rightFinding.message === 'string' ? rightFinding.message : '';
    return leftMessage.localeCompare(rightMessage);
  });

const buildFindingsBySeverity = (findings) => {
  const groupedFindings = {
    high: [],
    medium: [],
    low: []
  };

  for (const finding of findings) {
    const severity = normalizeSeverity(finding.severity);
    groupedFindings[severity].push(finding);
  }

  return groupedFindings;
};

const normalizePortableFilePath = (filePath) =>
  String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();

const isIgnoredFindingFile = (filePath) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return false;
  }

  const normalizedPath = normalizePortableFilePath(filePath);
  if (!normalizedPath) {
    return false;
  }

  if (
    normalizedPath === NODE_MODULES_DIRECTORY ||
    normalizedPath.startsWith(`${NODE_MODULES_DIRECTORY}/`) ||
    normalizedPath.includes(`/${NODE_MODULES_DIRECTORY}/`)
  ) {
    return true;
  }

  if (INTERNAL_TOOL_FILE_PATHS.has(normalizedPath)) {
    return true;
  }

  const segments = normalizedPath.split('/').filter(Boolean);
  return segments.some((segment) => segment.startsWith('tmp'));
};

const buildGroupedFindings = (findings) => {
  const groupedFindingsMap = new Map();

  for (const finding of findings) {
    const normalized = normalizeFinding(finding);
    if (isIgnoredFindingFile(normalized.file)) {
      continue;
    }

    const groupingKey = `${normalized.message}|${normalized.suggestion}`;
    if (!groupedFindingsMap.has(groupingKey)) {
      groupedFindingsMap.set(groupingKey, {
        message: normalized.message,
        severity: normalized.severity,
        confidence: normalized.confidence,
        suggestion: normalized.suggestion,
        occurrences: [],
        count: 0,
        _occurrenceSet: new Set()
      });
    }

    const group = groupedFindingsMap.get(groupingKey);
    const groupSeverity = normalizeSeverity(group.severity);
    const findingSeverity = normalizeSeverity(normalized.severity);
    if (SEVERITY_PRIORITY[findingSeverity] > SEVERITY_PRIORITY[groupSeverity]) {
      group.severity = findingSeverity;
    }

    const groupConfidence = normalizeConfidence(group.confidence);
    const findingConfidence = normalizeConfidence(normalized.confidence);
    if (CONFIDENCE_PRIORITY[findingConfidence] > CONFIDENCE_PRIORITY[groupConfidence]) {
      group.confidence = findingConfidence;
    }

    const occurrenceSignature = `${normalized.file}|${normalized.line}|${normalized.context}`;
    if (!group._occurrenceSet.has(occurrenceSignature)) {
      group._occurrenceSet.add(occurrenceSignature);
      group.occurrences.push({
        file: normalized.file,
        line: normalized.line,
        context: normalized.context
      });
    }
  }

  const groupedFindings = Array.from(groupedFindingsMap.values()).map((group) => {
    const occurrences = [...group.occurrences].sort((leftOccurrence, rightOccurrence) => {
      const leftFile = typeof leftOccurrence.file === 'string' ? leftOccurrence.file : '';
      const rightFile = typeof rightOccurrence.file === 'string' ? rightOccurrence.file : '';
      const fileDelta = leftFile.localeCompare(rightFile);
      if (fileDelta !== 0) {
        return fileDelta;
      }

      return normalizeLineNumber(leftOccurrence.line) - normalizeLineNumber(rightOccurrence.line);
    });

    return {
      message: group.message,
      severity: normalizeSeverity(group.severity),
      confidence: normalizeConfidence(group.confidence),
      suggestion: group.suggestion,
      occurrences,
      count: occurrences.length
    };
  });

  return groupedFindings.sort((leftGroup, rightGroup) => {
    const severityDelta =
      SEVERITY_PRIORITY[normalizeSeverity(rightGroup.severity)] - SEVERITY_PRIORITY[normalizeSeverity(leftGroup.severity)];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const countDelta = rightGroup.count - leftGroup.count;
    if (countDelta !== 0) {
      return countDelta;
    }

    const confidenceDelta =
      CONFIDENCE_PRIORITY[normalizeConfidence(rightGroup.confidence)] -
      CONFIDENCE_PRIORITY[normalizeConfidence(leftGroup.confidence)];
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }

    const leftMessage = typeof leftGroup.message === 'string' ? leftGroup.message : '';
    const rightMessage = typeof rightGroup.message === 'string' ? rightGroup.message : '';
    return leftMessage.localeCompare(rightMessage);
  });
};

const buildTopRisks = (groupedFindings) => {
  if (!Array.isArray(groupedFindings) || groupedFindings.length === 0) {
    return [];
  }

  const highGroups = groupedFindings.filter((group) => normalizeSeverity(group.severity) === 'high');
  const mediumGroups = groupedFindings.filter((group) => normalizeSeverity(group.severity) === 'medium');

  const targetGroups = highGroups.length > 0 ? highGroups : mediumGroups.length > 0 ? mediumGroups : groupedFindings;
  return targetGroups.slice(0, 3).map((group) => {
    const firstOccurrence = Array.isArray(group.occurrences) && group.occurrences.length > 0 ? group.occurrences[0] : null;
    const reason =
      firstOccurrence && typeof firstOccurrence.context === 'string' && firstOccurrence.context.trim().length > 0
        ? firstOccurrence.context
        : DEFAULT_REASON;

    return {
      message: group.message,
      file: firstOccurrence && typeof firstOccurrence.file === 'string' ? firstOccurrence.file : DEFAULT_FILE,
      severity: normalizeSeverity(group.severity),
      reason
    };
  });
};

const filterNoiseFindings = (findings) =>
  findings.filter((finding) => {
    const normalized = normalizeFinding(finding);
    return !isIgnoredFindingFile(normalized.file);
  });

const getExecutionFindingSignature = (finding) => {
  const normalized = normalizeFinding(finding);
  const normalizedType = typeof normalized.type === 'string' && normalized.type.trim().length > 0 ? normalized.type : 'unknown';
  const normalizedReason =
    typeof normalized.reason === 'string' && normalized.reason.trim().length > 0 ? normalized.reason.trim() : '';

  return [
    normalizedType,
    normalized.severity,
    normalized.confidence,
    normalized.file,
    String(normalized.line),
    typeof normalized.functionName === 'string' ? normalized.functionName : 'global',
    normalized.message,
    normalized.context,
    normalized.suggestion,
    normalizedReason
  ].join('|');
};

const dedupeFindings = (findings) => {
  const uniqueFindings = [];
  const seenSignatures = new Set();

  for (const finding of findings) {
    const normalizedFinding = normalizeFinding(finding);
    const signature = getExecutionFindingSignature(normalizedFinding);
    if (seenSignatures.has(signature)) {
      continue;
    }

    seenSignatures.add(signature);
    uniqueFindings.push(normalizedFinding);
  }

  return uniqueFindings;
};

const buildExecutionInsightFinding = (execution) => {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    return null;
  }

  if (!execution.attempted || execution.success) {
    return null;
  }

  const normalizedError = typeof execution.error === 'string' ? execution.error.trim() : '';
  if (!normalizedError) {
    return null;
  }

  const executionFile =
    typeof execution.entryFile === 'string' && execution.entryFile.trim().length > 0 ? execution.entryFile : RUNTIME_FINDING_FILE;

  if (normalizedError === 'Execution timed out') {
    return {
      type: 'runtime',
      severity: 'high',
      confidence: 'high',
      file: executionFile,
      line: -1,
      message: 'Potential infinite loop or blocking operation',
      reason: 'Code execution exceeded allowed time limit (5 seconds)',
      context: 'Code execution exceeded allowed time limit (5 seconds)',
      suggestion: 'Ensure loops and async operations have proper termination conditions'
    };
  }

  if (normalizedError.includes('Process limit exceeded')) {
    return {
      type: 'security',
      severity: 'high',
      confidence: 'high',
      file: executionFile,
      line: -1,
      message: 'Potential fork bomb or uncontrolled process spawning',
      reason: 'Execution attempted to create too many processes',
      context: 'Execution attempted to create too many processes',
      suggestion: 'Avoid spawning uncontrolled child processes'
    };
  }

  if (normalizedError.includes('Sandbox restriction')) {
    return {
      type: 'security',
      severity: 'medium',
      confidence: 'high',
      file: executionFile,
      line: -1,
      message: 'Attempted restricted operation (network or system access)',
      reason: 'Sandbox blocked unsafe operation',
      context: 'Sandbox blocked unsafe operation',
      suggestion: 'Avoid accessing external network or restricted system resources'
    };
  }

  if (normalizedError === 'Sandbox process failed to initialize') {
    return {
      type: 'system',
      severity: 'low',
      confidence: 'low',
      file: executionFile,
      line: -1,
      message: 'Execution environment failed to initialize',
      reason: 'Sandbox process could not start',
      context: 'Sandbox process could not start',
      suggestion: 'Check environment or dependencies'
    };
  }

  return null;
};

const normalizeExecution = (execution) => {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    return buildDefaultExecution();
  }

  const attempted = Boolean(execution.attempted);
  const normalizedDecision = typeof execution.decision === 'string' ? execution.decision.toLowerCase() : '';
  const normalizedConfidence = typeof execution.confidence === 'string' ? execution.confidence.toLowerCase() : '';
  const decision = EXECUTION_DECISION_VALUES.has(normalizedDecision)
    ? normalizedDecision
    : attempted
      ? 'executed'
      : 'skipped';
  const confidence = EXECUTION_CONFIDENCE_VALUES.has(normalizedConfidence) ? normalizedConfidence : 'medium';
  const reason =
    typeof execution.reason === 'string' && execution.reason.trim().length > 0
      ? execution.reason
      : typeof execution.error === 'string' && execution.error.trim().length > 0
        ? execution.error
        : decision === 'forced-execution'
          ? 'Execution attempted despite medium-risk pattern'
          : decision === 'executed'
            ? 'Execution executed'
            : 'Execution skipped';

  return {
    attempted,
    success: Boolean(execution.success),
    decision,
    executionDecision: decision,
    reason,
    error: typeof execution.error === 'string' ? execution.error : '',
    confidence,
    stdout: typeof execution.stdout === 'string' ? execution.stdout : '',
    stderr: typeof execution.stderr === 'string' ? execution.stderr : '',
    executionTime: Number.isFinite(execution.executionTime) && execution.executionTime >= 0 ? execution.executionTime : 0,
    entryFile: typeof execution.entryFile === 'string' ? execution.entryFile : null
  };
};

const normalizeAiReport = (aiReport) => {
  if (!aiReport || typeof aiReport !== 'object' || Array.isArray(aiReport)) {
    return buildDefaultAiReport();
  }

  return {
    summary: typeof aiReport.summary === 'string' ? aiReport.summary : buildDefaultAiReport().summary,
    files: Array.isArray(aiReport.files) ? aiReport.files : [],
    fixes: Array.isArray(aiReport.fixes) ? aiReport.fixes : [],
    aiUsed: Boolean(aiReport.aiUsed),
    fallbackUsed: Boolean(aiReport.fallbackUsed),
    errors: Array.isArray(aiReport.errors) ? aiReport.errors.map((errorValue) => String(errorValue)) : []
  };
};

const normalizeResult = ({ success, error, summary, findings, execution, aiReport }) => {
  const normalizedFindings = Array.isArray(findings) ? dedupeFindings(findings) : [];
  const filteredFindings = filterNoiseFindings(normalizedFindings);
  const prioritizedFindings = sortFindingsByPriority(filteredFindings);
  const findingsBySeverity = buildFindingsBySeverity(prioritizedFindings);
  const groupedFindings = buildGroupedFindings(prioritizedFindings);
  const topRisks = buildTopRisks(groupedFindings);
  const resolvedSummary = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
  const totalFiles =
    Number.isInteger(resolvedSummary.totalFiles) && resolvedSummary.totalFiles >= 0 ? resolvedSummary.totalFiles : 0;
  const issuesFound = prioritizedFindings.length;

  return {
    success: Boolean(success),
    error: typeof error === 'string' && error.trim().length > 0 ? error : null,
    summary: {
      totalFiles,
      issuesFound,
      severity: buildSeveritySummary(prioritizedFindings),
      topRisksCount: topRisks.length
    },
    findings: prioritizedFindings,
    groupedFindings,
    findingsBySeverity,
    topRisks,
    execution: normalizeExecution(execution),
    aiReport: normalizeAiReport(aiReport)
  };
};

module.exports = {
  buildDefaultSummary,
  buildDefaultExecution,
  buildDefaultAiReport,
  buildSeveritySummary,
  sortFindingsByPriority,
  buildGroupedFindings,
  buildTopRisks,
  dedupeFindings,
  buildExecutionInsightFinding,
  normalizeResult
};
