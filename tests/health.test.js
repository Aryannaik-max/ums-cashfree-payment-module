const request = require('supertest');

// Test-only env so config validation passes without a real .env.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://ums:ums@localhost:5432/ums_payments',
  CASHFREE_CLIENT_ID: 'test',
  CASHFREE_CLIENT_SECRET: 'test',
  CASHFREE_ENV: 'SANDBOX',
  CASHFREE_API_VERSION: 'test',
  APP_BASE_URL: 'http://localhost:3000',
});

const app = require('../src/app');

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
