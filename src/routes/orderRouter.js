const express = require('express');
const { Role } = require('../model/model.js');
const { asyncHandler, StatusCodeError } = require('../endpointHelper.js');

const docs = [
  {
    method: 'GET',
    path: '/api/order/menu',
    description: 'Get the pizza menu',
    example: `curl localhost:3000/api/order/menu`,
    response: [{ id: 1, title: 'Veggie', image: 'pizza1.png', price: 0.0038, description: 'A garden of delight' }],
  },
  {
    method: 'PUT',
    path: '/api/order/menu',
    requiresAuth: true,
    description: 'Add an item to the menu',
    example: `curl -X PUT localhost:3000/api/order/menu -H 'Content-Type: application/json' -d '{ "title":"Student", "description": "No topping, no sauce, just carbs", "image":"pizza9.png", "price": 0.0001 }'  -H 'Authorization: Bearer tttttt'`,
    response: [{ id: 1, title: 'Student', description: 'No topping, no sauce, just carbs', image: 'pizza9.png', price: 0.0001 }],
  },
  {
    method: 'GET',
    path: '/api/order',
    requiresAuth: true,
    description: 'Get the orders for the authenticated user',
    example: `curl -X GET localhost:3000/api/order  -H 'Authorization: Bearer tttttt'`,
    response: { dinerId: 4, orders: [{ id: 1, franchiseId: 1, storeId: 1, date: '2024-06-05T05:14:40.000Z', items: [{ id: 1, menuId: 1, description: 'Veggie', price: 0.05 }] }], page: 1 },
  },
  {
    method: 'POST',
    path: '/api/order',
    requiresAuth: true,
    description: 'Create a order for the authenticated user',
    example: `curl -X POST localhost:3000/api/order -H 'Content-Type: application/json' -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}'  -H 'Authorization: Bearer tttttt'`,
    response: { order: { franchiseId: 1, storeId: 1, items: [{ menuId: 1, description: 'Veggie', price: 0.05 }], id: 1 }, jwt: '1111111111' },
  },
];

function createOrderRouter({ db, auth, factoryClient }) {
  const router = express.Router();
  router.docs = docs;

  // getMenu
  async function getMenu(req, res) {
    res.send(await db.getMenu());
  }

  // addMenuItem
  async function addMenuItem(req, res) {
    if (!req.user.isRole(Role.Admin)) {
      throw new StatusCodeError('unable to add menu item', 403);
    }

    const addMenuItemReq = req.body;
    await db.addMenuItem(addMenuItemReq);
    res.send(await db.getMenu());
  }

  // getOrders
  async function getOrders(req, res) {
    res.json(await db.getOrders(req.user, req.query.page));
  }

  // createOrder
  async function createOrder(req, res) {
    const orderReq = req.body;
    const order = await db.addDinerOrder(req.user, orderReq);
    const { ok, body } = await factoryClient.createOrder({ id: req.user.id, name: req.user.name, email: req.user.email }, order);
    if (ok) {
      res.send({ order, followLinkToEndChaos: body.reportUrl, jwt: body.jwt });
    } else {
      res.status(500).send({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: body.reportUrl });
    }
  }

  router.get('/menu', asyncHandler(getMenu));
  router.put('/menu', auth.authenticateToken, asyncHandler(addMenuItem));
  router.get('/', auth.authenticateToken, asyncHandler(getOrders));
  router.post('/', auth.authenticateToken, asyncHandler(createOrder));

  router.handlers = { getMenu, addMenuItem, getOrders, createOrder };
  return router;
}

module.exports = { createOrderRouter };
