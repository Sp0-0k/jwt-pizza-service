const request = require('supertest');
const { createHarness } = require('./helpers/harness.js');

const h = createHarness();
beforeAll(h.start);
beforeEach(h.reset);

const count = async (table) => (await h.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

async function world() {
  const admin = await h.createAdmin();
  const { franchisee, franchise } = await h.createFranchisee(admin, 'pizzaPocket');
  return { admin, franchisee, franchise };
}

const addStore = (headers, franchiseId, name = 'SLC') => request(h.app).post(`/api/franchise/${franchiseId}/store`).set(headers).send({ name });

describe('GET /api/franchise', () => {
  test('is public and shows stores without admins or revenue', async () => {
    const { admin, franchise } = await world();
    const store = (await addStore(admin.headers, franchise.id)).body;

    const res = await request(h.app).get('/api/franchise');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ franchises: [{ id: franchise.id, name: 'pizzaPocket', stores: [{ id: store.id, name: 'SLC' }] }], more: false });
  });

  test('shows an admin the franchise admins and store revenue', async () => {
    const { admin, franchisee, franchise } = await world();
    const store = (await addStore(admin.headers, franchise.id)).body;
    const diner = await h.register();
    const menu = await h.db.addMenuItem({ title: 'Veggie', description: 'd', image: 'p.png', price: 0.05 });
    await h.db.addDinerOrder(diner.user, { franchiseId: franchise.id, storeId: store.id, items: [{ menuId: menu.id, description: 'Veggie', price: 0.05 }] });

    const res = await request(h.app).get('/api/franchise').set(admin.headers);

    const listed = res.body.franchises[0];
    expect(listed.admins).toEqual([{ id: franchisee.user.id, name: 'Franchisee', email: franchisee.email }]);
    expect(listed.stores).toHaveLength(1);
    expect(listed.stores[0]).toMatchObject({ id: store.id, name: 'SLC' });
    expect(listed.stores[0].totalRevenue).toBeCloseTo(0.05);
  });

  test('pages through franchises and reports whether more remain', async () => {
    const admin = await h.createAdmin();
    for (const name of ['f1', 'f2', 'f3']) {
      await h.createFranchise(admin, name);
    }

    const first = await request(h.app).get('/api/franchise?page=0&limit=2');
    const second = await request(h.app).get('/api/franchise?page=1&limit=2');

    expect(first.body.franchises).toHaveLength(2);
    expect(first.body.more).toBe(true);
    expect(second.body.franchises).toHaveLength(1);
    expect(second.body.more).toBe(false);
  });

  test('filters by name with * as a wildcard and treats SQL metacharacters literally', async () => {
    const admin = await h.createAdmin();
    await h.createFranchise(admin, 'pizzaPocket');
    await h.createFranchise(admin, 'burgerBarn');

    const filtered = await request(h.app).get('/api/franchise?name=pizza*');
    const injected = await request(h.app).get(`/api/franchise?name=${encodeURIComponent("' OR '1'='1")}`);

    expect(filtered.body.franchises.map((f) => f.name)).toEqual(['pizzaPocket']);
    expect(injected.status).toBe(200);
    expect(injected.body.franchises).toEqual([]);
  });

  test.each([['limit=abc'], ['page=-1'], ['limit=0']])('rejects invalid paging (%s) with 400', async (qs) => {
    const res = await request(h.app).get(`/api/franchise?${qs}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'invalid paging parameters' });
  });
});

describe('GET /api/franchise/:userId', () => {
  test('lets a user list their own franchises', async () => {
    const { franchisee, franchise } = await world();

    const res = await request(h.app).get(`/api/franchise/${franchisee.user.id}`).set(franchisee.headers);

    expect(res.status).toBe(200);
    expect(res.body.map((f) => f.id)).toEqual([franchise.id]);
  });

  test("lets an admin list another user's franchises", async () => {
    const { admin, franchisee, franchise } = await world();

    const res = await request(h.app).get(`/api/franchise/${franchisee.user.id}`).set(admin.headers);

    expect(res.body.map((f) => f.id)).toEqual([franchise.id]);
  });

  test('returns an empty list for another ordinary user', async () => {
    const { franchisee } = await world();
    const stranger = await h.register();

    const res = await request(h.app).get(`/api/franchise/${franchisee.user.id}`).set(stranger.headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/franchise', () => {
  test('lets an admin create a franchise, granting the admins the franchisee role', async () => {
    const admin = await h.createAdmin();
    const diner = await h.register({ name: 'Future Owner' });

    const res = await request(h.app)
      .post('/api/franchise')
      .set(admin.headers)
      .send({ name: 'pizzaPocket', admins: [{ email: diner.email }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: expect.any(Number), name: 'pizzaPocket', admins: [{ email: diner.email, id: diner.user.id, name: 'Future Owner' }] });
    const relogin = await h.sessionFor(diner.email);
    expect(relogin.user.roles).toContainEqual({ objectId: res.body.id, role: 'franchisee' });
  });

  test.each([
    ['a diner', async () => (await h.register()).headers],
    ['a franchisee', async () => (await world()).franchisee.headers],
  ])('forbids %s and creates nothing', async (name, headersFor) => {
    const headers = await headersFor();

    const res = await request(h.app).post('/api/franchise').set(headers).send({ name: 'hijack', admins: [] });

    expect(res.status).toBe(403);
    expect(await h.query("SELECT id FROM franchise WHERE name='hijack'")).toEqual([]);
  });

  test('an unknown admin email responds 404 and creates nothing', async () => {
    const admin = await h.createAdmin();

    const res = await request(h.app)
      .post('/api/franchise')
      .set(admin.headers)
      .send({ name: 'pizzaPocket', admins: [{ email: 'ghost@test.com' }] });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('unknown user for franchise admin ghost@test.com provided');
    expect(await count('franchise')).toBe(0);
  });
});

describe('DELETE /api/franchise/:franchiseId', () => {
  test('anonymous callers get 401 and nothing is deleted', async () => {
    const { franchise } = await world();

    const res = await request(h.app).delete(`/api/franchise/${franchise.id}`);

    expect(res.status).toBe(401);
    expect(await count('franchise')).toBe(1);
  });

  test.each([
    ['a diner', async () => (await h.register()).headers],
    ['a franchisee', async (w) => w.franchisee.headers],
  ])('forbids %s and deletes nothing', async (name, headersFor) => {
    const w = await world();
    const headers = await headersFor(w);

    const res = await request(h.app).delete(`/api/franchise/${w.franchise.id}`).set(headers);

    expect(res.status).toBe(403);
    expect(await count('franchise')).toBe(1);
  });

  test('lets an admin delete a franchise with its stores and franchisee roles', async () => {
    const { admin, franchisee, franchise } = await world();
    await addStore(admin.headers, franchise.id);

    const res = await request(h.app).delete(`/api/franchise/${franchise.id}`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'franchise deleted' });
    expect(await count('franchise')).toBe(0);
    expect(await count('store')).toBe(0);
    const relogin = await h.sessionFor(franchisee.email);
    expect(relogin.user.roles.map((r) => r.role)).not.toContain('franchisee');
  });
});

describe('POST /api/franchise/:franchiseId/store', () => {
  test.each([
    ['an admin', (w) => w.admin.headers],
    ["the franchise's franchisee", (w) => w.franchisee.headers],
  ])('lets %s create a store', async (name, headersFor) => {
    const w = await world();

    const res = await addStore(headersFor(w), w.franchise.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: expect.any(Number), franchiseId: w.franchise.id, name: 'SLC' });
    expect(await h.query('SELECT name FROM store WHERE id=?', [res.body.id])).toEqual([{ name: 'SLC' }]);
  });

  test.each([
    ['a diner', async () => (await h.register()).headers],
    ["another franchise's franchisee", async (w) => (await h.createFranchisee(w.admin, 'otherFranchise')).franchisee.headers],
  ])('forbids %s and creates nothing', async (name, headersFor) => {
    const w = await world();
    const headers = await headersFor(w);

    const res = await addStore(headers, w.franchise.id);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to create a store');
    expect(await count('store')).toBe(0);
  });

  test('fails for a franchise that does not exist and creates no store', async () => {
    const admin = await h.createAdmin();

    const res = await addStore(admin.headers, 9999);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count('store')).toBe(0);
  });

  test('uses the franchise id from the path, not one in the body', async () => {
    const w = await world();
    const other = await h.createFranchise(w.admin, 'otherFranchise');

    const res = await request(h.app).post(`/api/franchise/${w.franchise.id}/store`).set(w.admin.headers).send({ name: 'SLC', franchiseId: other.id });

    expect((await h.query('SELECT franchiseId FROM store WHERE id=?', [res.body.id]))[0].franchiseId).toBe(w.franchise.id);
  });
});

describe('DELETE /api/franchise/:franchiseId/store/:storeId', () => {
  test.each([
    ['an admin', (w) => w.admin.headers],
    ["the franchise's franchisee", (w) => w.franchisee.headers],
  ])('lets %s delete a store', async (name, headersFor) => {
    const w = await world();
    const store = (await addStore(w.admin.headers, w.franchise.id)).body;

    const res = await request(h.app).delete(`/api/franchise/${w.franchise.id}/store/${store.id}`).set(headersFor(w));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'store deleted' });
    expect(await count('store')).toBe(0);
  });

  test.each([
    ['a diner', async () => (await h.register()).headers],
    ["another franchise's franchisee", async (w) => (await h.createFranchisee(w.admin, 'otherFranchise')).franchisee.headers],
  ])('forbids %s and deletes nothing', async (name, headersFor) => {
    const w = await world();
    const store = (await addStore(w.admin.headers, w.franchise.id)).body;
    const headers = await headersFor(w);

    const res = await request(h.app).delete(`/api/franchise/${w.franchise.id}/store/${store.id}`).set(headers);

    expect(res.status).toBe(403);
    expect(await count('store')).toBe(1);
  });

  test('only deletes a store that belongs to the franchise in the path', async () => {
    const w = await world();
    const other = await h.createFranchise(w.admin, 'otherFranchise');
    const otherStore = (await addStore(w.admin.headers, other.id, 'Provo')).body;

    await request(h.app).delete(`/api/franchise/${w.franchise.id}/store/${otherStore.id}`).set(w.admin.headers);

    expect(await h.query('SELECT id FROM store WHERE id=?', [otherStore.id])).toHaveLength(1);
  });
});
