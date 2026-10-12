const baseConfig = require('../../src/config.js');

// Every jest worker gets its own database (pizza_test_1, pizza_test_2, ...) so test files can run in
// parallel without resetting each other's tables. Override the base name with PIZZA_TEST_DATABASE to run a
// second copy of the suite (for example next to a jest --watch session).
const baseName = process.env.PIZZA_TEST_DATABASE ?? 'pizza_test';
const TEST_DATABASE = `${baseName}_${process.env.JEST_WORKER_ID ?? '1'}`;

if (!/^[A-Za-z0-9_]+_test_\d+$/.test(TEST_DATABASE)) {
  throw new Error(`refusing to use "${TEST_DATABASE}" as the test database; its name must look like <name>_test_<n>`);
}

const testConfig = {
  ...baseConfig,
  db: {
    ...baseConfig.db,
    connection: { ...baseConfig.db.connection, database: TEST_DATABASE },
  },
};

module.exports = { testConfig, TEST_DATABASE };
