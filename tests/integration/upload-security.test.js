'use strict';

const request = require('supertest');
const { createZipBuffer } = require('../helpers/zip');

jest.mock('../../sandbox/executor', () => ({
  executeSandbox: jest.fn().mockResolvedValue({
    success: false,
    stdout: '',
    stderr: '',
    error: 'Sandbox unavailable in test',
    executionTime: 1
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

describe('upload security protections', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    app = require('../../app');
  });

  test('rejects path traversal in zip entries', async () => {
    const zipBuffer = await createZipBuffer([
      {
        name: '../evil.js',
        content: 'console.log("malicious");'
      }
    ]);

    const response = await request(app)
      .post('/api/upload')
      .attach('file', zipBuffer, {
        filename: 'path-traversal.zip',
        contentType: 'application/zip'
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/unsafe file path/i);
  });

  test('rejects invalid zip payload', async () => {
    const response = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('not-a-zip-content', 'utf8'), {
        filename: 'invalid.zip',
        contentType: 'application/zip'
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/invalid or corrupted zip/i);
  });

  test('rejects oversized zip payload', async () => {
    const oversizedBuffer = Buffer.alloc((10 * 1024 * 1024) + 1, 0x41);

    const response = await request(app)
      .post('/api/upload')
      .attach('file', oversizedBuffer, {
        filename: 'oversized.zip',
        contentType: 'application/zip'
      });

    expect(response.status).toBe(413);
    expect(response.body.message).toMatch(/file too large/i);
  });
});
