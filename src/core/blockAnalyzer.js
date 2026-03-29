'use strict';

const fsPromises = require('fs/promises');
const securityScanner = require('../services/securityScanner');
const {
  normalizeLineNumber,
  normalizeFinding,
  injectFunctionContext,
  extractCodeSnippet
} = require('./findingEnricher');

const FUNCTION_DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const FUNCTION_EXPRESSION_ASSIGNMENT_PATTERN =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/;
const ARROW_FUNCTION_ASSIGNMENT_PATTERN =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const CLASS_DECLARATION_PATTERN = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/;
const CLASS_METHOD_PATTERN = /^\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
const CLASS_METHOD_EXCLUSIONS = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch']);

const countBraceDelta = (line) => {
  if (typeof line !== 'string' || line.length === 0) {
    return 0;
  }

  let delta = 0;
  for (const character of line) {
    if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }

  return delta;
};

const findBlockEndLine = (lines, startLine) => {
  if (!Array.isArray(lines) || !Number.isInteger(startLine) || startLine <= 0 || startLine > lines.length) {
    return startLine;
  }

  const startIndex = startLine - 1;
  const startText = lines[startIndex] || '';
  if (!startText.includes('{')) {
    return startLine;
  }

  let braceBalance = 0;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    braceBalance += countBraceDelta(lines[lineIndex]);
    if (braceBalance <= 0 && lineIndex > startIndex) {
      return lineIndex + 1;
    }
  }

  return lines.length;
};

const buildFunctionBlocks = (fileContent) => {
  if (typeof fileContent !== 'string' || fileContent.length === 0) {
    return [];
  }

  const lines = fileContent.split(/\r?\n/);
  const blocks = [];
  const consumedLines = new Set();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (consumedLines.has(lineIndex + 1)) {
      continue;
    }

    const line = lines[lineIndex] || '';
    const startLine = lineIndex + 1;
    let functionName = null;

    const declarationMatch = line.match(FUNCTION_DECLARATION_PATTERN);
    if (declarationMatch) {
      functionName = declarationMatch[1];
    }

    if (!functionName) {
      const expressionMatch = line.match(FUNCTION_EXPRESSION_ASSIGNMENT_PATTERN);
      if (expressionMatch) {
        functionName = expressionMatch[1];
      }
    }

    if (!functionName) {
      const arrowMatch = line.match(ARROW_FUNCTION_ASSIGNMENT_PATTERN);
      if (arrowMatch) {
        functionName = arrowMatch[1];
      }
    }

    if (!functionName) {
      const classMatch = line.match(CLASS_DECLARATION_PATTERN);
      if (classMatch) {
        const className = classMatch[1];
        const classStartLine = startLine;
        const classEndLine = findBlockEndLine(lines, classStartLine);

        for (let classLineIndex = classStartLine; classLineIndex <= classEndLine; classLineIndex += 1) {
          const classLine = lines[classLineIndex - 1] || '';
          const methodMatch = classLine.match(CLASS_METHOD_PATTERN);
          if (!methodMatch) {
            continue;
          }

          const methodName = methodMatch[1];
          if (CLASS_METHOD_EXCLUSIONS.has(methodName)) {
            continue;
          }

          const methodStartLine = classLineIndex;
          const methodEndLine = findBlockEndLine(lines, methodStartLine);
          if (methodEndLine < methodStartLine) {
            continue;
          }

          for (let consumedLine = methodStartLine; consumedLine <= methodEndLine; consumedLine += 1) {
            consumedLines.add(consumedLine);
          }

          blocks.push({
            functionName: `${className}.${methodName}`,
            startLine: methodStartLine,
            endLine: methodEndLine
          });
        }

        lineIndex = Math.max(lineIndex, classEndLine - 1);
      }

      continue;
    }

    const endLine = findBlockEndLine(lines, startLine);
    for (let consumedLine = startLine; consumedLine <= endLine; consumedLine += 1) {
      consumedLines.add(consumedLine);
    }

    blocks.push({
      functionName,
      startLine,
      endLine
    });
  }

  return blocks.sort((leftBlock, rightBlock) => leftBlock.startLine - rightBlock.startLine);
};

const runStaticSecurityAnalysis = async (jsFileEntries) => {
  const findings = [];
  const readErrors = [];

  for (const fileEntry of jsFileEntries) {
    let fileContent;
    try {
      fileContent = await fsPromises.readFile(fileEntry.absolutePath, 'utf8');
    } catch (error) {
      readErrors.push(`Failed to read ${fileEntry.relativePath}: ${error.message}`);
      continue;
    }

    const fileLines = fileContent.split(/\r?\n/);
    const segmentedBlocks = buildFunctionBlocks(fileContent);
    const blocksToAnalyze =
      segmentedBlocks.length > 0
        ? segmentedBlocks
        : [
            {
              functionName: 'global',
              startLine: 1,
              endLine: fileLines.length > 0 ? fileLines.length : 1
            }
          ];

    for (const block of blocksToAnalyze) {
      const blockContent = fileLines.slice(block.startLine - 1, block.endLine).join('\n');
      const blockFindings = securityScanner.scanFile({
        filePath: fileEntry.relativePath,
        fileContent: blockContent
      });

      findings.push(
        ...blockFindings.map((finding) => {
          const normalizedLine = normalizeLineNumber(finding.line);
          const absoluteLine = normalizedLine > 0 ? normalizedLine + block.startLine - 1 : finding.line;

          return normalizeFinding({
            ...finding,
            line: absoluteLine,
            functionName: block.functionName || 'global',
            context: injectFunctionContext(finding.context, block.functionName || 'global'),
            codeSnippet: extractCodeSnippet(fileContent, absoluteLine)
          });
        })
      );
    }
  }

  return {
    findings,
    readErrors
  };
};

module.exports = {
  buildFunctionBlocks,
  runStaticSecurityAnalysis
};
