'use strict';

const {
  SEVERITY_PRIORITY,
  CONFIDENCE_PRIORITY,
  UNKNOWN_FILE,
  DEFAULT_MESSAGE,
  DEFAULT_SUGGESTION,
  DEFAULT_REASON,
  normalizeSeverity,
  normalizeConfidence,
  normalizeLine
} = require('./utils');

const groupFindingsBySeverity = (findings) => {
  const grouped = {
    high: [],
    medium: [],
    low: []
  };

  for (const finding of findings) {
    const severity = normalizeSeverity(finding.severity);
    grouped[severity].push({
      ...finding,
      severity
    });
  }

  return grouped;
};

const buildGroupedFindingsFallback = (findings) => {
  const groupedFindingsMap = new Map();

  for (const finding of findings) {
    const message =
      typeof finding.message === 'string' && finding.message.trim().length > 0 ? finding.message : DEFAULT_MESSAGE;
    const suggestion =
      typeof finding.suggestion === 'string' && finding.suggestion.trim().length > 0
        ? finding.suggestion
        : DEFAULT_SUGGESTION;
    const severity = normalizeSeverity(finding.severity);
    const confidence = normalizeConfidence(finding.confidence);
    const file = typeof finding.file === 'string' && finding.file.trim().length > 0 ? finding.file : UNKNOWN_FILE;
    const line = normalizeLine(finding.line);
    const groupingKey = `${message}|${suggestion}`;

    if (!groupedFindingsMap.has(groupingKey)) {
      groupedFindingsMap.set(groupingKey, {
        message,
        severity,
        confidence,
        suggestion,
        occurrences: [],
        _occurrenceSet: new Set()
      });
    }

    const group = groupedFindingsMap.get(groupingKey);
    if (SEVERITY_PRIORITY[severity] > SEVERITY_PRIORITY[normalizeSeverity(group.severity)]) {
      group.severity = severity;
    }

    if (CONFIDENCE_PRIORITY[confidence] > CONFIDENCE_PRIORITY[normalizeConfidence(group.confidence)]) {
      group.confidence = confidence;
    }

    const occurrenceSignature = `${file}|${line}`;
    if (!group._occurrenceSet.has(occurrenceSignature)) {
      group._occurrenceSet.add(occurrenceSignature);
      group.occurrences.push({
        file,
        line
      });
    }
  }

  return Array.from(groupedFindingsMap.values()).map((group) => ({
    message: group.message,
    severity: normalizeSeverity(group.severity),
    confidence: normalizeConfidence(group.confidence),
    suggestion: group.suggestion,
    occurrences: [...group.occurrences],
    count: group.occurrences.length
  }));
};

