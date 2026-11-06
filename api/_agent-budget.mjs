/* All dashboard, Telegram and research inference shares this private D1 ledger.
   Reserving is one conditional SQLite write, so different Worker instances cannot
   both spend the same remaining budget. No prompts or provider errors are stored. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { httpError } from './_agent-http.mjs';

const OWNER = 'owner', SCALE = 1_000_000, DEFAULT_LIMIT = 5000;
export const AGENT_USAGE_SCHEMA = 'agent-usage.v1';
const categories = new Set(['configuration_missing', 'authentication_failed', 'model_unavailable',
  'quota_exhausted', 'rate_limited', 'timeout', 'invalid_model_output', 'data_stale', 'data_unavailable']);
const error = (status, message, category) => Object.assign(httpError(status, message), { category });
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function neuronCost(inputTokens, outputTokens, rates) {
  if (!integer(inputTokens, 0, 1_000_000) || !integer(outputTokens, 0, 1_000_000)
    || !integer(rates?.inputNeuronsPerMillion, 1, 1_000_000_000)
    || !integer(rates?.outputNeuronsPerMillion, 1, 1_000_000_000))
    throw error(503, 'The AI usage profile could not be verified.', 'configuration_missing');
  // A neuron-per-million-token rate is exactly microneurons per token.
  const amount = BigInt(inputTokens) * BigInt(rates.inputNeuronsPerMillion)
    + BigInt(outputTokens) * BigInt(rates.outputNeuronsPerMillion);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw error(503, 'The AI usage estimate is too large.', 'configuration_missing');
  return Number(amount);
}
function inputEstimate(messages, request) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 32)
    throw error(503, 'The AI input could not be budgeted.', 'configuration_missing');
  let encoded;
  try { encoded = JSON.stringify(request || { messages }); } catch {}
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 262144)
    throw error(503, 'The AI input is too large to budget safely.', 'configuration_missing');
  // One UTF-8 byte per token is conservative for the selected byte-level tokenizer.
  // Include role/template delimiters rather than only counting user-visible text.
  const tokens = Buffer.byteLength(encoded, 'utf8') + 256 + 64 * messages.length;
  return { tokens, hash: createHash('sha256').update(encoded).digest('hex') };
}
function record(row) {
  if (!row) return null;
  return { reservationId: row.reservation_id, jobId: row.job_id, attempt: row.attempt,
    utcDate: row.utc_date, modelId: row.model_id, modelProfileVersion: row.model_profile_version,
    inputHash: row.input_hash, estimatedInputTokens: row.estimated_input_tokens,
    maxOutputTokens: row.max_output_tokens, reservedMicroneurons: row.reserved_microneurons,
    chargedMicroneurons: row.charged_microneurons, reservedNeurons: row.reserved_microneurons / SCALE,
    chargedNeurons: row.charged_microneurons / SCALE, outcome: row.outcome,
    usage: row.actual_input_tokens === null ? null : { inputTokens: row.actual_input_tokens, outputTokens: row.actual_output_tokens },
    errorCategory: row.error_category, createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString() };
}

export function createAgentBudget(env = process.env, { jobId, now = Date.now, timeoutMs = 8000 } = {}) {
  const db = env.AGENT_DB;
  if (!db || typeof db.prepare !== 'function')
    throw error(503, 'Private AI usage storage has not been configured.', 'configuration_missing');
  if (jobId !== undefined && (typeof jobId !== 'string' || !jobId || jobId.length > 200))
    throw error(400, 'The inference job reference is invalid.', 'configuration_missing');
  const limit = env.AGENT_DAILY_NEURON_LIMIT === undefined ? DEFAULT_LIMIT : Number(env.AGENT_DAILY_NEURON_LIMIT);
  if (!integer(limit, 1, 10000) || !integer(timeoutMs, 1, 30000))
    throw error(503, 'The AI usage limit has not been configured correctly.', 'configuration_missing');
  const cap = limit * SCALE;
  const clock = () => {
    const value = typeof now === 'function' ? now() : now;
    if (!integer(value, 1)) throw error(503, 'The AI usage clock is unavailable.', 'configuration_missing');
    return value;
  };
  async function first(sql, args) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => db.prepare(sql).bind(...args).first()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('usage deadline')), timeoutMs); }),
      ]);
    } catch (cause) {
      if (/no such table|does not exist/i.test(String(cause?.message || '')))
        throw error(503, 'Private AI usage storage needs its database migration.', 'configuration_missing');
      throw error(503, 'Private AI usage storage is unavailable. Inference has been stopped.', 'data_unavailable');
    } finally { clearTimeout(timer); }
  }
  const lookup = id => first('SELECT * FROM agent_usage WHERE owner=? AND reservation_id=?', [OWNER, id]);
  const budget = {
    async reserve({ profile, messages, request, maxOutputTokens, round } = {}) {
      if (!jobId || !integer(round, 0, 1) || !integer(maxOutputTokens, 1, 4096)
        || typeof profile?.id !== 'string' || profile.id.length > 160
        || typeof profile?.version !== 'string' || profile.version.length > 100
        || !integer(profile.maxOutputTokens, 1, 4096) || maxOutputTokens > profile.maxOutputTokens)
        throw error(503, 'The inference attempt could not be budgeted.', 'configuration_missing');
      const input = inputEstimate(messages, request), at = clock(), date = new Date(at).toISOString().slice(0, 10);
      if (profile.maxInputTokens !== undefined && (!integer(profile.maxInputTokens, 1, 1_000_000) || input.tokens > profile.maxInputTokens))
        throw error(503, 'The AI input exceeds its configured token budget.', 'configuration_missing');
      const amount = neuronCost(input.tokens, maxOutputTokens, profile.rates);
      const id = createHash('sha256').update(jobId + ':' + round).digest('hex');
      const inserted = await first(`INSERT INTO agent_usage
        (owner,reservation_id,job_id,attempt,utc_date,model_id,model_profile_version,input_hash,
         estimated_input_tokens,max_output_tokens,reserved_microneurons,charged_microneurons,outcome,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?
        WHERE NOT EXISTS (SELECT 1 FROM agent_usage WHERE owner=? AND reservation_id=?)
          AND COALESCE((SELECT SUM(charged_microneurons) FROM agent_usage WHERE owner=? AND utc_date=?),0)
            + COALESCE((SELECT SUM(charged_microneurons) FROM agent_usage
              WHERE owner=? AND utc_date<? AND outcome IN ('reserved','outcome_unknown')),0)<=?
        ON CONFLICT(owner,reservation_id) DO NOTHING RETURNING *`,
      [OWNER, id, jobId, round, date, profile.id, profile.version, input.hash, input.tokens,
        maxOutputTokens, amount, amount, at, OWNER, id, OWNER, date, OWNER, date, cap - amount]);
      if (inserted) return { ...record(inserted), rates: { ...profile.rates } };
      const existing = await lookup(id);
      if (existing)
        throw error(409, 'This AI attempt was already started. Its reservation is kept and it will not be repeated automatically.',
          ['reserved', 'outcome_unknown'].includes(existing.outcome) ? 'timeout' : 'rate_limited');
      throw error(429, 'The agent has reached its daily AI budget. Factual checks remain available; the budget resets at 08:00 MYT.', 'quota_exhausted');
    },
    async settle(attempt, { usage = null, outcome, errorCategory } = {}) {
      if (!attempt || attempt.jobId !== jobId || !/^[a-f0-9]{64}$/.test(attempt.reservationId || '')
        || !['succeeded', 'failed', 'outcome_unknown'].includes(outcome))
        throw error(503, 'The inference usage outcome could not be recorded.', 'data_unavailable');
      const at = clock();
      const actual = outcome !== 'outcome_unknown' && usage && integer(usage.inputTokens, 0, 1_000_000)
        && integer(usage.outputTokens, 0, 1_000_000) ? usage : null;
      const charged = actual ? neuronCost(actual.inputTokens, actual.outputTokens, attempt.rates) : attempt.reservedMicroneurons;
      const row = await first(`UPDATE agent_usage SET outcome=?,charged_microneurons=?,actual_input_tokens=?,actual_output_tokens=?,error_category=?,settled_at=?
        WHERE owner=? AND reservation_id=? AND job_id=? AND outcome IN ('reserved','outcome_unknown') RETURNING *`,
      [outcome, charged, actual?.inputTokens ?? null, actual?.outputTokens ?? null,
        categories.has(errorCategory) ? errorCategory : outcome === 'outcome_unknown' ? 'timeout' : null,
        at, OWNER, attempt.reservationId, jobId]);
      if (row) return record(row);
      const existing = await lookup(attempt.reservationId);
      if (!existing || existing.job_id !== jobId)
        throw error(503, 'The inference usage reservation is missing.', 'data_unavailable');
      return record(existing);
    },
    async status() {
      const date = new Date(clock()).toISOString().slice(0, 10);
      const row = await first(`WITH accounted AS (
          SELECT * FROM agent_usage WHERE owner=? AND utc_date=?
          UNION ALL
          SELECT * FROM agent_usage WHERE owner=? AND utc_date<? AND outcome IN ('reserved','outcome_unknown')
        ) SELECT COALESCE(SUM(charged_microneurons),0) AS charged,
        COALESCE(SUM(CASE WHEN utc_date<>? THEN charged_microneurons ELSE 0 END),0) AS carried,
        COALESCE(SUM(CASE WHEN outcome IN ('reserved','outcome_unknown') THEN charged_microneurons ELSE 0 END),0) AS outstanding,
        COUNT(*) AS attempts, COALESCE(SUM(outcome='reserved'),0) AS reserved_attempts,
        COALESCE(SUM(outcome='outcome_unknown'),0) AS unknown_attempts,
        (SELECT MAX(settled_at) FROM agent_usage WHERE owner=? AND outcome='succeeded') AS last_success
        FROM accounted`, [OWNER, date, OWNER, date, date, OWNER]);
      return { schemaVersion: AGENT_USAGE_SCHEMA, utcDate: date, dailyLimitNeurons: limit,
        chargedNeurons: Number(row?.charged || 0) / SCALE, reservedNeurons: Number(row?.outstanding || 0) / SCALE,
        carriedReservedNeurons: Number(row?.carried || 0) / SCALE,
        remainingNeurons: Math.max(0, cap - Number(row?.charged || 0)) / SCALE,
        attempts: Number(row?.attempts || 0), reservedAttempts: Number(row?.reserved_attempts || 0),
        unknownAttempts: Number(row?.unknown_attempts || 0),
        lastSuccessfulInference: row?.last_success ? new Date(row.last_success).toISOString() : null,
        resetsAt: new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString() };
    },
  };
  budget.summary = budget.status;
  return budget;
}
