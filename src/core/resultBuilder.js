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
const FAIL_ON_VALUES = new Set(['high', 'medium', 'low']);
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

const isValidFailOnLevel = (value) => typeof value === 'string' && FAIL_ON_VALUES.has(value.trim().toLowerCase());

const normalizeFailOnLevel = (value) => (isValidFailOnLevel(value) ? value.trim().toLowerCase() : 'high');

const resolveSeverityCounts = (severitySummary) => {
  const normalizedSummary = severitySummary && typeof severitySummary === 'object' ? severitySummary : {};

  return {
    high: Number.isInteger(normalizedSummary.high) && normalizedSummary.high > 0 ? normalizedSummary.high : 0,
    medium: Number.isInteger(normalizedSummary.medium) && normalizedSummary.medium > 0 ? normalizedSummary.medium : 0,
    low: Number.isInteger(normalizedSummary.low) && normalizedSummary.low > 0 ? normalizedSummary.low : 0
  };
};

const resolveHighestPresentSeverity = (severityCounts) => {
  if (severityCounts.high > 0) {
    return 'high';
  }

  if (severityCounts.medium > 0) {
    return 'medium';
  }

  if (severityCounts.low > 0) {
    return 'low';
  }

  return null;
};

const resolveTriggeredSeverity = (normalizedFailOn, severityCounts, resolvedIssuesFound) => {
  if (normalizedFailOn === 'high') {
    return severityCounts.high > 0 ? 'high' : null;
  }

  if (normalizedFailOn === 'medium') {
    if (severityCounts.high > 0) {
      return 'high';
    }

    return severityCounts.medium > 0 ? 'medium' : null;
  }

  if (resolvedIssuesFound <= 0) {
    return null;
  }

  return resolveHighestPresentSeverity(severityCounts);
};

const buildBuildGateDecision = ({ failOn, severitySummary, issuesFound }) => {
  const normalizedFailOn = normalizeFailOnLevel(failOn);
  const severityCounts = resolveSeverityCounts(severitySummary);
  const resolvedIssuesFound =
    Number.isInteger(issuesFound) && issuesFound >= 0
      ? issuesFound
      : severityCounts.high + severityCounts.medium + severityCounts.low;
  const triggeredSeverity = resolveTriggeredSeverity(normalizedFailOn, severityCounts, resolvedIssuesFound);

  let message = '';

  if (normalizedFailOn === 'high') {
    message = '\u274C Build blocked: HIGH severity issues detected';
  } else if (normalizedFailOn === 'medium') {
    message = '\u274C Build blocked: HIGH or MEDIUM severity issues detected';
  } else {
    message = '\u274C Build blocked: issues detected';
  }

  const shouldFail = triggeredSeverity !== null;
  const warningMessage = shouldFail ? `\u26A0 ${triggeredSeverity.toUpperCase()} severity issues detected` : '';

  return {
    failOn: normalizedFailOn,
    triggeredSeverity,
    shouldFail,
    message: shouldFail ? message : '',
    warningMessage,
    severity: severityCounts
  };
};

const buildSeveritySummary = (findings) => {
  const severitySummary = buildDefaultSeveritySummary();

  for (const finding of findings) {
    const severity = normalizeSeverity(finding.severity);
    severitySummary[severity] += 1;
  }

  return severitySummary;
};

const normalizeType = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'unknown';

const isValidGroupingCandidate = (finding) => {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return false;
  }

  return typeof finding.message === 'string' && finding.message.trim().length > 0;
};

const compareSuggestionSelection = (leftCandidate, rightCandidate) => {
  const leftConfidence = normalizeConfidence(leftCandidate && leftCandidate.confidence);
  const rightConfidence = normalizeConfidence(rightCandidate && rightCandidate.confidence);
  const confidenceDelta = CONFIDENCE_PRIORITY[rightConfidence] - CONFIDENCE_PRIORITY[leftConfidence];
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const leftCount = Number.isInteger(leftCandidate && leftCandidate.count) ? leftCandidate.count : 0;
  const rightCount = Number.isInteger(rightCandidate && rightCandidate.count) ? rightCandidate.count : 0;
  const countDelta = rightCount - leftCount;
  if (countDelta !== 0) {
    return countDelta;
  }

  const leftSuggestion = leftCandidate && typeof leftCandidate.suggestion === 'string' ? leftCandidate.suggestion : '';
  const rightSuggestion = rightCandidate && typeof rightCandidate.suggestion === 'string' ? rightCandidate.suggestion : '';
  return leftSuggestion.localeCompare(rightSuggestion);
};

