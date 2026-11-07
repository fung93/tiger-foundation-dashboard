/* Configured public evidence only. No general search, arbitrary URL tool, model
   execution or investment-policy authority is granted to retrieved content. */
import { createHash } from 'node:crypto';
import { httpError } from './_agent-http.mjs';

export const AGENT_EVIDENCE_SCHEMA_VERSION = 'agent-evidence-v1';
const VERIFIED_AT = '2026-11-07';
const source = (id, protocol, label, url, enabled, verificationStatus, options = {}) => Object.freeze({
  id, protocol, label, url, kind: 'documentation', assets: Object.freeze(protocol === 'morpho' ? ['KAT', 'avKAT', 'vbUSDC'] : ['LP', 'KAT']),
  type: url.startsWith('https://raw.githubusercontent.com/') ? 'markdown' : 'html', accessMethod: 'GET', expectedUpdateHours: 24, maxBytes: 65536,
  timeoutMs: 5000, cacheMs: 3600000, maxAgeMs: 86400000, enabled,
  approvedRedirects: Object.freeze([]), verification: Object.freeze({ checkedAt: VERIFIED_AT, status: verificationStatus }), ...options,
});
export const AGENT_EVIDENCE_SOURCES = Object.freeze([
  source('morpho-blue-readme', 'morpho', 'Morpho Blue official protocol overview',
    'https://raw.githubusercontent.com/morpho-org/morpho-blue/main/README.md', true, 'http_200'),
  source('morpho-blue-markets', 'morpho', 'Morpho Blue market definitions',
    'https://raw.githubusercontent.com/morpho-org/morpho-blue/main/src/interfaces/IMorpho.sol', true, 'http_200', { type: 'source_code', topic: 'isolated_markets' }),
  source('sushi-v3-readme', 'sushi', 'Sushi V3 official periphery overview',
    'https://raw.githubusercontent.com/sushiswap/v3-periphery/master/README.md', true, 'http_200'),
  source('merkl-contracts-readme', 'merkl', 'Merkl official core contracts overview',
    'https://raw.githubusercontent.com/AngleProtocol/merkl-contracts/main/README.md', true, 'http_200'),
  source('katana-docs', 'katana', 'Katana official documentation',
    'https://docs.katana.network/', false, 'development_proxy_403_unverified'),
  source('merkl-docs', 'merkl', 'Merkl official documentation',
    'https://docs.merkl.xyz/', false, 'development_proxy_403_unverified'),
]);
export const AGENT_RESEARCH_PROTOCOLS = Object.freeze(['morpho', 'sushi', 'katana', 'merkl']);
const MAX_DOCUMENTS = 4, MAX_PASSAGE = 1500, MAX_EXTRACTED = 50000;
const hash = value => createHash('sha256').update(value).digest('hex');
const category = (message, status = 400) => httpError(status, message, status === 400 ? 'configuration_missing' : 'data_unavailable');
const time = input => {
  const value = typeof input === 'function' ? input() : input;
  if (!Number.isSafeInteger(value) || value <= 0) throw category('Choose a valid research time.');
  return value;
};
function knownSource(value) {
  if (!value || !AGENT_EVIDENCE_SOURCES.includes(value)) throw category('Choose a configured research source.');
  return value;
}
export function configuredResearchSources() {
  return AGENT_RESEARCH_PROTOCOLS.map(protocol => ({ protocol,
    label: ({ morpho: 'Morpho', sushi: 'Sushi', katana: 'Katana', merkl: 'Merkl' })[protocol],
    available: AGENT_EVIDENCE_SOURCES.some(row => row.protocol === protocol && row.enabled),
    sourceCount: AGENT_EVIDENCE_SOURCES.filter(row => row.protocol === protocol && row.enabled).length,
    scope: 'configured_sources' }));
}
export const listResearchSources = configuredResearchSources;
export function validateEvidenceDestination(value, sourceRecord) {
  const configured = knownSource(sourceRecord);
  let url;
  try { url = new URL(value); } catch { throw category('The research destination is not allowed.'); }
  // Exact destinations make DNS/IP tricks, credentials, user-selected queries and
  // private/local targets unreachable; only explicitly approved redirects qualify.
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':')
    || /^\d+(?:\.\d+){0,3}$/.test(host)
    || ![configured.url, ...configured.approvedRedirects].includes(url.href))
    throw category('The research destination is not allowed.');
  return url.href;
}
const entities = text => text.replace(/&(?:amp|lt|gt|quot|apos|#39|#\d{1,7}|#x[0-9a-f]{1,6});/gi, item => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
  if (named[item.toLowerCase()]) return named[item.toLowerCase()];
  const n = /^&#x/i.test(item) ? Number.parseInt(item.slice(3, -1), 16) : Number.parseInt(item.slice(2, -1), 10);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
});
function publication(raw, at) {
  const match = raw.match(/<meta\b[^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*content=["']([^"']{1,100})["']/i)
    || raw.match(/<meta\b[^>]*content=["']([^"']{1,100})["'][^>]*(?:property|name)=["'](?:article:published_time|datePublished)["']/i);
  const date = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(date) && date > 0 && date <= at + 30000 ? new Date(date).toISOString() : null;
}
function extract(raw, configured, at) {
  if (configured.type === 'source_code') return { title: configured.label,
    text: raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, MAX_EXTRACTED), publishedAt: null };
  const title = raw.match(/<title\b[^>]*>([^<]{1,240})<\/title>/i)?.[1]
    || raw.match(/^#\s+(.{1,240})$/m)?.[1] || configured.label;
  const text = entities(raw.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ').replace(/<[^>]{0,1000}>/g, '\n'))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_EXTRACTED);
  if (text.length < 30) throw category('The configured source did not provide a usable passage.', 503);
  return { title: entities(title).trim().slice(0, 240), text, publishedAt: publication(raw, at) };
}
function passageFor(text, query) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,30}/gu) || [])].slice(0, 20);
  const lines = text.split(/\n+/).map((value, index) => ({ value: value.trim(), index })).filter(row => row.value.length >= 25).slice(0, 400);
  for (const row of lines) row.score = terms.reduce((n, term) => n + (row.value.toLowerCase().includes(term) ? 1 : 0), 0);
  const selected = [...lines].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3).sort((a, b) => a.index - b.index);
  return (selected.map(row => row.value).join('\n\n') || text).slice(0, MAX_PASSAGE);
}
function marketPassage(text) {
  const params = text.match(/struct MarketParams\s*\{[\s\S]*?\}/)?.[0];
  const position = text.match(/struct Position\s*\{[\s\S]*?\}/)?.[0];
  const getter = text.match(/function position\s*\([\s\S]{0,200}?\)[\s\S]{0,180}?;/)?.[0];
  return params && position && getter ? [params, position, getter].join('\n\n').slice(0, MAX_PASSAGE) : null;
}
async function boundedText(response, maxBytes, signal) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes) throw category('The configured source is too large for this research request.', 503);
  if (!response.body?.getReader) throw category('The configured source response could not be bounded.', 503);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => {}); throw category('The configured source is too large for this research request.', 503); }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
