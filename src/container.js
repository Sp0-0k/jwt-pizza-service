const { DB } = require('./database/database.js');
const { createFactoryClient } = require('./factoryClient.js');
const { createApp } = require('./service.js');

const db = new DB();
db.init(); // start schema initialization at startup, as before; failures are logged inside initializeDatabase
const factoryClient = createFactoryClient();
const app = createApp({ db, factoryClient });

module.exports = { app, db, factoryClient };
