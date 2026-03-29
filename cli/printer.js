'use strict';

const { mapExecutionError } = require('./formatter');
const {
  CONFIDENCE_PRIORITY,
  MAX_PRINTED_GROUPED_ISSUES,
  MAX_PRINTED_GROUP_LOCATIONS,
  UNKNOWN_FILE,
  DEFAULT_MESSAGE,
  DEFAULT_SUGGESTION,
  DEFAULT_REASON,
  normalizeSeverity,
  normalizeConfidence,
  normalizeLine,
  formatFileLocation
} = require('./utils');

const printTopRisksSection = (topRisks) => {
  process.stdout.write('\u{1F6A8} TOP RISKS\n');

  if (!Array.isArray(topRisks) || topRisks.length === 0) {
    process.stdout.write('No critical risks identified.\n\n');
    return;
  }

  topRisks.forEach((risk, index) => {
    const severity = normalizeSeverity(risk.severity).toUpperCase();
    const message = typeof risk.message === 'string' && risk.message.trim().length > 0 ? risk.message : DEFAULT_MESSAGE;
    const file = typeof risk.file === 'string' && risk.file.trim().length > 0 ? risk.file : UNKNOWN_FILE;
    const line = normalizeLine(risk.line);
    const reason = typeof risk.reason === 'string' && risk.reason.trim().length > 0 ? risk.reason : DEFAULT_REASON;
    const suggestion =
      typeof risk.suggestion === 'string' && risk.suggestion.trim().length > 0 ? risk.suggestion : DEFAULT_SUGGESTION;

    process.stdout.write(`${index + 1}. [${severity}] ${message} (${formatFileLocation(file, line)})\n`);
    process.stdout.write(`   \u2192 ${reason}\n`);
    process.stdout.write(`   \u2192 Fix: ${suggestion}\n\n`);
  });
};

const printSummarySection = ({ filesAnalyzed, issuesFound, severityCounts }) => {
  process.stdout.write('\u{1F4CA} SUMMARY\n');
  process.stdout.write(`Files analyzed: ${filesAnalyzed}\n`);
  process.stdout.write(`Issues found: ${issuesFound}\n`);
  process.stdout.write(`\u{1F534} HIGH (${severityCounts.high})\n`);
  process.stdout.write(`\u{1F7E1} MEDIUM (${severityCounts.medium})\n`);
  process.stdout.write(`\u{1F7E2} LOW (${severityCounts.low})\n\n`);
};

const compareFindingsForGroupContext = (leftFinding, rightFinding) => {
  const confidenceDelta =
    CONFIDENCE_PRIORITY[normalizeConfidence(rightFinding && rightFinding.confidence)] -
    CONFIDENCE_PRIORITY[normalizeConfidence(leftFinding && leftFinding.confidence)];
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const leftFile = leftFinding && typeof leftFinding.file === 'string' ? leftFinding.file : '';
  const rightFile = rightFinding && typeof rightFinding.file === 'string' ? rightFinding.file : '';
  const fileDelta = leftFile.localeCompare(rightFile);
  if (fileDelta !== 0) {
    return fileDelta;
  }

  const lineDelta = normalizeLine(leftFinding && leftFinding.line) - normalizeLine(rightFinding && rightFinding.line);
  if (lineDelta !== 0) {
    return lineDelta;
  }

  const leftSuggestion = leftFinding && typeof leftFinding.suggestion === 'string' ? leftFinding.suggestion : '';
  const rightSuggestion = rightFinding && typeof rightFinding.suggestion === 'string' ? rightFinding.suggestion : '';
  return leftSuggestion.localeCompare(rightSuggestion);
};

const resolveRepresentativeFinding = ({ group, findings }) => {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    return null;
  }

  if (!Array.isArray(findings) || findings.length === 0) {
    return null;
  }

  const targetMessage = typeof group.message === 'string' ? group.message : '';
  const targetSeverity = normalizeSeverity(group.severity);
  const targetSuggestion = typeof group.suggestion === 'string' ? group.suggestion : '';

  const strictMatches = findings.filter((finding) => {
    const findingMessage = finding && typeof finding.message === 'string' ? finding.message : '';
    const findingSeverity = normalizeSeverity(finding && finding.severity);
    const findingSuggestion = finding && typeof finding.suggestion === 'string' ? finding.suggestion : '';

    return findingMessage === targetMessage && findingSeverity === targetSeverity && findingSuggestion === targetSuggestion;
  });

  const looseMatches =
    strictMatches.length > 0
      ? strictMatches
      : findings.filter((finding) => {
          const findingMessage = finding && typeof finding.message === 'string' ? finding.message : '';
          const findingSeverity = normalizeSeverity(finding && finding.severity);
          return findingMessage === targetMessage && findingSeverity === targetSeverity;
        });

  if (looseMatches.length === 0) {
    return null;
  }

  return [...looseMatches].sort(compareFindingsForGroupContext)[0];
};

const printArrowBlock = (label, text) => {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return;
  }

  process.stdout.write(`${label}\n`);
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  lines.forEach((line) => {
    process.stdout.write(`\u2192 ${line}\n`);
  });
  process.stdout.write('\n');
};

