const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config.js');
const version = require('../src/version.json');
const { createApp } = require('../src/service.js');
const { StatusCodeError } = require('../src/endpointHelper.js');
const { createFakeDb } = require('./helpers/fakeDb.js');
const { makeDiner, makeAdmin } = require('./helpers/fixtures.js');
const { signToken } = require('./helpers/tokens.js');

function buildApp(dbImpls = {}, createOrderImpl) {
  const db = createFakeDb({ isLoggedIn: async () => true, ...dbImpls });
  const factoryClient = { createOrder: jest.fn(createOrderImpl ?? (async () => ({ ok: true, body: {} }))) };
  return { app: createApp({ db, factoryClient }), db, factoryClient };
}

const authHeader = (user) => ({ Authorization: `Bearer ${signToken(user)}` });

describe('shell', () => {
  test('GET / welcomes with the version', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'welcome to JWT Pizza', version: version.version });
  });

  test.each(['/nope', '/api/nope'])('%s responds 404 unknown endpoint', async (path) => {
    const { app } = buildApp();
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'unknown endpoint' });
  });

  test('CORS echoes the request origin', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/').set('Origin', 'https://pizza.test');
    expect(res.headers['access-control-allow-origin']).toBe('https://pizza.test');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });

  test('CORS allows any origin when none is sent', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('a malformed JSON body responds 400', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/auth').set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(400);
  });
});

describe('docs', () => {
  test('lists the version and every router\'s endpoints', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/docs');
    const paths = res.body.endpoints.map((e) => e.path);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version.version);
    expect(paths).toEqual(expect.arrayContaining(['/api/auth', '/api/user/me', '/api/order/menu', '/api/franchise/:franchiseId']));
  });

  // BUG (docs leak): the response exposes the DB host and the factory URL.
  test('does not expose server configuration', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/docs');
    expect(res.body).not.toHaveProperty('config');
  });
});

describe('error handler', () => {
  test('reports a known error with its status and message', async () => {
    const { app } = buildApp();
    const res = await request(app).put('/api/order/menu').set(authHeader(makeDiner(2))).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to add menu item');
  });

  test('reports an unexpected error as 500 with its message', async () => {
    const { app } = buildApp({
      getMenu: async () => {
        throw new Error('boom');
      },
    });
    const res = await request(app).get('/api/order/menu');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });

  // BUG (stack leak): the handler returns err.stack to clients.
  test('does not return a stack trace to the client', async () => {
    const { app } = buildApp({
      getMenu: async () => {
        throw new Error('boom');
      },
    });
    const res = await request(app).get('/api/order/menu');
    expect(res.body).not.toHaveProperty('stack');
  });
});

describe('authentication wiring', () => {
  test.each([
    ['PUT', '/api/order/menu'],
    ['GET', '/api/order'],
    ['POST', '/api/order'],
    ['GET', '/api/user/me'],
    ['PUT', '/api/user/1'],
    ['GET', '/api/franchise/1'],
    ['POST', '/api/franchise'],
    ['POST', '/api/franchise/1/store'],
    ['DELETE', '/api/franchise/1/store/1'],
    ['DELETE', '/api/auth'],
  ])('%s %s responds 401 without a token', async (method, path) => {
    const { app } = buildApp();
    const res = await request(app)[method.toLowerCase()](path).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
  });

  test('a revoked token is rejected', async () => {
    const { app } = buildApp({ isLoggedIn: async () => false });
    const res = await request(app).get('/api/user/me').set(authHeader(makeDiner(2)));
    expect(res.status).toBe(401);
  });

  test('a valid token reaches the user profile without a role helper', async () => {
    const diner = makeDiner(2);
    const { app } = buildApp();
    const res = await request(app).get('/api/user/me').set(authHeader(diner));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 2, name: diner.name, email: diner.email, roles: diner.roles });
    expect(res.body).not.toHaveProperty('password');
  });

  test('an ordinary user cannot update another user', async () => {
    const { app, db } = buildApp();
    const res = await request(app).put('/api/user/9').set(authHeader(makeDiner(2))).send({ name: 'Hacked' });
    expect(res.status).toBe(403);
    expect(db.updateUser).not.toHaveBeenCalled();
  });
});

