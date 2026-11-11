const defaultConfig = require('./config.js');
const logger = require('./logger.js');

function createFactoryClient({ config = defaultConfig, fetch: fetchFn = fetch } = {}) {
  return {
    async createOrder(diner, order) {
      const r = await fetchFn(`${config.factory.url}/api/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${config.factory.apiKey}` },
        body: JSON.stringify({ diner, order }),
      });
      const body = await r.json();
      logger.logFactory({ request: { diner, order }, response: { ok: r.ok, status: r.status, body } });
      return { ok: r.ok, body };
    },
  };
}

module.exports = { createFactoryClient };
