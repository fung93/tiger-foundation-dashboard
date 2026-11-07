/* Shared notification settings. Investment policy is stored separately. */
import { httpError } from './_agent-http.mjs';

export const DEFAULT_SETTINGS = Object.freeze({ healthThreshold: 1.2, ltvThreshold: 70, alertsEnabled: true, dailyEnabled: false, dailyTime: '09:00', pausedUntil: null });
export function normalizeSettings(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Choose valid alert settings.');
  const out = partial ? {} : { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw httpError(400, 'An alert setting was not recognised.');
    if (key === 'healthThreshold' && (!Number.isFinite(value) || value < 1 || value > 100)) throw httpError(400, 'The health alert must be between 1 and 100.');
    if (key === 'ltvThreshold' && (!Number.isFinite(value) || value <= 0 || value > 100)) throw httpError(400, 'The LTV alert must be above 0 and no higher than 100%.');
    if (['alertsEnabled', 'dailyEnabled'].includes(key) && typeof value !== 'boolean') throw httpError(400, 'Choose whether this alert is enabled.');
    if (key === 'dailyTime' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) throw httpError(400, 'Choose a valid daily report time in MYT.');
    if (key === 'pausedUntil' && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw httpError(400, 'Choose a valid time to resume alerts.');
    out[key] = value;
  }
  return out;
}
export async function getSettings(store) { return normalizeSettings(await store.get('settings') || {}); }
