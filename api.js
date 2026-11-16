// Network side of the web version: OpenAI and Discogs are called straight from the browser,
// there is no server. Keys never leave the device except to the service they belong to.
import * as core from './core.js';

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
function openaiMessage(status) {
  if (status === 401) return 'OpenAI: ключ отклонён (401). Проверьте его в настройках.';
  if (status === 429) return 'OpenAI: лимит запросов или средств (429).';
  if (status === 400 || status === 404) return `OpenAI: проверьте выбранную модель и её доступность (${status}).`;
  return `OpenAI: ошибка HTTP ${status}. Повторите.`;
}
function discogsMessage(status) {
  if (status === 401 || status === 403) return 'Discogs отклонил запрос. Проверьте personal token в настройках.';
  if (status === 429) return 'Discogs ограничил частоту запросов. Подождите минуту и повторите.';
  return `Discogs: ошибка ${status}. Повторите позже.`;
}
async function request(url, options, timeout, service) {
  const control = new AbortController(), timer = setTimeout(() => control.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: control.signal });
    if (!response.ok) throw new ApiError(service === 'openai' ? openaiMessage(response.status) : discogsMessage(response.status), response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const name = service === 'openai' ? 'OpenAI' : 'Discogs';
    throw new ApiError(error?.name === 'AbortError' ? `${name} не ответил вовремя. Проверьте связь и повторите.` : `Нет связи с ${name}. Проверьте интернет.`);
  } finally { clearTimeout(timer); }
}

// MARK: OpenAI

let fineRejected = false;
async function respond(body, key, timeout = 60000) {
  if (!String(key ?? '').trim()) throw new ApiError('Введите ключ OpenAI в настройках.');
  return request('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.trim()}` }, body: JSON.stringify(body),
  }, timeout, 'openai');
}
/** Reads one record from its photos. Falls back to the standard resolution if the full one is refused. */
export async function read({ front, back = null, key, model, focus = 'sleeve' }) {
  const body = (fine) => core.visionBody({ front, back, model, focus, fine });
  try { return core.parseVision(await respond(body(fineRejected ? 'high' : 'original'), key)); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400 || fineRejected) throw error;
    const seen = core.parseVision(await respond(body('high'), key));
    fineRejected = true; return seen;
  }
}
export async function select({ front, back = null, key, model, candidates }) {
  return core.parseSelection(await respond(core.selectionBody({ front, back, model, candidates }), key), candidates);
}
export const diagnostics = () => ({ fineRejected });
/** Digging: numbered photos → records (photo numbers within this request, from 1). */
export async function group({ images, key, model }) {
  return core.repairGroups(await respond(core.groupingBody({ images, model }), key, 150000), images.length);
}
/** Digging: one answer about the whole batch, to the user's own question. */
export async function report({ items, prompt, key, model, web = false }) {
  return core.parseReport(await respond(core.reportBody({ items, prompt, model, web }), key, web ? 180000 : 120000));
}

// MARK: Discogs