describe('franchise deletion access (BUG: unauthenticated delete)', () => {
  test('anonymous callers get 401 and nothing is deleted', async () => {
    const { app, db } = buildApp();
    const res = await request(app).delete('/api/franchise/1');
    expect(res.status).toBe(401);
    expect(db.deleteFranchise).not.toHaveBeenCalled();
  });

  test('a diner gets 403 and nothing is deleted', async () => {
    const { app, db } = buildApp();
    const res = await request(app).delete('/api/franchise/1').set(authHeader(makeDiner(2)));
    expect(res.status).toBe(403);
    expect(db.deleteFranchise).not.toHaveBeenCalled();
  });

  test('an admin can delete a franchise', async () => {
    const { app, db } = buildApp({ deleteFranchise: async () => {} });
    const res = await request(app).delete('/api/franchise/1').set(authHeader(makeAdmin(1)));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'franchise deleted' });
    expect(db.deleteFranchise).toHaveBeenCalledWith(1);
  });
});

describe('API flows', () => {
  const diner = makeDiner(12);

  test('register returns a user and a token that verifies for that user', async () => {
    const created = { id: 12, name: 'New', email: 'new@test.com', roles: [{ role: 'diner' }] };
    const { app, db } = buildApp({ addUser: async () => created, loginUser: async () => {} });

    const res = await request(app).post('/api/auth').send({ name: 'New', email: 'new@test.com', password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(created);
    expect(jwt.verify(res.body.token, config.jwtSecret)).toMatchObject({ id: 12, email: 'new@test.com' });
    expect(db.loginUser).toHaveBeenCalledWith(12, res.body.token);
  });

  test('register without a password responds 400 and writes nothing', async () => {
    const { app, db } = buildApp();
    const res = await request(app).post('/api/auth').send({ name: 'New', email: 'new@test.com' });
    expect(res.status).toBe(400);
    expect(db.addUser).not.toHaveBeenCalled();
  });

  test('login returns the user and a token', async () => {
    const { app } = buildApp({ getUser: async () => diner, loginUser: async () => {} });
    const res = await request(app).put('/api/auth').send({ email: diner.email, password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 12, email: diner.email });
    expect(res.body.token).toEqual(expect.any(String));
  });

  test('login with bad credentials responds 404 and issues no token', async () => {
    const { app, db } = buildApp({
      getUser: async () => {
        throw new StatusCodeError('unknown user', 404);
      },
    });
    const res = await request(app).put('/api/auth').send({ email: 'ghost@test.com', password: 'bad' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('unknown user');
    expect(res.body).not.toHaveProperty('token');
    expect(db.loginUser).not.toHaveBeenCalled();
  });

  test('logout revokes the token in the store', async () => {
    const { app, db } = buildApp({ logoutUser: async () => {} });
    const headers = authHeader(diner);
    const res = await request(app).delete('/api/auth').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'logout successful' });
    expect(db.logoutUser).toHaveBeenCalledWith(headers.Authorization.split(' ')[1]);
  });

  test.each([
    ['with items', [{ id: 1, title: 'Veggie' }]],
    ['empty', []],
  ])('the menu is public (%s)', async (name, menu) => {
    const { app } = buildApp({ getMenu: async () => menu });
    const res = await request(app).get('/api/order/menu');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(menu);
  });

  test('an admin adds a menu item and gets the updated menu', async () => {
    const item = { title: 'Student', description: 'carbs', image: 'p.png', price: 0.0001 };
    const { app, db } = buildApp({ addMenuItem: async () => ({ id: 1, ...item }), getMenu: async () => [{ id: 1, ...item }] });
    const res = await request(app).put('/api/order/menu').set(authHeader(makeAdmin(1))).send(item);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, ...item }]);
    expect(db.addMenuItem).toHaveBeenCalledWith(item);
  });

  test('a diner places an order that is fulfilled by the factory', async () => {
    const orderReq = { franchiseId: 1, storeId: 2, items: [{ menuId: 1, description: 'Veggie', price: 0.05 }] };
    const { app, factoryClient } = buildApp({ addDinerOrder: async () => ({ ...orderReq, id: 77 }) }, async () => ({ ok: true, body: { reportUrl: 'https://report', jwt: 'factory.jwt' } }));

    const res = await request(app).post('/api/order').set(authHeader(diner)).send(orderReq);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ order: { ...orderReq, id: 77 }, followLinkToEndChaos: 'https://report', jwt: 'factory.jwt' });
    expect(factoryClient.createOrder).toHaveBeenCalledWith({ id: 12, name: diner.name, email: diner.email }, { ...orderReq, id: 77 });
  });

  test('a factory failure responds 500 with the report link', async () => {
    const orderReq = { franchiseId: 1, storeId: 2, items: [] };
    const { app } = buildApp({ addDinerOrder: async () => ({ ...orderReq, id: 77 }) }, async () => ({ ok: false, body: { reportUrl: 'https://report' } }));

    const res = await request(app).post('/api/order').set(authHeader(diner)).send(orderReq);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: 'https://report' });
  });
});
