const request = require('supertest');
const { createHarness } = require('./helpers/harness.js');

const h = createHarness();
beforeAll(h.start);
beforeEach(h.reset);

const countUsers = async () => (await h.query('SELECT COUNT(*) AS n FROM user'))[0].n;

describe('harness', () => {
  test('reset empties every table', async () => {
    await h.register();
    expect(await countUsers()).toBe(1);

    await h.reset();

    expect(await countUsers()).toBe(0);
  });

  test('createAdmin returns a working admin session', async () => {
    const admin = await h.createAdmin();

    const res = await request(h.app).get('/api/user/me').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: admin.user.id, roles: [{ role: 'admin' }] });
  });

  test('createFranchisee returns a session carrying the franchisee role', async () => {
    const admin = await h.createAdmin();

    const { franchisee, franchise } = await h.createFranchisee(admin, 'pizzaPocket');

    expect(franchisee.user.roles).toContainEqual({ objectId: franchise.id, role: 'franchisee' });
  });
});
