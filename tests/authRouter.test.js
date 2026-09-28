const jwt = require('jsonwebtoken');
const config = require('../src/config.js');
const { createAuth, createAuthRouter } = require('../src/routes/authRouter.js');
const { StatusCodeError } = require('../src/endpointHelper.js');
const { Role } = require('../src/model/model.js');
const { createFakeDb } = require('./helpers/fakeDb.js');
const { createReq, createRes } = require('./helpers/fakeHttp.js');
const { makeDiner } = require('./helpers/fixtures.js');
const { signToken } = require('./helpers/tokens.js');

const bearer = (token) => ({ authorization: `Bearer ${token}` });

afterEach(() => {
  jest.restoreAllMocks();
});

describe('auth.setAuthUser', () => {
  async function run(db, headers) {
    const req = createReq({ headers });
    const next = jest.fn();
    await createAuth({ db }).setAuthUser(req, createRes(), next);
    return { req, next };
  }

  test('leaves req.user unset without an Authorization header', async () => {
    const db = createFakeDb();
    const { req, next } = await run(db, {});
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(db.isLoggedIn).not.toHaveBeenCalled();
  });

  test('leaves req.user unset when the header has no token', async () => {
    const db = createFakeDb();
    const { req } = await run(db, { authorization: 'Bearer' });
    expect(req.user).toBeUndefined();
    expect(db.isLoggedIn).not.toHaveBeenCalled();
  });

  test('sets req.user with working role checks for a valid, active token', async () => {
    const diner = makeDiner(5);
    const token = signToken(diner);
    const db = createFakeDb({ isLoggedIn: async () => true });

    const { req, next } = await run(db, bearer(token));

    expect(db.isLoggedIn).toHaveBeenCalledWith(token);
    expect(req.user).toMatchObject({ id: 5, name: diner.name, email: diner.email });
    expect(req.user.isRole(Role.Diner)).toBe(true);
    expect(req.user.isRole(Role.Admin)).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('does not authenticate a token the database says is revoked', async () => {
    const db = createFakeDb({ isLoggedIn: async () => false });
    const { req, next } = await run(db, bearer(signToken(makeDiner(5))));
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects a token whose payload was tampered with to grant admin', async () => {
    const [header, , signature] = signToken(makeDiner(5)).split('.');
    const adminPayload = Buffer.from(JSON.stringify({ id: 5, name: 'x', email: 'x@test.com', roles: [{ role: Role.Admin }] })).toString('base64url');
    const db = createFakeDb({ isLoggedIn: async () => true });

    const { req } = await run(db, bearer(`${header}.${adminPayload}.${signature}`));

    expect(req.user).toBeFalsy();
  });

  test('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ id: 5, roles: [{ role: Role.Admin }] }, 'some-other-secret');
    const db = createFakeDb({ isLoggedIn: async () => true });
    const { req } = await run(db, bearer(forged));
    expect(req.user).toBeFalsy();
  });

  test('rejects an expired token', async () => {
    const db = createFakeDb({ isLoggedIn: async () => true });
    const { req } = await run(db, bearer(signToken(makeDiner(5), { expiresIn: -10 })));
    expect(req.user).toBeFalsy();
  });
});

describe('auth.authenticateToken', () => {
  test('responds 401 when there is no user', () => {
    const res = createRes();
    const next = jest.fn();
    createAuth({ db: createFakeDb() }).authenticateToken(createReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: 'unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when there is a user', () => {
    const res = createRes();
    const next = jest.fn();
    createAuth({ db: createFakeDb() }).authenticateToken(createReq({ user: makeDiner() }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('auth.setAuth and auth.clearAuth', () => {
  test('setAuth signs a verifiable token and records the login', async () => {
    const diner = makeDiner(8);
    const db = createFakeDb({ loginUser: async () => {} });

    const token = await createAuth({ db }).setAuth(diner);

    expect(jwt.verify(token, config.jwtSecret)).toMatchObject({ id: 8, email: diner.email });
    expect(db.loginUser).toHaveBeenCalledWith(8, token);
  });

  test('clearAuth logs out the token from the Authorization header', async () => {
    const db = createFakeDb({ logoutUser: async () => {} });
    await createAuth({ db }).clearAuth(createReq({ headers: bearer('a.b.c') }));
    expect(db.logoutUser).toHaveBeenCalledWith('a.b.c');
  });

  test('clearAuth does nothing without a token', async () => {
    const db = createFakeDb();
    await createAuth({ db }).clearAuth(createReq());
    expect(db.logoutUser).not.toHaveBeenCalled();
  });
});

function setup(dbImpls = {}) {
  const db = createFakeDb(dbImpls);
  const auth = {
    setAuth: jest.fn(async () => 'token-123'),
    clearAuth: jest.fn(async () => {}),
    authenticateToken: (req, res, next) => next(),
  };
  const { handlers } = createAuthRouter({ db, auth });
  return { db, auth, handlers };
}

describe('register handler', () => {
  const body = { name: 'New Diner', email: 'new@test.com', password: 'pw' };

  test('creates a diner and returns the user and a token without a password', async () => {
    const created = { id: 9, name: body.name, email: body.email, roles: [{ role: Role.Diner }], password: undefined };
    const { db, auth, handlers } = setup({ addUser: async () => created });
    const res = createRes();

    await handlers.register(createReq({ body }), res);

    expect(db.addUser).toHaveBeenCalledWith({ ...body, roles: [{ role: Role.Diner }] });
    expect(auth.setAuth).toHaveBeenCalledWith(created);
    expect(res.json).toHaveBeenCalledWith({ user: created, token: 'token-123' });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('password');
  });

  test.each(['name', 'email', 'password'])('responds 400 and writes nothing when %s is missing', async (field) => {
    const { db, auth, handlers } = setup();
    const res = createRes();

    await handlers.register(createReq({ body: { ...body, [field]: undefined } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.addUser).not.toHaveBeenCalled();
    expect(auth.setAuth).not.toHaveBeenCalled();
  });

  test('ignores roles supplied by the caller and always registers a diner', async () => {
    const { db, handlers } = setup({ addUser: async (user) => ({ ...user, id: 9 }) });

    await handlers.register(createReq({ body: { ...body, roles: [{ role: Role.Admin }] } }), createRes());

    expect(db.addUser).toHaveBeenCalledWith(expect.objectContaining({ roles: [{ role: Role.Diner }] }));
  });
});

describe('login handler', () => {
  test('returns the user and a token for valid credentials', async () => {
    const user = makeDiner(3);
    const { db, auth, handlers } = setup({ getUser: async () => user });
    const res = createRes();

    await handlers.login(createReq({ body: { email: 'a@test.com', password: 'pw' } }), res);

    expect(db.getUser).toHaveBeenCalledWith('a@test.com', 'pw');
    expect(auth.setAuth).toHaveBeenCalledWith(user);
    expect(res.json).toHaveBeenCalledWith({ user, token: 'token-123' });
  });

  test('does not issue a token for unknown credentials', async () => {
    const { auth, handlers } = setup({
      getUser: async () => {
        throw new StatusCodeError('unknown user', 404);
      },
    });

    await expect(handlers.login(createReq({ body: { email: 'a@test.com', password: 'bad' } }), createRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(auth.setAuth).not.toHaveBeenCalled();
  });

  // BUG (empty-password bypass): a missing password reaches the DB, which skips the password check.
  test.each(['email', 'password'])('responds 400 without a lookup or token when %s is missing', async (field) => {
    const { db, auth, handlers } = setup({ getUser: async () => makeDiner(3) });
    const res = createRes();

    await handlers.login(createReq({ body: { email: 'a@test.com', password: 'pw', [field]: undefined } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.getUser).not.toHaveBeenCalled();
    expect(auth.setAuth).not.toHaveBeenCalled();
  });
});

describe('logout handler', () => {
  test('clears the auth for the request and confirms', async () => {
    const { auth, handlers } = setup();
    const req = createReq({ headers: bearer('a.b.c') });
    const res = createRes();

    await handlers.logout(req, res);

    expect(auth.clearAuth).toHaveBeenCalledWith(req);
    expect(res.json).toHaveBeenCalledWith({ message: 'logout successful' });
  });
});

describe('logout with real auth and a stateful token store', () => {
  function statefulSetup() {
    const active = new Set();
    const db = createFakeDb({
      loginUser: async (id, token) => {
        active.add(token);
      },
      isLoggedIn: async (token) => active.has(token),
      logoutUser: async (token) => {
        active.delete(token);
      },
    });
    const auth = createAuth({ db });
    const { handlers } = createAuthRouter({ db, auth });
    return { auth, handlers };
  }

  async function authenticate(auth, token) {
    const req = createReq({ headers: bearer(token) });
    await auth.setAuthUser(req, createRes(), jest.fn());
    return req.user;
  }

  test('revokes the same token so it cannot be reused', async () => {
    const { auth, handlers } = statefulSetup();
    const token = await auth.setAuth(makeDiner(4));
    expect(await authenticate(auth, token)).toBeTruthy();

    await handlers.logout(createReq({ headers: bearer(token) }), createRes());

    expect(await authenticate(auth, token)).toBeFalsy();
  });

  test('leaves a different session valid', async () => {
    const { auth, handlers } = statefulSetup();
    const first = await auth.setAuth(makeDiner(4));
    const second = await auth.setAuth(makeDiner(5));

    await handlers.logout(createReq({ headers: bearer(first) }), createRes());

    expect(await authenticate(auth, second)).toBeTruthy();
  });
});
