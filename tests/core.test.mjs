// Offline checks of the web core: `node --test web/tests`. No network, no keys, no camera.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core.js';

const release = (id, fields = {}) => ({ id, title: 'The Beatles - Abbey Road', country: 'UK', year: '1969', catno: 'PCS 7088', label: ['Apple Records'], format: ['Vinyl', 'LP', 'Album', 'Stereo'], barcode: [], ...fields });
const seen = (fields = {}) => core.emptyObservation({ artist: 'The Beatles', title: 'Abbey Road', ...fields });
const evidence = (fields = {}, barcode = '') => core.addObservation(core.newEvidence(), seen(fields), { barcode });

test('album identity tolerates Discogs spellings but not another artist or album', () => {
  assert.ok(core.namesAlbum(release(1, { title: 'Beatles, The - Abbey Road' }), seen()));
  assert.ok(core.namesAlbum(release(1, { title: 'Kino (2) - Группа Крови = Blood Type' }), seen({ artist: 'Kino', title: 'Blood Type' })));
  assert.ok(!core.namesAlbum(release(1), seen({ artist: 'The Beat' })));
  assert.ok(!core.namesAlbum(release(1, { title: 'The Beatles - Help!' }), seen()));
  assert.ok(!core.namesAlbum(release(1), core.emptyObservation()));
  assert.ok(core.sameAlbum(release(1, { title: 'Kino (2) - Ночь' }), release(2, { title: 'Kino - Ночь' })));
});

test('barcodes are validated by their check digit', () => {
  assert.ok(core.validEAN('5012394144777') && core.validEAN('077774644617'));
  assert.ok(!core.validEAN('5012394144778') && !core.validEAN('12345'));
  assert.equal(core.barcodeKey('0 77774 64461 7'), '077774644617');
  assert.equal(core.barcodeKey('0077774644617'), '077774644617');
});

test('countries printed on records map to Discogs names and regions', () => {
  assert.equal(core.countryKey('Made in England'), 'uk');
  assert.equal(core.countryKey('Printed in West Germany'), 'germany');
  assert.equal(core.countryKey('Russia'), 'russia');
  assert.equal(core.discogsCountry('Made in the U.S.A.'), 'US');
  assert.equal(core.discogsCountry('Made in Narnia'), null);
  assert.deepEqual([...core.countryRegions('UK, Europe & US')].sort(), ['europe', 'uk', 'us']);
});

test('evidence is collected from every shot; a close-up overrides the sleeve', () => {
  const found = evidence({ catalogNumber: 'PCS 7088 | YEX 749', country: 'Made in England', printedYears: '1969 1987', matrix: 'YEX 749-2', pressingNotes: 'Stereo' }, '5012394144777');
  assert.deepEqual(found.catalogNumbers, ['PCS 7088', 'YEX 749']);
  assert.deepEqual(found.years, [1969, 1987]);
  assert.equal(found.barcode, '5012394144777');
  core.addObservation(found, seen({ catalogNumber: 'pcs7088', country: 'Made in Holland', label: 'Parlophone' }), { overriding: true });
  assert.deepEqual(found.catalogNumbers, ['PCS 7088', 'YEX 749']);
  assert.equal(found.country, 'Made in Holland');
  assert.equal(found.label, 'Parlophone');
});

test('fixed-wording marks are mined from text without a model', () => {
  const found = core.absorbText(core.newEvidence(), '℗ 1969 EMI Records Ltd. © 1987. Made in West Germany by EMI. LC 0299 GEMA/BIEM stereo');
  assert.deepEqual(found.years, [1969, 1987]);
  assert.equal(found.country, 'West Germany');
  assert.equal(found.labelCode, 'LC 0299');
  assert.equal(found.rightsSociety, 'GEMA BIEM');
  assert.deepEqual(found.notes, ['Stereo']);
  assert.equal(core.absorbText(core.newEvidence(), 'Monogram stereophonic').notes.length, 0);
});

