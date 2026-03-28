'use strict';

const request = require('supertest');

describe('rate limiting', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    app = require('../../app');
  });

  test('returns 429 after exceeding 10 requests per minute per IP', async () => {
    const testIp = '203.0.113.10';

    for (let index = 0; index < 10; index += 1) {
      const response = await request(app)
        .get('/not-found')
        .set('x-forwarded-for', testIp);

      expect(response.status).toBe(404);
    }

    const rateLimitedResponse = await request(app)
      .get('/not-found')
      .set('x-forwarded-for', testIp);

    expect(rateLimitedResponse.status).toBe(429);
    expect(rateLimitedResponse.body.message).toMatch(/rate limit exceeded/i);
  });
});
