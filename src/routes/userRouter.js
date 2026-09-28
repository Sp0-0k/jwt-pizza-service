const express = require('express');
const { asyncHandler } = require('../endpointHelper.js');
const { Role } = require('../model/model.js');

const docs = [
  {
    method: 'GET',
    path: '/api/user/me',
    requiresAuth: true,
    description: 'Get authenticated user',
    example: `curl -X GET localhost:3000/api/user/me -H 'Authorization: Bearer tttttt'`,
    response: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] },
  },
  {
    method: 'PUT',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Update user',
    example: `curl -X PUT localhost:3000/api/user/1 -d '{"name":"常用名字", "email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt'`,
    response: { user: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] }, token: 'tttttt' },
  },
];

function createUserRouter({ db, auth }) {
  const router = express.Router();
  router.docs = docs;

  // getUser
  async function getMe(req, res) {
    res.json(req.user);
  }

  // updateUser
  async function updateUser(req, res) {
    const { name, email, password } = req.body;
    const userId = Number(req.params.userId);
    const user = req.user;
    if (user.id !== userId && !user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }

    const updatedUser = await db.updateUser(userId, name, email, password);
    const token = await auth.setAuth(updatedUser);
    res.json({ user: updatedUser, token: token });
  }

  // deleteUser
  async function deleteUser(req, res) {
    res.json({ message: 'not implemented' });
  }

  // listUsers
  async function listUsers(req, res) {
    res.json({ message: 'not implemented', users: [], more: false });
  }

  router.get('/me', auth.authenticateToken, asyncHandler(getMe));
  router.put('/:userId', auth.authenticateToken, asyncHandler(updateUser));
  router.delete('/:userId', auth.authenticateToken, asyncHandler(deleteUser));
  router.get('/', auth.authenticateToken, asyncHandler(listUsers));

  router.handlers = { getMe, updateUser, deleteUser, listUsers };
  return router;
}

module.exports = { createUserRouter };