const compareOccurrenceByLocation = (leftOccurrence, rightOccurrence) => {
  const leftFile = leftOccurrence && typeof leftOccurrence.file === 'string' ? leftOccurrence.file : '';
  const rightFile = rightOccurrence && typeof rightOccurrence.file === 'string' ? rightOccurrence.file : '';
  const fileDelta = leftFile.localeCompare(rightFile);
  if (fileDelta !== 0) {
    return fileDelta;
  }

  const lineDelta = normalizeLineNumber(leftOccurrence && leftOccurrence.line) - normalizeLineNumber(rightOccurrence && rightOccurrence.line);
  if (lineDelta !== 0) {
    return lineDelta;
  }

  const leftContext = leftOccurrence && typeof leftOccurrence.context === 'string' ? leftOccurrence.context : '';
  const rightContext = rightOccurrence && typeof rightOccurrence.context === 'string' ? rightOccurrence.context : '';
  return leftContext.localeCompare(rightContext);
};

const resolveFirstOccurrence = (group) => {
  if (!group || !Array.isArray(group.occurrences) || group.occurrences.length === 0) {
    return null;
  }

  let firstOccurrence = group.occurrences[0];
  for (let index = 1; index < group.occurrences.length; index += 1) {
    const currentOccurrence = group.occurrences[index];
    if (compareOccurrenceByLocation(currentOccurrence, firstOccurrence) < 0) {
      firstOccurrence = currentOccurrence;
    }
  }

  return firstOccurrence;
};

const compareFindingsForPriority = (leftFinding, rightFinding) => {
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

  const lineDelta = normalizeLineNumber(leftFinding.line) - normalizeLineNumber(rightFinding.line);
  if (lineDelta !== 0) {
    return lineDelta;
  }

  const leftMessage = typeof leftFinding.message === 'string' ? leftFinding.message : '';
  const rightMessage = typeof rightFinding.message === 'string' ? rightFinding.message : '';
  const messageDelta = leftMessage.localeCompare(rightMessage);
  if (messageDelta !== 0) {
    return messageDelta;
  }

  const leftType = normalizeType(leftFinding.type);
  const rightType = normalizeType(rightFinding.type);
  const typeDelta = leftType.localeCompare(rightType);
  if (typeDelta !== 0) {
    return typeDelta;
  }

  const leftSuggestion = typeof leftFinding.suggestion === 'string' ? leftFinding.suggestion : '';
  const rightSuggestion = typeof rightFinding.suggestion === 'string' ? rightFinding.suggestion : '';
  const suggestionDelta = leftSuggestion.localeCompare(rightSuggestion);
  if (suggestionDelta !== 0) {
    return suggestionDelta;
  }

  const leftFunctionName = typeof leftFinding.functionName === 'string' ? leftFinding.functionName : 'global';
  const rightFunctionName = typeof rightFinding.functionName === 'string' ? rightFinding.functionName : 'global';
  const functionNameDelta = leftFunctionName.localeCompare(rightFunctionName);
  if (functionNameDelta !== 0) {
    return functionNameDelta;
  }

  const leftContext = typeof leftFinding.context === 'string' ? leftFinding.context : '';
  const rightContext = typeof rightFinding.context === 'string' ? rightFinding.context : '';
  return leftContext.localeCompare(rightContext);
};

const compareGroupedFindingsForOutput = (leftGroup, rightGroup) => {
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

  const firstOccurrenceDelta = compareOccurrenceByLocation(leftGroup._firstOccurrence, rightGroup._firstOccurrence);
  if (firstOccurrenceDelta !== 0) {
    return firstOccurrenceDelta;
  }

  const leftMessage = typeof leftGroup.message === 'string' ? leftGroup.message : '';
  const rightMessage = typeof rightGroup.message === 'string' ? rightGroup.message : '';
  const messageDelta = leftMessage.localeCompare(rightMessage);
  if (messageDelta !== 0) {
    return messageDelta;
  }

  const leftSuggestion = typeof leftGroup.suggestion === 'string' ? leftGroup.suggestion : '';
  const rightSuggestion = typeof rightGroup.suggestion === 'string' ? rightGroup.suggestion : '';
  return leftSuggestion.localeCompare(rightSuggestion);
};

