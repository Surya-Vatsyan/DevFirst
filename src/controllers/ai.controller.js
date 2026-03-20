'use strict';

const aiService = require('../services/ai.service');
const logger = require('../utils/logger');

const SEVERITY_PRIORITY = {
  high: 3,
  medium: 2,
  low: 1
};

const sortIssuesBySeverity = (issues) => {
  if (!Array.isArray(issues)) {
    return [];
  }

  return [...issues].sort((leftIssue, rightIssue) => {
    const leftSeverity = leftIssue && typeof leftIssue.severity === 'string' ? leftIssue.severity.toLowerCase() : 'low';
    const rightSeverity = rightIssue && typeof rightIssue.severity === 'string' ? rightIssue.severity.toLowerCase() : 'low';

    return (SEVERITY_PRIORITY[rightSeverity] || 0) - (SEVERITY_PRIORITY[leftSeverity] || 0);
  });
};

const explainCodeSnippet = async (req, res, next) => {
  try {
    const codeSnippet = req.body ? req.body.codeSnippet : undefined;

    if (typeof codeSnippet !== 'string' || codeSnippet.trim().length === 0) {
      const error = new Error('codeSnippet is required');
      error.statusCode = 400;
      throw error;
    }

    logger.info('Code explanation requested', {
      requestId: req.requestId,
      snippetLength: codeSnippet.length
    });

    const debuggerOutput = await aiService.explainCode(codeSnippet);
    const responseData = {
      summary: debuggerOutput.summary,
      issues: sortIssuesBySeverity(debuggerOutput.issues),
      fixes: debuggerOutput.fixes,
      aiReliable: debuggerOutput.aiReliable
    };

    if (!debuggerOutput.aiReliable && typeof debuggerOutput.warning === 'string') {
      responseData.warning = debuggerOutput.warning;
    }

    res.status(200).json({
      success: true,
      data: responseData,
      requestId: req.requestId
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  explainCodeSnippet
};
