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

// The helpers below are used by the describe blocks added in later tasks.
module.exports = { testConfig, createFakeConnection, createTestDb, StatusCodeError, dbModel, makeAdmin };
