const request = require('supertest');
const version = require('../src/version.json');
const { createHarness } = require('./helpers/harness.js');

const h = createHarness();
beforeAll(h.start);
beforeEach(h.reset);

describe('shell', () => {
  test('GET / welcomes with the version', async () => {
    const res = await request(h.app).get('/');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'welcome to JWT Pizza', version: version.version });
  });

  test.each(['/nope', '/api/nope'])('%s responds 404 unknown endpoint', async (path) => {
    const res = await request(h.app).get(path);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'unknown endpoint' });
  });

  test('CORS echoes the request origin', async () => {
    const res = await request(h.app).get('/').set('Origin', 'https://pizza.test');

    expect(res.headers['access-control-allow-origin']).toBe('https://pizza.test');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });

  test('CORS allows any origin when none is sent', async () => {
    const res = await request(h.app).get('/');

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('a malformed JSON body responds 400', async () => {
    const res = await request(h.app).post('/api/auth').set('Content-Type', 'application/json').send('{not json');

    expect(res.status).toBe(400);
  });
});

describe('docs', () => {
  test("lists the version and every router's endpoints", async () => {
    const res = await request(h.app).get('/api/docs');

    const paths = res.body.endpoints.map((e) => e.path);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version.version);
    expect(paths).toEqual(expect.arrayContaining(['/api/auth', '/api/user/me', '/api/order/menu', '/api/franchise/:franchiseId']));
  });
});

describe('error handler', () => {
  test('reports a known error with its status and message', async () => {
    const diner = await h.register();

    const res = await request(h.app).put('/api/order/menu').set(diner.headers).send({});

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to add menu item');
  });

  test('reports an unexpected error as 500 with its message and no stack trace', async () => {
    const diner = await h.register();

    const res = await request(h.app)
      .post('/api/order')
      .set(diner.headers)
      .send({ franchiseId: 1, storeId: 1, items: [{ menuId: 9999, description: 'x', price: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('No ID found');
    expect(res.body).not.toHaveProperty('stack');
  });
});

describe('authentication wiring', () => {
  test.each([
    ['PUT', '/api/order/menu'],
    ['GET', '/api/order'],
    ['POST', '/api/order'],
    ['GET', '/api/user'],
    ['GET', '/api/user/me'],
    ['PUT', '/api/user/1'],
    ['GET', '/api/franchise/1'],
    ['POST', '/api/franchise'],
    ['DELETE', '/api/franchise/1'],
    ['POST', '/api/franchise/1/store'],
    ['DELETE', '/api/franchise/1/store/1'],
    ['DELETE', '/api/auth'],
  ])('%s %s responds 401 without a token', async (method, path) => {
    const res = await request(h.app)[method.toLowerCase()](path).send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
  });
});
