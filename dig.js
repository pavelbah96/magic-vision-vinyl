// Digging: shoot many records in a row, then ask one question about all of them.
// Photos → records (grouped by the model in portions) → album, edition and price for each →
// one answer to the user's prompt over the catalogue facts. The batch survives a page reload.
import * as core from './core.js';
import * as api from './api.js';

const LIMIT = 80;
const PRESETS = [
  ['Самые дорогие', 'Назови 5 самых дорогих пластинок и объясни, от чего зависит их цена.'],
  ['Коллекционное', core.DEFAULT_PROMPT],
  ['Что взять', 'Что из этого стоит купить для перепродажи? Сравни цену в продаже и то, насколько издание подтверждено.'],
  ['По жанрам', 'Разбей пачку по жанрам и в каждом выдели самое интересное.'],
];

export function createDig(ui) {
  const { $, esc, settings, prepare, openSettings, render } = ui;
  let D = blank(), ticket = 0, loaded = false;
  function blank() {
    return { phase: 'collect', shots: [], prompt: core.DEFAULT_PROMPT, web: false, items: [], report: null, reportError: '', progress: null, error: '', message: '', seconds: {} };
  }

  // MARK: storage — IndexedDB keeps the photos across a reload or a Safari tab eviction

  const db = () => new Promise((done, failed) => {
    const open = indexedDB.open('magicvision-dig', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('batch');
    open.onsuccess = () => done(open.result); open.onerror = () => failed(open.error);
  });
  async function save() {
    try {
      const base = await db(), { phase, shots, prompt, web, items, report, reportError } = D;
      const keep = { phase: phase === 'working' ? (items.length ? 'done' : 'collect') : phase, shots, prompt, web, items, report, reportError };
      await new Promise((done, failed) => { const tx = base.transaction('batch', 'readwrite'); tx.objectStore('batch').put(keep, 'current'); tx.oncomplete = done; tx.onerror = () => failed(tx.error); });
      base.close();
    } catch { D.message = 'Снимки не сохраняются в этом браузере: не закрывайте страницу до конца обработки.'; }
  }
  async function load() {
    if (loaded) return; loaded = true;
    try {
      const base = await db();
      const kept = await new Promise((done, failed) => { const get = base.transaction('batch').objectStore('batch').get('current'); get.onsuccess = () => done(get.result); get.onerror = () => failed(get.error); });
      base.close();
      if (kept?.shots?.length) D = { ...blank(), ...kept };
    } catch { /* nothing saved, or storage is unavailable */ }
  }

  // MARK: shots

  async function addFiles(files) {
    const list = [...(files ?? [])].slice(0, LIMIT - D.shots.length);
    if (!list.length) { if (files?.length) { D.message = `В пачке не больше ${LIMIT} снимков.`; render(); } return; }
    D.message = '';
    for (const file of list) {
      try {
        const shot = await prepare(file, 1600, 0.78);
        D.shots.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, data: shot.data, thumb: shot.thumb });
      } catch (error) { D.message = error.message; }
    }
    changed(); render(); save();
  }
  /** Results describe the photos they were made from: a changed batch is processed again. */
  function changed() { if (D.items.length || D.report) { D.items = []; D.report = null; D.reportError = ''; D.phase = 'collect'; } }

  // MARK: processing

  const live = (mine) => () => mine === ticket;
  function progress(step, done = 0, total = 0) { D.progress = { step, done, total }; render(); }
  async function timed(name, run) {
    const start = performance.now();
    try { return await run(); } finally { D.seconds[name] = (D.seconds[name] ?? 0) + (performance.now() - start) / 1000; }
  }
  async function run() {
    if (!settings.key) { openSettings(); return; }
    if (!D.shots.length) return;
    const mine = ++ticket, alive = live(mine);
    D.phase = 'working'; D.error = ''; D.message = ''; D.items = []; D.report = null; D.reportError = ''; D.seconds = {};
    try {
      const count = D.shots.length;
      progress('group', 0, count);
      const groups = await timed('grouping', () => core.groupInPortions(count, async (start, end) => {
        const found = await api.group({ images: D.shots.slice(start - 1, end).map((shot) => shot.data), key: settings.key, model: settings.model });
        if (!alive()) throw new Error('cancelled');
        progress('group', end, count);
        return found;
      }));
      if (!alive()) return;
      D.items = groups.map((group, index) => ({ number: index + 1, photos: group.photos, observation: group.observation, title: '', pending: true }));
      progress('lookup', 0, D.items.length);
      let next = 0, finished = 0;
      // Two records at a time: the Discogs limiter spaces the requests, the model calls overlap.
      await timed('catalogue', () => Promise.all([0, 1].map(async () => {
        while (alive() && next < D.items.length) {
          const item = D.items[next++];
          try { Object.assign(item, await lookup(item, alive)); }
          catch (error) { if (error.message === 'cancelled') return; item.issue = error.message; }
          item.pending = false; finished++;
          if (alive()) progress('lookup', finished, D.items.length);
        }
      })));
      if (!alive()) return;
      save();
      await ask(alive);
    } catch (error) {
      if (!alive() || error.message === 'cancelled') return;
      D.error = error.message; D.phase = D.items.length ? 'done' : 'collect'; D.progress = null; render();
    }
  }
  /** One record: read it if the grouping could not, then album → pressings → edition → price. */
  async function lookup(item, alive) {
    const images = item.photos.map((n) => D.shots[n - 1]?.data).filter(Boolean);
    let seen = item.observation;
    if (!core.readable(seen)) {
      seen = await api.read({ front: images[0], back: images[1] ?? null, key: settings.key, model: settings.model });
      if (!alive()) throw new Error('cancelled');
    }
    if (!core.readable(seen)) return { title: '', issue: 'Пластинку на снимке не разобрать' };
    const named = [seen.artist, seen.title].filter(Boolean).join(' — ') || seen.catalogNumber || seen.barcode;
    const text = core.observationText(seen);
    const evidence = core.absorbText(core.addObservation(core.newEvidence(), seen, { barcode: seen.barcode }), text);
    const found = await api.candidates(seen, evidence.barcode, settings.token);
    if (!alive()) throw new Error('cancelled');
    let pool = found.results.filter((release) => core.namesAlbum(release, seen));
    if (!pool.length && evidence.barcode) {
      const wanted = core.barcodeKey(evidence.barcode);
      const hit = found.results.find((release) => (release.barcode ?? []).some((value) => core.barcodeKey(value) === wanted));
      if (hit) pool = found.results.filter((release) => core.sameAlbum(release, hit));
    }
    if (!pool.length && found.results.length) {
      const picked = await api.select({ front: images[0], back: images[1] ?? null, key: settings.key, model: settings.model, candidates: found.results.slice(0, 15) }).catch(() => null);
      if (!alive()) throw new Error('cancelled');
      if (picked) pool = found.results.filter((release) => core.sameAlbum(release, picked));
    }
    if (!pool.length) return { title: named, issue: 'Нет в каталоге Discogs' };
    const total = found.total > found.results.length ? Math.max(pool.length + 1, Math.round(found.total * pool.length / found.results.length)) : pool.length;
    core.absorbPool(evidence, text, pool);
    let ranked = core.rank(pool, evidence);
    const pages = await api.details(ranked.slice(0, 2).map((entry) => entry.release.id), settings.token);
    if (!alive()) throw new Error('cancelled');
    pool = pool.map((release) => {
      const page = pages.get(release.id); if (!page) return release;
      return { ...page, title: release.title, country: page.country ?? release.country, year: page.year ?? release.year, catno: page.catno ?? release.catno, cover_image: page.cover_image ?? release.cover_image, thumb: page.thumb || release.thumb };
    });
    core.absorbPool(evidence, text, pool);
    ranked = core.rank(pool, evidence);
    // Without the close-up refinement a batch never fetches the whole list of a famous album.
    const verdict = core.verdict(ranked, total, total <= pool.length), best = verdict.best.release;
    const doubt = ['ambiguous', 'unknown'].includes(verdict.confidence) && verdict.group.length > 1;
    const ids = [best.id, ...(doubt ? verdict.group.slice(1, 4).map((entry) => entry.release.id) : [])];
    const quotes = await Promise.all(ids.map((id) => api.quote(id, settings.token).catch(() => undefined)));
    if (!alive()) throw new Error('cancelled');
    const euros = quotes.filter((quote) => quote?.currency === 'EUR').map((quote) => quote.amount);
    const range = doubt && euros.length > 1 && Math.min(...euros) !== Math.max(...euros) ? { from: Math.min(...euros), to: Math.max(...euros), currency: 'EUR' } : null;
    return {
      title: best.title, edition: core.releaseSummary(best), url: core.releaseURL(best.id), cover: core.coverURL(best),
      confidence: verdict.confidence, note: core.verdictNote(verdict), quote: quotes[0] ?? null, range, unpriced: quotes[0] === undefined,
      genres: best.genres ?? [], styles: best.styles ?? [], have: best.have ?? null, want: best.want ?? null, issue: '',
    };
  }
  /** The user's question over the facts gathered: the only step repeated for a new prompt. */
  async function ask(alive = live(++ticket)) {
    if (!D.items.length) return;
    D.phase = 'working'; D.reportError = ''; progress('report');
    try {
      const answer = await timed('report', () => api.report({ items: D.items, prompt: D.prompt, key: settings.key, model: settings.model, web: D.web }));
      if (!alive()) return;
      D.report = { ...answer, prompt: D.prompt, web: D.web };
    } catch (error) { if (!alive()) return; D.reportError = error.message; }
    D.phase = 'done'; D.progress = null; render(); save();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // MARK: screens

  const badge = (item) => (item.confidence ? `<span class="badge ${item.confidence}">${esc(core.CONFIDENCE_TITLE[item.confidence])}</span>` : '');
  function promptBox(label) {
    return `<div class="section-title">${label}</div>
    <div class="card">
      <textarea id="dig-prompt" rows="3" maxlength="1200" placeholder="Например: топ-10 по цене, только джаз, что взять до 20 €">${esc(D.prompt)}</textarea>
      <div class="chips">${PRESETS.map(([name], index) => `<button class="chip" data-act="dig-preset" data-n="${index}">${esc(name)}</button>`).join('')}</div>
      <label class="toggle"><input type="checkbox" id="dig-web" ${D.web ? 'checked' : ''}> <span>Дополнительно искать в интернете <span class="soft">— дольше</span></span></label>
    </div>`;
  }
  function viewCollect() {
    const count = D.shots.length;
    const grid = count ? `<div class="grid">${D.shots.map((shot, index) => `<div class="tile"><img src="${shot.thumb}" alt="Снимок ${index + 1}"><span>${index + 1}</span><button data-act="dig-remove" data-n="${index}" aria-label="Убрать снимок ${index + 1}">×</button></div>`).join('')}</div>` : '';
    const speed = settings.token ? '' : `<p class="hint">Без токена Discogs каталог отвечает медленно: около пяти пластинок в минуту.</p>`;
    return `${D.message ? `<div class="card notice">${esc(D.message)}</div>` : ''}${D.error ? `<div class="card error"><p>${esc(D.error)}</p></div>` : ''}
    <div class="dig-head"><h2>Диггинг</h2><button class="plain" data-act="dig-exit">Выйти</button></div>
    <div class="card">
      <div class="hero" style="padding:8px 0 4px">
        <button class="shutter small" data-act="dig-shoot"><span>Снять<br>${count ? `ещё · ${count}` : 'первую'}</span></button>
        <p class="lead">Снимайте пластинки подряд, по одной обложке. Оборот или яблоко — сразу после своей обложки.</p>
        <div class="links"><button class="link" data-act="dig-pick">Добавить из галереи</button></div>
      </div>
      ${grid}
    </div>
    ${count ? `${promptBox('Что сделать с пачкой')}
    <div class="stack">
      <button class="primary" data-act="dig-run">Обработать ${core.photos(count)}</button>
      ${speed}
      <button class="plain" data-act="dig-clear">Очистить пачку</button>
    </div>` : ''}`;
  }
  function viewWorking() {
    const p = D.progress ?? { step: 'group', done: 0, total: 0 };
    const line = {
      group: `Разбираю снимки по пластинкам · ${p.done} из ${p.total}`,
      lookup: `Ищу издания и цены · ${p.done} из ${core.plural(p.total, 'пластинки', 'пластинок', 'пластинок')}`,
      report: 'Отвечаю на вопрос по всей пачке…',
    }[p.step];
    const order = ['group', 'lookup', 'report'], now = order.indexOf(p.step), names = ['Снимки', 'Каталог', 'Ответ'];
    const done = D.items.filter((item) => !item.pending);
    return `<div class="card">
      <div class="stages">${order.map((step, index) => `<div class="stage ${index < now ? 'done' : index === now ? 'now' : ''}">${names[index]}</div>`).join('')}</div>
      <p class="center">${esc(line)}</p>
      ${p.total ? `<div class="bar-track"><div class="bar-fill" style="width:${Math.round(100 * p.done / p.total)}%"></div></div>` : ''}
      <div class="stack"><button class="plain" data-act="dig-cancel">Остановить</button></div>
    </div>
    ${done.length ? `<div class="card">${done.map(itemRow).join('')}</div>` : ''}`;
  }
  function itemRow(item) {
    const shot = D.shots[item.photos[0] - 1]?.thumb ?? '';
    const cover = item.cover || shot;
    const price = item.range ? `${core.money(item.range.from, 'EUR')}–${core.money(item.range.to, 'EUR')}`
      : item.quote ? core.money(item.quote.amount, item.quote.currency) : item.url ? (item.unpriced ? '?' : '—') : '';
    const what = `<span class="what"><b>№${item.number} ${esc(item.title || 'Не распознано')}</b>
      ${item.edition ? `<small>${esc(item.edition)}</small>` : ''}
      ${item.issue ? `<small class="clash">${esc(item.issue)}</small>` : badge(item)}</span>`;
    const inner = `<span class="thumb" style="background-image:url('${esc(cover)}')"></span>${what}<span class="cost">${esc(price)}</span>`;
    return item.url ? `<a class="past" href="${esc(item.url)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="past">${inner}</div>`;
  }
  function viewDone() {
    const report = D.report ? `<div class="card report">
        <p class="soft" style="font-size:13px;margin:0 0 6px">${esc(D.report.prompt)}${D.report.web ? ' · с поиском в интернете' : ''}</p>
        ${core.markdown(D.report.text)}
        ${D.report.sources?.length ? `<h3>Источники</h3><ul>${D.report.sources.map((source) => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.title)}</a></li>`).join('')}</ul>` : ''}
        <div class="row" style="margin-top:12px"><button class="ghost" data-act="dig-copy">Скопировать ответ</button></div>
      </div>` : '';
    const failed = D.reportError ? `<div class="card error"><p><b>Ответ не получен</b></p><p>${esc(D.reportError)}</p><div class="stack"><button class="ghost" data-act="dig-ask">Повторить</button></div></div>` : '';
    const times = [['grouping', 'снимки'], ['catalogue', 'каталог и цены'], ['report', 'ответ']].filter(([name]) => D.seconds[name] != null)
      .map(([name, word]) => `${word} ${D.seconds[name].toFixed(0)} с`).join(' · ');
    return `${D.error ? `<div class="card error"><p>${esc(D.error)}</p></div>` : ''}
    <div class="dig-head"><h2>Диггинг</h2><button class="plain" data-act="dig-exit">Выйти</button></div>
    <p class="basis" style="margin:0 4px 4px">${esc(core.batchSummary(D.items, D.shots.length))}</p>
    ${report}${failed}
    ${promptBox('Спросить иначе')}
    <div class="stack"><button class="primary" data-act="dig-ask">Ответить заново</button></div>
    <div class="section-title">Пластинки · ${D.items.length}</div>
    <div class="card">${D.items.map(itemRow).join('')}</div>
    <div class="stack">
      <button class="ghost" data-act="dig-more">Добавить снимки</button>
      <button class="plain" data-act="dig-clear">Новая пачка</button>
    </div>
    ${times ? `<p class="times">${esc(times)}</p>` : ''}`;
  }

  // MARK: events

  function readForm() {
    const prompt = $('dig-prompt'), web = $('dig-web');
    if (prompt) D.prompt = prompt.value.trim() || core.DEFAULT_PROMPT;
    if (web) D.web = web.checked;
  }
  const actions = {
    'dig-shoot': () => { if (!settings.key) return openSettings(); const input = $('dig-camera'); input.value = ''; input.click(); },
    'dig-pick': () => { if (!settings.key) return openSettings(); const input = $('dig-library'); input.value = ''; input.click(); },
    'dig-remove': (element) => { D.shots.splice(Number(element.dataset.n), 1); changed(); render(); save(); },
    'dig-preset': (element) => { const box = $('dig-prompt'); if (box) { box.value = PRESETS[Number(element.dataset.n)][1]; D.prompt = box.value; } },
    'dig-run': () => { readForm(); save(); run(); },
    'dig-ask': () => { readForm(); save(); ask(); },
    'dig-cancel': () => { ticket++; D.phase = D.items.some((item) => !item.pending) ? 'done' : 'collect'; D.items = D.items.filter((item) => !item.pending); D.progress = null; render(); save(); },
    'dig-more': () => { readForm(); D.phase = 'collect'; render(); },
    'dig-clear': () => { if (!confirm('Удалить все снимки и результаты этой пачки?')) return; ticket++; const { prompt, web } = D; D = { ...blank(), prompt, web }; render(); save(); },
    'dig-copy': async (element) => {
      const text = `${D.report.text}${D.report.sources?.length ? `\n\nИсточники:\n${D.report.sources.map((source) => `${source.title} — ${source.url}`).join('\n')}` : ''}`;
      try { await navigator.clipboard.writeText(text); element.textContent = 'Скопировано'; } catch { element.textContent = 'Не удалось скопировать'; }
    },
  };
  for (const id of ['dig-camera', 'dig-library']) $(id).addEventListener('change', (event) => addFiles(event.target.files));
  document.addEventListener('input', (event) => { if (event.target.id === 'dig-prompt' || event.target.id === 'dig-web') readForm(); });

  return {
    actions, load,
    get count() { return D.shots.length; },
    leave() { readForm(); save(); },
    view() { return { collect: viewCollect, working: viewWorking, done: viewDone }[D.phase](); },
    diagnostics: () => ({ digPhase: D.phase, digShots: D.shots.length, digItems: D.items.length, digReport: Boolean(D.report), digSeconds: Object.fromEntries(Object.entries(D.seconds).map(([name, value]) => [name, Number(value.toFixed(1))])) }),
  };
}
