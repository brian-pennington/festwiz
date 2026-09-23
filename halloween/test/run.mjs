/* Regression checks for the Halloween app. Run: node halloween/test/run.mjs */
import { boot } from './harness.mjs';

let failures = 0;
function is(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${got}${ok ? '' : `  (expected ${want})`}`);
}
const count = (s, re) => (s.match(re) || []).length;

console.log('\nRENDER — 17 Oct 2026, 8pm');
{
  const { api, data } = boot({ at: [2026, 9, 17, 20, 0, 0] });
  await new Promise(r => setTimeout(r, 60));
  api.state.events = data;
  const map = api.groupByDay(data), order = api.orderedDays(map);
  const cards = api.renderCards(map, order), table = api.renderTable(map, order);

  is('cards: one article per event', count(cards, /<article/g), data.length);
  is('table: one row per event', count(table, /<tr>/g) - count(table, /<thead>/g), data.length);
  is('table: one banner per day', count(table, /dtable__day"/g), Object.keys(map).length);
  is('cards: one Past Events heading', count(cards, /Past Events/g), 1);
  is('table: one Past Events heading', count(table, /Past Events/g), 1);
  is('cards: one Today badge', count(cards, /day__today/g), 1);
  is('table: one Today badge', count(table, /dtable__day-today/g), 1);
}

console.log('\nRENDER — 23 Sep 2026 (before the season)');
{
  const { api, data } = boot({ at: [2026, 8, 23, 12, 0, 0] });
  await new Promise(r => setTimeout(r, 60));
  api.state.events = data;
  const map = api.groupByDay(data), order = api.orderedDays(map);
  const cards = api.renderCards(map, order), table = api.renderTable(map, order);
  is('cards: every event shown', count(cards, /<article/g), data.length);
  is('table: every event shown', count(table, /<tr>/g) - count(table, /<thead>/g), data.length);
  is('no Past Events heading', count(cards, /Past Events/g) + count(table, /Past Events/g), 0);
  is('no Today badge', count(cards, /day__today/g), 0);
}

console.log('\nFILTERS');
{
  const { api, data } = boot({ at: [2026, 9, 17, 20, 0, 0] });
  await new Promise(r => setTimeout(r, 60));
  const s = api.state; s.events = data;
  const n = () => data.filter(api.matches).length;
  is('no filters', n(), data.length);
  s.when = 'today';   is('when=today', n(), 7);
  s.when = 'all';
  s.tags = ['film'];  is('tag=film', n(), 41);
  s.tags = ['film', 'haunted house']; is('tags OR', n(), 68);
  s.tags = [];
  s.maxAge = 0;  const a0 = n();
  s.maxAge = 13; const a13 = n();
  s.maxAge = 18; const a18 = n();
  s.maxAge = 21; const a21 = n();
  is('age filter is ordinal', a0 <= a13 && a13 <= a18 && a18 <= a21, true);
  is('age=21 admits everything', a21, data.length);

  // Unlisted ages count as 21+, so anything below 21 must hide them all.
  const noAge = data.filter(e => e.age_min === null).length;
  is('unlisted ages are hidden below 21', a18 <= data.length - noAge, true);
  is('unlisted ages reappear at 21', a21 - a18 >= noAge, true);
  s.maxAge = null;
  is('Any age shows everything', n(), data.length);
  s.search = 'vortex'; is('search matches venue', n() > 0, true);
  s.search = 'zzzznope'; is('search with no hits', n(), 0);
}

console.log('\nFILTER PANELS');
{
  const { made, api, data } = boot();
  await new Promise(r => setTimeout(r, 60));
  const btns = (id) => count(made[id].innerHTML, /<button type="button" class="opt/g);
  is('when: 3 options', btns('panel-when'), 3);
  is('age: any + one per distinct policy', btns('panel-age') > 1, true);
  is('tags: one per tag', btns('panel-tags'), new Set(data.flatMap(e => e.tags)).size);
  is('default label: All dates', made['val-when'].textContent, 'All dates');
  api.state.tags = ['film', 'haunted house'];
  api.state.when = 'weekend';
  api.buildPanels();
  is('label shows count when many', made['val-tags'].textContent, '2 selected');
  is('label shows the single tag', (api.state.tags = ['film'], api.buildPanels(), made['val-tags'].textContent), 'film');
  is('when label follows selection', made['val-when'].textContent, 'This weekend');
}

console.log('\nCARD CONTENT');
{
  const { api, data } = boot();
  await new Promise(r => setTimeout(r, 60));
  api.state.events = data;
  const map = api.groupByDay(data), order = api.orderedDays(map);
  const html = api.renderCards(map, order);
  is('no price placeholder', count(html, /price TBA/g), 0);
  is('no empty meta rows', count(html, /<div class="card__meta"><\/div>/g), 0);
  is('every event still rendered', count(html, /<article/g), data.length);
}

console.log('\nDROPDOWN OPEN/CLOSE STATE');
{
  const { made } = boot();
  await new Promise(r => setTimeout(r, 60));
  const panel = (id) => made[id].querySelector('.fdrop__panel');
  const btn = (id) => made[id].querySelector('.fdrop__btn');
  is('when panel starts hidden', panel('drop-when').hidden, true);
  is('tags panel starts hidden', panel('drop-tags').hidden, true);
  is('age panel starts hidden', panel('drop-age').hidden, true);
  is('when button starts collapsed', btn('drop-when').getAttribute('aria-expanded'), 'false');
  is('no drop starts open', made['drop-when']._cls.has('is-open'), false);
}

console.log('\nSTICKY OFFSETS');
{
  boot();
  await new Promise(r => setTimeout(r, 60));
  const p = globalThis.__styleProps;
  // Stub heights are 78 each; each bar overlaps the one above by 1px.
  is('--masthead-h overlaps the masthead by 1px', p['--masthead-h'], '77px');
  is('--sticky-top overlaps the filter bar by 1px', p['--sticky-top'], '154px');
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