const compareGroupedFindingsForTopRisks = (leftGroup, rightGroup) => {
  const severityDelta =
    SEVERITY_PRIORITY[normalizeSeverity(rightGroup.severity)] - SEVERITY_PRIORITY[normalizeSeverity(leftGroup.severity)];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const confidenceDelta =
    CONFIDENCE_PRIORITY[normalizeConfidence(rightGroup.confidence)] -
    CONFIDENCE_PRIORITY[normalizeConfidence(leftGroup.confidence)];
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const firstOccurrenceDelta = compareOccurrenceByLocation(leftGroup._firstOccurrence, rightGroup._firstOccurrence);
  if (firstOccurrenceDelta !== 0) {
    return firstOccurrenceDelta;
  }

  const leftMessage = typeof leftGroup.message === 'string' ? leftGroup.message : '';
  const rightMessage = typeof rightGroup.message === 'string' ? rightGroup.message : '';
  const messageDelta = leftMessage.localeCompare(rightMessage);
  if (messageDelta !== 0) {
    return messageDelta;
  }

  const leftSuggestion = typeof leftGroup.suggestion === 'string' ? leftGroup.suggestion : '';
  const rightSuggestion = typeof rightGroup.suggestion === 'string' ? rightGroup.suggestion : '';
  return leftSuggestion.localeCompare(rightSuggestion);
};

