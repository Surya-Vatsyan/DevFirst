#!/usr/bin/env node
'use strict';

const path = require('path');
const { analyzeProject } = require('../src/core/analyzeProject');
const {
  sortFindingsByPriority,
  normalizeGroupedFindings,
  normalizeSeverityCounts,
  normalizeTopRisks
} = require('./formatter');
const {
  printTopRisksSection,
  printSummarySection,
  printDetailedFindingsSection,
  printExecutionSection,
  printAiSection
} = require('./printer');
const { printUsage } = require('./utils');

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
  process.stdout.write('\u{1F50D} DevGuard Scan Started...\n\n');

  try {
    const result = await analyzeProject(scanPath);
    const safeResult = result && typeof result === 'object' ? result : {};
    const summary = safeResult.summary && typeof safeResult.summary === 'object' ? safeResult.summary : {};
    const findings = sortFindingsByPriority(Array.isArray(safeResult.findings) ? safeResult.findings : []);
    const groupedFindings = normalizeGroupedFindings(safeResult.groupedFindings, findings);
    const severityCounts = normalizeSeverityCounts(summary, findings);
    const topRisks = normalizeTopRisks(safeResult.topRisks, findings);

    if (!safeResult.success) {
      const errorMessage =
        typeof safeResult.error === 'string' && safeResult.error.trim().length > 0
          ? safeResult.error
          : 'Project scan failed.';
      process.stdout.write(`\u274C ${errorMessage}\n`);
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
      process.stdout.write('\u{1F4CB} DETAILED FINDINGS\n');
      process.stdout.write('\u26A0 No JavaScript files found.\n\n');
    } else {
      printDetailedFindingsSection(groupedFindings);
    }

    printExecutionSection(safeResult.execution);
    printAiSection(safeResult.aiReport);
    process.stdout.write('Tip: Fix HIGH severity issues before deploying.\n');

    if (severityCounts.high > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(`\u274C ${error.message}\n`);
    process.exitCode = 1;
  }
};

void run();
