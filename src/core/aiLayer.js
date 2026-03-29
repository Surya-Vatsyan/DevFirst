'use strict';

const fsPromises = require('fs/promises');
const aiService = require('../services/ai.service');
const { buildDefaultAiReport } = require('./resultBuilder');

const MAX_AI_FILES = 5;
const MAX_AI_SNIPPET_CHARACTERS = 8000;
const MAX_AI_FILE_CHARACTERS = 8000;
const MAX_AI_TOTAL_CHARACTERS = 32000;
const AI_CALL_TIMEOUT_MS = 5000;
const AI_TIMEOUT_ERROR = 'AI analysis timed out';

const executeWithTimeout = async (taskFunction, timeoutMs, timeoutMessage) => {
  let timeoutHandle;

  return new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    Promise.resolve()
      .then(taskFunction)
      .then((result) => {
        clearTimeout(timeoutHandle);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
  });
};

const buildAiSnippet = ({ relativePath, fileContent }) => {
  const prefix = `// file: ${relativePath}\n`;
  const maxBodyLength = Math.max(0, MAX_AI_SNIPPET_CHARACTERS - prefix.length);
  return `${prefix}${fileContent.slice(0, maxBodyLength)}`;
};

const runAiLayer = async (jsFileEntries) => {
  const aiReport = buildDefaultAiReport();
  const targetFiles = jsFileEntries.slice(0, MAX_AI_FILES);
  const uniqueFixes = new Set();
  let aiCalls = 0;
  let nonFallbackCalls = 0;
  let totalAiCharacters = 0;

  if (targetFiles.length === 0) {
    aiReport.summary = 'No JavaScript files available for AI analysis.';
    return aiReport;
  }

  if (!process.env.OPENAI_API_KEY) {
    aiReport.summary = 'AI analysis skipped: OPENAI_API_KEY is not configured.';
    return aiReport;
  }

  for (const fileEntry of targetFiles) {
    let fileContent;
    try {
      fileContent = await fsPromises.readFile(fileEntry.absolutePath, 'utf8');
    } catch (error) {
      aiReport.errors.push(`Failed to read ${fileEntry.relativePath}: ${error.message}`);
      continue;
    }

    if (!fileContent.trim()) {
      continue;
    }

    if (fileContent.length > MAX_AI_FILE_CHARACTERS) {
      aiReport.errors.push(`AI input rejected for ${fileEntry.relativePath}: file content too large`);
      continue;
    }

    const snippet = buildAiSnippet({
      relativePath: fileEntry.relativePath,
      fileContent
    });

    if (totalAiCharacters + snippet.length > MAX_AI_TOTAL_CHARACTERS) {
      aiReport.errors.push('AI input rejected: total input size limit exceeded');
      break;
    }

    try {
      const aiResult = await executeWithTimeout(() => aiService.explainCode(snippet), AI_CALL_TIMEOUT_MS, AI_TIMEOUT_ERROR);
      totalAiCharacters += snippet.length;

      aiCalls += 1;
      if (!aiResult.fallbackUsed) {
        nonFallbackCalls += 1;
      }

      for (const fix of Array.isArray(aiResult.fixes) ? aiResult.fixes : []) {
        uniqueFixes.add(fix);
      }

      aiReport.files.push({
        file: fileEntry.relativePath,
        summary: typeof aiResult.summary === 'string' ? aiResult.summary : '',
        issues: Array.isArray(aiResult.issues) ? aiResult.issues : [],
        fixes: Array.isArray(aiResult.fixes) ? aiResult.fixes : [],
        aiReliable: Boolean(aiResult.aiReliable),
        fallbackUsed: Boolean(aiResult.fallbackUsed),
        warning: typeof aiResult.warning === 'string' ? aiResult.warning : ''
      });
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message === AI_TIMEOUT_ERROR) {
        aiReport.errors.push(`AI analysis timed out for ${fileEntry.relativePath}`);
      } else {
        aiReport.errors.push(`AI analysis failed for ${fileEntry.relativePath}: ${error.message}`);
      }
    }
  }

  aiReport.fixes = Array.from(uniqueFixes);
  aiReport.aiUsed = nonFallbackCalls > 0;
  aiReport.fallbackUsed = aiCalls > nonFallbackCalls;
  aiReport.summary = `Analyzed ${targetFiles.length} file(s) for AI explanations.`;

  return aiReport;
};

module.exports = {
  runAiLayer
};
