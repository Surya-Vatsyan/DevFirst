#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { analyzeProject } = require('../src/core/analyzeProject');
const { isValidFailOnLevel, normalizeFailOnLevel, buildBuildGateDecision } = require('../src/core/resultBuilder');
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

const FAIL_ON_FLAG_PREFIX = '--fail-on=';
const OVERRIDE_FLAG_PREFIX = '--override=';
const OUTPUT_FLAG_PREFIX = '--output=';
const JSON_OUTPUT_FLAG = '--json';
const QUIET_OUTPUT_FLAG = '--quiet';
const DEVGUARD_CONFIG_FILE_NAME = 'devguard.config.json';
const OVERRIDE_AUDIT_LOG_FILE_NAME = 'devguard-overrides.log';

const printCliUsage = () => {
  printUsage();
  process.stdout.write(
    'Options: --fail-on=high|medium|low --override="reason" --json --output=<path> --quiet\n'
  );
  process.stdout.write(`Optional config: ${DEVGUARD_CONFIG_FILE_NAME}\n`);
};

const writeJsonOutput = (value, outputFilePath) => {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (outputFilePath) {
    fs.writeFileSync(outputFilePath, payload, 'utf8');
    return;
  }

  process.stdout.write(payload);
};

const emitJsonOutput = ({ value, outputFilePath }) => {
  try {
    writeJsonOutput(value, outputFilePath);
    return true;
  } catch (error) {
    process.stderr.write(`Error writing JSON output: ${error.message}\n`);
    return false;
  }
};

const buildJsonResult = ({ safeResult, summary, topRisks, groupedFindings }) => ({
  success: Boolean(safeResult && safeResult.success),
  summary: summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {},
  topRisks: Array.isArray(topRisks) ? topRisks : [],
  groupedFindings: Array.isArray(groupedFindings) ? groupedFindings : [],
  execution:
    safeResult && safeResult.execution && typeof safeResult.execution === 'object' && !Array.isArray(safeResult.execution)
      ? safeResult.execution
      : {},
  aiReport: safeResult && safeResult.aiReport && typeof safeResult.aiReport === 'object' && !Array.isArray(safeResult.aiReport)
    ? safeResult.aiReport
    : {}
});

const unwrapQuotedValue = (value) => {
  const rawValue = typeof value === 'string' ? value.trim() : '';
  if (rawValue.length >= 2) {
    const startsWithSingle = rawValue.startsWith("'");
    const endsWithSingle = rawValue.endsWith("'");
    const startsWithDouble = rawValue.startsWith('"');
    const endsWithDouble = rawValue.endsWith('"');

    if ((startsWithSingle && endsWithSingle) || (startsWithDouble && endsWithDouble)) {
      return rawValue.slice(1, -1).trim();
    }
  }

  return rawValue;
};

const extractOutputPathFromRawArgs = (rawArgs) => {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  for (const arg of args) {
    if (typeof arg !== 'string') {
      continue;
    }

    if (arg.startsWith(OUTPUT_FLAG_PREFIX)) {
      const outputPath = unwrapQuotedValue(arg.slice(OUTPUT_FLAG_PREFIX.length));
      if (outputPath.length > 0) {
        return outputPath;
      }
    }
  }

  return null;
};