const sortFindingsByPriority = (findings) =>
  [...findings].sort(compareFindingsForPriority);

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
  if (!Array.isArray(findings) || findings.length === 0) {
    return [];
  }

  const exactGroupedFindingsMap = new Map();

  for (const finding of findings) {
    if (!isValidGroupingCandidate(finding)) {
      continue;
    }

    const normalized = normalizeFinding(finding);
    if (isIgnoredFindingFile(normalized.file)) {
      continue;
    }

    const exactGroupingKey = `${normalized.message}|${normalized.severity}|${normalized.suggestion}`;
    if (!exactGroupedFindingsMap.has(exactGroupingKey)) {
      exactGroupedFindingsMap.set(exactGroupingKey, {
        message: normalized.message,
        severity: normalized.severity,
        confidence: normalized.confidence,
        suggestion: normalized.suggestion,
        occurrences: [],
        _occurrenceSet: new Set()
      });
    }

    const exactGroup = exactGroupedFindingsMap.get(exactGroupingKey);
    const groupConfidence = normalizeConfidence(exactGroup.confidence);
    const findingConfidence = normalizeConfidence(normalized.confidence);
    if (CONFIDENCE_PRIORITY[findingConfidence] > CONFIDENCE_PRIORITY[groupConfidence]) {
      exactGroup.confidence = findingConfidence;
    }

    const occurrenceSignature = `${normalized.file}|${normalized.line}|${normalized.context}`;
    if (!exactGroup._occurrenceSet.has(occurrenceSignature)) {
      exactGroup._occurrenceSet.add(occurrenceSignature);
      exactGroup.occurrences.push({
        file: normalized.file,
        line: normalized.line,
        context: normalized.context
      });
    }
  }

  const mergedGroupedFindingsMap = new Map();
  const exactGroups = Array.from(exactGroupedFindingsMap.values()).sort((leftGroup, rightGroup) => {
    const leftMessage = typeof leftGroup.message === 'string' ? leftGroup.message : '';
    const rightMessage = typeof rightGroup.message === 'string' ? rightGroup.message : '';
    const messageDelta = leftMessage.localeCompare(rightMessage);
    if (messageDelta !== 0) {
      return messageDelta;
    }

    const leftSeverity = normalizeSeverity(leftGroup.severity);
    const rightSeverity = normalizeSeverity(rightGroup.severity);
    const severityDelta = SEVERITY_PRIORITY[rightSeverity] - SEVERITY_PRIORITY[leftSeverity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const leftSuggestion = typeof leftGroup.suggestion === 'string' ? leftGroup.suggestion : '';
    const rightSuggestion = typeof rightGroup.suggestion === 'string' ? rightGroup.suggestion : '';
    return leftSuggestion.localeCompare(rightSuggestion);
  });

  for (const exactGroup of exactGroups) {
    const mergedGroupingKey = `${exactGroup.message}|${exactGroup.severity}`;
    if (!mergedGroupedFindingsMap.has(mergedGroupingKey)) {
      mergedGroupedFindingsMap.set(mergedGroupingKey, {
        message: exactGroup.message,
        severity: normalizeSeverity(exactGroup.severity),
        confidence: normalizeConfidence(exactGroup.confidence),
        suggestion: exactGroup.suggestion,
        occurrences: [],
        _occurrenceSet: new Set(),
        _selectedSuggestionMeta: {
          suggestion: exactGroup.suggestion,
          confidence: normalizeConfidence(exactGroup.confidence),
          count: Array.isArray(exactGroup.occurrences) ? exactGroup.occurrences.length : 0
        }
      });
    }

    const mergedGroup = mergedGroupedFindingsMap.get(mergedGroupingKey);

    const mergedGroupConfidence = normalizeConfidence(mergedGroup.confidence);
    const exactGroupConfidence = normalizeConfidence(exactGroup.confidence);
    if (CONFIDENCE_PRIORITY[exactGroupConfidence] > CONFIDENCE_PRIORITY[mergedGroupConfidence]) {
      mergedGroup.confidence = exactGroupConfidence;
    }

    const candidateSuggestionMeta = {
      suggestion: exactGroup.suggestion,
      confidence: exactGroupConfidence,
      count: Array.isArray(exactGroup.occurrences) ? exactGroup.occurrences.length : 0
    };

    if (compareSuggestionSelection(candidateSuggestionMeta, mergedGroup._selectedSuggestionMeta) < 0) {
      mergedGroup._selectedSuggestionMeta = candidateSuggestionMeta;
      mergedGroup.suggestion = candidateSuggestionMeta.suggestion;
    }

    for (const occurrence of Array.isArray(exactGroup.occurrences) ? exactGroup.occurrences : []) {
      const occurrenceSignature = `${occurrence.file}|${occurrence.line}|${occurrence.context}`;
      if (!mergedGroup._occurrenceSet.has(occurrenceSignature)) {
        mergedGroup._occurrenceSet.add(occurrenceSignature);
        mergedGroup.occurrences.push({
          file: occurrence.file,
          line: occurrence.line,
          context: occurrence.context
        });
      }
    }
  }

  const groupedFindings = Array.from(mergedGroupedFindingsMap.values()).map((group) => {
    const occurrences = [...group.occurrences].sort((leftOccurrence, rightOccurrence) =>
      compareOccurrenceByLocation(leftOccurrence, rightOccurrence)
    );

    return {
      message: group.message,
      severity: normalizeSeverity(group.severity),
      confidence: normalizeConfidence(group.confidence),
      suggestion: group.suggestion,
      occurrences,
      count: occurrences.length
    };
  });

  const groupedFindingsWithFirstOccurrence = groupedFindings.map((group) => ({
    ...group,
    _firstOccurrence: resolveFirstOccurrence(group)
  }));

  const sortedGroupedFindings = groupedFindingsWithFirstOccurrence.sort(compareGroupedFindingsForOutput);
  return sortedGroupedFindings.map(({ _firstOccurrence, ...group }) => group);
};

const buildTopRisks = (groupedFindings) => {
  if (!Array.isArray(groupedFindings) || groupedFindings.length === 0) {
    return [];
  }

  const groupedFindingsWithFirstOccurrence = groupedFindings.map((group) => ({
    ...group,
    _firstOccurrence: resolveFirstOccurrence(group)
  }));

  const prioritizedGroups = groupedFindingsWithFirstOccurrence.sort(compareGroupedFindingsForTopRisks);

  return prioritizedGroups.slice(0, 3).map((group) => {
    const firstOccurrence = group._firstOccurrence;
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
    if (!isValidGroupingCandidate(finding)) {
      continue;
    }

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
  isValidFailOnLevel,
  normalizeFailOnLevel,
  buildBuildGateDecision,
  buildSeveritySummary,
  sortFindingsByPriority,
  buildGroupedFindings,
  buildTopRisks,
  dedupeFindings,
  buildExecutionInsightFinding,
  normalizeResult
};
