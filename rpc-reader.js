/* Read-only JSON-RPC transport, shared by the browser and serverless readers.
   One paced queue per endpoint prevents wallet, LP and ledger reads from bursting.
   In-flight identical reads are shared; completed results are never reused as live. */
(function (root) {
  'use strict';
  function create(options) {
    options = options || {};
    var now = options.now || function () { return Date.now(); };
    var later = options.setTimeout || root.setTimeout.bind(root);
    var cancel = options.clearTimeout || root.clearTimeout.bind(root);
    var sleep = options.sleep || function (ms) { return new Promise(function (resolve) { later(resolve, ms); }); };
    var fetcher = options.fetch || function (url, init) { return root.fetch(url, init); };
    var endpoints = new Map(), pending = new Map();
    function fault(message, retryable) {
      var error = new Error(message); error.retryable = retryable; return error;
    }
    function copy(value) {
      return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }
    function retryAfter(response) {
      var raw = response.headers && response.headers.get && response.headers.get('retry-after');
      if (!raw) return 0;
      var seconds = Number(raw);
      return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(raw) - now()) || 0;
    }
    async function attempt(state, task) {
      var left = task.deadline - now();
      if (left <= 0 || task.done) throw fault('RPC request timed out', false);
      var controller = new AbortController(), timer, succeeded = false;
      task.controller = controller;
      var timeout = new Promise(function (_, reject) {
        timer = later(function () { controller.abort(); reject(fault('RPC read timed out', true)); }, Math.min(task.timeout, left));
      });
      try {
        var result = await Promise.race([timeout, (async function () {
          var response = await fetcher(task.url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: task.method, params: task.params }), signal: controller.signal });
          if (!response.ok) {
            var status = response.status, limited = status === 429;
            var error = fault('RPC HTTP ' + status + (limited ? ' (rate limited)' : ''), limited || status === 408 || status === 425 || status >= 500);
            if (limited || status === 503) error.retryAfter = retryAfter(response);
            error.limited = limited;
            throw error;
          }
          var payload = await response.json();
          if (!payload || typeof payload !== 'object') throw fault('Invalid JSON-RPC response', true);
          if (payload.error) {
            var detail = payload.error, message = String(detail.message || 'JSON-RPC error');
            var limited = /too many|rate.?limit|429|quota/i.test(message) || detail.code === -32005;
            var error = fault(message, limited || detail.code === -32603 || /temporar|busy|timeout|timed out|unavailable/i.test(message));
            error.limited = limited; throw error;
          }
          if (!Object.prototype.hasOwnProperty.call(payload, 'result') || payload.result === undefined)
            throw fault('JSON-RPC result is missing', true);
          return payload.result;
        })()]);
        succeeded = true; return result;
      } finally { cancel(timer); if (!succeeded) controller.abort(); task.controller = null; }
    }
    async function execute(state, task) {
      for (var index = 0; index < task.attempts; index++) {
        var wait = Math.max(0, state.next - now(), state.cooldown - now());
        if (wait >= task.deadline - now()) throw fault('RPC retry exceeds the request deadline', false);
        if (wait) await sleep(wait);
        if (task.done || now() >= task.deadline) throw fault('RPC request timed out', false);
        state.next = now() + task.pace;
        try { return await attempt(state, task); }
        catch (error) {
          if (task.done || error.retryable === false) throw error;
          var delay = error.retryAfter || Math.min(task.retryMax, task.retryBase * Math.pow(2, index));
          state.cooldown = Math.max(state.cooldown, now() + delay);
          if (index + 1 === task.attempts) throw error;
        }
      }
    }
    async function drain(state) {
      if (state.active) return;
      state.active = true;
      try {
        while (state.queue.length) {
          state.queue = state.queue.filter(function (task) { return !task.done; });
          if (!state.queue.length) break;
          var wait = Math.max(0, state.next - now(), state.cooldown - now());
          if (wait) {
            var deadline = Math.min.apply(null, state.queue.map(function (task) { return task.deadline; }));
            await sleep(Math.min(wait, Math.max(0, deadline - now())));
            continue;
          }
          state.queue.sort(function (a, b) { return a.priority - b.priority || a.order - b.order; });
          var task = state.queue.shift();
          if (task.done) continue;
          try { task.finish(null, await execute(state, task)); } catch (error) { task.finish(error); }
        }
      } finally { state.active = false; }
    }
    var order = 0;
    return function read(url, method, params, overrides) {
      var config = Object.assign({}, options, overrides || {});
      var key = JSON.stringify([url, method, params]);
      if (pending.has(key)) return pending.get(key).then(copy);
      var resolve, reject;
      var promise = new Promise(function (yes, no) { resolve = yes; reject = no; });
      var task = { url: url, method: method, params: params, order: order++, done: false,
        priority: method === 'eth_getLogs' ? 1 : 0,
        deadline: now() + (config.totalTimeoutMs || 16000), timeout: config.timeoutMs || 5000,
        pace: config.paceMs === undefined ? 120 : config.paceMs,
        attempts: config.maxAttempts || 3, retryBase: config.retryBaseMs || 1000, retryMax: config.retryMaxMs || 10000 };
      task.finish = function (error, value) {
        if (task.done) return;
        task.done = true; cancel(task.expiry); pending.delete(key);
        if (error) { if (task.controller) task.controller.abort(); reject(error); } else resolve(value);
      };
      pending.set(key, promise);
      task.expiry = later(function () { task.finish(fault('RPC request timed out in the queue or network', false)); }, task.deadline - now());
      if (!endpoints.has(url)) endpoints.set(url, { queue: [], active: false, next: 0, cooldown: 0 });
      var state = endpoints.get(url); state.queue.push(task); drain(state);
      return promise.then(copy);
    };
  }
  root.TigerRpc = { create: create };
})(globalThis);
