const express = require('express');
const request = require('supertest');
const { createLogger } = require('../src/logger.js');

const config = {
  logging: { source: 'jwt-pizza-service-test', endpointUrl: 'https://loki.test/push', accountId: '42', apiKey: 'glc_secret' },
};

function setup(overrides = {}) {
  const fetch = jest.fn().mockResolvedValue({ ok: true });
  const logger = createLogger({ config, fetch, enabled: true, ...overrides });
  // Returns every Loki entry that was pushed: { labels, line (parsed) }
  const entries = () =>
    fetch.mock.calls.map(([, init]) => {
      const { stream, values } = JSON.parse(init.body).streams[0];
      return { labels: stream, line: JSON.parse(values[0][1]), raw: values[0][1] };
    });
  return { fetch, logger, entries };
}

describe('sanitize', () => {
  const { logger } = setup();

  test('redacts sensitive keys at any depth', () => {
    const out = logger.sanitize({ email: 'a@b.c', password: 'pw', nested: [{ token: 't', apiKey: 'k', jwt: 'j', Authorization: 'x' }] });

    expect(out).toEqual({ email: '*****', password: '*****', nested: [{ token: '*****', apiKey: '*****', jwt: '*****', Authorization: '*****' }] });
  });

  test('parses and redacts JSON strings', () => {
    expect(logger.sanitize('{"password":"pw","name":"x"}')).toEqual({ password: '*****', name: 'x' });
  });

  test('redacts bearer tokens and JWT-shaped values inside plain strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2ln';

    expect(logger.sanitize(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
    expect(logger.sanitize(`token is ${jwt}`)).toBe('token is *****');
  });

  test('does not mutate its input and survives circular references', () => {
    const input = { password: 'pw' };
    input.self = input;

    const out = logger.sanitize(input);

    expect(input.password).toBe('pw');
    expect(out.password).toBe('*****');
  });
});

describe('PII', () => {
  const { logger } = setup();
  const person = { id: 3, name: 'Pat Person', email: 'pat@example.com', roles: [{ role: 'diner' }] };

  test('masks email and the name of user-shaped objects', () => {
    expect(logger.sanitize(person)).toEqual({ id: 3, name: '*****', email: '*****', roles: [{ role: 'diner' }] });
  });

  test('masks every person in lists and nested franchise admins, keeping business names', () => {
    const franchises = [{ id: 1, name: 'Pizza Palace', admins: [person, { ...person, id: 4, name: 'Sam', email: 's@x.io' }], stores: [{ id: 9, name: 'SLC' }] }];

    const raw = JSON.stringify(logger.sanitize({ users: [person], franchises }));

    for (const pii of ['Pat Person', 'pat@example.com', 'Sam', 's@x.io']) expect(raw).not.toContain(pii);
    for (const kept of ['Pizza Palace', 'SLC']) expect(raw).toContain(kept);
  });

  test('masks the factory diner and an email-only admin on franchise creation', () => {
    const out = logger.sanitize({ request: { diner: person, order: { items: [{ description: 'Veggie' }] } }, admins: [{ email: 'f@x.io' }] });

    expect(JSON.stringify(out)).not.toMatch(/Pat Person|pat@example|f@x\.io/);
    expect(JSON.stringify(out)).toContain('Veggie');
  });

  test('scrubs email addresses inside free text such as database errors', () => {
    expect(logger.sanitize("Duplicate entry 'pat@example.com' for key 'user.email'")).toBe("Duplicate entry '*****' for key 'user.email'");
  });

  test('a login typo that puts a password in the email field is still masked', () => {
    expect(JSON.stringify(logger.sanitize({ email: 'hunter2', password: 'hunter2' }))).not.toContain('hunter2');
  });

  test('http logs drop search terms from the query string but keep numeric paging', async () => {
    const { logger: l, entries } = setup();
    const app = express();
    app.use(l.httpLogger);
    app.get('/api/user', (req, res) => res.json({ users: [person], more: false }));

    await request(app).get('/api/user?page=2&limit=10&name=Pat%20Person');

    const { line, raw } = entries()[0];
    expect(line).toMatchObject({ path: '/api/user', query: { page: 2, limit: 10 } });
    expect(raw).not.toMatch(/Pat|pat@example|Person/);
  });
});

describe('log', () => {
  test('pushes a Loki stream with labels and auth header', async () => {
    const { fetch, logger, entries } = setup();

    await logger.log('info', 'db', { sql: 'SELECT 1' });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(config.logging.endpointUrl);
    expect(init.headers.Authorization).toBe('Bearer 42:glc_secret');
    expect(entries()[0].labels).toEqual({ component: 'jwt-pizza-service-test', level: 'info', type: 'db' });
    expect(entries()[0].line).toEqual({ sql: 'SELECT 1' });
  });

  test('uses a nanosecond timestamp string', async () => {
    const { fetch, logger } = setup();

    await logger.log('info', 'db', 'x');

    const ts = JSON.parse(fetch.mock.calls[0][1].body).streams[0].values[0][0];
    expect(ts).toMatch(/^\d{19}$/);
  });

  test('never throws or rejects when Grafana is down or returns an error', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const down = setup({ fetch: jest.fn().mockRejectedValue(new Error('offline')) });
    const bad = setup({ fetch: jest.fn().mockResolvedValue({ ok: false, status: 401 }) });

    await expect(down.logger.log('info', 'db', 'x')).resolves.toBeUndefined();
    await expect(bad.logger.log('info', 'db', 'x')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  test('is a no-op when disabled or when logging config is missing', async () => {
    const off = setup({ enabled: false });
    const missing = setup({ config: {} });

    await off.logger.log('info', 'db', 'x');
    await missing.logger.log('info', 'db', 'x');

    expect(off.fetch).not.toHaveBeenCalled();
    expect(missing.fetch).not.toHaveBeenCalled();
  });
});

describe('httpLogger', () => {
  function appWith(logger) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.headers.authorization) req.user = { id: 7, name: 'Pat', email: 'pat@x.y', roles: [{ role: 'diner' }] };
      next();
    });
    app.use(logger.httpLogger);
    app.put('/api/auth', (req, res) => res.json({ user: { id: 7 }, token: 'secret-token' }));
    app.get('/api/boom', (req, res) => res.status(500).json({ message: 'boom' }));
    app.get('/api/missing', (req, res) => res.status(404).send('nope'));
    app.get('/api/db', async (req, res) => {
      logger.logDb('SELECT * FROM user WHERE id=?');
      await Promise.resolve();
      logger.logDb('SELECT * FROM auth');
      res.send('ok');
    });
    return app;
  }

  test('logs method, path, status, auth flag, user and both bodies, sanitized', async () => {
    const { logger, entries } = setup();

    await request(appWith(logger)).put('/api/auth').set('Authorization', 'Bearer abc').send({ email: 'a@b.c', password: 'hunter2' });

    const { labels, line, raw } = entries()[0];
    expect(labels).toMatchObject({ type: 'http', level: 'info' });
    expect(line).toMatchObject({
      method: 'PUT',
      path: '/api/auth',
      statusCode: 200,
      authorized: true,
      user: { id: 7 },
      reqBody: { email: '*****', password: '*****' },
      resBody: { user: { id: 7 }, token: '*****' },
    });
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('a@b.c');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('Bearer abc');
  });

  test('anonymous requests have authorized=false and no user', async () => {
    const { logger, entries } = setup();

    await request(appWith(logger)).get('/api/missing');

    expect(entries()[0].line).toMatchObject({ authorized: false, user: null, statusCode: 404, resBody: 'nope' });
    expect(entries()[0].labels.level).toBe('warn');
  });

  test('5xx responses log at error level', async () => {
    const { logger, entries } = setup();

    await request(appWith(logger)).get('/api/boom');

    expect(entries()[0].labels.level).toBe('error');
  });

  test('logs exactly one entry per request', async () => {
    const { logger, fetch } = setup();

    await request(appWith(logger)).put('/api/auth').send({});

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('DB logs made during a request carry that request\'s user, even after awaits', async () => {
    const { logger, entries } = setup();

    await request(appWith(logger)).get('/api/db').set('Authorization', 'Bearer abc');

    const db = entries().filter((e) => e.labels.type === 'db');
    expect(db.map((e) => e.line)).toEqual([
      { sql: 'SELECT * FROM user WHERE id=####', user: { id: 7 } },
      { sql: 'SELECT * FROM auth', user: { id: 7 } },
    ]);
  });
});

describe('logError filtering', () => {
  test('skips expected 4xx errors but logs 5xx and status-less errors', async () => {
    const { logger, fetch } = setup();

    await logger.logError(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    expect(fetch).not.toHaveBeenCalled();

    await logger.logError(Object.assign(new Error('bad'), { statusCode: 500 }));
    await logger.logError(new Error('surprise'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('logDb / logFactory / logError outside a request', () => {
  test('logDb masks every placeholder as ####', async () => {
    const { logger, entries } = setup();

    await logger.logDb('INSERT INTO t (a, b) VALUES (?, ?)');

    expect(entries()[0].line.sql).toBe('INSERT INTO t (a, b) VALUES (####, ####)');
  });

  test('logDb has a null user', async () => {
    const { logger, entries } = setup();

    await logger.logDb('SELECT 1');

    expect(entries()[0].line).toEqual({ sql: 'SELECT 1', user: null });
  });

  test('logFactory logs request and response with secrets redacted', async () => {
    const { logger, entries } = setup();

    await logger.logFactory({ request: { diner: { id: 1 }, order: {} }, response: { ok: true, body: { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2ln', reportUrl: 'u' } } });

    const { labels, line } = entries()[0];
    expect(labels.type).toBe('factory');
    expect(line.response.body).toEqual({ jwt: '*****', reportUrl: 'u' });
    expect(line.user).toBeNull();
  });

  test('logError records message and status but never the stack', async () => {
    const { logger, entries } = setup();
    const err = Object.assign(new Error('kaboom'), { statusCode: 500 });

    await logger.logError(err);

    expect(entries()[0].labels).toMatchObject({ type: 'unhandledError', level: 'error' });
    expect(entries()[0].line).toMatchObject({ message: 'kaboom', status: 500 });
    expect(entries()[0].line).not.toHaveProperty('stack');
    expect(entries()[0].raw).not.toContain('at ');
  });
});
