const { createUserRouter } = require('../src/routes/userRouter.js');
const { createFakeDb } = require('./helpers/fakeDb.js');
const { createReq, createRes } = require('./helpers/fakeHttp.js');
const { makeDiner, makeAdmin } = require('./helpers/fixtures.js');

function setup(dbImpls = {}) {
  const db = createFakeDb(dbImpls);
  const auth = { setAuth: jest.fn(async () => 'new-token'), authenticateToken: (req, res, next) => next() };
  const { handlers } = createUserRouter({ db, auth });
  return { db, auth, handlers };
}

describe('getMe', () => {
  test('returns the authenticated user without a password or role helper', async () => {
    const { handlers } = setup();
    const user = makeDiner(3);
    const res = createRes();

    await handlers.getMe(createReq({ user }), res);

    const body = JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
    expect(body).toEqual({ id: 3, name: user.name, email: user.email, roles: user.roles });
  });
});

describe('updateUser', () => {
  const updated = { id: 3, name: 'New Name', email: 'new@test.com', roles: [{ role: 'diner' }] };

  test('lets a user update themselves and returns the refreshed user and token', async () => {
    const { db, auth, handlers } = setup({ updateUser: async () => updated });
    const res = createRes();

    await handlers.updateUser(createReq({ user: makeDiner(3), params: { userId: '3' }, body: { name: 'New Name', email: 'new@test.com', password: 'pw' } }), res);

    expect(db.updateUser).toHaveBeenCalledWith(3, 'New Name', 'new@test.com', 'pw');
    expect(auth.setAuth).toHaveBeenCalledWith(updated);
    expect(res.json).toHaveBeenCalledWith({ user: updated, token: 'new-token' });
  });

  test('passes through a partial update', async () => {
    const { db, handlers } = setup({ updateUser: async () => updated });

    await handlers.updateUser(createReq({ user: makeDiner(3), params: { userId: '3' }, body: { name: 'Only Name' } }), createRes());

    expect(db.updateUser).toHaveBeenCalledWith(3, 'Only Name', undefined, undefined);
  });

  test('lets an admin update another user', async () => {
    const { db, handlers } = setup({ updateUser: async () => updated });

    await handlers.updateUser(createReq({ user: makeAdmin(1), params: { userId: '9' }, body: { name: 'New Name' } }), createRes());

    expect(db.updateUser).toHaveBeenCalledWith(9, 'New Name', undefined, undefined);
  });

  test('forbids an ordinary user from updating someone else, with no update or token', async () => {
    const { db, auth, handlers } = setup();
    const res = createRes();

    await handlers.updateUser(createReq({ user: makeDiner(3), params: { userId: '9' }, body: { name: 'Hacked' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'unauthorized' });
    expect(db.updateUser).not.toHaveBeenCalled();
    expect(auth.setAuth).not.toHaveBeenCalled();
  });
});
