// Screen and flow of the phone-only web version:
// front photo → optional back → album → edition → price → optional close-up of the label.
import * as core from './core.js';
import * as api from './api.js';

const VERSION = '1 (16.11.2026)';
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(name, fallback = '') { try { return localStorage.getItem(`mv.${name}`) ?? fallback; } catch { return fallback; } },
  set(name, value) { try { localStorage.setItem(`mv.${name}`, value); } catch { /* private mode */ } },
};
const settings = {
  get key() { return store.get('openaiKey').trim(); },
  get token() { return store.get('discogsToken').trim(); },
  get model() { return store.get('model').trim() || core.MODEL; },
};

let ticket = 0; // every new lookup takes a ticket; answers for an older one are dropped
let S = fresh();
function fresh() {
  return {
    phase: 'ready', run: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, role: 'front', front: null, back: null, stage: '',
    observation: null, evidence: null, text: '', pool: [], poolTotal: 0, complete: true, widened: '', detailed: new Set(), ranked: [], verdict: null,
    chosen: null, manual: false, quotes: {}, suggest: null, priceError: '', timings: {}, shots: [], labelShots: 0, message: '', error: '', query: '',
  };
}
async function timed(name, run) {
  const start = performance.now();
  try { return await run(); } finally { S.timings[name] = (S.timings[name] ?? 0) + (performance.now() - start) / 1000; }
}
function setStage(stage) { S.stage = stage; render(); }

// MARK: photos

/** Scales a photo down for upload and returns it as a JPEG data URL with a small preview. */
async function prepare(file, side, quality) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((done, failed) => { const img = new Image(); img.onload = () => done(img); img.onerror = failed; img.src = url; });
    const draw = (limit) => {
      const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const full = draw(side);
    return { data: full.toDataURL('image/jpeg', quality), thumb: draw(360).toDataURL('image/jpeg', 0.7), pixels: `${image.naturalWidth}×${image.naturalHeight} → ${full.width}×${full.height}` };
  } catch { throw new Error('Не удалось открыть снимок. Попробуйте ещё раз.'); }
  finally { URL.revokeObjectURL(url); }
}
function shoot(role, library = false) {
  if (!settings.key) { openSettings(); return; }
  S.role = role;
  const input = $(library ? 'library' : 'camera'); input.value = ''; input.click();
}
async function onFile(file) {
  if (!file) return;
  const role = S.role;
  try {
    const shot = await prepare(file, role === 'front' ? 2048 : 2600, role === 'front' ? 0.82 : 0.85);
    if (role === 'front') { ticket++; S = fresh(); S.front = shot; S.shots.push(`обложка ${shot.pixels}`); S.phase = 'front'; render(); }
    else if (role === 'back' && S.phase === 'front') { S.back = shot; S.shots.push(`оборот ${shot.pixels}`); lookup(); }
    else if (role === 'label' && S.phase === 'result') { S.shots.push(`крупно ${shot.pixels}`); refine(shot); }
  } catch (error) { S.message = error.message; render(); }
}

// MARK: lookup

