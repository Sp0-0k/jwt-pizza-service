const config = require('./config');
const os = require('os');

//Metrics stored in memory before pushing
const requests = {};
let totalHttpRequestCount = 0;
let successfulLoginRequestCount = 0;
let failedLoginRequestCount = 0;
const activeUsers = new Map();

//Function for tracking requests
function recordHttpRequest() {
    totalHttpRequestCount++;
}

function markActiveUser(userID){
    activeUsers.set(userID, Date.now());
}

function pruneActiveUsers() {
    const now = Date.now();
    activeUsers.forEach((lastActive, userID) => {
        if (now - lastActive > (60000 * 5)) { // Prune users inactive for more than 5 minutes
            activeUsers.delete(userID);
        }
    });
}


//Middleware injection
function requestTracker(req, res, next){
    const method = req.method.toLowerCase();
    requests[method] = (requests[method] || 0) + 1;
    recordHttpRequest();
    if(req.user?.id){
        markActiveUser(req.user.id);
    }
    res.on('finish', () => {
        const requestPath = (req.originalUrl || req.path || '')
            .split('?')[0]
            .replace(/\/+$/, '') || '/';
        if(method === "put" && requestPath === "/api/auth"){
            if(res.statusCode === 200){
                successfulLoginRequestCount++;
            } else {
                failedLoginRequestCount++;
            }
        }
    });
    next();
}

//System metrics
function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return cpuUsage.toFixed(2) * 100;
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return memoryUsage.toFixed(2);
}


//Sends metrics to Grafana every 20s
setInterval(() => {
  try{
    const metrics = [];
    Object.keys(requests).forEach((method) => {
        metrics.push(createMetric('requests', requests[method], '1', 'sum', 'asInt', { method }));
    });
    metrics.push(createMetric('totalHttpRequests', totalHttpRequestCount, '1', 'sum', 'asInt', {}));
    metrics.push(createMetric('successfulLoginRequests', successfulLoginRequestCount, '1', 'sum', 'asInt', {}));
    metrics.push(createMetric('failedLoginRequests', failedLoginRequestCount, '1', 'sum', 'asInt', {}));
    metrics.push(createMetric('cpuUsage', getCpuUsagePercentage(), '%', 'gauge', 'asDouble', {}));
    metrics.push(createMetric('memoryUsage', getMemoryUsagePercentage(), '%', 'gauge', 'asDouble', {}));
    pruneActiveUsers();
    metrics.push(createMetric('activeUsers', activeUsers.size, '1', 'gauge', 'asInt', {}));
    sendMetricToGrafana(metrics);
  } catch (error) {
    console.error('Error collecting metrics:', error);
  }
}, 20000);



function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes) {
  attributes = { ...attributes, source: config.dashboard.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: attributes[key] },
    });
  });

  if (metricType === 'sum') {
    metric[metricType].aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metric[metricType].isMonotonic = true;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  fetch(`${config.dashboard.endpointUrl}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${config.dashboard.accountId}:${config.dashboard.apiKey}`, 'Content-Type': 'application/json' },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
    })
    .catch((error) => {
      console.error('Error pushing metrics:', error);
    });
}

module.exports = {
  recordHttpRequest,
  requestTracker,
};