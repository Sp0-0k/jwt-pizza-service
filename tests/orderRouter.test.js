const { createOrderRouter } = require('../src/routes/orderRouter.js');
const { createFakeDb } = require('./helpers/fakeDb.js');
const { createReq, createRes } = require('./helpers/fakeHttp.js');
const { makeDiner, makeAdmin, makeFranchisee } = require('./helpers/fixtures.js');

function setup(dbImpls = {}, createOrderImpl) {
  const db = createFakeDb(dbImpls);
  const auth = { authenticateToken: (req, res, next) => next() };
  const factoryClient = { createOrder: jest.fn(createOrderImpl ?? (async () => ({ ok: true, body: {} }))) };
  const { handlers } = createOrderRouter({ db, auth, factoryClient });
  return { db, factoryClient, handlers };
}

describe('getMenu', () => {
  test('sends the menu', async () => {
    const menu = [{ id: 1, title: 'Veggie' }];
    const { handlers } = setup({ getMenu: async () => menu });
    const res = createRes();
    await handlers.getMenu(createReq(), res);
    expect(res.send).toHaveBeenCalledWith(menu);
  });

  test('sends an empty menu', async () => {
    const { handlers } = setup({ getMenu: async () => [] });
    const res = createRes();
    await handlers.getMenu(createReq(), res);
    expect(res.send).toHaveBeenCalledWith([]);
  });
});

describe('addMenuItem', () => {
  const item = { title: 'Student', description: 'Just carbs', image: 'pizza9.png', price: 0.0001 };

  test.each([
    ['diner', makeDiner(2)],
    ['franchisee', makeFranchisee(2, 3)],
  ])('forbids a %s and writes nothing', async (name, user) => {
    const { db, handlers } = setup();
    await expect(handlers.addMenuItem(createReq({ user, body: item }), createRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(db.addMenuItem).not.toHaveBeenCalled();
  });

  test('lets an admin add an item and returns the updated menu', async () => {
    const menu = [{ id: 1, ...item }];
    const { db, handlers } = setup({ addMenuItem: async () => ({ id: 1, ...item }), getMenu: async () => menu });
    const res = createRes();

    await handlers.addMenuItem(createReq({ user: makeAdmin(1), body: item }), res);

    expect(db.addMenuItem).toHaveBeenCalledWith(item);
    expect(res.send).toHaveBeenCalledWith(menu);
  });
});

describe('getOrders', () => {
  test('returns only the authenticated diner\'s orders for the requested page', async () => {
    const diner = makeDiner(4);
    const page = { dinerId: 4, orders: [], page: 2 };
    const { db, handlers } = setup({ getOrders: async () => page });
    const res = createRes();

    await handlers.getOrders(createReq({ user: diner, query: { page: '2' } }), res);

    expect(db.getOrders).toHaveBeenCalledWith(diner, '2');
    expect(res.json).toHaveBeenCalledWith(page);
  });
});

describe('createOrder', () => {
  const orderReq = { franchiseId: 1, storeId: 2, items: [{ menuId: 1, description: 'Veggie', price: 0.05 }] };
  const stored = { ...orderReq, id: 77 };
  const diner = makeDiner(4);

  test('persists the order, sends it to the factory and returns the factory jwt', async () => {
    const { db, factoryClient, handlers } = setup(
      { addDinerOrder: async () => stored },
      async () => ({ ok: true, body: { reportUrl: 'https://report', jwt: 'factory.jwt' } })
    );
    const res = createRes();

    await handlers.createOrder(createReq({ user: diner, body: orderReq }), res);

    expect(db.addDinerOrder).toHaveBeenCalledWith(diner, orderReq);
    expect(factoryClient.createOrder).toHaveBeenCalledWith({ id: 4, name: diner.name, email: diner.email }, stored);
    expect(res.send).toHaveBeenCalledWith({ order: stored, followLinkToEndChaos: 'https://report', jwt: 'factory.jwt' });
  });

  test('responds 500 with the report link when the factory refuses the order', async () => {
    const { handlers } = setup({ addDinerOrder: async () => stored }, async () => ({ ok: false, body: { reportUrl: 'https://report' } }));
    const res = createRes();

    await handlers.createOrder(createReq({ user: diner, body: orderReq }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: 'https://report' });
  });

  test('propagates a factory network failure', async () => {
    const { handlers } = setup({ addDinerOrder: async () => stored }, async () => {
      throw new Error('network down');
    });

    await expect(handlers.createOrder(createReq({ user: diner, body: orderReq }), createRes())).rejects.toThrow('network down');
  });

  test('does not call the factory when persisting the order fails', async () => {
    const { factoryClient, handlers } = setup({
      addDinerOrder: async () => {
        throw new Error('No ID found');
      },
    });

    await expect(handlers.createOrder(createReq({ user: diner, body: orderReq }), createRes())).rejects.toThrow('No ID found');
    expect(factoryClient.createOrder).not.toHaveBeenCalled();
  });
});