const sortGroupedFindingsByPriority = (groupedFindings) =>
  [...groupedFindings].sort((leftGroup, rightGroup) => {
    const severityDelta =
      SEVERITY_PRIORITY[normalizeSeverity(rightGroup.severity)] - SEVERITY_PRIORITY[normalizeSeverity(leftGroup.severity)];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const leftCount = Number.isInteger(leftGroup.count) ? leftGroup.count : 0;
    const rightCount = Number.isInteger(rightGroup.count) ? rightGroup.count : 0;
    const countDelta = rightCount - leftCount;
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

const normalizeGroupedFindings = (groupedFindings, findings) => {
  if (Array.isArray(groupedFindings) && groupedFindings.length > 0) {
    return sortGroupedFindingsByPriority(groupedFindings);
  }

  return sortGroupedFindingsByPriority(buildGroupedFindingsFallback(findings));
};

const sortFindingsByPriority = (findings) =>
  [...findings].sort((leftFinding, rightFinding) => {
    const severityDelta =
      SEVERITY_PRIORITY[normalizeSeverity(rightFinding.severity)] - SEVERITY_PRIORITY[normalizeSeverity(leftFinding.severity)];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const confidenceDelta =
      CONFIDENCE_PRIORITY[normalizeConfidence(rightFinding.confidence)] -
      CONFIDENCE_PRIORITY[normalizeConfidence(leftFinding.confidence)];
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

const normalizeSeverityCounts = (summary, findings) => {
  const grouped = groupFindingsBySeverity(findings);
  const summarySeverity = summary && summary.severity && typeof summary.severity === 'object' ? summary.severity : {};

  return {
    high: Number.isInteger(summarySeverity.high) ? summarySeverity.high : grouped.high.length,
    medium: Number.isInteger(summarySeverity.medium) ? summarySeverity.medium : grouped.medium.length,
    low: Number.isInteger(summarySeverity.low) ? summarySeverity.low : grouped.low.length
  };
};

const mapExecutionError = (error) => {
  if (typeof error !== 'string' || error.trim().length === 0) {
    return '';
  }

  const normalized = error.toLowerCase();

  if (normalized.includes('spawn eperm') || normalized.includes('eacces')) {
    return 'Sandbox execution failed (Docker permission issue)';
  }

  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'Execution timed out (possible infinite loop)';
  }

  if (normalized.includes('process limit exceeded')) {
    return 'Process limit exceeded (possible fork bomb)';
  }

  if (normalized.includes('sandbox restriction')) {
    return 'Restricted operation blocked by sandbox policy';
  }

  if (normalized.includes('memory limit exceeded') || normalized.includes('out of memory')) {
    return 'Memory limit exceeded in sandbox';
  }

  return error;
};

const findMatchingFinding = (risk, findings) => {
  const riskSeverity = normalizeSeverity(risk.severity);
  const riskMessage = typeof risk.message === 'string' ? risk.message : '';
  const riskFile = typeof risk.file === 'string' ? risk.file : '';

  return findings.find((finding) => {
    const findingSeverity = normalizeSeverity(finding.severity);
    const findingMessage = typeof finding.message === 'string' ? finding.message : '';
    const findingFile = typeof finding.file === 'string' ? finding.file : '';

    return findingSeverity === riskSeverity && findingMessage === riskMessage && findingFile === riskFile;
  });
};

const buildTopRisksFallback = (sortedFindings) => {
  const highFindings = sortedFindings.filter((finding) => normalizeSeverity(finding.severity) === 'high');
  if (highFindings.length > 0) {
    return highFindings.slice(0, 3);
  }

  const mediumFindings = sortedFindings.filter((finding) => normalizeSeverity(finding.severity) === 'medium');
  if (mediumFindings.length > 0) {
    return mediumFindings.slice(0, 3);
  }

  return sortedFindings.slice(0, 3);
};

const normalizeTopRisks = (topRisks, findings) => {
  const sortedFindings = sortFindingsByPriority(findings);
  const sourceTopRisks =
    Array.isArray(topRisks) && topRisks.length > 0 ? topRisks.slice(0, 3) : buildTopRisksFallback(sortedFindings);
  const normalizedTopRisks = sourceTopRisks.map((risk) => {
    const normalizedRisk = risk && typeof risk === 'object' ? risk : {};
    const matchingFinding = findMatchingFinding(normalizedRisk, sortedFindings);

    const severity = normalizeSeverity(normalizedRisk.severity || (matchingFinding ? matchingFinding.severity : 'low'));
    const message =
      typeof normalizedRisk.message === 'string' && normalizedRisk.message.trim().length > 0
        ? normalizedRisk.message
        : matchingFinding && typeof matchingFinding.message === 'string' && matchingFinding.message.trim().length > 0
          ? matchingFinding.message
          : DEFAULT_MESSAGE;
    const file =
      typeof normalizedRisk.file === 'string' && normalizedRisk.file.trim().length > 0
        ? normalizedRisk.file
        : matchingFinding && typeof matchingFinding.file === 'string' && matchingFinding.file.trim().length > 0
          ? matchingFinding.file
          : UNKNOWN_FILE;
    const line = normalizeLine(
      Number.isInteger(normalizedRisk.line) ? normalizedRisk.line : matchingFinding ? matchingFinding.line : -1
    );
    const reason =
      typeof normalizedRisk.reason === 'string' && normalizedRisk.reason.trim().length > 0
        ? normalizedRisk.reason
        : matchingFinding && typeof matchingFinding.context === 'string' && matchingFinding.context.trim().length > 0
          ? matchingFinding.context
          : DEFAULT_REASON;
    const suggestion =
      matchingFinding && typeof matchingFinding.suggestion === 'string' && matchingFinding.suggestion.trim().length > 0
        ? matchingFinding.suggestion
        : DEFAULT_SUGGESTION;

    return {
      severity,
      message,
      file,
      line,
      reason,
      suggestion
    };
  });

  const uniqueTopRisks = [];
  const seen = new Set();

  for (const risk of normalizedTopRisks) {
    const signature = `${risk.severity}|${risk.message}|${risk.file}|${risk.line}`;
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    uniqueTopRisks.push(risk);
    if (uniqueTopRisks.length >= 3) {
      break;
    }
  }

  if (uniqueTopRisks.length < 3) {
    const fallbackCandidates = buildTopRisksFallback(sortedFindings).map((finding) => {
      const severity = normalizeSeverity(finding.severity);
      const message =
        typeof finding.message === 'string' && finding.message.trim().length > 0 ? finding.message : DEFAULT_MESSAGE;
      const file = typeof finding.file === 'string' && finding.file.trim().length > 0 ? finding.file : UNKNOWN_FILE;
      const line = normalizeLine(finding.line);
      const reason =
        typeof finding.reason === 'string' && finding.reason.trim().length > 0
          ? finding.reason
          : typeof finding.context === 'string' && finding.context.trim().length > 0
            ? finding.context
            : DEFAULT_REASON;
      const suggestion =
        typeof finding.suggestion === 'string' && finding.suggestion.trim().length > 0
          ? finding.suggestion
          : DEFAULT_SUGGESTION;

      return {
        severity,
        message,
        file,
        line,
        reason,
        suggestion
      };
    });

    for (const risk of fallbackCandidates) {
      const signature = `${risk.severity}|${risk.message}|${risk.file}|${risk.line}`;
      if (seen.has(signature)) {
        continue;
      }

      seen.add(signature);
      uniqueTopRisks.push(risk);
      if (uniqueTopRisks.length >= 3) {
        break;
      }
    }
  }

  return uniqueTopRisks;
};

module.exports = {
  sortFindingsByPriority,
  normalizeGroupedFindings,
  normalizeSeverityCounts,
  normalizeTopRisks,
  mapExecutionError
};
