const DB_METHODS = [
  'getMenu',
  'addMenuItem',
  'addUser',
  'getUser',
  'updateUser',
  'loginUser',
  'isLoggedIn',
  'logoutUser',
  'getOrders',
  'addDinerOrder',
  'createFranchise',
  'deleteFranchise',
  'getFranchises',
  'getUserFranchises',
  'getFranchise',
  'createStore',
  'deleteStore',
];

// Every method is a jest.fn. A method the test did not plan (no entry in impls) throws when called,
// so an unexpected collaborator call fails the test loudly instead of returning undefined.
function createFakeDb(impls = {}) {
  for (const name of Object.keys(impls)) {
    if (!DB_METHODS.includes(name)) {
      throw new Error(`createFakeDb: unknown DB method ${name}`);
    }
  }
  const db = {};
  for (const name of DB_METHODS) {
    db[name] = jest.fn(
      impls[name] ??
        (async () => {
          throw new Error(`unplanned db call: ${name}`);
        })
    );
  }
  return db;
}

module.exports = { createFakeDb };
