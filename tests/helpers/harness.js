const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const request = require('supertest');
const config = require('../../src/config.js');
const { DB } = require('../../src/database/database.js');
const { createApp } = require('../../src/service.js');
const { Role } = require('../../src/model/model.js');
const { testConfig } = require('../setup/testConfig.js');

const PASSWORD = 'pw-for-tests';

// bcrypt at cost 10 takes ~250ms, so fixtures are inserted with a pre-computed hash (one per distinct
// password). The tests that exercise registration, login and password changes still hash for real.
const hashes = new Map();
const hashFor = (password) => {
  if (!hashes.has(password)) {
    hashes.set(password, bcrypt.hashSync(password, 10));
  }
  return hashes.get(password);
};

const defaultRespond = async () => ({ ok: true, body: { jwt: 'factory.jwt', reportUrl: 'https://report.test' } });

// The one fake in the suite: stands in for the external pizza factory. Records calls; tests change
// `respond` to simulate a refusal or a network failure.
function createStubFactory() {
  const stub = {
    calls: [],
    respond: defaultRespond,
    async createOrder(diner, order) {
      stub.calls.push({ diner, order });
      return stub.respond(diner, order);
    },
  };
  return stub;
}

function createHarness() {
  const db = new DB({ config: testConfig });
  const factory = createStubFactory();
  const app = createApp({ db, factoryClient: factory });
  let counter = 0;

  const nextEmail = (prefix = 'user') => `${prefix}${++counter}@test.com`;

  async function withConnection(fn, useDatabase = true) {
    const { host, user, password, database, connectTimeout } = testConfig.db.connection;
    const connection = await mysql.createConnection({ host, user, password, connectTimeout, decimalNumbers: true, ...(useDatabase ? { database } : {}) });
    try {
      return await fn(connection);
    } finally {
      await connection.end();
    }
  }

  async function query(sql, params) {
    return withConnection(async (connection) => (await connection.query(sql, params))[0]);
  }

  async function serverQuery(sql) {
    return withConnection((connection) => connection.query(sql), false);
  }

  async function start() {
    // Create the database ourselves so DB.init() sees it as existing: for a new database it also inserts a
    // default admin without awaiting it, which would race with the tests.
    await serverQuery(`CREATE DATABASE IF NOT EXISTS \`${testConfig.db.connection.database}\``);
    await db.init();
    const tables = await query('SHOW TABLES');
    if (tables.length === 0) {
      throw new Error('test database was not initialized; check the MySQL connection settings in src/config.js');
    }
  }

  async function reset() {
    await withConnection(async (connection) => {
      const [[{ name }]] = await connection.query('SELECT DATABASE() AS name');
      if (!/_test_\d+$/.test(name)) {
        throw new Error(`refusing to reset non-test database ${name}`);
      }
      const [tables] = await connection.query('SHOW TABLES');
      await connection.query('SET FOREIGN_KEY_CHECKS=0');
      for (const row of tables) {
        await connection.query(`DELETE FROM \`${Object.values(row)[0]}\``);
      }
      await connection.query('SET FOREIGN_KEY_CHECKS=1');
    });
    factory.calls.length = 0;
    factory.respond = defaultRespond;
  }

  function expectOk(res, what) {
    if (res.status !== 200) {
      throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
  }

  function toSession(user, token, password) {
    return { user, token, email: user.email, password, headers: { Authorization: `Bearer ${token}` } };
  }

  // Inserts a user and its roles directly, the way DB.addUser would, but with a cached password hash.
  async function createUser({ name = 'Test Diner', email = nextEmail('diner'), password = PASSWORD, roles = [{ role: Role.Diner }] } = {}) {
    return withConnection(async (connection) => {
      const [{ insertId }] = await connection.query('INSERT INTO user (name, email, password) VALUES (?, ?, ?)', [name, email, hashFor(password)]);
      for (const role of roles) {
        await connection.query('INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)', [insertId, role.role, role.objectId ?? 0]);
      }
      return { id: insertId, name, email, roles: roles.map((r) => ({ objectId: r.objectId || undefined, role: r.role })) };
    });
  }

  // Issues a token exactly as auth.setAuth does: sign the user, record the login.
  async function startSession(user, password = PASSWORD) {
    const token = jwt.sign(user, config.jwtSecret);
    await db.loginUser(user.id, token);
    return toSession(user, token, password);
  }

  // A fresh session for an existing user (picks up roles granted since the last token) without checking a password.
  async function sessionFor(email, password = PASSWORD) {
    const [row] = await query('SELECT id, name, email FROM user WHERE email=?', [email]);
    const roleRows = await query('SELECT role, objectId FROM userRole WHERE userId=?', [row.id]);
    return startSession({ ...row, roles: roleRows.map((r) => ({ objectId: r.objectId || undefined, role: r.role })) }, password);
  }

  // Test setup shortcut: creates a diner and a session without going through the (slow) register endpoint.
  async function register({ name, email, password = PASSWORD } = {}) {
    return startSession(await createUser({ name, email, password }), password);
  }

  // The real login endpoint (real bcrypt compare).
  async function login(email, password = PASSWORD) {
    const res = await request(app).put('/api/auth').send({ email, password });
    const body = expectOk(res, 'login');
    return toSession(body.user, body.token, password);
  }

  async function createAdmin({ name = 'Test Admin', email = nextEmail('admin'), password = PASSWORD } = {}) {
    return startSession(await createUser({ name, email, password, roles: [{ role: Role.Admin }] }), password);
  }

  async function createFranchise(admin, name, adminEmails = []) {
    const res = await request(app)
      .post('/api/franchise')
      .set(admin.headers)
      .send({ name, admins: adminEmails.map((email) => ({ email })) });
    return expectOk(res, 'createFranchise');
  }

  async function createFranchisee(admin, franchiseName = 'pizzaPocket') {
    const owner = await createUser({ name: 'Franchisee', email: nextEmail('franchisee') });
    const franchise = await createFranchise(admin, franchiseName, [owner.email]);
    const franchisee = await sessionFor(owner.email);
    return { franchisee, franchise };
  }

  return { app, db, factory, start, reset, query, serverQuery, nextEmail, createUser, sessionFor, register, login, createAdmin, createFranchise, createFranchisee, PASSWORD };
}

module.exports = { createHarness };