test('identifiers Discogs lists are recognised when literally printed on the photo', () => {
  const pool = [release(1, { catno: 'PCS 7088', barcode: ['YEX 749-2', '5012394144777', 'GEMA'] }), release(2, { catno: 'SO 383', barcode: ['SO-1-383 Z12'] })];
  const found = core.absorbPool(core.newEvidence(), 'side 1 yex 749-2 (PCS 7088) 5012394144777', pool);
  assert.deepEqual(found.catalogNumbers, ['PCS 7088']);
  assert.deepEqual(found.matrix, ['YEX 749-2']);
  assert.equal(found.barcode, '5012394144777');
  assert.deepEqual(core.absorbPool(core.newEvidence(), 'stereo album', pool).catalogNumbers, []);
});

test('scoring rewards agreeing identifiers and punishes contradictions', () => {
  const barcode = core.score(release(1, { barcode: ['5 012394 144777'] }), evidence({}, '5012394144777'));
  assert.ok(barcode.strong && barcode.matched.includes('штрихкод') && barcode.points >= 45);
  assert.ok(core.score(release(1, { barcode: ['077774644617'] }), evidence({}, '5012394144777')).conflicts.includes('другой штрихкод'));
  const matrix = core.score(release(1, { barcode: ['YEX 749-2 (Side A runout)'] }), evidence({ matrix: 'YEX 749-2' }));
  assert.ok(matrix.strong && matrix.matched.includes('матрица'));
  // The catalogue number with a side letter is on every pressing: it must not single one out.
  const stamper = evidence({ catalogNumber: 'SHVL 804', matrix: 'SHVL 804 A-2 G 1' }), shvl = { catno: 'SHVL 804' };
  const first = core.score(release(1, { ...shvl, barcode: ['SHVL 804A', 'SHVL 804 A-2 G 1'] }), stamper);
  const later = core.score(release(2, { ...shvl, barcode: ['SHVL 804A', 'SHVL 804 A-3'] }), stamper);
  assert.ok(first.strong && !later.strong && later.matched.includes('номер стороны') && first.points - later.points >= 25);
  assert.ok(!core.score(release(3, { ...shvl, barcode: ['SHVL 804 A-2 GOD'] }), evidence({ catalogNumber: 'SHVL 804', matrix: 'SHVL 804 A' })).strong);
  assert.ok(core.score(release(4, { barcode: ['YEX 749'] }), evidence({ catalogNumber: 'PCS 7088', matrix: 'YEX 749-2' })).strong);
  const full = core.score(release(1), evidence({ catalogNumber: 'PCS 7088', country: 'Made in England', year: '1969' }));
  assert.deepEqual(full.matched, ['каталожный номер', 'страна', 'год']);
  assert.equal(full.points, 52);
  assert.ok(core.score(release(1, { country: 'UK & Europe' }), evidence({ country: 'Made in England' })).matched.includes('регион'));
  assert.ok(core.score(release(1, { country: 'Europe' }), evidence({ country: 'Made in Holland' })).matched.includes('регион'));
  assert.ok(core.score(release(1, { country: 'US' }), evidence({ country: 'Made in England' })).conflicts.includes('другая страна'));
  assert.ok(core.score(release(1), evidence({ printedYears: '1969 1987' })).conflicts.includes('издано раньше напечатанного года'));
  assert.ok(core.score(release(1, { format: ['Vinyl', 'LP', 'Mono'] }), evidence({ pressingNotes: 'Stereo' })).conflicts.includes('моно вместо стерео'));
  assert.equal(core.score(release(1, { format: ['Vinyl', 'Unofficial Release'] }), core.newEvidence()).points, -8);
});

