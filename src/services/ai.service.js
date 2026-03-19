'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');

const MAX_SNIPPET_CHARACTERS = 8000;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const EXPLANATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      minLength: 1
    },
    issues: {
      type: 'array',
      items: {
        type: 'string'
      }
    },
    fixes: {
      type: 'array',
      items: {
        type: 'string'
      }
    }
  },
  required: ['summary', 'issues', 'fixes']
};

let openAIClient;

const buildFallbackExplanation = () => ({
  summary: 'Unable to generate reliable debugger analysis for this snippet right now.',
  issues: ['AI response could not be validated as structured JSON.'],
  fixes: ['Try again with a smaller, focused snippet.']
});

const throwBadRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

const getClient = () => {
  if (openAIClient) {
    return openAIClient;
  }

  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OpenAI API key is not configured');
    error.statusCode = 500;
    throw error;
  }

  openAIClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  return openAIClient;
};

const extractExplanationText = (response) => {
  if (response && typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  if (Array.isArray(response.output)) {
    for (const outputItem of response.output) {
      if (!outputItem || !Array.isArray(outputItem.content)) {
        continue;
      }

      for (const contentItem of outputItem.content) {
        if (contentItem && contentItem.type === 'output_text' && typeof contentItem.text === 'string') {
          const trimmedText = contentItem.text.trim();
          if (trimmedText) {
            return trimmedText;
          }
        }
      }
    }
  }

  return '';
};

const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

const validateStructuredExplanation = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    return false;
  }

  if (!isStringArray(value.issues) || !isStringArray(value.fixes)) {
    return false;
  }

  return true;
};

const explainCode = async (codeSnippet) => {
  if (typeof codeSnippet !== 'string') {
    throwBadRequest('codeSnippet must be a string');
  }

  const trimmedSnippet = codeSnippet.trim();
  if (!trimmedSnippet) {
    throwBadRequest('codeSnippet is required');
  }

  if (trimmedSnippet.length > MAX_SNIPPET_CHARACTERS) {
    throwBadRequest(`codeSnippet must be ${MAX_SNIPPET_CHARACTERS} characters or fewer`);
  }

  const client = getClient();

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      input: [
        {
          role: 'system',
          content:
            'You are a senior backend developer in debugger mode. Return only JSON with bug analysis and fixes. ' +
            'Do not include markdown, prose, or extra keys.'
        },
        {
          role: 'user',
          content:
            `Analyze this code snippet and return a JSON object with exactly these keys: ` +
            `"summary" (string), "issues" (string array), "fixes" (string array).\n\n${trimmedSnippet}`
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'code_explanation',
          strict: true,
          schema: EXPLANATION_SCHEMA
        }
      },
      max_output_tokens: 500
    });

    const outputText = extractExplanationText(response);
    if (!outputText) {
      logger.warn('AI returned empty structured response', {
        fallbackUsed: true
      });
      return buildFallbackExplanation();
    }

    let parsedOutput;
    try {
      parsedOutput = JSON.parse(outputText);
    } catch (error) {
      logger.warn('AI returned non-JSON response', {
        fallbackUsed: true,
        errorMessage: error.message
      });
      return buildFallbackExplanation();
    }

    if (!validateStructuredExplanation(parsedOutput)) {
      logger.warn('AI returned invalid structured response shape', {
        fallbackUsed: true
      });
      return buildFallbackExplanation();
    }

    return {
      summary: parsedOutput.summary.trim(),
      issues: parsedOutput.issues,
      fixes: parsedOutput.fixes
    };
  } catch (error) {
    logger.error('OpenAI explainCode request failed', {
      statusCode: typeof error.status === 'number' ? error.status : undefined,
      code: error.code,
      errorMessage: error.message
    });

    return buildFallbackExplanation();
  }
};

module.exports = {
  explainCode
};
