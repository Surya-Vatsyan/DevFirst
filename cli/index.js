#!/usr/bin/env node
'use strict';

const path = require('path');
const { analyzeProject } = require('../src/core/analyzeProject');

const SEVERITY_ORDER = ['high', 'medium', 'low'];

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

const toTitleCase = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
};

const printFindings = (findings) => {
  const grouped = groupFindingsBySeverity(findings);

  process.stdout.write(
    `Severity: HIGH=${grouped.high.length} MEDIUM=${grouped.medium.length} LOW=${grouped.low.length}\n\n`
  );

  for (const severity of SEVERITY_ORDER) {
    const entries = grouped[severity];
    for (const finding of entries) {
      const title = typeof finding.message === 'string' && finding.message.trim().length > 0
        ? finding.message
        : 'Issue detected';
      const file = typeof finding.file === 'string' && finding.file.trim().length > 0 ? finding.file : 'unknown file';
      const context =
        typeof finding.context === 'string' && finding.context.trim().length > 0
          ? finding.context
          : 'No context available.';

      process.stdout.write(`[${toTitleCase(severity).toUpperCase()}] ${title} in ${file}\n`);
      process.stdout.write(`→ ${context}\n\n`);
    }
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
  if (execution.error) {
    process.stdout.write(`error: ${execution.error}\n`);
  }
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
    const errorMessage =
      result &&
      result.aiReport &&
      Array.isArray(result.aiReport.errors) &&
      result.aiReport.errors.length > 0 &&
      result.summary &&
      result.summary.totalFiles === 0
        ? result.aiReport.errors[0]
        : '';

    if (errorMessage) {
      process.stdout.write(`❌ ${errorMessage}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`✔ Files analyzed: ${result.summary.totalFiles}\n`);
    process.stdout.write(`⚠ Issues found: ${result.summary.issuesFound}\n\n`);

    if (result.summary.totalFiles === 0) {
      process.stdout.write('⚠ No JavaScript files found.\n\n');
    } else if (result.summary.issuesFound > 0) {
      printFindings(result.findings);
    } else {
      process.stdout.write('✔ No issues detected.\n\n');
    }

    printExecution(result.execution);
  } catch (error) {
    process.stdout.write(`❌ ${error.message}\n`);
    process.exitCode = 1;
  }
};

void run();
