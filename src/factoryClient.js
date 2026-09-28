const defaultConfig = require('./config.js');

function createFactoryClient({ config = defaultConfig, fetch: fetchFn = fetch } = {}) {
  return {
    async createOrder(diner, order) {
      const r = await fetchFn(`${config.factory.url}/api/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${config.factory.apiKey}` },
        body: JSON.stringify({ diner, order }),
      });
      return { ok: r.ok, body: await r.json() };
    },
  };
}

module.exports = { createFactoryClient };
