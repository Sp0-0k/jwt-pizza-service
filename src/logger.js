const { AsyncLocalStorage } = require('async_hooks');
const defaultConfig = require('./config.js');

const REDACTED = '*****';
const SENSITIVE_KEY = /pass|token|jwt|authorization|api[-_]?key|secret|cookie|email/i;
const PERSON_NAME_KEY = /^name$/i;
const EMAIL_KEY = /^email$/i;
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_SHAPED = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const MAX_DEPTH = 8;

function statusToLogLevel(statusCode) {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

// Returns a copy of `value` that is safe to ship to a third party: sensitive keys are masked at any depth, JSON
// strings are parsed so their keys get the same treatment, and bearer tokens / JWTs in free text are scrubbed.
function sanitize(value, ancestors = new WeakSet(), depth = 0) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return sanitize(JSON.parse(text), ancestors, depth);
      } catch {
        // not JSON after all, fall through to plain-string scrubbing
      }
    }
    return value.replace(BEARER, `Bearer ${REDACTED}`).replace(JWT_SHAPED, REDACTED).replace(EMAIL_ADDRESS, REDACTED);
  }
  if (Buffer.isBuffer(value)) return '[binary]';
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';

  ancestors.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((v) => sanitize(v, ancestors, depth + 1));
  } else {
    // A `name` is a person's name only on user-shaped objects (those that also carry an email). Franchise, store and
    // menu-item names are business data and stay readable.
    const isUserShaped = Object.keys(value).some((k) => EMAIL_KEY.test(k));
    const mask = (k) => SENSITIVE_KEY.test(k) || (isUserShaped && PERSON_NAME_KEY.test(k));
    out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(k) ? REDACTED : sanitize(v, ancestors, depth + 1)]));
  }
  ancestors.delete(value);
  return out;
}

// Query strings can hold search terms such as ?name=Pat, so only numeric paging values are logged.
const pathOf = (req) => (req.originalUrl ?? '').split('?')[0];
function safeQuery(req) {
  const query = {};
  for (const key of ['page', 'limit']) {
    if (/^\d+$/.test(req.query?.[key] ?? '')) query[key] = Number(req.query[key]);
  }
  return Object.keys(query).length ? query : undefined;
}

// All Grafana (Loki) interaction lives here so the rest of the service only needs one-line hooks.
function createLogger({ config = defaultConfig, fetch: fetchFn = fetch, enabled = process.env.NODE_ENV !== 'test' } = {}) {
  // Carries the current request through async code so DB and factory logs can name the user without
  // threading `req` through every call.
  const requestContext = new AsyncLocalStorage();

  const userOf = (req) => (req?.user ? { id: req.user.id } : null);
  const currentUser = () => userOf(requestContext.getStore()?.req);

  async function log(level, type, logData) {
    const logging = config.logging;
    if (!enabled || !logging?.endpointUrl) return;

    const labels = { component: logging.source, level, type };
    const timestamp = (BigInt(Date.now()) * 1000000n).toString();
    const line = JSON.stringify(sanitize(logData));
    try {
      const res = await fetchFn(logging.endpointUrl, {
        method: 'POST',
        body: JSON.stringify({ streams: [{ stream: labels, values: [[timestamp, line]] }] }),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${logging.accountId}:${logging.apiKey}` },
      });
      if (!res.ok) console.error(`Failed to send log to Grafana: HTTP ${res.status}`);
    } catch (error) {
      console.error('Failed to send log to Grafana:', error.message);
    }
  }

  // Express middleware. Install after the auth middleware so req.user is populated.
  function httpLogger(req, res, next) {
    if (!enabled) return next();

    let resBody;
    const send = res.send;
    res.send = function (body) {
      resBody = body; // res.json() re-enters send() with the serialized string; the last call wins
      return send.call(this, body);
    };
    res.on('finish', () => {
      log(statusToLogLevel(res.statusCode), 'http', {
        method: req.method,
        path: pathOf(req),
        query: safeQuery(req),
        statusCode: res.statusCode,
        authorized: !!req.headers.authorization,
        user: userOf(req),
        reqBody: req.body,
        resBody,
      });
    });
    requestContext.run({ req }, next);
  }

  // Parameter values are never logged; each placeholder is shown as #### so it reads as "a value went here".
  const logDb = (sql) => log('info', 'db', { sql: sql.replace(/\?/g, '####'), user: currentUser() });

  const logFactory = ({ request, response }) => log('info', 'factory', { user: currentUser(), request, response });

  // Expected errors (StatusCodeError 4xx) are already recorded by httpLogger as warnings, so only log surprises here.
  const logError = async (err) => {
    if (err.statusCode && err.statusCode < 500) return;
    await log('error', 'unhandledError', { message: err.message, status: err.statusCode, user: currentUser() });
  };

  return { httpLogger, logDb, logFactory, logError, log, sanitize };
}

module.exports = { createLogger, ...createLogger() };
