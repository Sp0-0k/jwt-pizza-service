const express = require('express');
const { createAuth, createAuthRouter } = require('./routes/authRouter.js');
const { createOrderRouter } = require('./routes/orderRouter.js');
const { createFranchiseRouter } = require('./routes/franchiseRouter.js');
const { createUserRouter } = require('./routes/userRouter.js');
const version = require('./version.json');
const config = require('./config.js');

function createApp({ db, factoryClient }) {
  const auth = createAuth({ db });
  const authRouter = createAuthRouter({ db, auth });
  const userRouter = createUserRouter({ db, auth });
  const orderRouter = createOrderRouter({ db, auth, factoryClient });
  const franchiseRouter = createFranchiseRouter({ db, auth });

  const app = express();
  app.use(express.json());
  app.use(auth.setAuthUser);
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
  });

  const apiRouter = express.Router();
  app.use('/api', apiRouter);
  apiRouter.use('/auth', authRouter);
  apiRouter.use('/user', userRouter);
  apiRouter.use('/order', orderRouter);
  apiRouter.use('/franchise', franchiseRouter);

  apiRouter.use('/docs', (req, res) => {
    res.json({
      version: version.version,
      endpoints: [...authRouter.docs, ...userRouter.docs, ...orderRouter.docs, ...franchiseRouter.docs],
      config: { factory: config.factory.url, db: config.db.connection.host },
    });
  });

  app.get('/', (req, res) => {
    res.json({
      message: 'welcome to JWT Pizza',
      version: version.version,
    });
  });

  app.use('*', (req, res) => {
    res.status(404).json({
      message: 'unknown endpoint',
    });
  });

  // Default error handler for all exceptions and errors.
  app.use((err, req, res, next) => {
    res.status(err.statusCode ?? 500).json({ message: err.message, stack: err.stack });
    next();
  });

  return app;
}

module.exports = { createApp };
