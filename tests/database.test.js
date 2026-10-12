const bcrypt = require('bcrypt');
const { DB } = require('../src/database/database.js');
const { testConfig } = require('./setup/testConfig.js');
const { createHarness } = require('./helpers/harness.js');

const h = createHarness();
const db = h.db;
beforeAll(h.start);
beforeEach(h.reset);

const count = async (table) => (await h.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;
const diner = (email = 'd@test.com') => ({ name: 'Dee', email, password: 'pw', roles: [{ role: 'diner' }] });
const menuItem = { title: 'Veggie', description: 'd', image: 'p.png', price: 0.05 };
const withDatabase = (database) => ({ ...testConfig, db: { ...testConfig.db, connection: { ...testConfig.db.connection, database } } });

describe('initializeDatabase', () => {
  const freshName = 'pizza_init_test';
  beforeEach(() => h.serverQuery(`DROP DATABASE IF EXISTS ${freshName}`));
  afterAll(() => h.serverQuery(`DROP DATABASE IF EXISTS ${freshName}`));

  async function waitForDefaultAdmin(target) {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        return await target.getUser('a@jwt.com', 'admin');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error('default admin was never created');
  }

  test('a new database gets the schema and the default admin', async () => {
    const fresh = new DB({ config: withDatabase(freshName) });

    await fresh.init();

    const admin = await waitForDefaultAdmin(fresh);
    expect(admin.roles.map((r) => r.role)).toEqual(['admin']);
  });

  test('an existing database only ensures the schema and creates no default admin', async () => {
    await new DB({ config: testConfig }).init();

    expect(await count('user')).toBe(0);
  });

  test('init runs initialization only once', async () => {
    const fresh = new DB({ config: testConfig });

    expect(fresh.init()).toBe(fresh.init());
    await fresh.init();
  });
});

describe('addUser', () => {
  test('stores a hashed password, writes each role and returns the user without a password', async () => {
    const user = await db.addUser(diner());

    expect(user).toMatchObject({ name: 'Dee', email: 'd@test.com' });
    expect(user.password).toBeUndefined();
    const [row] = await h.query('SELECT password FROM user WHERE id=?', [user.id]);
    expect(row.password).not.toBe('pw');
    expect(await bcrypt.compare('pw', row.password)).toBe(true);
    expect(await h.query('SELECT role, objectId FROM userRole WHERE userId=?', [user.id])).toEqual([{ role: 'diner', objectId: 0 }]);
  });

  test('ties a franchisee role to the named franchise', async () => {
    const franchise = await db.createFranchise({ name: 'pizzaPocket', admins: [] });

    const user = await db.addUser({ ...diner(), roles: [{ role: 'franchisee', object: 'pizzaPocket' }] });

    expect(await h.query('SELECT role, objectId FROM userRole WHERE userId=?', [user.id])).toEqual([{ role: 'franchisee', objectId: franchise.id }]);
  });

  test('fails when the franchise is unknown', async () => {
    await expect(db.addUser({ ...diner(), roles: [{ role: 'franchisee', object: 'nope' }] })).rejects.toThrow('No ID found');
  });
});

describe('getUser', () => {
  test('returns the user with roles and no password when the password matches', async () => {
    const created = await h.createUser(diner());

    const user = await db.getUser('d@test.com', 'pw');

    expect(user).toMatchObject({ id: created.id, name: 'Dee', email: 'd@test.com' });
    expect(user.roles.map((r) => r.role)).toEqual(['diner']);
    expect(user.password).toBeUndefined();
  });

  test.each([
    ['a wrong password', 'd@test.com', 'wrong'],
    ['an unknown email', 'ghost@test.com', 'pw'],
    ['an empty password', 'd@test.com', ''],
  ])('rejects with 404 for %s', async (name, email, password) => {
    await h.createUser(diner());

    await expect(db.getUser(email, password)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('updateUser', () => {
  test('stores user-controlled values literally, never as SQL', async () => {
    const created = await h.createUser(diner());
    const name = "x', password='hacked";

    const user = await db.updateUser(created.id, name, undefined, undefined);

    expect(user.name).toBe(name);
    await expect(db.getUser('d@test.com', 'pw')).resolves.toBeTruthy();
  });

  test('hashes a new password', async () => {
    const created = await h.createUser(diner());

    await db.updateUser(created.id, undefined, undefined, 'new-pw');

    await expect(db.getUser('d@test.com', 'new-pw')).resolves.toBeTruthy();
    await expect(db.getUser('d@test.com', 'pw')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('a partial update returns the refreshed user by id without a password', async () => {
    const created = await h.createUser(diner());

    const user = await db.updateUser(created.id, 'Only Name', undefined, undefined);

    expect(user).toMatchObject({ id: created.id, name: 'Only Name', email: 'd@test.com' });
    expect(user.password).toBeUndefined();
  });

  test('changes nothing when nothing is provided', async () => {
    const created = await h.createUser(diner());

    const user = await db.updateUser(created.id, undefined, undefined, undefined);

    expect(user).toMatchObject({ name: 'Dee', email: 'd@test.com' });
  });

  test('rejects with 404 for an unknown user', async () => {
    await expect(db.updateUser(9999, 'x', undefined, undefined)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('token storage', () => {
  const token = 'aaa.bbb.sig123';

  test('loginUser stores only the token signature, once', async () => {
    await db.loginUser(5, token);
    await db.loginUser(5, token);

    expect(await h.query('SELECT token, userId FROM auth')).toEqual([{ token: 'sig123', userId: 5 }]);
  });

  test('isLoggedIn is true for a stored signature and false otherwise', async () => {
    await db.loginUser(5, token);

    expect(await db.isLoggedIn(token)).toBe(true);
    expect(await db.isLoggedIn('aaa.bbb.other')).toBe(false);
  });

  test('logoutUser deletes by signature', async () => {
    await db.loginUser(5, token);

    await db.logoutUser(token);

    expect(await db.isLoggedIn(token)).toBe(false);
  });
});

describe('menu', () => {
  test('getMenu returns the rows', async () => {
    expect(await db.getMenu()).toEqual([]);
  });

  test('addMenuItem inserts the item and returns it with its new id', async () => {
    const added = await db.addMenuItem(menuItem);

    expect(added).toEqual({ ...menuItem, id: expect.any(Number) });
    expect(await db.getMenu()).toEqual([{ ...menuItem, id: added.id }]);
  });
});

describe('orders', () => {
  const orderFor = (menuId, items = 1) => ({
    franchiseId: 1,
    storeId: 2,
    items: Array.from({ length: items }, () => ({ menuId, description: 'Veggie', price: 0.05 })),
  });

  test('addDinerOrder writes the order and every item and returns the order with its id', async () => {
    const user = await h.createUser(diner());
    const menu = await db.addMenuItem(menuItem);

    const order = await db.addDinerOrder(user, orderFor(menu.id, 2));

    expect(order.id).toEqual(expect.any(Number));
    expect(await count('orderItem')).toBe(2);
  });

  test('addDinerOrder fails for an unknown menu item', async () => {
    const user = await h.createUser(diner());

    await expect(db.addDinerOrder(user, orderFor(9999))).rejects.toThrow('No ID found');
  });

  test("getOrders defaults to the first page and attaches each order's items", async () => {
    const user = await h.createUser(diner());
    const menu = await db.addMenuItem(menuItem);
    await db.addDinerOrder(user, orderFor(menu.id));

    const result = await db.getOrders(user);

    expect(result).toMatchObject({ dinerId: user.id, page: 1 });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].items).toEqual([expect.objectContaining({ menuId: menu.id, description: 'Veggie', price: 0.05 })]);
  });

  test('getOrders offsets later pages', async () => {
    const user = await h.createUser(diner());
    const menu = await db.addMenuItem(menuItem);
    for (let i = 0; i < 11; i++) {
      await db.addDinerOrder(user, orderFor(menu.id));
    }

    expect((await db.getOrders(user, 1)).orders).toHaveLength(10);
    expect((await db.getOrders(user, 2)).orders).toHaveLength(1);
  });
});

describe('franchises', () => {
  const adminUser = { isRole: (role) => role === 'admin' };

  test('createFranchise resolves admins by email and grants each the franchisee role', async () => {
    const owner = await h.createUser(diner('owner@test.com'));

    const franchise = await db.createFranchise({ name: 'pizzaPocket', admins: [{ email: 'owner@test.com' }] });

    expect(franchise.admins).toEqual([{ email: 'owner@test.com', id: owner.id, name: 'Dee' }]);
    expect(await h.query("SELECT userId, objectId FROM userRole WHERE role='franchisee'")).toEqual([{ userId: owner.id, objectId: franchise.id }]);
  });

  test('createFranchise fails with 404 for an unknown admin before writing anything', async () => {
    await expect(db.createFranchise({ name: 'pizzaPocket', admins: [{ email: 'ghost@test.com' }] })).rejects.toMatchObject({ statusCode: 404 });
    expect(await count('franchise')).toBe(0);
  });

  test('deleteFranchise removes the franchise, its stores and its franchisee roles', async () => {
    const owner = await h.createUser(diner('owner@test.com'));
    const franchise = await db.createFranchise({ name: 'pizzaPocket', admins: [{ email: owner.email }] });
    await db.createStore(franchise.id, { name: 'SLC' });

    await db.deleteFranchise(franchise.id);

    expect(await count('franchise')).toBe(0);
    expect(await count('store')).toBe(0);
    expect(await h.query("SELECT id FROM userRole WHERE role='franchisee'")).toEqual([]);
  });

  test('getFranchises trims to the limit, reports more, and gives non-admins stores only', async () => {
    const first = await db.createFranchise({ name: 'f1', admins: [] });
    await db.createFranchise({ name: 'f2', admins: [] });
    await db.createStore(first.id, { name: 'SLC' });

    const [franchises, more] = await db.getFranchises(undefined, 0, 1);

    expect(more).toBe(true);
    expect(franchises).toEqual([{ id: first.id, name: 'f1', stores: [{ id: expect.any(Number), name: 'SLC' }] }]);
  });

  test('getFranchises reports no more when the page is not full', async () => {
    await db.createFranchise({ name: 'f1', admins: [] });

    const [franchises, more] = await db.getFranchises(undefined, 0, 10);

    expect(franchises).toHaveLength(1);
    expect(more).toBe(false);
  });

  test('getFranchises loads admins and revenue for an admin caller', async () => {
    const owner = await h.createUser(diner('owner@test.com'));
    const franchise = await db.createFranchise({ name: 'pizzaPocket', admins: [{ email: owner.email }] });
    await db.createStore(franchise.id, { name: 'SLC' });

    const [[listed]] = await db.getFranchises(adminUser);

    expect(listed.admins).toEqual([{ id: owner.id, name: 'Dee', email: 'owner@test.com' }]);
    expect(listed.stores[0].totalRevenue).toBe(0);
  });

  test('treats a string limit from the query string as a number', async () => {
    await db.createFranchise({ name: 'f1', admins: [] });
    await db.createFranchise({ name: 'f2', admins: [] });

    const [franchises, more] = await db.getFranchises(undefined, '0', '1');

    expect(franchises).toHaveLength(1);
    expect(more).toBe(true);
  });

  test('rejects a non-numeric limit with 400', async () => {
    await expect(db.getFranchises(undefined, 0, 'abc')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('getUserFranchises returns an empty list when the user administers none', async () => {
    const user = await h.createUser(diner());

    expect(await db.getUserFranchises(user.id)).toEqual([]);
  });

  test('getUserFranchises loads details for each franchise the user administers', async () => {
    const owner = await h.createUser(diner('owner@test.com'));
    await db.createFranchise({ name: 'f1', admins: [{ email: owner.email }] });
    await db.createFranchise({ name: 'f2', admins: [{ email: owner.email }] });

    const franchises = await db.getUserFranchises(owner.id);

    expect(franchises.map((f) => f.name)).toEqual(['f1', 'f2']);
    expect(franchises[0].admins).toHaveLength(1);
  });

  test('getFranchise attaches admins and stores with revenue', async () => {
    const user = await h.createUser(diner());
    const franchise = await db.createFranchise({ name: 'pizzaPocket', admins: [{ email: user.email }] });
    const store = await db.createStore(franchise.id, { name: 'SLC' });
    const menu = await db.addMenuItem(menuItem);
    await db.addDinerOrder(user, { franchiseId: franchise.id, storeId: store.id, items: [{ menuId: menu.id, description: 'Veggie', price: 0.05 }] });

    const result = await db.getFranchise({ id: franchise.id });

    expect(result.admins).toHaveLength(1);
    expect(result.stores).toEqual([expect.objectContaining({ id: store.id, name: 'SLC' })]);
    expect(result.stores[0].totalRevenue).toBeCloseTo(0.05);
  });
});

describe('stores', () => {
  test('createStore inserts under the franchise and returns the store', async () => {
    const franchise = await db.createFranchise({ name: 'pizzaPocket', admins: [] });

    const store = await db.createStore(franchise.id, { name: 'SLC' });

    expect(store).toEqual({ id: expect.any(Number), franchiseId: franchise.id, name: 'SLC' });
  });

  test('deleteStore only deletes a store belonging to the franchise', async () => {
    const a = await db.createFranchise({ name: 'a', admins: [] });
    const b = await db.createFranchise({ name: 'b', admins: [] });
    const store = await db.createStore(b.id, { name: 'Provo' });

    await db.deleteStore(a.id, store.id);

    expect(await count('store')).toBe(1);
  });
});

describe('helpers', () => {
  test.each([
    [1, 0],
    [3, 20],
    [undefined, 0],
  ])('getOffset(%s, 10) is %s', (page, expected) => {
    expect(db.getOffset(page, 10)).toBe(expected);
  });

  test.each([
    ['a.b.c', 'c'],
    ['a.b', ''],
    ['abc', ''],
  ])('getTokenSignature(%s) is "%s"', (token, expected) => {
    expect(db.getTokenSignature(token)).toBe(expected);
  });

  test('getID returns the id of the matching row and throws when none matches', async () => {
    const menu = await db.addMenuItem(menuItem);
    const connection = await db.getConnection();
    try {
      expect(await db.getID(connection, 'id', menu.id, 'menu')).toBe(menu.id);
      await expect(db.getID(connection, 'id', 9999, 'menu')).rejects.toThrow('No ID found');
    } finally {
      connection.end();
    }
  });
});
