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
const FLUSH_INTERVAL_MS = 10000;
const FLUSH_AT = 500; // flush early if this many lines are waiting
const MAX_QUEUE = 5000;

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

  // Log lines are queued and shipped in one batched push so a burst of traffic doesn't open hundreds of simultaneous
  // connections to Grafana (which caused connect timeouts).
  let queue = [];

  function log(level, type, logData) {
    const logging = config.logging;
    if (!enabled || !logging?.endpointUrl) return;

    queue.push({ labels: { component: logging.source, level, type }, timestamp: (BigInt(Date.now()) * 1000000n).toString(), line: JSON.stringify(sanitize(logData)) });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE); // drop oldest rather than grow unbounded
    if (queue.length >= FLUSH_AT) flush();
  }

  async function push(logging, body) {
    const res = await fetchFn(logging.endpointUrl, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${logging.accountId}:${logging.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  // Sends everything queued as a single Loki push (one stream per distinct label set). Never rejects.
  async function flush() {
    const logging = config.logging;
    if (!queue.length || !logging?.endpointUrl) return;

    const batch = queue;
    queue = [];
    const streams = new Map();
    for (const { labels, timestamp, line } of batch) {
      const key = JSON.stringify(labels);
      if (!streams.has(key)) streams.set(key, { stream: labels, values: [] });
      streams.get(key).values.push([timestamp, line]);
    }
    const body = JSON.stringify({ streams: [...streams.values()] });

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await push(logging, body);
        return;
      } catch (error) {
        // fetch's own message is just "fetch failed"; the useful reason is on error.cause
        const reason = error.cause?.code ?? error.cause?.message ?? error.message;
        if (attempt === 2) console.error(`Failed to send ${batch.length} logs to Grafana: ${error.message} (${reason})`);
      }
    }
  }

  // unref so the timer never keeps the process (or a Jest worker) alive
  if (enabled) setInterval(flush, FLUSH_INTERVAL_MS).unref();

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
  const logError = (err) => {
    if (err.statusCode && err.statusCode < 500) return;
    log('error', 'unhandledError', { message: err.message, status: err.statusCode, user: currentUser() });
  };

  return { httpLogger, logDb, logFactory, logError, log, flush, sanitize };
}

module.exports = { createLogger, ...createLogger() };
