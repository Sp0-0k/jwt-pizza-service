const { createFranchiseRouter } = require('../src/routes/franchiseRouter.js');
const { createFakeDb } = require('./helpers/fakeDb.js');
const { createReq, createRes } = require('./helpers/fakeHttp.js');
const { makeDiner, makeAdmin, makeFranchisee } = require('./helpers/fixtures.js');

function setup(dbImpls = {}) {
  const db = createFakeDb(dbImpls);
  const auth = { authenticateToken: (req, res, next) => next() };
  const { handlers } = createFranchiseRouter({ db, auth });
  return { db, handlers };
}

// Franchise 3 is administered by user 20.
const franchise = { id: 3, name: 'pizzaPocket', admins: [{ id: 20, name: 'f', email: 'f@test.com' }], stores: [] };
const owner = makeFranchisee(20, 3);
const otherFranchisee = makeFranchisee(21, 4);

describe('getFranchises', () => {
  test('passes the caller and paging/filter params to the DB and returns franchises with more', async () => {
    const user = makeDiner(2);
    const { db, handlers } = setup({ getFranchises: async () => [[franchise], true] });
    const res = createRes();

    await handlers.getFranchises(createReq({ user, query: { page: '1', limit: '5', name: 'pizza*' } }), res);

    expect(db.getFranchises).toHaveBeenCalledWith(user, '1', '5', 'pizza*');
    expect(res.json).toHaveBeenCalledWith({ franchises: [franchise], more: true });
  });

  test('returns an empty page', async () => {
    const { handlers } = setup({ getFranchises: async () => [[], false] });
    const res = createRes();
    await handlers.getFranchises(createReq({ query: {} }), res);
    expect(res.json).toHaveBeenCalledWith({ franchises: [], more: false });
  });
});

describe('getUserFranchises', () => {
  test('lets a user list their own franchises', async () => {
    const { db, handlers } = setup({ getUserFranchises: async () => [franchise] });
    const res = createRes();
    await handlers.getUserFranchises(createReq({ user: owner, params: { userId: '20' } }), res);
    expect(db.getUserFranchises).toHaveBeenCalledWith(20);
    expect(res.json).toHaveBeenCalledWith([franchise]);
  });

  test('lets an admin list another user\'s franchises', async () => {
    const { db, handlers } = setup({ getUserFranchises: async () => [franchise] });
    const res = createRes();
    await handlers.getUserFranchises(createReq({ user: makeAdmin(1), params: { userId: '20' } }), res);
    expect(db.getUserFranchises).toHaveBeenCalledWith(20);
    expect(res.json).toHaveBeenCalledWith([franchise]);
  });

  test('returns an empty list without a lookup for another ordinary user', async () => {
    const { db, handlers } = setup();
    const res = createRes();
    await handlers.getUserFranchises(createReq({ user: makeDiner(2), params: { userId: '20' } }), res);
    expect(db.getUserFranchises).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([]);
  });
});

