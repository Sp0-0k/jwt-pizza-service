const { asyncHandler, StatusCodeError } = require('../src/endpointHelper.js');

describe('StatusCodeError', () => {
  test('preserves message and status code and is an Error', () => {
    const error = new StatusCodeError('nope', 403);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('nope');
    expect(error.statusCode).toBe(403);
  });
});

describe('asyncHandler', () => {
  test('calls the wrapped handler with req, res and next', async () => {
    const handler = jest.fn(async () => {});
    const req = {};
    const res = {};
    const next = jest.fn();

    await asyncHandler(handler)(req, res, next);

    expect(handler).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  test('forwards a rejected promise to next', async () => {
    const error = new Error('boom');
    const next = jest.fn();

    await asyncHandler(async () => {
      throw error;
    })({}, {}, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
