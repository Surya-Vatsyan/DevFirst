'use strict';

const request = require('supertest');
const { spawn } = require('child_process');
const { createZipBuffer } = require('../helpers/zip');
const { createFakeChildProcess, createCleanupChildProcess } = require('../helpers/fake-child-process');

jest.mock('child_process', () => ({
  spawn: jest.fn()
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

describe('concurrency queue behavior', () => {
  let app;
  let activeRuns;
  let maxConcurrentRuns;

  beforeEach(() => {
    jest.resetModules();
    spawn.mockReset();
    activeRuns = 0;
    maxConcurrentRuns = 0;

    spawn.mockImplementation((_command, args) => {
      if (args[0] === 'run') {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);

        const runChild = createFakeChildProcess();
        setTimeout(() => {
          activeRuns -= 1;
          runChild.stdout.emit('data', Buffer.from('ok'));
          runChild.emit('close', 0, null);
        }, 80);
        return runChild;
      }

      return createCleanupChildProcess();
    });

    app = require('../../app');
  });

  test('handles parallel uploads without crashing and respects queue cap', async () => {
    const zipBuffer = await createZipBuffer([
      {
        name: 'index.js',
        content: 'console.log("parallel");'
      }
    ]);

    const uploadRequests = Array.from({ length: 6 }, (_value, index) =>
      request(app)
        .post('/api/upload')
        .set('x-forwarded-for', `198.51.100.${index + 1}`)
        .attach('file', Buffer.from(zipBuffer), {
          filename: `parallel-${index}.zip`,
          contentType: 'application/zip'
        })
    );

    const responses = await Promise.all(uploadRequests);

    for (const response of responses) {
      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.report.execution).toBeDefined();
    }

    expect(maxConcurrentRuns).toBeLessThanOrEqual(3);
  });
});
