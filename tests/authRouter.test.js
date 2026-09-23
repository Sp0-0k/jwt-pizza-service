const request = require('supertest');
const app = require('../src/service');
// const Role = require('../src/model/model');
// const DB = require('../src/database/dbModel');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = randomName() + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

// TODO: Add a after all that deletes users
// TODO: Add DELETE User endpoint
// TODO: Add dependancy inversion to database construction so we can use a randomly named database in testing instead
// TODO: 

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('registered user can get the menu', async () => {
  const menuRes = await request(app)
    .get('/api/order/menu')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(menuRes.status).toBe(200);
  expect(menuRes.body).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Crusty' })]));
});



function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

// async function createAdminUser(){
//   let user = { password: 'toomanysecrets', roles: [{role: Role.Admin}] };
//   user.name = randomName();
//   user.email = user.name+'@admin.com';

//   await DB.addUser(user);
//   user.password = 'toomanysecets';
//   return user;
// }