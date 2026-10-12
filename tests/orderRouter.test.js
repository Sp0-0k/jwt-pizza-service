const request = require('supertest');
const { createHarness } = require('./helpers/harness.js');

const h = createHarness();
beforeAll(h.start);
beforeEach(h.reset);

const item = { title: 'Student', description: 'Just carbs', image: 'pizza9.png', price: 0.0001 };
const orderFor = (menuId) => ({ franchiseId: 1, storeId: 2, items: [{ menuId, description: 'Veggie', price: 0.05 }] });
const count = async (table) => (await h.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

describe('GET /api/order/menu', () => {
  test('is public and empty when there are no items', async () => {
    const res = await request(h.app).get('/api/order/menu');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns the stored items', async () => {
    const stored = await h.db.addMenuItem(item);

    const res = await request(h.app).get('/api/order/menu');

    expect(res.body).toEqual([{ id: stored.id, ...item }]);
  });
});

describe('PUT /api/order/menu', () => {
  test('lets an admin add an item and returns the updated menu', async () => {
    const admin = await h.createAdmin();

    const res = await request(h.app).put('/api/order/menu').set(admin.headers).send(item);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: expect.any(Number), ...item }]);
    expect(await count('menu')).toBe(1);
  });

  test.each([
    ['a diner', async () => (await h.register()).headers],
    ['a franchisee', async () => (await h.createFranchisee(await h.createAdmin())).franchisee.headers],
  ])('forbids %s and adds nothing', async (name, headersFor) => {
    const headers = await headersFor();

    const res = await request(h.app).put('/api/order/menu').set(headers).send(item);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to add menu item');
    expect(await count('menu')).toBe(0);
  });
});

describe('POST /api/order', () => {
  test('persists the order, sends it to the factory and returns the factory jwt', async () => {
    const diner = await h.register({ name: 'Dee Diner' });
    const menu = await h.db.addMenuItem(item);
    const orderReq = orderFor(menu.id);

    const res = await request(h.app).post('/api/order').set(diner.headers).send(orderReq);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ order: { ...orderReq, id: expect.any(Number) }, followLinkToEndChaos: 'https://report.test', jwt: 'factory.jwt' });
    expect(h.factory.calls).toEqual([{ diner: { id: diner.user.id, name: 'Dee Diner', email: diner.email }, order: res.body.order }]);
    expect(await count('orderItem')).toBe(1);
  });

  test('responds 500 with the report link when the factory refuses the order', async () => {
    const diner = await h.register();
    const menu = await h.db.addMenuItem(item);
    h.factory.respond = async () => ({ ok: false, body: { reportUrl: 'https://report.test' } });

    const res = await request(h.app).post('/api/order').set(diner.headers).send(orderFor(menu.id));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: 'https://report.test' });
  });

  test('reports a factory network failure as a 500 with its message', async () => {
    const diner = await h.register();
    const menu = await h.db.addMenuItem(item);
    h.factory.respond = async () => {
      throw new Error('network down');
    };

    const res = await request(h.app).post('/api/order').set(diner.headers).send(orderFor(menu.id));

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('network down');
  });

  test('an unknown menu item fails with 500 and never reaches the factory', async () => {
    const diner = await h.register();

    const res = await request(h.app).post('/api/order').set(diner.headers).send(orderFor(9999));

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('No ID found');
    expect(h.factory.calls).toHaveLength(0);
  });
});

describe('GET /api/order', () => {
  test("returns only the caller's orders, with items, and pages them", async () => {
    const diner = await h.register();
    const other = await h.register();
    const menu = await h.db.addMenuItem(item);
    for (let i = 0; i < 11; i++) {
      await h.db.addDinerOrder(diner.user, orderFor(menu.id));
    }
    await h.db.addDinerOrder(other.user, orderFor(menu.id));

    const first = await request(h.app).get('/api/order').set(diner.headers);
    const second = await request(h.app).get('/api/order?page=2').set(diner.headers);

    expect(first.status).toBe(200);
    expect(first.body.dinerId).toBe(diner.user.id);
    expect(first.body.orders).toHaveLength(10);
    expect(first.body.orders[0]).toMatchObject({ franchiseId: 1, storeId: 2, items: [{ menuId: menu.id, description: 'Veggie', price: 0.05 }] });
    expect(second.body.orders).toHaveLength(1);
  });

  test('returns no orders for a diner who has not ordered', async () => {
    const diner = await h.register();

    const res = await request(h.app).get('/api/order').set(diner.headers);

    expect(res.body.orders).toEqual([]);
  });
});
