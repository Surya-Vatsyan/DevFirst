'use strict';

const request = require('supertest');
const { createZipBuffer } = require('../helpers/zip');

jest.mock('../../sandbox/executor', () => ({
  executeSandbox: jest.fn().mockResolvedValue({
    success: true,
    stdout: 'Hello from sandbox',
    stderr: '',
    error: null,
    executionTime: 42
  })
}));

jest.mock('../../src/services/ai-orchestrator.service', () => ({
  runDebuggerPipeline: jest.fn().mockResolvedValue({
    summary: 'AI disabled in tests',
    summaryStats: { high: 0, medium: 0, low: 0 },
    issues: [],
    files: [],
    fixes: [],
    aiUsed: false,
    fallbackUsed: true
  })
}));

describe('end-to-end upload flow', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    app = require('../../app');
  });

  test('returns normalized report for valid project upload', async () => {
    const zipBuffer = await createZipBuffer([
      {
        name: 'index.js',
        content: 'console.log("Hello");'
      },
      {
        name: 'src/util.js',
        content: 'module.exports = 1;'
      }
    ]);

    const response = await request(app)
      .post('/api/upload')
      .set('x-forwarded-for', '192.0.2.50')
      .attach('file', zipBuffer, {
        filename: 'sample-project.zip',
        contentType: 'application/zip'
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toBeDefined();
    expect(response.body.data.report).toBeDefined();
    expect(response.body.data.report.totalFiles).toBe(2);
    expect(response.body.data.report.execution).toBeDefined();
    expect(response.body.data.report.execution.attempted).toBe(true);
    expect(response.body.data.report.execution.success).toBe(true);
    expect(response.body.data.report.execution.stdout).toContain('Hello from sandbox');
    expect(response.body.data.report.securitySummary).toBeDefined();
  });
});
