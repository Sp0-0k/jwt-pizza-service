const express = require('express');
const { Role } = require('../model/model.js');
const { StatusCodeError, asyncHandler } = require('../endpointHelper.js');

const docs = [
  {
    method: 'GET',
    path: '/api/franchise?page=0&limit=10&name=*',
    description: 'List all the franchises',
    example: `curl localhost:3000/api/franchise&page=0&limit=10&name=pizzaPocket`,
    response: { franchises: [{ id: 1, name: 'pizzaPocket', admins: [{ id: 4, name: 'pizza franchisee', email: 'f@jwt.com' }], stores: [{ id: 1, name: 'SLC', totalRevenue: 0 }] }], more: true },
  },
  {
    method: 'GET',
    path: '/api/franchise/:userId',
    requiresAuth: true,
    description: `List a user's franchises`,
    example: `curl localhost:3000/api/franchise/4  -H 'Authorization: Bearer tttttt'`,
    response: [{ id: 2, name: 'pizzaPocket', admins: [{ id: 4, name: 'pizza franchisee', email: 'f@jwt.com' }], stores: [{ id: 4, name: 'SLC', totalRevenue: 0 }] }],
  },
  {
    method: 'POST',
    path: '/api/franchise',
    requiresAuth: true,
    description: 'Create a new franchise',
    example: `curl -X POST localhost:3000/api/franchise -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt' -d '{"name": "pizzaPocket", "admins": [{"email": "f@jwt.com"}]}'`,
    response: { name: 'pizzaPocket', admins: [{ email: 'f@jwt.com', id: 4, name: 'pizza franchisee' }], id: 1 },
  },
  {
    method: 'DELETE',
    path: '/api/franchise/:franchiseId',
    requiresAuth: true,
    description: `Delete a franchise`,
    example: `curl -X DELETE localhost:3000/api/franchise/1 -H 'Authorization: Bearer tttttt'`,
    response: { message: 'franchise deleted' },
  },
  {
    method: 'POST',
    path: '/api/franchise/:franchiseId/store',
    requiresAuth: true,
    description: 'Create a new franchise store',
    example: `curl -X POST localhost:3000/api/franchise/1/store -H 'Content-Type: application/json' -d '{"franchiseId": 1, "name":"SLC"}' -H 'Authorization: Bearer tttttt'`,
    response: { id: 1, name: 'SLC', totalRevenue: 0 },
  },
  {
    method: 'DELETE',
    path: '/api/franchise/:franchiseId/store/:storeId',
    requiresAuth: true,
    description: `Delete a store`,
    example: `curl -X DELETE localhost:3000/api/franchise/1/store/1  -H 'Authorization: Bearer tttttt'`,
    response: { message: 'store deleted' },
  },
];

function createFranchiseRouter({ db, auth }) {
  const router = express.Router();
  router.docs = docs;

  // getFranchises
  async function getFranchises(req, res) {
    const [franchises, more] = await db.getFranchises(req.user, req.query.page, req.query.limit, req.query.name);
    res.json({ franchises, more });
  }

  // getUserFranchises
  async function getUserFranchises(req, res) {
    let result = [];
    const userId = Number(req.params.userId);
    if (req.user.id === userId || req.user.isRole(Role.Admin)) {
      result = await db.getUserFranchises(userId);
    }

    res.json(result);
  }

  // createFranchise
  async function createFranchise(req, res) {
    if (!req.user.isRole(Role.Admin)) {
      throw new StatusCodeError('unable to create a franchise', 403);
    }

    const franchise = req.body;
    res.send(await db.createFranchise(franchise));
  }

  // deleteFranchise
  async function deleteFranchise(req, res) {
    if (!req.user?.isRole(Role.Admin)) {
      throw new StatusCodeError('unable to delete a franchise', 403);
    }
    const franchiseId = Number(req.params.franchiseId);
    await db.deleteFranchise(franchiseId);
    res.json({ message: 'franchise deleted' });
  }

  // createStore
  async function createStore(req, res) {
    const franchiseId = Number(req.params.franchiseId);
    const franchise = await db.getFranchise({ id: franchiseId });
    if (!franchise || (!req.user.isRole(Role.Admin) && !franchise.admins.some((admin) => admin.id === req.user.id))) {
      throw new StatusCodeError('unable to create a store', 403);
    }

    res.send(await db.createStore(franchise.id, req.body));
  }

  // deleteStore
  async function deleteStore(req, res) {
    const franchiseId = Number(req.params.franchiseId);
    const franchise = await db.getFranchise({ id: franchiseId });
    if (!franchise || (!req.user.isRole(Role.Admin) && !franchise.admins.some((admin) => admin.id === req.user.id))) {
      throw new StatusCodeError('unable to delete a store', 403);
    }

    const storeId = Number(req.params.storeId);
    await db.deleteStore(franchiseId, storeId);
    res.json({ message: 'store deleted' });
  }

  router.get('/', asyncHandler(getFranchises));
  router.get('/:userId', auth.authenticateToken, asyncHandler(getUserFranchises));
  router.post('/', auth.authenticateToken, asyncHandler(createFranchise));
  router.delete('/:franchiseId', auth.authenticateToken, asyncHandler(deleteFranchise));
  router.post('/:franchiseId/store', auth.authenticateToken, asyncHandler(createStore));
  router.delete('/:franchiseId/store/:storeId', auth.authenticateToken, asyncHandler(deleteStore));

  router.handlers = { getFranchises, getUserFranchises, createFranchise, deleteFranchise, createStore, deleteStore };
  return router;
}

module.exports = { createFranchiseRouter };