const parseScanArgs = (rawArgs) => {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  let targetPath = null;
  let failOnFromCli = null;
  let overrideReasonFromCli = null;
  let outputPathFromCli = null;
  let isJsonOutput = false;
  let isQuiet = false;

  for (const arg of args) {
    if (typeof arg !== 'string') {
      continue;
    }

    if (arg.startsWith(FAIL_ON_FLAG_PREFIX)) {
      if (failOnFromCli) {
        throw new Error('Duplicate --fail-on flag.');
      }

      const flagValue = arg.slice(FAIL_ON_FLAG_PREFIX.length);
      if (!isValidFailOnLevel(flagValue)) {
        throw new Error('Invalid --fail-on value. Use one of: high, medium, low.');
      }

      failOnFromCli = normalizeFailOnLevel(flagValue);
      continue;
    }

    if (arg.startsWith(OVERRIDE_FLAG_PREFIX)) {
      if (overrideReasonFromCli) {
        throw new Error('Duplicate --override flag.');
      }

      const overrideReason = unwrapQuotedValue(arg.slice(OVERRIDE_FLAG_PREFIX.length));
      if (overrideReason.length === 0) {
        throw new Error('Invalid --override value. Provide a non-empty reason.');
      }

      overrideReasonFromCli = overrideReason;
      continue;
    }

    if (arg.startsWith(OUTPUT_FLAG_PREFIX)) {
      if (outputPathFromCli) {
        throw new Error('Duplicate --output flag.');
      }

      const outputPath = unwrapQuotedValue(arg.slice(OUTPUT_FLAG_PREFIX.length));
      if (outputPath.length === 0) {
        throw new Error('Invalid --output value. Provide a non-empty file path.');
      }

      outputPathFromCli = outputPath;
      continue;
    }

    if (arg === JSON_OUTPUT_FLAG) {
      isJsonOutput = true;
      continue;
    }

    if (arg === QUIET_OUTPUT_FLAG) {
      isQuiet = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (targetPath) {
      throw new Error('Only one scan path is supported.');
    }

    targetPath = arg;
  }

  return {
    targetPath,
    failOnFromCli,
    overrideReasonFromCli,
    outputPathFromCli,
    isJsonOutput,
    isQuiet
  };
};

const loadDevGuardConfig = async (workingDirectory) => {
  const configPath = path.join(workingDirectory, DEVGUARD_CONFIG_FILE_NAME);

  try {
    const configText = await fsPromises.readFile(configPath, 'utf8');
    const sanitizedConfigText = String(configText || '').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(sanitizedConfigText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid ${DEVGUARD_CONFIG_FILE_NAME}: root must be a JSON object.`);
    }

    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${DEVGUARD_CONFIG_FILE_NAME}: ${error.message}`);
    }

    throw error;
  }
};

const resolveFailOnLevel = ({ failOnFromCli, config }) => {
  if (failOnFromCli) {
    return failOnFromCli;
  }

  const configValue = config && typeof config === 'object' ? config.failOn : undefined;
  if (typeof configValue === 'undefined') {
    return 'high';
  }

  if (!isValidFailOnLevel(configValue)) {
    throw new Error(`Invalid failOn in ${DEVGUARD_CONFIG_FILE_NAME}. Use one of: high, medium, low.`);
  }

  return normalizeFailOnLevel(configValue);
};

const normalizePortablePath = (value) =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();

const normalizeIgnorePath = (value) => normalizePortablePath(value).trim();

const resolveIgnorePaths = (config) => {
  const configValue = config && typeof config === 'object' ? config.ignore : undefined;
  if (typeof configValue === 'undefined') {
    return [];
  }

  if (!Array.isArray(configValue)) {
    throw new Error(`Invalid ignore in ${DEVGUARD_CONFIG_FILE_NAME}: expected an array of paths.`);
  }

  const normalizedPaths = [];
  for (const ignorePath of configValue) {
    if (typeof ignorePath !== 'string') {
      throw new Error(`Invalid ignore in ${DEVGUARD_CONFIG_FILE_NAME}: all entries must be strings.`);
    }

    const normalized = normalizeIgnorePath(ignorePath);
    if (normalized.length > 0) {
      normalizedPaths.push(normalized);
    }
  }

  return [...new Set(normalizedPaths)].sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
};

