jest.mock('bcrypt', () => ({
  hash: jest.fn(async (password) => `hashed:${password}`),
  compare: jest.fn(async (password, hash) => hash === `hashed:${password}`),
}));

const { DB } = require('../src/database/database.js');
const { StatusCodeError } = require('../src/endpointHelper.js');
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

// The helpers below are used by the describe blocks added in later tasks.
module.exports = { testConfig, createFakeConnection, createTestDb, StatusCodeError, dbModel, makeAdmin };
