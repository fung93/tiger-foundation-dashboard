import { createHash, timingSafeEqual } from 'node:crypto';

export function httpError(status, message, category) { return Object.assign(new Error(message), { status, expose: true,
  ...(category ? { category } : {}) }); }
const ERROR_CATEGORIES = new Set(['configuration_missing', 'authentication_failed', 'model_unavailable',
  'quota_exhausted', 'rate_limited', 'timeout', 'invalid_model_output', 'data_stale', 'data_unavailable', 'request_failed']);
export function agentErrorCategory(error) {
  if (error?.expose && ERROR_CATEGORIES.has(error.category)) return error.category;
  if (error?.status === 401 || error?.status === 403) return 'authentication_failed';
  if (error?.status === 429) return 'rate_limited';
  return 'request_failed';
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function getAgentOrigin(env = process.env) {
  try {
    const url = new URL(env.AGENT_ORIGIN);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw Error();
    return url.origin;
  } catch { throw httpError(503, 'The agent website address has not been configured.'); }
}
export function json(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('vary', 'Cookie, Origin');
  res.status(status).end(JSON.stringify(payload));
}
export async function readJson(req, limit = 16384) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw httpError(415, 'Send a JSON request.');
  if (Number(req.headers?.['content-length']) > limit) throw httpError(413, 'The message is too large.');
  let body = req.body;
  if (body === undefined) {
    const parts = []; let size = 0;
    for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > limit) throw httpError(413, 'The message is too large.'); parts.push(Buffer.from(chunk)); }
    body = Buffer.concat(parts).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body) || '') > limit) throw httpError(413, 'The message is too large.');
  try { if (typeof body === 'string') body = JSON.parse(body); }
  catch { throw httpError(400, 'The request could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Send a JSON object.');
  return body;
}
export function requireSameOrigin(req, env = process.env) {
  const origin = req.headers?.origin;
  if (origin !== getAgentOrigin(env) || req.headers?.['sec-fetch-site'] === 'cross-site') throw httpError(403, 'Open the agent from your dashboard.');
}
export function publicError(error) {
  return error?.expose && Number.isInteger(error.status) && error.status >= 400 && error.status <= 503
    ? { status: error.status, message: error.message }
    : { status: 503, message: 'The agent could not finish this request. Please try again shortly.' };
}
