'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');

const MAX_SNIPPET_CHARACTERS = 8000;
const MAX_OUTPUT_TOKENS = 500;
const MAX_AI_ATTEMPTS = 2;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const SEVERITY_VALUES = new Set(['low', 'medium', 'high']);
const RETRYABLE_FAILURE_REASONS = new Set(['empty_output', 'json_parse_failed', 'schema_validation_failed']);
const UNRELIABLE_WARNING_MESSAGE = 'AI output may be unreliable. Please review carefully.';
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
        type: 'object',
        additionalProperties: false,
        properties: {
          issue: {
            type: 'string',
            minLength: 1
          },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high']
          },
          confidence: {
            type: 'string',
            enum: ['low', 'medium', 'high']
          }
        },
        required: ['issue', 'severity', 'confidence']
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
let hasLoggedMissingApiKeyWarning = false;

const buildFallbackExplanation = () => ({
  summary: 'Unable to generate reliable debugger analysis for this snippet right now.',
  issues: [],
  fixes: [],
  aiReliable: false,
  fallbackUsed: true,
  warning: UNRELIABLE_WARNING_MESSAGE
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
    if (!hasLoggedMissingApiKeyWarning) {
      logger.warn('OpenAI API key is not configured. AI analysis is disabled.', {
        aiDisabled: true
      });
      hasLoggedMissingApiKeyWarning = true;
    }
    return null;
  }

  hasLoggedMissingApiKeyWarning = false;
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

const buildSystemPrompt = (strictRetry) => {
  const retryInstruction = strictRetry
    ? 'STRICT RETRY MODE: previous output was invalid; output must be valid JSON only.'
    : '';

  return [
    'You are DevGuard AI in strict backend debugger mode.',
    'Return exactly one JSON object and nothing else.',
    'Do not output markdown, code fences, comments, or any prose outside the JSON object.',
    'Use only these top-level keys: "summary", "issues", "fixes".',
    '"issues" must be an array of objects with keys "issue", "severity", "confidence".',
    '"fixes" must be an array of strings.',
    '"severity" and "confidence" values must be one of: low, medium, high.',
    'Do not alter, remove, or re-grade static security scanner findings; only add explanations and suggested fixes.',
    retryInstruction
  ]
    .filter(Boolean)
    .join(' ');
};

const buildUserPrompt = (trimmedSnippet, strictRetry) => {
  const retryLine = strictRetry ? 'Retry: previous response failed strict JSON validation.' : 'Analyze this code snippet.';

  return [
    retryLine,
    'Return a JSON object that matches the schema exactly and has no extra keys.',
    'If no issues are found, return: {"summary":"No obvious issues found.","issues":[],"fixes":[]}.',
    '',
    trimmedSnippet
  ].join('\n');
};

const normalizeIssueObject = (issueValue) => {
  if (typeof issueValue === 'string') {
    const normalizedIssueText = issueValue.trim();
    if (!normalizedIssueText) {
      return null;
    }

    return {
      issue: normalizedIssueText,
      severity: 'medium',
      confidence: 'low'
    };
  }

  if (!issueValue || typeof issueValue !== 'object' || Array.isArray(issueValue)) {
    return null;
  }

  if (typeof issueValue.issue !== 'string' || issueValue.issue.trim().length === 0) {
    return null;
  }

  const severity = typeof issueValue.severity === 'string' ? issueValue.severity.toLowerCase() : '';
  const confidence = typeof issueValue.confidence === 'string' ? issueValue.confidence.toLowerCase() : '';

  if (!SEVERITY_VALUES.has(severity) || !SEVERITY_VALUES.has(confidence)) {
    return null;
  }

  return {
    issue: issueValue.issue.trim(),
    severity,
    confidence
  };
};

const normalizeStructuredExplanation = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    return null;
  }

  if (!Array.isArray(value.issues) || !isStringArray(value.fixes)) {
    return null;
  }

  const normalizedIssues = [];
  for (const issueValue of value.issues) {
    const normalizedIssue = normalizeIssueObject(issueValue);
    if (!normalizedIssue) {
      return null;
    }
    normalizedIssues.push(normalizedIssue);
  }

  return {
    summary: value.summary.trim(),
    issues: normalizedIssues,
    fixes: value.fixes.map((fix) => fix.trim()).filter(Boolean)
  };
};

