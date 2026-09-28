jest.mock('bcrypt', () => ({
  hash: jest.fn(async (password) => `hashed:${password}`),
  compare: jest.fn(async (password, hash) => hash === `hashed:${password}`),
}));

const { DB } = require('../src/database/database.js');
const dbModel = require('../src/database/dbModel.js');
const { makeAdmin } = require('./helpers/fixtures.js');

const testConfig = {
  db: {
    connection: { host: 'db.test', user: 'tester', password: 'super-secret-password', database: 'testdb', connectTimeout: 100 },
    listPerPage: 10,
  },
};

// execute() resolves the queued results in order, each wrapped as mysql2 does: [rows]. Calling execute()
// more times than results were queued yields undefined and fails loudly with a TypeError.
function createFakeConnection(results = []) {
  const connection = {
    execute: jest.fn(),
    query: jest.fn(async () => [[]]),
    end: jest.fn(),
    beginTransaction: jest.fn(async () => {}),
    commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}),
  };
  for (const result of results) {
    connection.execute.mockResolvedValueOnce([result]);
  }
  return connection;
}

// Skips schema initialization so a test only sees the calls made by the method under test.
function createTestDb(connection) {
  const db = new DB({ connect: async () => connection, config: testConfig });
  db.initialized = Promise.resolve();
  return db;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('initializeDatabase', () => {
  test('logs a connection failure without the database password', async () => {
    const connect = jest.fn().mockRejectedValue(new Error('connect refused'));
    const db = new DB({ connect, config: testConfig });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await db.init();

    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('Error initializing database');
    expect(logged).toContain('connect refused');
    expect(logged).not.toContain(testConfig.db.connection.password);
  });
});

describe('addUser', () => {
  test('stores a hashed password, writes each role and returns the user without a password', async () => {
    const conn = createFakeConnection([{ insertId: 11 }, {}, {}]);
    const db = createTestDb(conn);

    const user = await db.addUser({ name: 'N', email: 'n@test.com', password: 'pw', roles: [{ role: 'diner' }, { role: 'admin' }] });

    expect(conn.execute.mock.calls[0][1]).toEqual(['N', 'n@test.com', 'hashed:pw']);
    expect(conn.execute.mock.calls[1][1]).toEqual([11, 'diner', 0]);
    expect(conn.execute.mock.calls[2][1]).toEqual([11, 'admin', 0]);
    expect(user).toMatchObject({ id: 11, name: 'N', email: 'n@test.com' });
    expect(user.password).toBeUndefined();
    expect(conn.end).toHaveBeenCalled();
  });

  test('ties a franchisee role to the named franchise', async () => {
    const conn = createFakeConnection([{ insertId: 12 }, [{ id: 4 }], {}]);
    const db = createTestDb(conn);

    await db.addUser({ name: 'F', email: 'f@test.com', password: 'pw', roles: [{ role: 'franchisee', object: 'pizzaPocket' }] });

    expect(conn.execute.mock.calls[1][1]).toEqual(['pizzaPocket']);
    expect(conn.execute.mock.calls[2][1]).toEqual([12, 'franchisee', 4]);
  });

  test('fails and still closes the connection when the franchise is unknown', async () => {
    const conn = createFakeConnection([{ insertId: 12 }, []]);
    const db = createTestDb(conn);

    await expect(db.addUser({ name: 'F', email: 'f@test.com', password: 'pw', roles: [{ role: 'franchisee', object: 'nope' }] })).rejects.toThrow('No ID found');
    expect(conn.end).toHaveBeenCalled();
  });
});

describe('getUser', () => {
  const row = { id: 1, name: 'A', email: 'a@test.com', password: 'hashed:pw' };

  test('returns the user with roles and no password when the password matches', async () => {
    const conn = createFakeConnection([[row], [{ role: 'admin', objectId: 0 }, { role: 'franchisee', objectId: 3 }]]);
    const db = createTestDb(conn);

    const user = await db.getUser('a@test.com', 'pw');

    expect(user).toEqual({ id: 1, name: 'A', email: 'a@test.com', password: undefined, roles: [{ role: 'admin', objectId: undefined }, { role: 'franchisee', objectId: 3 }] });
    expect(conn.end).toHaveBeenCalled();
  });

  test('rejects with 404 for a wrong password', async () => {
    const db = createTestDb(createFakeConnection([[row]]));
    await expect(db.getUser('a@test.com', 'nope')).rejects.toMatchObject({ statusCode: 404, message: 'unknown user' });
  });

  test('rejects with 404 for an unknown email', async () => {
    const db = createTestDb(createFakeConnection([[]]));
    await expect(db.getUser('ghost@test.com', 'pw')).rejects.toMatchObject({ statusCode: 404 });
  });

  // BUG (empty-password bypass): an empty password skips the password comparison entirely.
  test('rejects an empty password instead of skipping the password check', async () => {
    const db = createTestDb(createFakeConnection([[row], []]));
    await expect(db.getUser('a@test.com', '')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('updateUser', () => {
  const row = { id: 7, name: 'New', email: 'e@test.com', password: 'hashed:pw' };

  // BUG (SQL interpolation): values are concatenated into the UPDATE, and a partial update calls
  // getUser(email, password) with undefined values.
  test('sends user-controlled values as parameters, never inside the SQL text', async () => {
    const evil = "x', password='pwned";
    const conn = createFakeConnection([{ affectedRows: 1 }, [row], []]);
    const db = createTestDb(conn);

    await db.updateUser(7, evil, undefined, undefined);

    const [sql, params] = conn.execute.mock.calls[0];
    expect(sql).not.toContain('pwned');
    expect(params).toContain(evil);
    expect(params).toContain(7);
  });

  test('hashes a new password and sends it as a parameter', async () => {
    const conn = createFakeConnection([{ affectedRows: 1 }, [row], []]);
    const db = createTestDb(conn);

    await db.updateUser(7, undefined, 'e@test.com', 'newpw');

    const [sql, params] = conn.execute.mock.calls[0];
    expect(sql).not.toContain('hashed:newpw');
    expect(params).toContain('hashed:newpw');
    expect(params).toContain('e@test.com');
  });

  test('a partial update returns the refreshed user by id without a password', async () => {
    const conn = createFakeConnection([{ affectedRows: 1 }, [row], [{ role: 'diner', objectId: 0 }]]);
    const db = createTestDb(conn);

    const user = await db.updateUser(7, 'New', undefined, undefined);

    expect(user).toMatchObject({ id: 7, name: 'New', email: 'e@test.com', roles: [{ role: 'diner' }] });
    expect(user.password).toBeUndefined();
    expect(conn.execute.mock.calls[1]).toEqual([expect.stringContaining('WHERE id=?'), [7]]);
    expect(conn.end).toHaveBeenCalled();
  });

  test('runs no UPDATE when nothing is provided', async () => {
    const conn = createFakeConnection([[row], []]);
    const db = createTestDb(conn);

    await db.updateUser(7);

    expect(conn.execute.mock.calls[0][0]).toContain('SELECT');
    expect(conn.execute.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false);
  });
});

describe('token storage', () => {
  test('loginUser stores only the token signature', async () => {
    const conn = createFakeConnection([{}]);
    await createTestDb(conn).loginUser(5, 'aaa.bbb.sig');
    expect(conn.execute.mock.calls[0][1]).toEqual(['sig', 5]);
    expect(conn.end).toHaveBeenCalled();
  });

  test('isLoggedIn is true when a row exists for the signature', async () => {
    const conn = createFakeConnection([[{ userId: 5 }]]);
    await expect(createTestDb(conn).isLoggedIn('aaa.bbb.sig')).resolves.toBe(true);
    expect(conn.execute.mock.calls[0][1]).toEqual(['sig']);
  });

  test('isLoggedIn is false when no row exists', async () => {
    await expect(createTestDb(createFakeConnection([[]])).isLoggedIn('aaa.bbb.sig')).resolves.toBe(false);
  });

  test('logoutUser deletes by signature', async () => {
    const conn = createFakeConnection([{}]);
    await createTestDb(conn).logoutUser('aaa.bbb.sig');
    expect(conn.execute.mock.calls[0][1]).toEqual(['sig']);
  });
});

describe('menu', () => {
  test('getMenu returns the rows and closes the connection', async () => {
    const rows = [{ id: 1, title: 'Veggie' }];
    const conn = createFakeConnection([rows]);
    await expect(createTestDb(conn).getMenu()).resolves.toEqual(rows);
    expect(conn.query).toHaveBeenCalledWith('USE testdb');
    expect(conn.end).toHaveBeenCalled();
  });

  test('getMenu closes the connection when the query fails', async () => {
    const conn = createFakeConnection();
    conn.execute.mockRejectedValueOnce(new Error('db down'));
    await expect(createTestDb(conn).getMenu()).rejects.toThrow('db down');
    expect(conn.end).toHaveBeenCalled();
  });

  test('addMenuItem inserts the item and returns it with its new id', async () => {
    const conn = createFakeConnection([{ insertId: 6 }]);
    const item = { title: 'Student', description: 'carbs', image: 'p.png', price: 0.0001 };
    await expect(createTestDb(conn).addMenuItem(item)).resolves.toEqual({ ...item, id: 6 });
    expect(conn.execute.mock.calls[0][1]).toEqual(['Student', 'carbs', 'p.png', 0.0001]);
  });
});

describe('orders', () => {
  test('getOrders defaults to the first page and attaches each order\'s items', async () => {
    const conn = createFakeConnection([[{ id: 1 }, { id: 2 }], [{ id: 10 }], []]);

    const result = await createTestDb(conn).getOrders({ id: 4 });

    expect(conn.execute.mock.calls[0][0]).toContain('LIMIT 0,10');
    expect(conn.execute.mock.calls[0][1]).toEqual([4]);
    expect(result).toEqual({ dinerId: 4, page: 1, orders: [{ id: 1, items: [{ id: 10 }] }, { id: 2, items: [] }] });
  });

  test('getOrders offsets later pages', async () => {
    const conn = createFakeConnection([[]]);
    const result = await createTestDb(conn).getOrders({ id: 4 }, 3);
    expect(conn.execute.mock.calls[0][0]).toContain('LIMIT 20,10');
    expect(result).toEqual({ dinerId: 4, page: 3, orders: [] });
  });

  test('addDinerOrder writes the order and every item and returns the order with its id', async () => {
    const conn = createFakeConnection([{ insertId: 50 }, [{ id: 1 }], {}, [{ id: 2 }], {}]);
    const order = { franchiseId: 1, storeId: 2, items: [{ menuId: 1, description: 'Veggie', price: 0.05 }, { menuId: 2, description: 'Pepperoni', price: 0.06 }] };

    const result = await createTestDb(conn).addDinerOrder({ id: 4 }, order);

    expect(result).toEqual({ ...order, id: 50 });
    expect(conn.execute.mock.calls[0][1]).toEqual([4, 1, 2]);
    expect(conn.execute.mock.calls[2][1]).toEqual([50, 1, 'Veggie', 0.05]);
    expect(conn.execute.mock.calls[4][1]).toEqual([50, 2, 'Pepperoni', 0.06]);
  });

  test('addDinerOrder fails for an unknown menu item and closes the connection', async () => {
    const conn = createFakeConnection([{ insertId: 50 }, []]);
    const order = { franchiseId: 1, storeId: 2, items: [{ menuId: 999, description: 'Ghost', price: 1 }] };
    await expect(createTestDb(conn).addDinerOrder({ id: 4 }, order)).rejects.toThrow('No ID found');
    expect(conn.end).toHaveBeenCalled();
  });
});

describe('franchises', () => {
  test('createFranchise resolves admins by email and grants each the franchisee role', async () => {
    const conn = createFakeConnection([[{ id: 4, name: 'F' }], { insertId: 9 }, {}]);

    const result = await createTestDb(conn).createFranchise({ name: 'pizzaPocket', admins: [{ email: 'f@test.com' }] });

    expect(result).toEqual({ id: 9, name: 'pizzaPocket', admins: [{ email: 'f@test.com', id: 4, name: 'F' }] });
    expect(conn.execute.mock.calls[2][1]).toEqual([4, 'franchisee', 9]);
  });

  test('createFranchise fails with 404 for an unknown admin before writing anything', async () => {
    const conn = createFakeConnection([[]]);

    await expect(createTestDb(conn).createFranchise({ name: 'pizzaPocket', admins: [{ email: 'ghost@test.com' }] })).rejects.toMatchObject({ statusCode: 404 });
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(conn.end).toHaveBeenCalled();
  });

  test('deleteFranchise commits the transaction on success', async () => {
    const conn = createFakeConnection([{}, {}, {}]);

    await createTestDb(conn).deleteFranchise(3);

    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.end).toHaveBeenCalled();
  });

  test('deleteFranchise rolls back and reports 500 when a statement fails', async () => {
    const conn = createFakeConnection([{}]);
    conn.execute.mockRejectedValueOnce(new Error('fk violation'));

    await expect(createTestDb(conn).deleteFranchise(3)).rejects.toMatchObject({ statusCode: 500, message: 'unable to delete franchise' });

    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.end).toHaveBeenCalled();
  });

  test('getFranchises trims to the limit, reports more, and gives non-admins stores only', async () => {
    const conn = createFakeConnection([[{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }], [{ id: 11, name: 's1' }], [{ id: 12, name: 's2' }]]);

    const [franchises, more] = await createTestDb(conn).getFranchises(undefined, 0, 2, 'p*');

    expect(conn.execute.mock.calls[0][1]).toEqual(['p%']);
    expect(more).toBe(true);
    expect(franchises).toEqual([{ id: 1, name: 'a', stores: [{ id: 11, name: 's1' }] }, { id: 2, name: 'b', stores: [{ id: 12, name: 's2' }] }]);
  });

  test('getFranchises reports no more when the page is not full', async () => {
    const conn = createFakeConnection([[{ id: 1, name: 'a' }], [{ id: 11, name: 's1' }]]);
    const [franchises, more] = await createTestDb(conn).getFranchises(undefined, 0, 2);
    expect(more).toBe(false);
    expect(franchises).toHaveLength(1);
  });

  test('getFranchises loads full details for an admin caller', async () => {
    const conn = createFakeConnection([[{ id: 1, name: 'a' }]]);
    const db = createTestDb(conn);
    const detail = jest.spyOn(db, 'getFranchise').mockImplementation(async (f) => Object.assign(f, { admins: [], stores: [] }));

    await db.getFranchises(makeAdmin(1), 0, 10, '*');

    expect(detail).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  // BUG (SQL interpolation): req.query values are strings, so limit + 1 concatenates ('10' + 1 = '101')
  // and the raw value is interpolated into the SQL.
  test('treats a string limit from the query string as a number', async () => {
    const conn = createFakeConnection([[]]);
    await createTestDb(conn).getFranchises(undefined, '0', '10', '*');
    expect(conn.execute.mock.calls[0][0]).toContain('LIMIT 11 OFFSET 0');
  });

  test('rejects a non-numeric limit with 400 before touching SQL', async () => {
    const conn = createFakeConnection([[]]);
    await expect(createTestDb(conn).getFranchises(undefined, 0, '1 UNION SELECT password FROM user', '*')).rejects.toMatchObject({ statusCode: 400 });
    expect(conn.execute).not.toHaveBeenCalled();
  });

  test('getUserFranchises returns an empty list when the user administers none', async () => {
    const conn = createFakeConnection([[]]);
    await expect(createTestDb(conn).getUserFranchises(20)).resolves.toEqual([]);
  });

  test('getUserFranchises loads details for each franchise the user administers', async () => {
    const conn = createFakeConnection([[{ objectId: 3 }], [{ id: 3, name: 'p' }]]);
    const db = createTestDb(conn);
    const detail = jest.spyOn(db, 'getFranchise').mockImplementation(async (f) => Object.assign(f, { admins: [], stores: [] }));

    const result = await db.getUserFranchises(20);

    expect(detail).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 3, name: 'p', admins: [], stores: [] }]);
  });

  test('getFranchise attaches admins and stores with revenue', async () => {
    const admins = [{ id: 20, name: 'f', email: 'f@test.com' }];
    const stores = [{ id: 8, name: 'SLC', totalRevenue: 1.5 }];
    const conn = createFakeConnection([admins, stores]);

    const result = await createTestDb(conn).getFranchise({ id: 3, name: 'p' });

    expect(result).toEqual({ id: 3, name: 'p', admins, stores });
    expect(conn.execute.mock.calls[0][1]).toEqual([3]);
  });
});

describe('stores', () => {
  test('createStore inserts under the franchise and returns the store', async () => {
    const conn = createFakeConnection([{ insertId: 8 }]);
    await expect(createTestDb(conn).createStore(3, { name: 'SLC' })).resolves.toEqual({ id: 8, franchiseId: 3, name: 'SLC' });
    expect(conn.execute.mock.calls[0][1]).toEqual([3, 'SLC']);
  });

  test('deleteStore only deletes a store belonging to the franchise', async () => {
    const conn = createFakeConnection([{}]);
    await createTestDb(conn).deleteStore(3, 8);
    expect(conn.execute.mock.calls[0][1]).toEqual([3, 8]);
    expect(conn.execute.mock.calls[0][0]).toContain('franchiseId=?');
  });
});

describe('helpers', () => {
  test.each([
    [1, 0],
    [3, 20],
    [undefined, 0],
  ])('getOffset(%s) is %s with 10 per page', (page, expected) => {
    expect(createTestDb(createFakeConnection()).getOffset(page, 10)).toBe(expected);
  });

  test.each([
    ['a.b.sig', 'sig'],
    ['a.b', ''],
    ['', ''],
  ])('getTokenSignature(%j) is %j', (token, expected) => {
    expect(createTestDb(createFakeConnection()).getTokenSignature(token)).toBe(expected);
  });

  test('getID returns the id of the matching row', async () => {
    const conn = createFakeConnection([[{ id: 4 }]]);
    await expect(createTestDb(conn).getID(conn, 'name', 'pizzaPocket', 'franchise')).resolves.toBe(4);
  });

  test('getID throws when no row matches', async () => {
    const conn = createFakeConnection([[]]);
    await expect(createTestDb(conn).getID(conn, 'name', 'nope', 'franchise')).rejects.toThrow('No ID found');
  });
});

describe('database initialization', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('an existing database only ensures the schema and creates no default admin', async () => {
    const conn = createFakeConnection([[{ SCHEMA_NAME: 'testdb' }]]);
    const db = new DB({ connect: async () => conn, config: testConfig });
    const addUser = jest.spyOn(db, 'addUser').mockResolvedValue({});

    await db.init();

    expect(conn.query).toHaveBeenCalledWith('CREATE DATABASE IF NOT EXISTS testdb');
    expect(conn.query).toHaveBeenCalledWith('USE testdb');
    expect(conn.query).toHaveBeenCalledTimes(2 + dbModel.tableCreateStatements.length);
    expect(addUser).not.toHaveBeenCalled();
    expect(conn.end).toHaveBeenCalled();
  });

  test('a new database also creates the default admin', async () => {
    const conn = createFakeConnection([[]]);
    const db = new DB({ connect: async () => conn, config: testConfig });
    const addUser = jest.spyOn(db, 'addUser').mockResolvedValue({});

    await db.init();

    expect(addUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@jwt.com', roles: [{ role: 'admin' }] }));
  });

  test('init runs initialization only once', async () => {
    const conn = createFakeConnection([[{ SCHEMA_NAME: 'testdb' }]]);
    const connect = jest.fn(async () => conn);
    const db = new DB({ connect, config: testConfig });

    const first = db.init();
    expect(db.init()).toBe(first);
    await first;

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
