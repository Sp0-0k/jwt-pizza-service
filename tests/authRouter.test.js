const jwt = require('jsonwebtoken');
const request = require('supertest');
const config = require('../src/config.js');
const { createHarness } = require('./helpers/harness.js');

const h = createHarness();
beforeAll(h.start);
beforeEach(h.reset);

const count = async (table) => (await h.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

describe('POST /api/auth (register)', () => {
  test('creates a diner and returns the user and a verifiable token without a password', async () => {
    const res = await request(h.app).post('/api/auth').send({ name: 'New Diner', email: 'new@test.com', password: 'pw' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'New Diner', email: 'new@test.com', roles: [{ role: 'diner' }] });
    expect(res.body.user).not.toHaveProperty('password');
    expect(jwt.verify(res.body.token, config.jwtSecret)).toMatchObject({ id: res.body.user.id, email: 'new@test.com' });
  });

  test('persists the user so they can log in', async () => {
    const diner = await h.register({ email: 'persist@test.com' });

    const session = await h.login('persist@test.com', diner.password);

    expect(session.user.id).toBe(diner.user.id);
  });

  test.each(['name', 'email', 'password'])('responds 400 and creates no user when %s is missing', async (field) => {
    const body = { name: 'N', email: 'n@test.com', password: 'pw', [field]: undefined };

    const res = await request(h.app).post('/api/auth').send(body);

    expect(res.status).toBe(400);
    expect(await count('user')).toBe(0);
  });

  test('ignores roles supplied by the caller and always registers a diner', async () => {
    const res = await request(h.app)
      .post('/api/auth')
      .send({ name: 'Sneaky', email: 's@test.com', password: 'pw', roles: [{ role: 'admin' }] });

    expect(res.body.user.roles).toEqual([{ role: 'diner' }]);
    const adminOnly = await request(h.app).put('/api/order/menu').set({ Authorization: `Bearer ${res.body.token}` }).send({});
    expect(adminOnly.status).toBe(403);
  });

  test('stores names with SQL metacharacters literally', async () => {
    const name = "Robert'); DROP TABLE user;--";

    const diner = await h.register({ name });

    const rows = await h.query('SELECT name FROM user WHERE id=?', [diner.user.id]);
    expect(rows).toEqual([{ name }]);
  });
});

describe('PUT /api/auth (login)', () => {
  test('returns the user and a token that authenticates', async () => {
    const diner = await h.register({ email: 'a@test.com' });

    const res = await request(h.app).put('/api/auth').send({ email: 'a@test.com', password: diner.password });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: diner.user.id, email: 'a@test.com', roles: [{ role: 'diner' }] });
    const me = await request(h.app).get('/api/user/me').set({ Authorization: `Bearer ${res.body.token}` });
    expect(me.status).toBe(200);
  });

  test('a wrong password responds 404 and issues no token', async () => {
    const diner = await h.register();
    const before = await count('auth');

    const res = await request(h.app).put('/api/auth').send({ email: diner.email, password: 'wrong' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'unknown user' });
    expect(await count('auth')).toBe(before);
  });

  test('an unknown email responds 404 and issues no token', async () => {
    const res = await request(h.app).put('/api/auth').send({ email: 'ghost@test.com', password: 'pw' });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('token');
  });

  test.each(['email', 'password'])('responds 400 without issuing a token when %s is missing', async (field) => {
    const diner = await h.register();
    const before = await count('auth');

    const res = await request(h.app).put('/api/auth').send({ email: diner.email, password: diner.password, [field]: undefined });

    expect(res.status).toBe(400);
    expect(await count('auth')).toBe(before);
  });

  test('an empty password is rejected rather than skipping the password check', async () => {
    const diner = await h.register();

    const res = await request(h.app).put('/api/auth').send({ email: diner.email, password: '' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/auth (logout)', () => {
  test('revokes the token so it can no longer be used', async () => {
    const diner = await h.register();

    const res = await request(h.app).delete('/api/auth').set(diner.headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'logout successful' });
    expect((await request(h.app).get('/api/user/me').set(diner.headers)).status).toBe(401);
  });

  test("leaves another user's session valid", async () => {
    const first = await h.register();
    const second = await h.register();

    await request(h.app).delete('/api/auth').set(first.headers);

    expect((await request(h.app).get('/api/user/me').set(second.headers)).status).toBe(200);
  });
});

describe('token validation', () => {
  const adminOnly = (headers) => request(h.app).get('/api/user').set(headers);

  test('a payload tampered with to grant admin is rejected', async () => {
    const diner = await h.register();
    const [header, , signature] = diner.token.split('.');
    const payload = Buffer.from(JSON.stringify({ id: diner.user.id, name: 'x', email: diner.email, roles: [{ role: 'admin' }] })).toString('base64url');

    const res = await adminOnly({ Authorization: `Bearer ${header}.${payload}.${signature}` });

    expect(res.status).toBe(401);
  });

  test('a token signed with a different secret is rejected', async () => {
    const forged = jwt.sign({ id: 1, roles: [{ role: 'admin' }] }, 'some-other-secret');

    const res = await adminOnly({ Authorization: `Bearer ${forged}` });

    expect(res.status).toBe(401);
  });

  test('an expired token is rejected even though it is on record', async () => {
    const diner = await h.register();
    const expired = jwt.sign({ id: diner.user.id, name: diner.user.name, email: diner.email, roles: diner.user.roles }, config.jwtSecret, { expiresIn: -10 });
    await h.db.loginUser(diner.user.id, expired);

    const res = await request(h.app).get('/api/user/me').set({ Authorization: `Bearer ${expired}` });

    expect(res.status).toBe(401);
  });

  test.each(['Bearer', 'Bearer not-a-jwt', 'Bearer a.b.c', 'garbage'])('the Authorization value "%s" is treated as anonymous', async (value) => {
    const protectedRes = await request(h.app).get('/api/user/me').set('Authorization', value);
    const publicRes = await request(h.app).get('/api/order/menu').set('Authorization', value);

    expect(protectedRes.status).toBe(401);
    expect(publicRes.status).toBe(200);
  });
});
