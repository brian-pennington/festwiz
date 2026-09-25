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
  const nDays = Object.keys(map).length;
  is('a subscribe link per day banner', count(table, /dtable__day-sub/g), nDays);
  is('the count is kept in the markup', count(table, /dtable__day-count/g), nDays);
  is('cards: a subscribe link per day header', count(cards, /day__sub/g), nDays);
  is('cards: the count is kept too', count(cards, /day__count/g), nDays);
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
  // Counts are derived from the data, never hardcoded — the feeder grows.
  const onDay = (iso) => data.filter(e => e.date === iso).length;
  const todayISO = api.today().toISOString().slice(0, 10);
  s.when = 'today';   is('when=today matches that day', n(), onDay(todayISO));
  s.when = 'all';
  const withTag = (t) => data.filter(e => e.tags.includes(t)).length;
  const withEither = (a, b) =>
    data.filter(e => e.tags.includes(a) || e.tags.includes(b)).length;
  const tagA = [...new Set(data.flatMap(e => e.tags))][0];
  const tagB = [...new Set(data.flatMap(e => e.tags))][1];
  s.tags = [tagA];        is(`tag=${tagA}`, n(), withTag(tagA));
  s.tags = [tagA, tagB];  is('tags OR', n(), withEither(tagA, tagB));
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

  // Price tiers are cumulative ceilings; a range uses its first number.
  s.maxPrice = 0;  const p0 = n();
  s.maxPrice = 10; const p10 = n();
  s.maxPrice = 20; const p20 = n();
  s.maxPrice = 50; const p50 = n();
  is('price tiers are cumulative', p0 <= p10 && p10 <= p20 && p20 <= p50, true);
  const noPrice = data.filter(e => e.price_min === null).length;
  is('unpriced events excluded by any tier', p50 <= data.length - noPrice, true);
  s.maxPrice = null;
  is('All price shows everything', n(), data.length);
  const range = data.find(e => /^\$\d+\s*-/.test(e.price || ''));
  if (range) {
    is('a range uses its first number',
       range.price_min, parseFloat(range.price.replace(/[^\d.]/, '').match(/^[\d.]+/)[0]));
  }
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

  const tagged = data.reduce((n, e) => n + e.tags.length, 0);
  is('tags render as buttons', count(html, /class="badge badge--tag"/g), tagged);
  is('tag buttons carry their value', count(html, /data-tag="/g), tagged);
  is('none pressed with no filter', count(html, /class="badge badge--tag" data-tag="[^"]*" aria-pressed="true"/g), 0);

  api.state.tags = ['film'];
  const filtered = api.renderCards(
    api.groupByDay(data.filter(api.matches)),
    api.orderedDays(api.groupByDay(data.filter(api.matches))));
  is('active tag marked pressed', count(filtered, /aria-pressed="true"/g) > 0, true);
  api.state.tags = [];

  // Each tag keeps one colour from the six-colour rotation, everywhere.
  const pairs = [...html.matchAll(/data-tag="([^"]+)" style="--tag-bg:var\(--day-(\d)\)"/g)];
  const byTag = new Map();
  let stable = true;
  for (const [, tag, n] of pairs) {
    if (byTag.has(tag) && byTag.get(tag) !== n) stable = false;
    byTag.set(tag, n);
  }
  is('every tag has a colour', byTag.size, new Set(data.flatMap(e => e.tags)).size);
  is('a tag keeps the same colour throughout', stable, true);
  is('colours come from the six-colour set',
     [...byTag.values()].every(n => +n >= 1 && +n <= 6), true);
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

console.log('\nABOUT MODAL (markup)');
{
  // A stub DOM does not parse HTML, so assert on the file itself.
  const fs = await import('fs');
  const html = fs.readFileSync('halloween/index.html', 'utf8');
  is('overlay starts hidden', /id="modal-about" hidden/.test(html), true);
  is('has a dialog role', /role="dialog"/.test(html), true);
  is('dialog is modal', /aria-modal="true"/.test(html), true);
  is('dialog is labelled', /aria-labelledby="about-title"/.test(html), true);
  is('logo is a button, not a link', /class="masthead__brand" id="btn-about"/.test(html), true);
  is('trigger declares a dialog', /aria-haspopup="dialog"/.test(html), true);
  is('links to the festival app', html.includes('/southbysouthwest/'), true);
  is('no stale logo link', /<a class="masthead__brand"/.test(html), false);
  is('two view toggles, both tagged', (html.match(/data-view-set=/g) || []).length, 4);

  // The ZAP! dismissal must match the festival app exactly.
  const fsx = await import('fs');
  const norm = (t) => t.replace(/\s+/g, ' ');
  const kf = (src, name) => {
    const i = src.indexOf('@keyframes ' + name);
    let d = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}' && --d === 0) break;
    }
    return norm(src.slice(i, j + 1));
  };
  const sx = fsx.readFileSync('southbysouthwest/style.css', 'utf8');
  const hw = fsx.readFileSync('halloween/style.css', 'utf8');
  is('zap-screen-flash matches the festival app',
     kf(hw, 'zap-screen-flash'), kf(sx, 'zap-screen-flash'));
  is('zap-modal-shrink matches the festival app',
     kf(hw, 'zap-modal-shrink'), kf(sx, 'zap-modal-shrink'));
  const js = fsx.readFileSync('halloween/halloween.js', 'utf8');
  is('zap runs for 700ms like the festival app', /\}, 700\);/.test(js), true);
}

console.log('\nEASTER EGG');
{
  const fs = await import('fs');
  const js = fs.readFileSync('halloween/halloween.js', 'utf8');
  const css = fs.readFileSync('halloween/style.css', 'utf8');
  is('10 second hover', /BLOOD_DELAY = 10000/.test(js), true);
  is('respects reduced motion (js)', /prefers-reduced-motion: reduce/.test(js), true);
  is('respects reduced motion (css)', /@media \(prefers-reduced-motion: reduce\) \{\s*\.brand-blood/.test(css), true);
  is('drips are aria-hidden', /setAttribute\('aria-hidden', 'true'\)/.test(js), true);
  is('cleans up on leave', /removeChild/.test(js), true);
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