async function fetchSource(configured, cached, fetcher, at) {
  const controller = new AbortController(); let timer;
  const task = (async () => {
    let destination = validateEvidenceDestination(configured.url, configured);
    for (let redirects = 0; redirects <= 2; redirects++) {
      const headers = { accept: 'text/plain,text/markdown,text/html;q=0.8',
        ...(cached?.etag ? { 'if-none-match': cached.etag } : {}),
        ...(cached?.lastModified ? { 'if-modified-since': cached.lastModified } : {}) };
      const response = await fetcher(destination, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: controller.signal });
      if (response.redirected || (response.url && response.url !== destination))
        throw category('The configured source redirected without verification.', 503);
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers?.get?.('location');
        if (!location || redirects === 2) throw category('The configured source redirect is not approved.', 503);
        destination = validateEvidenceDestination(new URL(location, destination).href, configured); continue;
      }
      if (response.status === 304) {
        if (!cached?.text || !cached?.contentHash) throw category('The configured source cache could not be verified.', 503);
        return { ...cached, retrievedAt: new Date(at).toISOString(), checkedAt: at, canonicalUrl: destination };
      }
      if (!response.ok) throw category('The configured source is unavailable.', 503);
      const contentType = response.headers?.get?.('content-type') || '';
      if (!/^text\/(?:plain|markdown|html)(?:;|$)/i.test(contentType)) throw category('The configured source format is unsupported.', 503);
      if (configured.type === 'source_code' && !/^text\/plain(?:;|$)/i.test(contentType)) throw category('The configured source format is unsupported.', 503);
      const raw = await boundedText(response, configured.maxBytes, controller.signal), extracted = extract(raw, configured, at);
      return { ...extracted, contentHash: hash(extracted.text), retrievedAt: new Date(at).toISOString(), checkedAt: at,
        canonicalUrl: destination, etag: response.headers?.get?.('etag')?.slice(0, 240) || null,
        lastModified: response.headers?.get?.('last-modified')?.slice(0, 100) || null };
    }
  })();
  try { return await Promise.race([task, new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(category('The configured source timed out.', 503)); }, configured.timeoutMs);
  })]); } finally { clearTimeout(timer); controller.abort(); }
}
function cacheValid(cached, configured, at) {
  return cached && typeof cached.text === 'string' && cached.text.length <= MAX_EXTRACTED
    && /^[a-f0-9]{64}$/.test(cached.contentHash || '') && hash(cached.text) === cached.contentHash
    && Number.isFinite(Date.parse(cached.retrievedAt)) && Date.parse(cached.retrievedAt) <= at + 30000
    && cached.canonicalUrl === configured.url;
}
async function collect(configured, { store, query, fetcher, at }) {
  if (!configured.enabled) return { source: { sourceId: configured.id, protocol: configured.protocol, status: 'unavailable', reason: configured.verification.status }, limitation: configured.label + ' is disabled until source access is verified.' };
  const key = 'evidence:cache:' + configured.id;
  let cached = await store.get(key);
  if (!cacheValid(cached, configured, at)) cached = null;
  let observed = cached, stale = false, failure = null;
  if (!cached || !Number.isFinite(cached.checkedAt) || at - cached.checkedAt >= configured.cacheMs) {
    try { observed = await fetchSource(configured, cached, fetcher, at); }
    catch { failure = 'Source retrieval failed; current content was not verified.'; stale = true; }
    if (!stale) await store.set(key, observed, { ttlSeconds: 7 * 86400 });
  }
  if (!observed) return { source: { sourceId: configured.id, protocol: configured.protocol, status: 'unavailable', reason: 'retrieval_failed' }, limitation: configured.label + ': ' + failure };
  const retrieved = Date.parse(observed.retrievedAt), expired = at >= retrieved + configured.maxAgeMs;
  const passage = (configured.topic === 'isolated_markets' ? marketPassage(observed.text) : null) || passageFor(observed.text, query), observationHash = hash(configured.id + '\n' + observed.contentHash + '\n' + passage + '\n' + observed.retrievedAt);
  const evidence = { schemaVersion: AGENT_EVIDENCE_SCHEMA_VERSION, evidenceId: 'evidence:' + observationHash,
    sourceId: configured.id, protocol: configured.protocol, canonicalUrl: observed.canonicalUrl, title: observed.title,
    publishedAt: observed.publishedAt || null, retrievedAt: observed.retrievedAt, contentHash: observed.contentHash,
    contentHashBasis: 'normalized_extracted_text',
    passage, supportedClaim: { kind: 'source_excerpt', text: passage }, kind: configured.kind,
    validUntil: new Date(retrieved + configured.maxAgeMs).toISOString() };
  const existing = await store.get(evidence.evidenceId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(evidence)) throw category('Saved research evidence could not be verified.', 503);
  if (!existing && !await store.putImmutable(evidence.evidenceId, evidence)) {
    const winner = await store.get(evidence.evidenceId);
    if (JSON.stringify(winner) !== JSON.stringify(evidence)) throw category('Saved research evidence could not be verified.', 503);
  }
  const status = stale || expired ? 'stale' : 'fresh';
  return { evidence, source: { sourceId: configured.id, protocol: configured.protocol, status,
    retrievedAt: evidence.retrievedAt, publishedAt: evidence.publishedAt, validUntil: evidence.validUntil,
    changed: cached ? cached.contentHash !== observed.contentHash : null },
  ...(stale || expired ? { limitation: configured.label + ': ' + (failure || 'the saved evidence has expired.') } : {}) };
}
export async function researchProtocol({ store, protocol, query = '', fetcher = fetch, now = Date.now } = {}) {
  if (!AGENT_RESEARCH_PROTOCOLS.includes(protocol) || typeof query !== 'string' || !query.trim() || query.length > 1000)
    throw category('Choose a configured protocol and a focused question of up to 1,000 characters.');
  if (!store || !['get', 'set', 'putImmutable'].every(method => typeof store[method] === 'function')) throw category('Private research storage is unavailable.', 503);
  const needsMarkets = /isolated|markets?|collateral|loans?|独立.*市场|隔离/iu.test(query);
  const at = time(now), configured = AGENT_EVIDENCE_SOURCES.filter(row => row.protocol === protocol && (!row.topic || needsMarkets)).slice(0, MAX_DOCUMENTS);
  // Sequential fetches bound active connections and aggregate memory/CPU.
  const results = [];
  for (const item of configured) results.push(await collect(item, { store, query: query.trim(), fetcher, at }));
  const evidence = results.flatMap(item => item.evidence ? [item.evidence] : []), sources = results.map(item => item.source);
  const ready = sources.length > 0 && sources.every(item => item.status === 'fresh');
  const needsEventCoverage = /\b(?:latest|recent|today|changes?|changed|announcements?|news|governance|proposals?|votes?|incentive changes|current incentives?|campaign changes)\b|最新|公告|新闻|治理|变化|berita|terkini|pengumuman|tadbir|berubah/iu.test(query);
  const lacksEventCoverage = needsEventCoverage && !configured.some(item => item.enabled && ['announcement_feed', 'governance', 'public_api'].includes(item.kind));
  return { schemaVersion: AGENT_EVIDENCE_SCHEMA_VERSION, protocol, scope: 'configured_sources',
    status: !evidence.length ? 'blocked' : ready && !lacksEventCoverage ? 'ready' : 'partial', createdAt: new Date(at).toISOString(), evidence, sources,
    queryCoverage: { requested: needsEventCoverage ? 'current_events_or_governance' : 'protocol_background',
      established: !lacksEventCoverage && ready },
    limitations: ['Configured official documentation only; no general web search, announcement feed or governance coverage is implied.',
      'Cross-source agreement has not been established; no numerical confidence score is assigned.',
      ...(lacksEventCoverage ? ['Background documentation cannot establish current announcements, governance votes or incentive changes for this question; the required feed or public API is not configured.'] : []),
      ...results.flatMap(item => item.limitation ? [item.limitation] : [])], conflicts: [] };
}
export function validateEvidenceReferences(ids, evidence) {
  if (!Array.isArray(ids) || ids.length > MAX_DOCUMENTS || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
    throw category('The research citations could not be verified.', 503);
  const known = new Map((Array.isArray(evidence) ? evidence : []).map(item => [item?.evidenceId, item]));
  return ids.map(id => {
    const row = known.get(id), configured = AGENT_EVIDENCE_SOURCES.find(item => item.id === row?.sourceId);
    const retrieved = Date.parse(row?.retrievedAt), published = row?.publishedAt === null ? null : Date.parse(row?.publishedAt);
    if (!row || !configured || !/^evidence:[a-f0-9]{64}$/.test(id) || typeof row.passage !== 'string' || !row.passage || row.passage.length > MAX_PASSAGE
      || row.schemaVersion !== AGENT_EVIDENCE_SCHEMA_VERSION || row.protocol !== configured.protocol
      || typeof row.title !== 'string' || !row.title || row.title.length > 240 || !/^[a-f0-9]{64}$/.test(row.contentHash || '')
      || row.contentHashBasis !== 'normalized_extracted_text' || !Number.isFinite(retrieved)
      || (published !== null && (!Number.isFinite(published) || published > retrieved + 30000))
      || Date.parse(row.validUntil) !== retrieved + configured.maxAgeMs
      || id !== 'evidence:' + hash(configured.id + '\n' + row.contentHash + '\n' + row.passage + '\n' + row.retrievedAt)
      || row.supportedClaim?.kind !== 'source_excerpt' || row.supportedClaim.text !== row.passage)
      throw category('The research citations could not be verified.', 503);
    validateEvidenceDestination(row.canonicalUrl, configured);
    return row;
  });
}
export function renderEvidenceCitations(ids, evidence) {
  return validateEvidenceReferences(ids, evidence).map(row => '[' + row.evidenceId + '] ' + row.title + '\n'
    + row.passage + '\nSource: ' + row.canonicalUrl + '\nRetrieved: ' + row.retrievedAt
    + (row.publishedAt ? '\nPublished: ' + row.publishedAt : '\nPublication date unavailable.')).join('\n\n');
}
