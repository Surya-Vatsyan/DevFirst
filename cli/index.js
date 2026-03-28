#!/usr/bin/env node
'use strict';

const path = require('path');
const { analyzeProject } = require('../src/core/analyzeProject');

const SEVERITY_ORDER = ['high', 'medium', 'low'];
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
const MAX_PRINTED_ISSUES = 10;
const UNKNOWN_FILE = 'unknown';
const DEFAULT_MESSAGE = 'Issue detected.';
const DEFAULT_CONTEXT = 'No context available.';
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

const flattenFindingsBySeverity = (groupedFindings) => {
  const orderedFindings = [];
  for (const severity of SEVERITY_ORDER) {
    orderedFindings.push(...groupedFindings[severity]);
  }
  return orderedFindings;
};

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

const printTopRisksSection = (topRisks) => {
  process.stdout.write('🚨 TOP RISKS\n');

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
    process.stdout.write(`   → ${reason}\n`);
    process.stdout.write(`   → Fix: ${suggestion}\n\n`);
  });
};

const printSummarySection = ({ filesAnalyzed, issuesFound, severityCounts }) => {
  process.stdout.write('📊 SUMMARY\n');
  process.stdout.write(`Files analyzed: ${filesAnalyzed}\n`);
  process.stdout.write(`Issues found: ${issuesFound}\n`);
  process.stdout.write(`🔴 HIGH (${severityCounts.high})\n`);
  process.stdout.write(`🟡 MEDIUM (${severityCounts.medium})\n`);
  process.stdout.write(`🟢 LOW (${severityCounts.low})\n\n`);
};

const printDetailedFindingsSection = (findings) => {
  process.stdout.write('📋 DETAILED FINDINGS\n');

  const groupedFindings = groupFindingsBySeverity(findings);
  const orderedFindings = flattenFindingsBySeverity(groupedFindings);
  const visibleFindings = orderedFindings.slice(0, MAX_PRINTED_ISSUES);

  if (visibleFindings.length === 0) {
    process.stdout.write('No findings to display.\n\n');
    return;
  }

  visibleFindings.forEach((finding, index) => {
    const severity = normalizeSeverity(finding.severity).toUpperCase();
    const message =
      typeof finding.message === 'string' && finding.message.trim().length > 0 ? finding.message : DEFAULT_MESSAGE;
    const file = typeof finding.file === 'string' && finding.file.trim().length > 0 ? finding.file : UNKNOWN_FILE;
    const line = normalizeLine(finding.line);
    const confidence = normalizeConfidence(finding.confidence).toUpperCase();
    const context =
      typeof finding.context === 'string' && finding.context.trim().length > 0 ? finding.context : DEFAULT_CONTEXT;
    const suggestion =
      typeof finding.suggestion === 'string' && finding.suggestion.trim().length > 0
        ? finding.suggestion
        : DEFAULT_SUGGESTION;

    process.stdout.write(`${index + 1}. [${severity}] ${message}\n`);
    process.stdout.write(`   File: ${formatFileLocation(file, line)}\n`);
    process.stdout.write(`   Confidence: ${confidence}\n`);
    process.stdout.write(`   Context: ${context}\n`);
    process.stdout.write(`   Fix: ${suggestion}\n\n`);
  });

  if (orderedFindings.length > MAX_PRINTED_ISSUES) {
    const remaining = orderedFindings.length - MAX_PRINTED_ISSUES;
    process.stdout.write(`...and ${remaining} more issues\n\n`);
  }
};

const printExecutionSection = (execution) => {
  process.stdout.write('🚀 EXECUTION\n');

  if (!execution || !execution.attempted) {
    process.stdout.write('Status: ⚠ skipped\n');
    process.stdout.write('Time: 0 ms\n\n');
    return;
  }

  if (execution.success) {
    process.stdout.write('Status: ✔ success\n');
  } else {
    process.stdout.write('Status: ❌ failed\n');
  }

  process.stdout.write(`Time: ${execution.executionTime || 0} ms\n`);

  const mappedError = mapExecutionError(execution.error);
  if (mappedError) {
    process.stdout.write(`Error: ${mappedError}\n`);
  }

  process.stdout.write('\n');
};

const printAiSection = (aiReport) => {
  process.stdout.write('🤖 AI\n');

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

const run = async () => {
  const [, , command, targetPath] = process.argv;

  if (command !== 'scan') {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!targetPath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const scanPath = path.resolve(process.cwd(), targetPath);
  process.stdout.write('🔍 DevGuard Scan Started...\n\n');

  try {
    const result = await analyzeProject(scanPath);
    const safeResult = result && typeof result === 'object' ? result : {};
    const summary = safeResult.summary && typeof safeResult.summary === 'object' ? safeResult.summary : {};
    const findings = sortFindingsByPriority(Array.isArray(safeResult.findings) ? safeResult.findings : []);
    const severityCounts = normalizeSeverityCounts(summary, findings);
    const topRisks = normalizeTopRisks(safeResult.topRisks, findings);

    if (!safeResult.success) {
      const errorMessage =
        typeof safeResult.error === 'string' && safeResult.error.trim().length > 0
          ? safeResult.error
          : 'Project scan failed.';
      process.stdout.write(`❌ ${errorMessage}\n`);
      process.exitCode = 1;
      return;
    }

    const filesAnalyzed = Number.isInteger(summary.totalFiles) ? summary.totalFiles : 0;
    const issuesFound = Number.isInteger(summary.issuesFound) ? summary.issuesFound : findings.length;

    printTopRisksSection(topRisks);
    printSummarySection({
      filesAnalyzed,
      issuesFound,
      severityCounts
    });

    if (filesAnalyzed === 0) {
      process.stdout.write('📋 DETAILED FINDINGS\n');
      process.stdout.write('⚠ No JavaScript files found.\n\n');
    } else {
      printDetailedFindingsSection(findings);
    }

    printExecutionSection(safeResult.execution);
    printAiSection(safeResult.aiReport);
    process.stdout.write('Tip: Fix HIGH severity issues before deploying.\n');

    if (severityCounts.high > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(`❌ ${error.message}\n`);
    process.exitCode = 1;
  }
};

void run();
