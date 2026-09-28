const { createFactoryClient } = require('../src/factoryClient.js');

const config = { factory: { url: 'https://factory.test', apiKey: 'key-123' } };

describe('factoryClient.createOrder', () => {
  test('posts the diner and order with the API key and returns ok and body', async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, json: async () => ({ jwt: 'abc', reportUrl: 'https://report' }) }));
    const client = createFactoryClient({ config, fetch: fetchFn });

    const result = await client.createOrder({ id: 1 }, { items: [] });

    expect(fetchFn).toHaveBeenCalledWith('https://factory.test/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer key-123' },
      body: JSON.stringify({ diner: { id: 1 }, order: { items: [] } }),
    });
    expect(result).toEqual({ ok: true, body: { jwt: 'abc', reportUrl: 'https://report' } });
  });

  test('passes through a non-ok factory response', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, json: async () => ({ reportUrl: 'https://report' }) }));
    const client = createFactoryClient({ config, fetch: fetchFn });

    await expect(client.createOrder({ id: 1 }, {})).resolves.toEqual({ ok: false, body: { reportUrl: 'https://report' } });
  });
});
