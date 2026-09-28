function createReq({ user, body = {}, params = {}, query = {}, headers = {} } = {}) {
  return { user, body, params, query, headers };
}

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
}

module.exports = { createReq, createRes };
