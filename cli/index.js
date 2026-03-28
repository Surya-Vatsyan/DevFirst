#!/usr/bin/env node
'use strict';

const path = require('path');
const { analyzeProject } = require('../src/core/analyzeProject');

const SEVERITY_ORDER = ['high', 'medium', 'low'];
const MAX_PRINTED_ISSUES = 10;
const UNKNOWN_FILE = 'unknown';
const DEFAULT_MESSAGE = 'Issue detected.';
const DEFAULT_CONTEXT = 'No context available.';
const DEFAULT_SUGGESTION = 'Review and remediate this issue.';
const DEFAULT_CONFIDENCE = 'low';

const printUsage = () => {
  process.stdout.write('Usage: devguard scan <path>\n');
  process.stdout.write('Example: devguard scan .\n');
};

const groupFindingsBySeverity = (findings) => {
  const grouped = {
    high: [],
    medium: [],
    low: []
  };

  for (const finding of findings) {
    const severity = typeof finding.severity === 'string' ? finding.severity.toLowerCase() : 'low';
    if (grouped[severity]) {
      grouped[severity].push(finding);
      continue;
    }

    grouped.low.push({
      ...finding,
      severity: 'low'
    });
  }

  return grouped;
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

const normalizeSeverityCounts = (summary, findings) => {
  const grouped = groupFindingsBySeverity(findings);
  const summarySeverity = summary && summary.severity && typeof summary.severity === 'object' ? summary.severity : {};

  return {
    high: Number.isInteger(summarySeverity.high) ? summarySeverity.high : grouped.high.length,
    medium: Number.isInteger(summarySeverity.medium) ? summarySeverity.medium : grouped.medium.length,
    low: Number.isInteger(summarySeverity.low) ? summarySeverity.low : grouped.low.length
  };
};

const flattenFindingsBySeverity = (grouped) => {
  const ordered = [];
  for (const severity of SEVERITY_ORDER) {
    ordered.push(...grouped[severity]);
  }
  return ordered;
};

const mapExecutionError = (error) => {
  if (typeof error !== 'string' || error.trim().length === 0) {
    return '';
  }

  const normalized = error.toLowerCase();
  if (normalized.includes('spawn eperm')) {
    return 'Sandbox execution failed (Docker permission issue)';
  }

  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'Execution timed out (possible infinite loop)';
  }

  return error;
};

const printSeverityGroups = (severityCounts) => {
  process.stdout.write(`🔴 HIGH (${severityCounts.high} issues)\n`);
  process.stdout.write(`🟡 MEDIUM (${severityCounts.medium} issues)\n`);
  process.stdout.write(`🟢 LOW (${severityCounts.low} issues)\n\n`);
};

const printFindings = (findings) => {
  const grouped = groupFindingsBySeverity(findings);
  const orderedFindings = flattenFindingsBySeverity(grouped);
  const visibleFindings = orderedFindings.slice(0, MAX_PRINTED_ISSUES);

  for (const finding of visibleFindings) {
    const severity = typeof finding.severity === 'string' ? finding.severity.toUpperCase() : 'LOW';
    const message =
      typeof finding.message === 'string' && finding.message.trim().length > 0 ? finding.message : DEFAULT_MESSAGE;
    const file = typeof finding.file === 'string' && finding.file.trim().length > 0 ? finding.file : UNKNOWN_FILE;
    const line = normalizeLine(finding.line);
    const confidence =
      typeof finding.confidence === 'string' && finding.confidence.trim().length > 0
        ? finding.confidence.toUpperCase()
        : DEFAULT_CONFIDENCE.toUpperCase();
    const context =
      typeof finding.context === 'string' && finding.context.trim().length > 0 ? finding.context : DEFAULT_CONTEXT;
    const suggestion =
      typeof finding.suggestion === 'string' && finding.suggestion.trim().length > 0
        ? finding.suggestion
        : DEFAULT_SUGGESTION;

    process.stdout.write(`[${severity}] ${message}\n`);
    process.stdout.write(`File: ${formatFileLocation(file, line)}\n`);
    process.stdout.write(`Confidence: ${confidence}\n`);
    process.stdout.write('Context:\n');
    process.stdout.write(`→ ${context}\n`);
    process.stdout.write('Fix:\n');
    process.stdout.write(`→ ${suggestion}\n\n`);
  }

  if (orderedFindings.length > MAX_PRINTED_ISSUES) {
    const remaining = orderedFindings.length - MAX_PRINTED_ISSUES;
    process.stdout.write(`...and ${remaining} more issues\n\n`);
  }
};

const printExecution = (execution) => {
  process.stdout.write('🚀 Execution:\n');

  if (!execution || !execution.attempted) {
    process.stdout.write('⚠ skipped\n');
    process.stdout.write('time: 0 ms\n');
    return;
  }

  if (execution.success) {
    process.stdout.write('✔ success\n');
  } else {
    process.stdout.write('❌ failed\n');
  }

  process.stdout.write(`time: ${execution.executionTime || 0} ms\n`);
  const mappedError = mapExecutionError(execution.error);
  if (mappedError) {
    process.stdout.write(`error: ${mappedError}\n`);
  }
};

const printFinalTip = () => {
  process.stdout.write('\nTip:\n');
  process.stdout.write('Fix HIGH severity issues before deploying.\n');
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
    const findings = Array.isArray(safeResult.findings) ? safeResult.findings : [];
    const severityCounts = normalizeSeverityCounts(summary, findings);

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

    process.stdout.write(`✔ Files analyzed: ${filesAnalyzed}\n`);
    process.stdout.write(`⚠ Issues found: ${issuesFound}\n\n`);
    printSeverityGroups(severityCounts);

    if (filesAnalyzed === 0) {
      process.stdout.write('⚠ No JavaScript files found.\n\n');
    } else if (issuesFound > 0) {
      printFindings(findings);
    } else {
      process.stdout.write('✔ No issues detected.\n\n');
    }

    printExecution(safeResult.execution);
    printFinalTip();

    if (severityCounts.high > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(`❌ ${error.message}\n`);
    process.exitCode = 1;
  }
};

void run();