test('verdicts: confirmed only on decisive evidence, otherwise a group', () => {
  const pressings = [release(1), release(2, { country: 'US', catno: 'SO 383' }), release(3, { year: '1976', catno: 'PCS 7088', country: 'UK' })];
  const anchored = core.verdict(core.rank(pressings, evidence({ catalogNumber: 'PCS 7088', country: 'Made in England', year: '1969' })), 3);
  assert.equal(anchored.confidence, 'confirmed'); assert.equal(anchored.best.release.id, 1);
  // The same evidence over an incompletely fetched album is not proof: an unseen pressing may fit as well.
  assert.equal(core.verdict(core.rank(pressings, evidence({ catalogNumber: 'PCS 7088', country: 'Made in England', year: '1969' })), 300, false).confidence, 'likely');
  const byBarcode = core.verdict(core.rank([release(1), release(2, { barcode: ['5012394144777'] })], evidence({}, '5012394144777')), 2);
  assert.equal(byBarcode.confidence, 'confirmed'); assert.equal(byBarcode.best.release.id, 2);
  const nothing = core.verdict(core.rank(pressings, evidence()), 300);
  assert.equal(nothing.confidence, 'unknown'); assert.equal(nothing.group.length, 3);
  const tie = core.verdict(core.rank([release(1), release(2)], evidence({ catalogNumber: 'PCS 7088', country: 'Made in England' })), 2);
  assert.equal(tie.confidence, 'ambiguous'); assert.equal(tie.group.length, 2);
  assert.match(core.verdictNote(tie), /Подходят 2 изд\./);
  const single = core.verdict(core.rank([release(1)], evidence()), 1);
  assert.equal(single.confidence, 'likely');
  assert.equal(core.verdict([], 0).confidence, 'unknown');
});

test('advice names what is still missing', () => {
  assert.equal(core.advice(evidence(), 'confirmed'), '');
  assert.match(core.advice(evidence(), 'unknown'), /номер матрицы.*каталожный номер.*страну.*штрихкод/);
  assert.doesNotMatch(core.advice(evidence({ printedYears: '1969' }), 'unknown'), /штрихкод/);
  assert.match(core.advice(evidence({ catalogNumber: 'PCS 7088', country: 'UK', matrix: 'YEX 749' }, '5012394144777'), 'ambiguous'), /Сравните варианты/);
});

test('request pacing stays inside the Discogs limits', () => {
  const start = 9_000_000, burst = Array.from({ length: 6 }, (_, index) => start + index * 100);
  assert.equal(core.pacerDelay(burst, start + 1000, false), 0);
  const full = Array.from({ length: core.pacerCapacity(false) }, (_, index) => start + index * 1000);
  const wait = core.pacerDelay(full, start + 30000, false);
  assert.ok(wait > 29000 && wait < 31000);
  assert.equal(core.pacerDelay(full, start + 30000, true), 0);
  assert.equal(core.pacerDelay(full, start + 200000, false), 0);
  assert.ok(core.pacerCapacity(true) < 60 && core.pacerCapacity(false) < 25);
});

const jpeg = 'data:image/jpeg;base64,AAAA';
test('the vision request sends the back cover and close-ups at full resolution', () => {
  const sleeve = core.visionBody({ front: jpeg, back: jpeg });
  const images = sleeve.input[0].content.filter((part) => part.type === 'input_image');
  assert.deepEqual(images.map((part) => part.detail), ['high', 'original']);
  assert.equal(sleeve.store, false); assert.deepEqual(sleeve.reasoning, { effort: 'low' });
  assert.ok(sleeve.text.format.strict && sleeve.text.format.schema.required.includes('barcode') && sleeve.text.format.schema.required.includes('isRecord'));
  const label = core.visionBody({ front: jpeg, focus: 'label' });
  assert.equal(label.input[0].content[1].detail, 'original');
  assert.match(label.instructions, /close-up of the pressing marks/);
  assert.equal(core.visionBody({ front: jpeg, back: jpeg, fine: 'high' }).input[0].content[3].detail, 'high');
  assert.equal(core.visionBody({ front: jpeg, model: 'gpt-4o' }).reasoning, undefined);
  assert.throws(() => core.visionBody({ front: 'http://example.org/a.jpg' }));
  assert.throws(() => core.visionBody({ front: jpeg, model: 'bad model' }));
});

