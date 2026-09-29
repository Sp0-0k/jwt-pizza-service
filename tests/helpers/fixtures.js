const { Role } = require('../../src/model/model.js');

// Mirrors req.user in production: JWT claims plus an isRole helper. isRole is non-enumerable
// so it is never serialized or compared by toEqual.
function makeUser({ id = 1, name = `user ${id}`, email = `user${id}@test.com`, roles = [{ role: Role.Diner }] } = {}) {
  const user = { id, name, email, roles };
  Object.defineProperty(user, 'isRole', {
    value: (role) => user.roles.some((r) => r.role === role),
    enumerable: false,
  });
  return user;
}

const makeDiner = (id = 1) => makeUser({ id, roles: [{ role: Role.Diner }] });
const makeAdmin = (id = 1) => makeUser({ id, roles: [{ role: Role.Admin }] });
const makeFranchisee = (id = 2, franchiseId = 3) => makeUser({ id, roles: [{ role: Role.Franchisee, objectId: franchiseId }] });

module.exports = { makeUser, makeDiner, makeAdmin, makeFranchisee };