function fail(error, query = '') {
  S.phase = 'error'; S.stage = ''; S.error = error?.message ?? String(error); S.query = query; render();
}
/** Photos → what is printed on them → the album and its pressings. */
async function lookup() {
  const mine = ++ticket, live = () => mine === ticket;
  S.phase = 'working'; S.message = ''; setStage('read');
  try {
    const seen = await timed('vision', () => api.read({ front: S.front.data, back: S.back?.data ?? null, key: settings.key, model: settings.model }));
    if (!live()) return;
    if (!seen.isRecord || !(seen.artist || seen.title || seen.catalogNumber || seen.barcode)) {
      fail(new Error('На снимке не удалось разобрать пластинку. Снимите обложку целиком, без бликов.')); return;
    }
    await resolve(seen, live);
  } catch (error) { if (live()) fail(error); }
}
async function resolve(seen, live) {
  S.observation = seen; S.text = core.observationText(seen);
  S.evidence = core.absorbText(core.addObservation(core.newEvidence(), seen, { barcode: seen.barcode }), S.text);
  setStage('catalogue');
  const found = await timed('discogs', () => api.candidates(seen, S.evidence.barcode, settings.token));
  if (!live()) return;
  let pool = found.results.filter((release) => core.namesAlbum(release, seen));
  if (!pool.length && S.evidence.barcode) {
    // A barcode names the record even when Discogs spells the title differently.
    const wanted = core.barcodeKey(S.evidence.barcode);
    const hit = found.results.find((release) => (release.barcode ?? []).some((value) => core.barcodeKey(value) === wanted));
    if (hit) pool = found.results.filter((release) => core.sameAlbum(release, hit));
  }
  if (!pool.length && found.results.length) {
    // Spelling differs from Discogs: with photos the model points at the album, a typed query takes the best hit.
    let picked = found.results[0];
    if (S.front) {
      picked = await timed('verify', () => api.select({ front: S.front.data, back: S.back?.data ?? null, key: settings.key, model: settings.model, candidates: found.results.slice(0, 15) })).catch(() => null);
      if (!live()) return;
    }
    if (picked) pool = found.results.filter((release) => core.sameAlbum(release, picked));
  }
  const query = [seen.artist, seen.title, seen.catalogNumber].filter(Boolean).join(' ');
  if (!pool.length) { fail(new Error('В каталоге Discogs такой пластинки не нашлось.'), query); return; }
  S.pool = pool; S.query = query;
  // Discogs lists more pressings than one page returns; the share that is this album is estimated.
  S.poolTotal = found.total > found.results.length ? Math.max(pool.length + 1, Math.round(found.total * pool.length / found.results.length)) : pool.length;
  S.complete = S.poolTotal <= S.pool.length;
  if (await widen(live)) await settle(live);
}
/** Adds the pressings named by the evidence when the pool is only part of the album. False if superseded. */
async function widen(live) {
  if (S.poolTotal <= S.pool.length) return true;
  const named = [S.evidence.barcode, ...S.evidence.catalogNumbers.slice(0, 2), core.discogsCountry(S.evidence.country) ?? ''].join('|');
  if (named === S.widened || !named.replaceAll('|', '')) return true;
  S.widened = named;
  const extra = await timed('discogs', () => api.narrowed(S.observation, S.evidence, settings.token));
  if (!live()) return false;
  const known = new Set(S.pool.map((release) => release.id));
  for (const release of extra.results) if (!known.has(release.id) && (core.namesAlbum(release, S.observation) || core.sameAlbum(release, S.pool[0]))) S.pool.push(release);
  if (extra.complete) S.complete = true;
  return true;
}
/** Ranks the pressings against the evidence, reads the pages of the best three, decides. */
async function settle(live) {
  core.absorbPool(S.evidence, S.text, S.pool);
  let ranked = core.rank(S.pool, S.evidence);
  const ids = ranked.slice(0, 3).map((item) => item.release.id).filter((id) => !S.detailed.has(id));
  if (ids.length) {
    const pages = await timed('details', () => api.details(ids, settings.token));
    if (!live()) return;
    S.pool = S.pool.map((release) => {
      const page = pages.get(release.id); if (!page) return release;
      S.detailed.add(release.id);
      return { ...page, title: release.title, country: page.country ?? release.country, year: page.year ?? release.year, catno: page.catno ?? release.catno, cover_image: page.cover_image ?? release.cover_image, thumb: page.thumb || release.thumb };
    });
    core.absorbPool(S.evidence, S.text, S.pool);
    ranked = core.rank(S.pool, S.evidence);
  }
  S.ranked = ranked; S.verdict = core.verdict(ranked, S.poolTotal, S.complete);
  S.chosen = S.verdict.best.release; S.manual = false; S.phase = 'result'; setStage('price');
  await prices(live);
}
const uncertain = () => !S.manual && ['ambiguous', 'unknown'].includes(S.verdict.confidence) && S.verdict.group.length > 1;
async function prices(live, renew = false) {
  const ids = [S.chosen.id];
  if (uncertain()) for (const item of S.verdict.group.slice(0, 4)) if (!ids.includes(item.release.id)) ids.push(item.release.id);
  S.priceError = '';
  await timed('quotes', () => Promise.all(ids.map(async (id) => {
    try { S.quotes[id] = await api.quote(id, settings.token, renew); } catch (error) { S.priceError = error.message; }
  })));
  if (!live()) return;
  if (settings.token && S.suggest?.id !== S.chosen.id) {
    const id = S.chosen.id, found = await api.suggestions(id, settings.token).catch(() => null);
    if (!live()) return;
    S.suggest = found ? { id, ...found } : null;
  }
  setStage(''); remember();
}
/** A close-up of the label, run-out or barcode corner adds evidence and the edition is decided again. */
async function refine(shot) {
  const mine = ++ticket, live = () => mine === ticket;
  const back = (message) => { S.phase = 'result'; S.message = message; setStage(''); };
  S.phase = 'working'; S.message = ''; setStage('read');
  try {
    const seen = await timed('label', () => api.read({ front: shot.data, key: settings.key, model: settings.model, focus: 'label' }));
    if (!live()) return;
    S.labelShots++;
    const text = core.observationText(seen);
    if (!text && !seen.label && !seen.country) { back('На крупном плане ничего не прочиталось. Поднесите ближе, уберите блики и повторите.'); return; }
    core.addObservation(S.evidence, seen, { barcode: seen.barcode, overriding: true });
    S.text += ` | ${text}`; core.absorbText(S.evidence, S.text);
    setStage('catalogue');
    if (!(await widen(live))) return;
    await settle(live);
  } catch (error) { if (live()) back(error.message); }
}
/** Typed search: "artist - album", a barcode, or anything Discogs can find. */
async function manual(text) {
  const query = text.trim(); if (!query) return;
  const mine = ++ticket, live = () => mine === ticket;
  S = fresh(); S.phase = 'working'; S.query = query; setStage('catalogue');
  const clean = (artist) => artist.replace(/\s*\([0-9]+\)\s*$/, '').replace(/\*$/, '');
  try {
    const digits = query.replace(/[\s-]/g, ''), parts = query.split(/\s+[-–—]\s+/);
    let seen;
    if (/^\d{12,13}$/.test(digits) && core.validEAN(digits)) seen = core.emptyObservation({ barcode: digits });
    else if (parts.length === 2) seen = core.emptyObservation({ artist: parts[0].trim(), title: parts[1].trim() });
    else {
      const first = (await timed('discogs', () => api.broad(query, settings.token))).results?.find(core.isVinyl);
      if (!live()) return;
      if (!first) { fail(new Error('В каталоге Discogs такой пластинки не нашлось.'), query); return; }
      const [artist, title] = core.splitTitle(first.title);
      seen = core.emptyObservation({ artist: clean(artist), title });
    }
    await resolve(seen, live);
  } catch (error) { if (live()) fail(error, query); }
}
function choose(id) {
  const item = S.ranked.find((entry) => entry.release.id === id); if (!item || S.phase !== 'result') return;
  S.chosen = item.release; S.manual = item.release.id !== S.verdict.best.release.id || S.manual; render();
  const mine = ticket; prices(() => mine === ticket);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// MARK: history

function history() { try { const all = JSON.parse(store.get('history', '[]')); return Array.isArray(all) ? all : []; } catch { return []; } }
function remember() {
  const release = S.chosen; if (!release) return;
  const quote = S.quotes[release.id];
  const entry = {
    id: S.run, at: Date.now(), title: release.title, summary: core.releaseSummary(release), confidence: S.manual ? 'manual' : S.verdict.confidence,
    price: quote ? core.money(quote.amount, quote.currency) : '', url: core.releaseURL(release.id), cover: core.coverURL(release),
  };
  store.set('history', JSON.stringify([entry, ...history().filter((item) => item.id !== entry.id)].slice(0, 100)));
  renderHistory();
}

// MARK: screens

const CAMERA = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.6l1.2-1.8h7.4L16.9 6h1.6A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.6"/></svg>';
const offers = (count) => { const a = count % 10, b = count % 100; return `${count} ${a === 1 && b !== 11 ? 'предложение' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'предложения' : 'предложений'}`; };
const seconds = (value) => `${value.toFixed(1).replace('.', ',')} с`;
const thumb = (url) => (url ? ` style="background-image:url('${esc(url)}')"` : '');
const messageCard = () => (S.message ? `<div class="card notice">${esc(S.message)}</div>` : '');

function viewReady() {
  const noKey = settings.key ? '' : '<div class="card notice">Чтобы распознавать пластинки по фото, добавьте ключ OpenAI. Поиск по названию работает и без него.<br><button data-act="settings">Открыть настройки</button></div>';
  return `${noKey}${messageCard()}
  <div class="hero">
    <button class="shutter" data-act="shoot-front"><span>${CAMERA}Снять<br>обложку</span></button>
    <p class="lead">Наведите телефон на пластинку — найду альбом, конкретное издание и цену.</p>
    <div class="links"><button class="link" data-act="pick-front">Выбрать фото из галереи</button></div>
  </div>
  <form class="search" data-form="search">
    <input name="q" placeholder="Исполнитель — альбом или штрихкод" enterkeyhint="search" autocomplete="off" aria-label="Поиск по названию">
    <button class="ghost" style="flex:none">Найти</button>
  </form>`;
}
function shotsRow(extra = '') {
  if (!S.front) return '';
  const back = S.back ? `<div class="shot"><img src="${S.back.thumb}" alt="Оборот"><span>Оборот</span></div>` : extra;
  return `<div class="shots"><div class="shot"><img src="${S.front.thumb}" alt="Обложка"><span>Обложка</span></div>${back}</div>`;
}
function viewFront() {
  return `<div class="card">
    ${shotsRow('<button class="shot" data-act="shoot-back">＋ Оборот</button>')}
    <p class="hint">На обороте обычно напечатаны каталожный номер и штрихкод — по ним издание определяется точнее.</p>
    <div class="stack">
      <button class="primary" data-act="shoot-back">Снять оборот</button>
      <button class="ghost" data-act="lookup">Искать без оборота</button>
      <button class="plain" data-act="reset">Отмена</button>
    </div>
  </div>${messageCard()}`;
}
function stagesRow() {
  const order = ['capture', 'read', 'catalogue', 'price'], names = { capture: 'Снимок', read: 'Чтение', catalogue: 'Каталог', price: 'Цена' };
  const now = order.indexOf(S.stage);
  return `<div class="stages">${order.map((stage, index) => `<div class="stage ${index < now ? 'done' : index === now ? 'now' : ''}">${names[stage]}</div>`).join('')}</div>`;
}
function viewWorking() {
  const doing = { read: 'Читаю, что напечатано на пластинке…', catalogue: 'Ищу издания в каталоге Discogs…', price: 'Узнаю цены…' }[S.stage] ?? '';
  return `<div class="card">${stagesRow()}${shotsRow()}<p class="center soft">${doing}</p>
    <div class="stack"><button class="plain" data-act="reset">Отмена</button></div></div>`;
}
function priceBlock() {
  const release = S.chosen, quote = S.quotes[release.id], doubt = uncertain();
  let main;
  if (quote === undefined) main = S.priceError ? `<div class="sub">${esc(S.priceError)}</div>` : '<div class="label">Узнаю цену…</div>';
  else if (quote === null) main = '<div class="label">На Discogs</div><div class="amount" style="font-size:22px">сейчас не продаётся</div>';
  else main = `<div class="label">${doubt ? 'Показанный вариант · в продаже от' : 'В продаже от'}</div><div class="amount">${esc(core.money(quote.amount, quote.currency))}</div><div class="sub">${offers(quote.offers)} на Discogs</div>`;
  let range = '';
  if (doubt) {
    const found = S.verdict.group.map((item) => S.quotes[item.release.id]).filter(Boolean);
    const currency = found[0]?.currency, amounts = found.filter((item) => item.currency === currency).map((item) => item.amount);
    if (amounts.length > 1 && Math.min(...amounts) !== Math.max(...amounts)) range = `<div class="range">Среди подходящих изданий: от ${esc(core.money(Math.min(...amounts), currency))} до ${esc(core.money(Math.max(...amounts), currency))}</div>`;
  }
  let grades = '';
  if (S.suggest?.id === release.id) {
    const cell = (name, value) => (value ? `<div class="grade">${name}<b>${esc(core.money(value.amount, value.currency))}</b></div>` : '');
    grades = `<div class="grades">${cell('VG', S.suggest.vg)}${cell('VG+', S.suggest.vgPlus)}${cell('NM', S.suggest.nearMint)}</div><div class="sub">Оценка Discogs по состоянию, из истории продаж</div>`;
  }
  return `<div class="price">${main}${range}${grades}</div>`;
}
function variantRow(item) {
  const release = item.release, quote = S.quotes[release.id];
  const format = (release.format ?? []).filter((name) => String(name).toLowerCase() !== 'vinyl').slice(0, 5).join(', ');
  const cost = quote ? esc(core.money(quote.amount, quote.currency)) : quote === null ? '—' : '';
  return `<button class="variant ${release.id === S.chosen.id ? 'chosen' : ''}" data-act="choose" data-id="${release.id}">
    <span class="thumb"${thumb(core.coverURL(release))}></span>
    <span class="what"><b>${esc(core.releaseSummary(release) || 'Без данных')}</b>
      ${format ? `<small>${esc(format)}</small>` : ''}
      ${item.score.matched.length ? `<small>совпало: ${esc(item.score.matched.join(', '))}</small>` : ''}
      ${item.score.conflicts.length ? `<small class="clash">${esc(item.score.conflicts.join(', '))}</small>` : ''}</span>
    <span class="cost">${cost}</span></button>`;
}
function viewResult() {
  const release = S.chosen, [artist, title] = core.splitTitle(release.title);
  const confidence = S.manual ? 'manual' : S.verdict.confidence;
  const badge = S.manual ? 'Издание выбрано вручную' : core.CONFIDENCE_TITLE[confidence];
  const basis = S.manual ? '' : core.verdictNote(S.verdict).replace(`${core.CONFIDENCE_TITLE[confidence]} · `, '').replace(core.CONFIDENCE_TITLE[confidence], '');
  const read = core.evidenceSummary(S.evidence), labels = (release.label ?? []).slice(0, 2).join(', ');
  const hint = S.manual || !settings.key ? '' : core.advice(S.evidence, S.verdict.confidence);
  const rows = uncertain() ? S.verdict.group : S.ranked.slice(0, 6);
  const all = release.master_id > 0 ? `https://www.discogs.com/master/${release.master_id}` : `https://www.discogs.com/search/?${new URLSearchParams({ q: S.query || release.title, type: 'release', format: 'Vinyl' })}`;
  const ebay = `https://www.ebay.com/sch/i.html?${new URLSearchParams({ _nkw: `${artist} ${title} vinyl`.trim(), LH_Sold: '1', LH_Complete: '1' })}`;
  const times = [['vision', 'чтение'], ['verify', 'сверка'], ['label', 'крупный план'], ['discogs', 'каталог'], ['details', 'издания'], ['quotes', 'цены']]
    .filter(([name]) => S.timings[name] != null).map(([name, word]) => `${word} ${seconds(S.timings[name])}`).join(' · ');
  return `${messageCard()}<div class="card">
    <div class="result-head">
      <div class="cover"${thumb(core.coverURL(release))}></div>
      <div style="min-width:0">
        <h1>${esc(title)}</h1><p class="artist">${esc(artist)}</p>
        <p class="edition">${esc(core.releaseSummary(release) || 'Данных об издании нет')}${labels ? `<br><span class="soft">${esc(labels)}</span>` : ''}</p>
      </div>
    </div>
    <div class="badge ${confidence}">${esc(badge)}</div>
    ${basis ? `<p class="basis">${esc(basis)}</p>` : ''}
    ${priceBlock()}
    <div class="stack">
      ${settings.key && confidence !== 'confirmed' ? '<button class="primary" data-act="shoot-label">Уточнить издание: снять крупно</button>' : ''}
      <div class="row"><a class="ghost" href="${core.releaseURL(release.id)}" target="_blank" rel="noopener">Discogs</a><a class="ghost" href="${esc(ebay)}" target="_blank" rel="noopener">Продано на eBay</a></div>
      <button class="${settings.key && confidence !== 'confirmed' ? 'ghost' : 'primary'}" data-act="${settings.key ? 'shoot-front' : 'reset'}">Следующая пластинка</button>
    </div>
    ${hint ? `<p class="advice">${esc(hint)}</p>` : ''}
  </div>
  ${read.length ? `<div class="section-title">Прочитано с пластинки</div><div class="card"><div class="chips">${read.map((part) => `<span class="chip">${esc(part)}</span>`).join('')}</div></div>` : ''}
  ${S.ranked.length > 1 ? `<div class="section-title">${uncertain() ? 'Подходящие издания' : 'Издания альбома'} · ${rows.length} из ${Math.max(S.poolTotal, S.ranked.length)}</div>
  <div class="card">${rows.map(variantRow).join('')}
    <div class="stack"><a class="plain" href="${esc(all)}" target="_blank" rel="noopener">Все издания на Discogs</a></div></div>` : ''}
  ${times ? `<p class="times">${esc(times)}</p>` : ''}`;
}
function viewError() {
  const search = S.query ? `<a class="ghost" href="https://www.discogs.com/search/?${new URLSearchParams({ q: S.query, type: 'release', format: 'Vinyl' })}" target="_blank" rel="noopener">Искать «${esc(S.query)}» на Discogs</a>` : '';
  const retry = S.front ? '<button class="ghost" data-act="lookup">Повторить</button>' : '';
  return `<div class="card error"><p><b>Не получилось</b></p><p>${esc(S.error)}</p>
    <div class="stack">${search}${retry}<button class="primary" data-act="reset">На главный экран</button></div></div>`;
}
function render() {
  $('view').innerHTML = { ready: viewReady, front: viewFront, working: viewWorking, result: viewResult, error: viewError }[S.phase]();
}
const BADGE = { confirmed: 'издание подтверждено', likely: 'вероятное издание', ambiguous: 'издание не определено', unknown: 'издание неизвестно', manual: 'выбрано вручную' };
function renderHistory() {
  const all = history();
  $('history').innerHTML = all.length ? `<div class="history-head"><div class="section-title">Недавние · ${all.length}</div><button data-act="clear-history">Очистить</button></div>
    <div class="card">${all.slice(0, 30).map((item) => `<a class="past" href="${esc(item.url)}" target="_blank" rel="noopener">
      <span class="thumb"${thumb(item.cover)}></span>
      <span class="what">${esc(item.title)}<small>${esc([item.summary, BADGE[item.confidence]].filter(Boolean).join(' · '))}</small></span>
      <span class="cost">${esc(item.price)}</span></a>`).join('')}</div>` : '';
}

// MARK: settings and diagnostics

function openSettings() {
  $('set-key').value = store.get('openaiKey'); $('set-token').value = store.get('discogsToken'); $('set-model').value = settings.model;
  $('version').textContent = `Веб-версия ${VERSION}`;
  $('settings').showModal();
}
function saveSettings() {
  store.set('openaiKey', $('set-key').value.trim()); store.set('discogsToken', $('set-token').value.trim());
  const model = $('set-model').value.trim(); store.set('model', model && model !== core.MODEL ? model : '');
  render();
}
/** Counters and states only: no keys, no photos. */
function diagnostics() {
  return JSON.stringify({
    version: VERSION, phase: S.phase, stage: S.stage, confidence: S.manual ? 'manual' : S.verdict?.confidence ?? null,
    release: S.chosen?.id ?? null, pool: S.pool.length, poolTotal: S.poolTotal, complete: S.complete, group: S.verdict?.group.length ?? 0,
    evidence: S.evidence ? core.evidenceSummary(S.evidence) : [], matched: S.verdict?.best?.score.matched ?? [], conflicts: S.verdict?.best?.score.conflicts ?? [],
    shots: S.shots, labelShots: S.labelShots, seconds: Object.fromEntries(Object.entries(S.timings).map(([name, value]) => [name, Number(value.toFixed(2))])),
    error: S.error || S.priceError || S.message, openaiKey: Boolean(settings.key), discogsToken: Boolean(settings.token), model: settings.model,
    ...api.diagnostics(), secure: window.isSecureContext, agent: navigator.userAgent,
  }, null, 1);
}
async function copyDiagnostics(button) {
  const text = diagnostics();
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = document.createElement('textarea'); area.value = text; $('settings').append(area); area.select();
    document.execCommand('copy'); area.remove();
  }
  button.textContent = 'Скопировано'; setTimeout(() => { button.textContent = 'Скопировать диагностику'; }, 1500);
}

// MARK: events

const actions = {
  'shoot-front': () => shoot('front'), 'pick-front': () => shoot('front', true), 'shoot-back': () => shoot('back'), 'shoot-label': () => shoot('label'),
  lookup: () => lookup(), settings: () => openSettings(),
  reset: () => { ticket++; S = fresh(); render(); },
  choose: (element) => choose(Number(element.dataset.id)),
  'clear-history': () => { if (confirm('Очистить список недавних пластинок?')) { store.set('history', '[]'); renderHistory(); } },
};
document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-act]');
  if (element) actions[element.dataset.act]?.(element);
});
document.addEventListener('submit', (event) => {
  if (event.target.dataset.form !== 'search') return;
  event.preventDefault();
  const input = event.target.elements.q; input.blur(); manual(input.value);
});
for (const id of ['camera', 'library']) $(id).addEventListener('change', (event) => onFile(event.target.files?.[0]));
$('open-settings').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', saveSettings);
$('copy-diagnostics').addEventListener('click', (event) => copyDiagnostics(event.currentTarget));

render(); renderHistory();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