const answer = (object) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(object) }] }] });
test('the model answer is validated; a wrong barcode is dropped, not trusted', () => {
  const raw = { isRecord: true, certain: true, artist: ' The Beatles ', title: 'Abbey Road', catalogNumber: 'PCS 7088', label: 'Apple', country: 'Made in England', year: '1969', printedYears: '1969', matrix: '', rightsSociety: '', labelCode: '', pressingNotes: 'Stereo', barcode: '5 012394 144777' };
  const good = core.parseVision(answer(raw));
  assert.equal(good.artist, 'The Beatles'); assert.equal(good.barcode, '5012394144777');
  assert.equal(core.parseVision(answer({ ...raw, barcode: '5012394144778', year: 'about 1969' })).barcode, '');
  assert.equal(core.parseVision(answer({ ...raw, year: 'about 1969' })).year, '');
  assert.equal(core.parseVision(answer({ ...raw, pressingNotes: 'x'.repeat(900) })).pressingNotes.length, 400);
  assert.throws(() => core.parseVision({ status: 'incomplete' }), /не завершён/);
  assert.throws(() => core.parseVision({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }), /не смогла/);
  assert.match(core.observationText(good), /PCS 7088.*Stereo.*5012394144777/);
});

test('the model may only point at one of the offered candidates', () => {
  const list = [release(1), release(2)];
  const body = core.selectionBody({ front: jpeg, candidates: list });
  assert.match(body.input[0].content.at(-1).text, /Discogs candidates/);
  assert.equal(body.text.format.name, 'vinyl_candidate');
  assert.equal(core.parseSelection(answer({ index: 1 }), list).id, 2);
  assert.equal(core.parseSelection(answer({ index: -1 }), list), null);
  assert.throws(() => core.parseSelection(answer({ index: 7 }), list));
  assert.throws(() => core.selectionBody({ front: jpeg, candidates: [] }));
});

test('a Discogs release page becomes a search-shaped record', () => {
  const page = core.parseRelease({
    id: 7, title: 'Abbey Road', year: 1969, country: 'UK', master_id: 24047, thumb: 'https://i.discogs.com/t.jpg', notes: 'Misaligned Apple logo.',
    artists: [{ name: 'The Beatles' }], labels: [{ name: 'Apple Records', catno: 'PCS 7088' }], images: [{ uri: 'https://i.discogs.com/c.jpg' }],
    formats: [{ name: 'Vinyl', descriptions: ['LP', 'Album', 'Stereo'], text: '1st pressing' }],
    identifiers: [{ type: 'Matrix / Runout', value: 'YEX 749-2' }, { type: 'Rights Society', value: 'NCB' }], community: { have: 10, want: 20 },
  });
  assert.equal(page.title, 'The Beatles - Abbey Road'); assert.equal(page.year, '1969'); assert.equal(page.catno, 'PCS 7088');
  assert.deepEqual(page.format, ['Vinyl', 'LP', 'Album', 'Stereo', '1st pressing']);
  assert.deepEqual(page.barcode, ['YEX 749-2', 'NCB']);
  assert.ok(core.isVinyl(page)); assert.equal(core.coverURL(page), 'https://i.discogs.com/c.jpg');
  assert.equal(core.parseRelease({ id: 8, title: 'X', year: 0 }).year, null);
  assert.throws(() => core.parseRelease({ title: 'no id' }));
  assert.equal(core.coverURL({ cover_image: 'https://evil.example/c.jpg', thumb: '' }), '');
});

test('a price is shown only when something is really for sale', () => {
  assert.deepEqual(core.parseQuote({ lowest_price: { value: 12.5, currency: 'EUR' }, num_for_sale: 34 }, 7), { releaseID: 7, amount: 12.5, currency: 'EUR', offers: 34 });
  assert.equal(core.parseQuote({ lowest_price: null, num_for_sale: 0 }, 7), null);
  assert.equal(core.parseQuote({ lowest_price: { value: 12.5, currency: 'EUR' }, num_for_sale: 3, blocked_from_sale: true }, 7), null);
  assert.match(core.money(12.5, 'EUR'), /12,50\s€/);
});
