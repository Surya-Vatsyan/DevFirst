'use strict';

const aiService = require('../services/ai.service');
const logger = require('../utils/logger');

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

    res.status(200).json({
      success: true,
      data: debuggerOutput,
      requestId: req.requestId
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  explainCodeSnippet
};
