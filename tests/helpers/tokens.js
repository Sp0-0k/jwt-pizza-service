const jwt = require('jsonwebtoken');
const config = require('../../src/config.js');

function signToken(user, options) {
  const { id, name, email, roles } = user;
  return jwt.sign({ id, name, email, roles }, config.jwtSecret, options);
}

module.exports = { signToken };