const pathMatchesIgnorePath = (filePath, ignorePath) => {
  const normalizedFilePath = normalizePortablePath(filePath);
  const normalizedIgnorePath = normalizeIgnorePath(ignorePath);

  if (!normalizedFilePath || !normalizedIgnorePath) {
    return false;
  }

  if (
    normalizedFilePath === normalizedIgnorePath ||
    normalizedFilePath.startsWith(`${normalizedIgnorePath}/`) ||
    normalizedFilePath.includes(`/${normalizedIgnorePath}/`)
  ) {
    return true;
  }

  const fileSegments = normalizedFilePath.split('/').filter(Boolean);
  const ignoreSegments = normalizedIgnorePath.split('/').filter(Boolean);
  if (ignoreSegments.length === 0 || ignoreSegments.length > fileSegments.length) {
    return false;
  }

  for (let startIndex = 0; startIndex <= fileSegments.length - ignoreSegments.length; startIndex += 1) {
    let isMatch = true;
    for (let index = 0; index < ignoreSegments.length; index += 1) {
      if (fileSegments[startIndex + index] !== ignoreSegments[index]) {
        isMatch = false;
        break;
      }
    }

    if (isMatch) {
      return true;
    }
  }

  return false;
};

const isIgnoredFilePath = (filePath, ignorePaths) => {
  if (!Array.isArray(ignorePaths) || ignorePaths.length === 0) {
    return false;
  }

  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return false;
  }

  return ignorePaths.some((ignorePath) => pathMatchesIgnorePath(filePath, ignorePath));
};

const filterFindingsByIgnorePaths = (findings, ignorePaths) => {
  if (!Array.isArray(findings) || findings.length === 0) {
    return [];
  }

  if (!Array.isArray(ignorePaths) || ignorePaths.length === 0) {
    return findings;
  }

  return findings.filter((finding) => !isIgnoredFilePath(finding && finding.file, ignorePaths));
};

const filterGroupedFindingsByIgnorePaths = (groupedFindings, ignorePaths) => {
  if (!Array.isArray(groupedFindings) || groupedFindings.length === 0) {
    return groupedFindings;
  }

  if (!Array.isArray(ignorePaths) || ignorePaths.length === 0) {
    return groupedFindings;
  }

  const filteredGroups = [];
  for (const group of groupedFindings) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      continue;
    }

    const occurrences = Array.isArray(group.occurrences) ? group.occurrences : [];
    const filteredOccurrences = occurrences.filter((occurrence) => !isIgnoredFilePath(occurrence && occurrence.file, ignorePaths));

    if (filteredOccurrences.length === 0) {
      continue;
    }

    filteredGroups.push({
      ...group,
      occurrences: filteredOccurrences,
      count: filteredOccurrences.length
    });
  }

  return filteredGroups;
};

const filterTopRisksByIgnorePaths = (topRisks, ignorePaths) => {
  if (!Array.isArray(topRisks) || topRisks.length === 0) {
    return topRisks;
  }

  if (!Array.isArray(ignorePaths) || ignorePaths.length === 0) {
    return topRisks;
  }

  return topRisks.filter((risk) => !isIgnoredFilePath(risk && risk.file, ignorePaths));
};

const toPlainMessage = (message) =>
  typeof message === 'string' ? message.replace(/^[^A-Za-z0-9]+/, '').trim() : '';

const printMinimalSummary = ({
  filesAnalyzed,
  issuesFound,
  severityCounts,
  gateDecision,
  overrideApplied
}) => {
  process.stdout.write(`Files analyzed: ${filesAnalyzed}\n`);
  process.stdout.write(`Issues found: ${issuesFound}\n`);
  process.stdout.write(`High: ${severityCounts.high} Medium: ${severityCounts.medium} Low: ${severityCounts.low}\n`);

  if (overrideApplied) {
    process.stdout.write('Status: override applied\n');
    return;
  }

  if (gateDecision && gateDecision.shouldFail) {
    const blockedMessage = toPlainMessage(gateDecision.message) || 'Build blocked';
    process.stdout.write(`Status: blocked - ${blockedMessage}\n`);
    return;
  }

  process.stdout.write('Status: success\n');
};

