'use strict';

const { detectEntryFile } = require('../../utils/entryDetector');
const { validateProjectPath, collectFilesRecursively, buildJsFileEntries } = require('./fileCollector');
const { runStaticSecurityAnalysis } = require('./blockAnalyzer');
const { runSandboxStage } = require('./executionEngine');
const { runAiLayer } = require('./aiLayer');
const {
  buildDefaultSummary,
  buildDefaultExecution,
  buildDefaultAiReport,
  buildSeveritySummary,
  dedupeFindings,
  buildExecutionInsightFinding,
  normalizeResult
} = require('./resultBuilder');

async function analyzeProject(projectPath) {
  const fallbackResult = normalizeResult({
    success: false,
    error: null,
    summary: buildDefaultSummary(),
    findings: [],
    execution: buildDefaultExecution(),
    aiReport: buildDefaultAiReport()
  });

  try {
    const resolvedProjectPath = await validateProjectPath(projectPath);
    const allFiles = await collectFilesRecursively(resolvedProjectPath);
    const jsFileEntries = buildJsFileEntries(resolvedProjectPath, allFiles);
    const { findings, readErrors } = await runStaticSecurityAnalysis(jsFileEntries);
    const entryFile = detectEntryFile(jsFileEntries.map((fileEntry) => fileEntry.relativePath));
    const execution = await runSandboxStage({
      projectPath: resolvedProjectPath,
      entryFile
    });
    const executionInsightFinding = buildExecutionInsightFinding(execution);
    const mergedFindings = executionInsightFinding ? dedupeFindings([...findings, executionInsightFinding]) : findings;
    const aiReport = await runAiLayer(jsFileEntries);

    if (readErrors.length > 0) {
      aiReport.errors.push(...readErrors);
    }

    return normalizeResult({
      success: true,
      error: null,
      summary: {
        totalFiles: jsFileEntries.length,
        issuesFound: mergedFindings.length,
        severity: buildSeveritySummary(mergedFindings)
      },
      findings: mergedFindings,
      execution,
      aiReport
    });
  } catch (error) {
    fallbackResult.aiReport.summary = 'Project analysis failed.';
    fallbackResult.aiReport.errors.push(error.message);
    fallbackResult.success = false;
    fallbackResult.error = error.message;
    return normalizeResult(fallbackResult);
  }
}

module.exports = {
  analyzeProject
};