const printDetailedFindingsSection = (input) => {
  const groupedFindings = Array.isArray(input)
    ? input
    : input && Array.isArray(input.groupedFindings)
      ? input.groupedFindings
      : [];
  const findings = input && Array.isArray(input.findings) ? input.findings : [];

  process.stdout.write('\u{1F4CB} DETAILED FINDINGS\n');

  const visibleGroupedFindings = groupedFindings.slice(0, MAX_PRINTED_GROUPED_ISSUES);

  if (visibleGroupedFindings.length === 0) {
    process.stdout.write('No findings to display.\n\n');
    return;
  }

  visibleGroupedFindings.forEach((group) => {
    const severity = normalizeSeverity(group.severity).toUpperCase();
    const message = typeof group.message === 'string' && group.message.trim().length > 0 ? group.message : DEFAULT_MESSAGE;
    const suggestion =
      typeof group.suggestion === 'string' && group.suggestion.trim().length > 0 ? group.suggestion : DEFAULT_SUGGESTION;
    const occurrences = Array.isArray(group.occurrences) ? group.occurrences : [];
    const occurrenceCount = Number.isInteger(group.count) && group.count > 0 ? group.count : occurrences.length;
    const visibleOccurrences = occurrences.slice(0, MAX_PRINTED_GROUP_LOCATIONS);
    const representativeFinding = resolveRepresentativeFinding({
      group,
      findings
    });
    const primaryOccurrence =
      visibleOccurrences.length > 0
        ? visibleOccurrences[0]
        : representativeFinding && typeof representativeFinding === 'object'
          ? representativeFinding
          : {};
    const primaryFile =
      typeof primaryOccurrence.file === 'string' && primaryOccurrence.file.trim().length > 0
        ? primaryOccurrence.file
        : UNKNOWN_FILE;
    const primaryLine = normalizeLine(primaryOccurrence.line);
    const functionName =
      representativeFinding && typeof representativeFinding.functionName === 'string'
        ? representativeFinding.functionName.trim()
        : '';
    const functionLabel = functionName && functionName !== 'global' ? ` (function: ${functionName})` : '';
    const impact =
      representativeFinding && typeof representativeFinding.impact === 'string' ? representativeFinding.impact.trim() : '';
    const codeSnippet =
      representativeFinding && typeof representativeFinding.codeSnippet === 'string'
        ? representativeFinding.codeSnippet.trim()
        : '';

    process.stdout.write(
      `[${severity}] ${message} (${occurrenceCount} ${occurrenceCount === 1 ? 'occurrence' : 'occurrences'})\n`
    );
    process.stdout.write(`File: ${formatFileLocation(primaryFile, primaryLine)}${functionLabel}\n\n`);
    printArrowBlock('Impact:', impact);
    printArrowBlock('Code:', codeSnippet);
    process.stdout.write('Files:\n');

    if (visibleOccurrences.length === 0) {
      process.stdout.write(`* ${formatFileLocation(UNKNOWN_FILE, -1)}\n`);
    } else {
      visibleOccurrences.forEach((occurrence) => {
        const file = typeof occurrence.file === 'string' && occurrence.file.trim().length > 0 ? occurrence.file : UNKNOWN_FILE;
        const line = normalizeLine(occurrence.line);
        process.stdout.write(`* ${formatFileLocation(file, line)}\n`);
      });
    }

    if (occurrences.length > MAX_PRINTED_GROUP_LOCATIONS) {
      process.stdout.write(`* ...and ${occurrences.length - MAX_PRINTED_GROUP_LOCATIONS} more occurrences\n`);
    }

    process.stdout.write('\n');
    process.stdout.write('Fix:\n');
    process.stdout.write(`\u2192 ${suggestion}\n\n`);
  });

  if (groupedFindings.length > MAX_PRINTED_GROUPED_ISSUES) {
    const remaining = groupedFindings.length - MAX_PRINTED_GROUPED_ISSUES;
    process.stdout.write(`...and ${remaining} more grouped issues\n\n`);
  }
};

const printExecutionSection = (execution) => {
  process.stdout.write('\u{1F680} EXECUTION\n');

  if (!execution || !execution.attempted) {
    process.stdout.write('Status: \u26A0 skipped\n');
    process.stdout.write('Time: 0 ms\n');
    process.stdout.write('Execution skipped: no safe runnable entry detected\n');
    const mappedError = execution ? mapExecutionError(execution.error) : '';
    if (mappedError) {
      process.stdout.write(`Error: ${mappedError}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  if (execution.success) {
    process.stdout.write('Status: \u2714 success\n');
  } else {
    process.stdout.write('Status: \u274C failed\n');
  }

  process.stdout.write(`Time: ${execution.executionTime || 0} ms\n`);

  const mappedError = mapExecutionError(execution.error);
  if (mappedError) {
    process.stdout.write(`Error: ${mappedError}\n`);
  }

  process.stdout.write('\n');
};

const printAiSection = (aiReport) => {
  process.stdout.write('\u{1F916} AI\n');

  if (aiReport && aiReport.aiUsed) {
    const summary =
      typeof aiReport.summary === 'string' && aiReport.summary.trim().length > 0
        ? aiReport.summary
        : 'AI insights generated.';

    process.stdout.write(`${summary}\n\n`);
    return;
  }

  process.stdout.write('AI Disabled (no API key found)\n\n');
};

module.exports = {
  printTopRisksSection,
  printSummarySection,
  printDetailedFindingsSection,
  printExecutionSection,
  printAiSection
};