const appendOverrideAuditLog = async ({ workingDirectory, reason, severityCounts, topRisks }) => {
  const logPath = path.join(workingDirectory, OVERRIDE_AUDIT_LOG_FILE_NAME);
  const entry = {
    timestamp: new Date().toISOString(),
    reason,
    severityCounts: {
      high: Number.isInteger(severityCounts && severityCounts.high) ? severityCounts.high : 0,
      medium: Number.isInteger(severityCounts && severityCounts.medium) ? severityCounts.medium : 0,
      low: Number.isInteger(severityCounts && severityCounts.low) ? severityCounts.low : 0
    },
    topRisks: Array.isArray(topRisks)
      ? topRisks.slice(0, 3).map((risk) => ({
          severity: risk && typeof risk.severity === 'string' ? risk.severity : 'low',
          message: risk && typeof risk.message === 'string' ? risk.message : 'Issue detected.',
          file: risk && typeof risk.file === 'string' ? risk.file : 'unknown',
          line: Number.isInteger(risk && risk.line) ? risk.line : -1,
          reason: risk && typeof risk.reason === 'string' ? risk.reason : ''
        }))
      : []
  };

  await fsPromises.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
};

const run = async () => {
  const [, , command, ...rawArgs] = process.argv;
  const isJsonRequested = rawArgs.includes(JSON_OUTPUT_FLAG);
  const fallbackOutputPath = isJsonRequested ? extractOutputPathFromRawArgs(rawArgs) : null;
  const fallbackOutputFilePath = fallbackOutputPath ? path.resolve(process.cwd(), fallbackOutputPath) : null;

  if (command !== 'scan') {
    if (isJsonRequested) {
      emitJsonOutput({
        value: {
          success: false,
          error: 'Invalid command'
        },
        outputFilePath: fallbackOutputFilePath
      });
    } else {
      printCliUsage();
    }
    process.exitCode = 1;
    return;
  }

  let parsedArgs;
  try {
    parsedArgs = parseScanArgs(rawArgs);
  } catch (error) {
    if (isJsonRequested) {
      emitJsonOutput({
        value: {
          success: false,
          error: error.message
        },
        outputFilePath: fallbackOutputFilePath
      });
    } else {
      process.stdout.write(`\u274C ${error.message}\n`);
      printCliUsage();
    }
    process.exitCode = 1;
    return;
  }

  const isJsonOutput = Boolean(parsedArgs.isJsonOutput);
  const isQuiet = Boolean(parsedArgs.isQuiet);
  const outputFilePath =
    isJsonOutput && parsedArgs.outputPathFromCli ? path.resolve(process.cwd(), parsedArgs.outputPathFromCli) : null;

  try {
    const config = await loadDevGuardConfig(process.cwd());
    const failOn = resolveFailOnLevel({
      failOnFromCli: parsedArgs.failOnFromCli,
      config
    });
    const ignorePaths = resolveIgnorePaths(config);

    if (!parsedArgs.targetPath) {
      if (isJsonOutput) {
        emitJsonOutput({
          value: {
            success: false,
            error: 'Missing scan path'
          },
          outputFilePath
        });
        process.exitCode = 1;
      } else {
        printCliUsage();
        process.exitCode = 1;
      }
      return;
    }

    const scanPath = path.resolve(process.cwd(), parsedArgs.targetPath);
    if (!isJsonOutput && !isQuiet) {
      process.stdout.write(`\u{1F50D} DevGuard Scan Started... (fail-on=${failOn})\n\n`);
    }

    const result = await analyzeProject(scanPath);
    const isValidResult = result && typeof result === 'object' && !Array.isArray(result);
    if (!isValidResult) {
      if (isJsonOutput) {
        const wroteOutput = emitJsonOutput({
          value: { success: false, error: 'Invalid result format' },
          outputFilePath
        });
        if (!wroteOutput) {
          process.exitCode = 1;
          return;
        }
      } else {
        process.stdout.write('\u274C Invalid result format\n');
      }
      process.exitCode = 1;
      return;
    }

    const safeResult = result;
    const summary = safeResult.summary && typeof safeResult.summary === 'object' ? safeResult.summary : {};
    const rawFindings = Array.isArray(safeResult.findings) ? safeResult.findings : [];
    const filteredFindings = filterFindingsByIgnorePaths(rawFindings, ignorePaths);
    const findings = sortFindingsByPriority(filteredFindings);
    const filteredGroupedSource = filterGroupedFindingsByIgnorePaths(
      Array.isArray(safeResult.groupedFindings) ? safeResult.groupedFindings : [],
      ignorePaths
    );
    const groupedFindings = normalizeGroupedFindings(filteredGroupedSource, findings);
    const filteredTopRiskSource = filterTopRisksByIgnorePaths(
      Array.isArray(safeResult.topRisks) ? safeResult.topRisks : [],
      ignorePaths
    );
    const topRisks = normalizeTopRisks(filteredTopRiskSource, findings);
    const severityCounts = normalizeSeverityCounts({}, findings);
    const filesAnalyzed = Number.isInteger(summary.totalFiles) ? summary.totalFiles : 0;
    const issuesFound = findings.length;
    const summaryForOutput = {
      totalFiles: filesAnalyzed,
      issuesFound,
      severity: severityCounts,
      topRisksCount: topRisks.length
    };

    const jsonResult = buildJsonResult({
      safeResult,
      summary: summaryForOutput,
      topRisks,
      groupedFindings
    });

    if (!safeResult.success) {
      const errorMessage =
        typeof safeResult.error === 'string' && safeResult.error.trim().length > 0
          ? safeResult.error
          : 'Project scan failed.';

      if (isJsonOutput) {
        emitJsonOutput({
          value: {
            ...jsonResult,
            error: errorMessage
          },
          outputFilePath
        });
        process.exitCode = 1;
      } else {
        process.stdout.write(`\u274C ${errorMessage}\n`);
        process.exitCode = 1;
      }
      return;
    }

    const gateDecision = buildBuildGateDecision({
      failOn,
      severitySummary: severityCounts,
      issuesFound
    });

    let overrideApplied = false;
    if (gateDecision.shouldFail && parsedArgs.overrideReasonFromCli) {
      try {
        await appendOverrideAuditLog({
          workingDirectory: process.cwd(),
          reason: parsedArgs.overrideReasonFromCli,
          severityCounts: gateDecision.severity,
          topRisks
        });
      } catch (error) {
        const errorMessage = `Failed to write override audit log: ${error.message}`;
        if (isJsonOutput) {
          emitJsonOutput({
            value: {
              success: false,
              error: errorMessage
            },
            outputFilePath
          });
        } else {
          process.stdout.write(`\u274C ${errorMessage}\n`);
        }
        process.exitCode = 1;
        return;
      }

      overrideApplied = true;
    }

    if (isJsonOutput) {
      const wroteOutput = emitJsonOutput({
        value: jsonResult,
        outputFilePath
      });
      process.exitCode = wroteOutput ? 0 : 1;

      if (gateDecision.shouldFail && !overrideApplied && wroteOutput) {
        process.exitCode = 1;
      }
      return;
    }

    if (isQuiet) {
      printMinimalSummary({
        filesAnalyzed,
        issuesFound,
        severityCounts,
        gateDecision,
        overrideApplied
      });
    } else {
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
        printDetailedFindingsSection({
          groupedFindings,
          findings
        });
      }

      printExecutionSection(safeResult.execution);
      printAiSection(safeResult.aiReport);
      process.stdout.write('Tip: Fix HIGH severity issues before deploying.\n');

      if (gateDecision.shouldFail) {
        if (overrideApplied) {
          process.stdout.write(`${gateDecision.warningMessage}\n`);
          process.stdout.write(`\u26A0 Override applied: ${parsedArgs.overrideReasonFromCli}\n`);
        } else {
          process.stdout.write(`${gateDecision.message}\n`);
        }
      }
    }

    if (gateDecision.shouldFail && !overrideApplied) {
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  } catch (error) {
    if (isJsonOutput) {
      emitJsonOutput({
        value: {
          success: false,
          error: error.message
        },
        outputFilePath
      });
      process.exitCode = 1;
    } else {
      process.stdout.write(`\u274C ${error.message}\n`);
      process.exitCode = 1;
    }
  }
};

void run();
