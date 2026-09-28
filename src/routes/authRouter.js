const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config.js');
const { asyncHandler } = require('../endpointHelper.js');
const { Role } = require('../model/model.js');

const docs = [
  {
    method: 'POST',
    path: '/api/auth',
    description: 'Register a new user',
    example: `curl -X POST localhost:3000/api/auth -d '{"name":"pizza diner", "email":"d@jwt.com", "password":"diner"}' -H 'Content-Type: application/json'`,
    response: { user: { id: 2, name: 'pizza diner', email: 'd@jwt.com', roles: [{ role: 'diner' }] }, token: 'tttttt' },
  },
  {
    method: 'PUT',
    path: '/api/auth',
    description: 'Login existing user',
    example: `curl -X PUT localhost:3000/api/auth -d '{"email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json'`,
    response: { user: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] }, token: 'tttttt' },
  },
  {
    method: 'DELETE',
    path: '/api/auth',
    requiresAuth: true,
    description: 'Logout a user',
    example: `curl -X DELETE localhost:3000/api/auth -H 'Authorization: Bearer tttttt'`,
    response: { message: 'logout successful' },
  },
];

function readAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    return authHeader.split(' ')[1];
  }
  return null;
}

function createAuth({ db }) {
  async function setAuthUser(req, res, next) {
    const token = readAuthToken(req);
    if (token) {
      try {
        if (await db.isLoggedIn(token)) {
          // Check the database to make sure the token is valid.
          req.user = jwt.verify(token, config.jwtSecret);
          req.user.isRole = (role) => !!req.user.roles.find((r) => r.role === role);
        }
      } catch {
        req.user = null;
      }
    }
    next();
  }

  // Authenticate token
  function authenticateToken(req, res, next) {
    if (!req.user) {
      return res.status(401).send({ message: 'unauthorized' });
    }
    next();
  }

  async function setAuth(user) {
    const token = jwt.sign(user, config.jwtSecret);
    await db.loginUser(user.id, token);
    return token;
  }

  async function clearAuth(req) {
    const token = readAuthToken(req);
    if (token) {
      await db.logoutUser(token);
    }
  }

  return { setAuthUser, authenticateToken, setAuth, clearAuth };
}

function createAuthRouter({ db, auth }) {
  const router = express.Router();
  router.docs = docs;

  // register
  async function register(req, res) {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email, and password are required' });
    }
    const user = await db.addUser({ name, email, password, roles: [{ role: Role.Diner }] });
    const token = await auth.setAuth(user);
    res.json({ user: user, token: token });
  }

  // login
  async function login(req, res) {
    const { email, password } = req.body;
    const user = await db.getUser(email, password);
    const token = await auth.setAuth(user);
    res.json({ user: user, token: token });
  }

  // logout
  async function logout(req, res) {
    await auth.clearAuth(req);
    res.json({ message: 'logout successful' });
  }

  router.post('/', asyncHandler(register));
  router.put('/', asyncHandler(login));
  router.delete('/', auth.authenticateToken, asyncHandler(logout));

  router.handlers = { register, login, logout };
  return router;
}

module.exports = { createAuth, createAuthRouter };
