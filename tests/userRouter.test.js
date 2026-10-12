const request = require('supertest');
const { createHarness } = require('./helpers/harness.js');

const h = createHarness();
beforeAll(h.start);
beforeEach(h.reset);

describe('GET /api/user/me', () => {
  test('returns the authenticated user without a password', async () => {
    const diner = await h.register({ name: 'Dee Diner' });

    const res = await request(h.app).get('/api/user/me').set(diner.headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: diner.user.id, name: 'Dee Diner', email: diner.email, roles: [{ role: 'diner' }] });
    expect(res.body).not.toHaveProperty('password');
  });
});

describe('PUT /api/user/:userId', () => {
  test('lets a user update themselves and returns the refreshed user and a working token', async () => {
    const diner = await h.register();

    const res = await request(h.app).put(`/api/user/${diner.user.id}`).set(diner.headers).send({ name: 'New Name', email: 'new@test.com', password: 'new-pw' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: diner.user.id, name: 'New Name', email: 'new@test.com', roles: [{ role: 'diner' }] });
    expect(res.body.user).not.toHaveProperty('password');
    const me = await request(h.app).get('/api/user/me').set({ Authorization: `Bearer ${res.body.token}` });
    expect(me.body.name).toBe('New Name');
    const relogin = await h.login('new@test.com', 'new-pw');
    expect(relogin.user.id).toBe(diner.user.id);
  });

  test('a partial update changes only the supplied fields', async () => {
    const diner = await h.register({ name: 'Old Name', email: 'keep@test.com' });

    const res = await request(h.app).put(`/api/user/${diner.user.id}`).set(diner.headers).send({ name: 'Only Name' });

    expect(res.body.user).toMatchObject({ name: 'Only Name', email: 'keep@test.com' });
    await h.login('keep@test.com', diner.password);
  });

  test('lets an admin update another user', async () => {
    const admin = await h.createAdmin();
    const diner = await h.register({ name: 'Before' });

    const res = await request(h.app).put(`/api/user/${diner.user.id}`).set(admin.headers).send({ name: 'After' });

    expect(res.status).toBe(200);
    expect((await h.query('SELECT name FROM user WHERE id=?', [diner.user.id]))[0].name).toBe('After');
  });

  test('forbids an ordinary user from updating someone else, changing nothing and issuing no token', async () => {
    const attacker = await h.register();
    const victim = await h.register({ name: 'Victim' });

    const res = await request(h.app).put(`/api/user/${victim.user.id}`).set(attacker.headers).send({ name: 'Hacked' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect((await h.query('SELECT name FROM user WHERE id=?', [victim.user.id]))[0].name).toBe('Victim');
  });
});

// The list-users feature is not implemented yet (GET /api/user answers "not implemented" to everyone),
// so the tests below are expected to fail until it is built.
describe('GET /api/user (list users)', () => {
  test('requires authentication', async () => {
    const res = await request(h.app).get('/api/user');

    expect(res.status).toBe(401);
  });

  test('list users', async () => {
    const listUsersRes = await request(h.app).get('/api/user');
    expect(listUsersRes.status).toBe(200);
  });

  test('forbids a diner', async () => {
    const diner = await h.register();

    const res = await request(h.app).get('/api/user').set(diner.headers);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'unable to list users' });
  });

  test('lists users for an admin, with roles and without passwords', async () => {
    const admin = await h.createAdmin({ name: 'Ada Admin' });
    const diner = await h.register({ name: 'Dee Diner' });

    const res = await request(h.app).get('/api/user').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      users: [
        { id: admin.user.id, name: 'Ada Admin', email: admin.email, roles: [{ role: 'admin' }] },
        { id: diner.user.id, name: 'Dee Diner', email: diner.email, roles: [{ role: 'diner' }] },
      ],
      more: false,
    });
  });

  test('pages through users and reports whether more remain', async () => {
    const admin = await h.createAdmin();
    await h.register();
    await h.register();

    const first = await request(h.app).get('/api/user?page=0&limit=2').set(admin.headers);
    const second = await request(h.app).get('/api/user?page=1&limit=2').set(admin.headers);

    expect(first.body.users).toHaveLength(2);
    expect(first.body.more).toBe(true);
    expect(second.body.users).toHaveLength(1);
    expect(second.body.more).toBe(false);
  });

  test('filters by name with * as a wildcard', async () => {
    const admin = await h.createAdmin({ name: 'Ada Admin' });
    await h.register({ name: 'Alice Smith' });
    await h.register({ name: 'Bob Jones' });

    const res = await request(h.app).get('/api/user?name=Ali*').set(admin.headers);

    expect(res.body.users.map((u) => u.name)).toEqual(['Alice Smith']);
  });

  test('treats SQL metacharacters in the name filter literally', async () => {
    const admin = await h.createAdmin();
    await h.register();

    const res = await request(h.app).get(`/api/user?name=${encodeURIComponent("' OR '1'='1")}`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  test.each([['limit=abc'], ['page=-1'], ['limit=0'], ['page=1.5']])('rejects invalid paging (%s) with 400', async (qs) => {
    const admin = await h.createAdmin();

    const res = await request(h.app).get(`/api/user?${qs}`).set(admin.headers);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'invalid paging parameters' });
  });
});