describe('createFranchise', () => {
  const body = { name: 'pizzaPocket', admins: [{ email: 'f@test.com' }] };

  test.each([
    ['diner', makeDiner(2)],
    ['franchisee', owner],
  ])('forbids a %s and creates nothing', async (name, user) => {
    const { db, handlers } = setup();
    await expect(handlers.createFranchise(createReq({ user, body }), createRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.createFranchise).not.toHaveBeenCalled();
  });

  test('lets an admin create a franchise and returns it', async () => {
    const created = { ...body, id: 9 };
    const { db, handlers } = setup({ createFranchise: async () => created });
    const res = createRes();
    await handlers.createFranchise(createReq({ user: makeAdmin(1), body }), res);
    expect(db.createFranchise).toHaveBeenCalledWith(body);
    expect(res.send).toHaveBeenCalledWith(created);
  });
});

describe('deleteFranchise', () => {
  // BUG (unauthenticated franchise delete): the handler and route have no role check.
  test.each([
    ['diner', makeDiner(2)],
    ['franchisee', owner],
    ['anonymous caller', undefined],
  ])('forbids a %s and deletes nothing', async (name, user) => {
    const { db, handlers } = setup();
    await expect(handlers.deleteFranchise(createReq({ user, params: { franchiseId: '3' } }), createRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.deleteFranchise).not.toHaveBeenCalled();
  });

  test('lets an admin delete a franchise', async () => {
    const { db, handlers } = setup({ deleteFranchise: async () => {} });
    const res = createRes();
    await handlers.deleteFranchise(createReq({ user: makeAdmin(1), params: { franchiseId: '3' } }), res);
    expect(db.deleteFranchise).toHaveBeenCalledWith(3);
    expect(res.json).toHaveBeenCalledWith({ message: 'franchise deleted' });
  });
});

describe('createStore', () => {
  const body = { name: 'SLC' };
  const store = { id: 8, franchiseId: 3, name: 'SLC' };

  test.each([
    ['an admin', makeAdmin(1)],
    ['the franchise\'s franchisee', owner],
  ])('lets %s create a store', async (name, user) => {
    const { db, handlers } = setup({ getFranchise: async () => franchise, createStore: async () => store });
    const res = createRes();
    await handlers.createStore(createReq({ user, params: { franchiseId: '3' }, body }), res);
    expect(db.createStore).toHaveBeenCalledWith(3, body);
    expect(res.send).toHaveBeenCalledWith(store);
  });

  test.each([
    ['a diner', makeDiner(2)],
    ['another franchise\'s franchisee', otherFranchisee],
  ])('forbids %s and creates nothing', async (name, user) => {
    const { db, handlers } = setup({ getFranchise: async () => franchise });
    await expect(handlers.createStore(createReq({ user, params: { franchiseId: '3' }, body }), createRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.createStore).not.toHaveBeenCalled();
  });

  test('forbids creation for an unknown franchise', async () => {
    const { db, handlers } = setup({ getFranchise: async () => null });
    await expect(handlers.createStore(createReq({ user: makeAdmin(1), params: { franchiseId: '99' }, body }), createRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.createStore).not.toHaveBeenCalled();
  });

  test('uses the franchise id from the path, not one in the body', async () => {
    const { db, handlers } = setup({ getFranchise: async () => franchise, createStore: async () => store });
    await handlers.createStore(createReq({ user: makeAdmin(1), params: { franchiseId: '3' }, body: { name: 'SLC', franchiseId: 4 } }), createRes());
    expect(db.createStore).toHaveBeenCalledWith(3, { name: 'SLC', franchiseId: 4 });
  });
});

describe('deleteStore', () => {
  const params = { franchiseId: '3', storeId: '8' };

  test.each([
    ['an admin', makeAdmin(1)],
    ['the franchise\'s franchisee', owner],
  ])('lets %s delete a store', async (name, user) => {
    const { db, handlers } = setup({ getFranchise: async () => franchise, deleteStore: async () => {} });
    const res = createRes();
    await handlers.deleteStore(createReq({ user, params }), res);
    expect(db.deleteStore).toHaveBeenCalledWith(3, 8);
    expect(res.json).toHaveBeenCalledWith({ message: 'store deleted' });
  });

  test.each([
    ['a diner', makeDiner(2)],
    ['another franchise\'s franchisee', otherFranchisee],
  ])('forbids %s and deletes nothing', async (name, user) => {
    const { db, handlers } = setup({ getFranchise: async () => franchise });
    await expect(handlers.deleteStore(createReq({ user, params }), createRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.deleteStore).not.toHaveBeenCalled();
  });

  test('forbids deletion for an unknown franchise', async () => {
    const { db, handlers } = setup({ getFranchise: async () => null });
    await expect(handlers.deleteStore(createReq({ user: makeAdmin(1), params }), createRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.deleteStore).not.toHaveBeenCalled();
  });
});