const recent = [];
async function pace(authenticated) {
  for (;;) {
    const now = Date.now(), delay = core.pacerDelay(recent, now, authenticated);
    if (delay <= 0) { recent.push(now); while (recent.length && now - recent[0] >= 60000) recent.shift(); return; }
    await new Promise((done) => setTimeout(done, delay));
  }
}
async function discogs(path, query = {}, token = '') {
  const url = new URL(`https://api.discogs.com/${path}`);
  for (const [name, value] of Object.entries(query)) if (value !== '' && value != null) url.searchParams.set(name, value);
  await pace(Boolean(token));
  // Without a token the request carries no custom header, so the browser sends it without a preflight.
  return request(url, token ? { headers: { Authorization: `Discogs token=${token}` } } : {}, 20000, 'discogs');
}
const searchQuery = ({ artist = '', title = '', catalogNumber = '', country = '', barcode = '' }) => ({
  type: 'release', format: 'Vinyl', per_page: 100, barcode, artist: barcode ? '' : artist, release_title: barcode ? '' : title,
  catno: catalogNumber, country: core.discogsCountry(country) ?? '',
});
/** Structured search: pressings of an album, a hundred at a time, each with its identifiers. */
export function search(fields, token) { return discogs('database/search', searchQuery(fields), token); }
/** The same search read to the end (up to `limit` pages); `complete` says whether that was all of it. */
async function searchAll(fields, token, limit = 3) {
  const query = searchQuery(fields), first = await discogs('database/search', query, token);
  const pages = first.pagination?.pages ?? 1, results = [...(first.results ?? [])];
  const rest = await Promise.all(Array.from({ length: Math.max(0, Math.min(pages, limit) - 1) }, (_, index) => discogs('database/search', { ...query, page: index + 2 }, token)));
  for (const page of rest) results.push(...(page.results ?? []));
  return { results, complete: pages <= limit };
}
/** Free-text search: forgives spelling and needs no artist/title split. */
export function broad(query, token) {
  return discogs('database/search', { q: query.slice(0, 500), type: 'release', format: 'Vinyl', per_page: 50 }, token);
}
export async function release(id, token) { return core.parseRelease(await discogs(`releases/${id}`, {}, token)); }
/** Full pages of a few pressings at once; one that cannot be read keeps its search data. */
export async function details(ids, token) {
  const found = new Map();
  await Promise.all([...new Set(ids)].map(async (id) => { try { found.set(id, await release(id, token)); } catch { /* keep search data */ } }));
  return found;
}
const quotes = new Map();
/** Lowest asking price, cached for ten minutes unless `fresh`. null = nothing for sale. */
export async function quote(id, token, fresh = false) {
  const cached = quotes.get(id);
  if (!fresh && cached && Date.now() - cached.at < 600000) return cached.quote;
  const found = core.parseQuote(await discogs(`marketplace/stats/${id}`, { curr_abbr: 'EUR' }, token), id);
  quotes.set(id, { quote: found, at: Date.now() });
  return found;
}
/** Discogs' own price suggestions by condition, from sales history. Needs a personal token. */
export async function suggestions(id, token) {
  if (!token) return null;
  const data = await discogs(`marketplace/price_suggestions/${id}`, {}, token);
  const pick = (name) => (data?.[name]?.value > 0 ? { amount: data[name].value, currency: data[name].currency } : null);
  const result = { vg: pick('Very Good (VG)'), vgPlus: pick('Very Good Plus (VG+)'), nearMint: pick('Near Mint (NM or M-)') };
  return result.vg || result.vgPlus || result.nearMint ? result : null;
}
/**
 * Collects the pressings of one album, from the most to the least specific identifier.
 * A step that fails is remembered: if nothing at all is found, the real error (rate limit,
 * network) is thrown instead of being reported as "no such record".
 */
export async function candidates(observation, barcode, token) {
  let found = [], total = 0, failure = null;
  const attempt = async (run, merge = false) => {
    try {
      const response = await run(), vinyl = (response.results ?? []).filter(core.isVinyl);
      if (merge) { const known = new Set(found.map((item) => item.id)); found.push(...vinyl.filter((item) => !known.has(item.id))); }
      else { found = vinyl; total = response.pagination?.items ?? vinyl.length; }
    } catch (error) { failure = error; }
  };
  const { artist, title } = observation, plain = [artist, title].filter(Boolean).join(' ');
  // A barcode names the edition far more precisely than a title, so it is searched first and alone.
  if (barcode) await attempt(() => search({ barcode }, token));
  if (!found.length && plain) {
    if (artist && title) await attempt(() => search({ artist, title }, token));
    if (!found.length) await attempt(() => broad(plain, token));
  }
  if (!found.length && observation.catalogNumber) await attempt(() => search({ artist, title, catalogNumber: observation.catalogNumber, country: observation.country }, token));
  if (!found.length && failure) throw failure;
  return { total: Math.max(total, found.length), results: found.slice(0, 250) };
}
/**
 * A famous album has hundreds of pressings and a search returns a hundred. This asks for exactly
 * the ones the evidence names (barcode, catalogue number, country), read to the end.
 * `complete` is true when at least one of those lists was fetched whole: only then can the best
 * match be called confirmed, because every rival that shares the identifier has been compared.
 */
export async function narrowed(observation, evidence, token) {
  const { artist, title } = observation, found = new Map();
  let complete = false;
  const add = async (fields) => {
    try {
      const got = await searchAll(fields, token);
      for (const item of got.results.filter(core.isVinyl)) found.set(item.id, item);
      if (got.complete) complete = true;
    } catch { /* an optional refinement: the lookup goes on without it */ }
  };
  const jobs = [];
  if (evidence.barcode) jobs.push(add({ barcode: evidence.barcode }));
  if (artist && title) {
    for (const number of evidence.catalogNumbers.slice(0, 2)) jobs.push(add({ artist, title, catalogNumber: number }));
    if (core.discogsCountry(evidence.country)) jobs.push(add({ artist, title, country: evidence.country }));
  }
  await Promise.all(jobs);
  return { results: [...found.values()], complete };
}