const buildReliableResponse = (normalizedOutput) => {
  const totalIssues = normalizedOutput.issues.length;
  const lowConfidenceIssues = normalizedOutput.issues.filter((issue) => issue.confidence === 'low').length;
  const aiReliable = totalIssues === 0 || lowConfidenceIssues <= totalIssues / 2;

  if (!aiReliable) {
    return {
      ...normalizedOutput,
      aiReliable: false,
      fallbackUsed: false,
      warning: UNRELIABLE_WARNING_MESSAGE
    };
  }

  return {
    ...normalizedOutput,
    aiReliable: true,
    fallbackUsed: false
  };
};

const requestStructuredExplanation = async ({ client, trimmedSnippet, attemptNumber }) => {
  const strictRetry = attemptNumber > 1;

  let response;
  try {
    response = await client.responses.create({
      model: DEFAULT_MODEL,
      input: [
        {
          role: 'system',
          content: buildSystemPrompt(strictRetry)
        },
        {
          role: 'user',
          content: buildUserPrompt(trimmedSnippet, strictRetry)
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
      max_output_tokens: MAX_OUTPUT_TOKENS
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'openai_request_failed',
      error
    };
  }

  const outputText = extractExplanationText(response);
  if (!outputText) {
    return {
      ok: false,
      reason: 'empty_output'
    };
  }

  let parsedOutput;
  try {
    parsedOutput = JSON.parse(outputText);
  } catch (error) {
    return {
      ok: false,
      reason: 'json_parse_failed',
      error
    };
  }

  const normalizedOutput = normalizeStructuredExplanation(parsedOutput);
  if (!normalizedOutput) {
    return {
      ok: false,
      reason: 'schema_validation_failed'
    };
  }

  return {
    ok: true,
    normalizedOutput
  };
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
  if (!client) {
    logger.warn('AI analysis skipped because OpenAI API key is missing.', {
      aiSkipped: true,
      reason: 'missing_api_key'
    });
    return buildFallbackExplanation();
  }

  let attemptsUsed = 0;
  let lastFailureReason = 'unknown';

  for (let attemptNumber = 1; attemptNumber <= MAX_AI_ATTEMPTS; attemptNumber += 1) {
    attemptsUsed = attemptNumber;
    const attemptResult = await requestStructuredExplanation({
      client,
      trimmedSnippet,
      attemptNumber
    });

    if (attemptResult.ok) {
      logger.info('AI structured response validated', {
        attemptNumber,
        retryAttempts: attemptNumber - 1,
        issues: attemptResult.normalizedOutput.issues.length,
        fixes: attemptResult.normalizedOutput.fixes.length
      });
      return buildReliableResponse(attemptResult.normalizedOutput);
    }

    lastFailureReason = attemptResult.reason;
    logger.warn('AI structured response attempt failed', {
      attemptNumber,
      reason: attemptResult.reason,
      errorMessage: attemptResult.error ? attemptResult.error.message : undefined
    });

    const shouldRetry =
      attemptNumber < MAX_AI_ATTEMPTS && RETRYABLE_FAILURE_REASONS.has(attemptResult.reason);

    if (shouldRetry) {
      logger.info('Retrying AI request with stricter prompt', {
        nextAttempt: attemptNumber + 1,
        previousFailureReason: attemptResult.reason
      });
      continue;
    }

    if (attemptResult.reason === 'openai_request_failed') {
      logger.error('OpenAI explainCode request failed', {
        statusCode:
          attemptResult.error && typeof attemptResult.error.status === 'number'
            ? attemptResult.error.status
            : undefined,
        code: attemptResult.error ? attemptResult.error.code : undefined,
        errorMessage: attemptResult.error ? attemptResult.error.message : undefined
      });
    }

    break;
  }

  logger.warn('AI fallback engaged after validation failure', {
    fallbackUsed: true,
    attemptsUsed,
    lastFailureReason
  });
  return buildFallbackExplanation();
};

module.exports = {
  explainCode
};
