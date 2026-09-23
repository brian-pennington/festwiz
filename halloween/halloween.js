/* FestWiz — Halloween tracker
 *
 * Reads events.json (written by build.py from the feeder sheet) and renders
 * it as either cards or a table, filtered by date, tag, age and free text.
 *
 * Today and Past Events are computed in the BROWSER from the visitor's own
 * clock, not baked in at build time, so the page stays correct between
 * publishes. The 2am rollover matches publish.py: a night's events stay
 * current until 2am the next morning.
 */
(function () {
  'use strict';

  var DAY_ROLLOVER_HOUR = 2;
  var VIEW_KEY = 'halloween2026_view';
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_COLOURS = 6;

  // An event with no stated age policy is treated as 21+, so picking 18+ or
  // lower hides it. Most unlisted events here are bar shows; assuming they
  // admit children would be the more misleading guess. The card still shows
  // no age rather than claiming 21+, because we do not actually know.
  var UNKNOWN_AGE = 21;

  // Price tiers, cheapest first. null = All, which is the default.
  var PRICE_TIERS = [
    { label: 'All',            max: null },
    { label: 'Free',           max: 0 },
    { label: '$10 and under',  max: 10 },
    { label: '$20 and under',  max: 20 },
    { label: '$50 and under',  max: 50 }
  ];

  var state = {
    events: [],
    view: 'cards',
    when: 'all',          // all | today | weekend
    tags: [],             // OR within tags
    maxAge: null,         // show events admitting someone of this age
    maxPrice: null,       // show events costing no more than this
    search: ''
  };

  var els = {};

  /* ── helpers ──────────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Parse 'YYYY-MM-DD' as a LOCAL date. new Date('2026-10-17') is parsed as
  // UTC and lands on the 16th in US timezones, which would shift every
  // weekday label and break the Today match.
  function parseISO(iso) {
    var p = iso.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function today() {
    var now = new Date();
    if (now.getHours() < DAY_ROLLOVER_HOUR) {
      now = new Date(now.getTime() - 24 * 3600 * 1000);
    }
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function dayLabel(iso) {
    if (iso === 'all-month') return 'All Month Long';
    var d = parseISO(iso);
    return DAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  // Free-text times ("various", "") sort to the top of a day, as they do in
  // the printed guide; anything after midnight belongs to the night before.
  function timeKey(t) {
    var m = /(\d{1,2})(?::([0-5]\d))?\s*(am|pm)/i.exec(t || '');
    if (!m) return -1;
    var h = (+m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    var mins = h * 60 + (+(m[2] || 0));
    return mins < 6 * 60 ? mins + 24 * 60 : mins;
  }

  function isWeekend(iso) {
    if (iso === 'all-month') return true;
    var d = parseISO(iso).getDay();
    return d === 5 || d === 6 || d === 0;
  }

  /* ── filtering ────────────────────────────────────────────────────── */

  function matches(ev) {
    var t = today();

    if (state.when === 'today') {
      if (ev.date !== 'all-month' && parseISO(ev.date).getTime() !== t.getTime()) return false;
    } else if (state.when === 'weekend') {
      if (!isWeekend(ev.date)) return false;
      if (ev.date !== 'all-month' && parseISO(ev.date) < t) return false;
    }

    if (state.tags.length) {
      var hit = false;
      for (var i = 0; i < state.tags.length; i++) {
        if (ev.tags.indexOf(state.tags[i]) !== -1) { hit = true; break; }
      }
      if (!hit) return false;
    }

    if (state.maxAge !== null) {
      var min = ev.age_min === null ? UNKNOWN_AGE : ev.age_min;
      if (min > state.maxAge) return false;
    }

    // A stated price only. An event with no price is not known to be cheap,
    // so a ceiling excludes it — the same rule as the age filter: a tier
    // lists what we have confirmed, not what might qualify.
    if (state.maxPrice !== null) {
      if (ev.price_min === null || ev.price_min > state.maxPrice) return false;
    }

    if (state.search) {
      var hay = (ev.name + ' ' + ev.venue + ' ' + ev.description + ' ' + ev.tags.join(' ')).toLowerCase();
      if (hay.indexOf(state.search) === -1) return false;
    }
    return true;
  }

  function groupByDay(list) {
    var map = {};
    list.forEach(function (ev) {
      (map[ev.date] = map[ev.date] || []).push(ev);
    });
    Object.keys(map).forEach(function (k) {
      map[k].sort(function (a, b) {
        var d = timeKey(a.time) - timeKey(b.time);
        return d || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
    });
    return map;
  }

  function orderedDays(map) {
    var t = today();
    var dated = Object.keys(map).filter(function (k) { return k !== 'all-month'; }).sort();
    var upcoming = [], past = [];
    dated.forEach(function (k) {
      (parseISO(k) < t ? past : upcoming).push(k);
    });
    var head = map['all-month'] ? ['all-month'] : [];
    return { upcoming: head.concat(upcoming), past: past };
  }

  /* ── rendering ────────────────────────────────────────────────────── */

  function dayVar(index) { return 'var(--day-' + ((index % DAY_COLOURS) + 1) + ')'; }

  function cardHTML(ev) {
    var time = ev.time
      ? '<div class="card__time">' + esc(ev.time) + '</div>'
      : '<div class="card__time card__time--tba">time TBA</div>';
    var name = ev.url
      ? '<a href="' + esc(ev.url) + '" target="_blank" rel="noopener">' + esc(ev.name) + '</a>'
      : esc(ev.name);
    // No price stated: show nothing rather than a placeholder. Most of these
    // are free or door-price events; announcing "TBA" implies we are waiting
    // on a number that may never exist.
    var price = ev.price
      ? '<span class="card__price">' + esc(ev.price) + '</span>'
      : '';
    var badges = '';
    if (ev.age) badges += '<span class="badge">' + esc(ev.age) + '</span>';
    ev.tags.forEach(function (tg) { badges += tagButton(tg); });

    return '<article class="card">' +
      '<div class="card__top"><h3 class="card__name">' + name + '</h3>' + time + '</div>' +
      (ev.venue ? '<div class="card__venue">' + esc(ev.venue) + '</div>' : '') +
      (ev.description ? '<p class="card__desc">' + esc(ev.description) + '</p>' : '') +
      // Skip the meta row entirely when there is nothing to put in it, so an
      // empty strip of padding does not hang off the bottom of the card.
      (price || badges ? '<div class="card__meta">' + price + badges + '</div>' : '') +
      '</article>';
  }

  function rowHTML(ev) {
    var name = ev.url
      ? '<a href="' + esc(ev.url) + '" target="_blank" rel="noopener">' + esc(ev.name) + '</a>'
      : esc(ev.name);
    var tags = ev.tags.length
      ? ev.tags.map(tagButton).join(' ')
      : '<span class="t-none">&mdash;</span>';
    function cell(v, cls) {
      return v ? '<td class="' + cls + '">' + esc(v) + '</td>'
               : '<td class="t-none">&mdash;</td>';
    }
    return '<tr>' +
      '<td class="t-name">' + name +
        (ev.description ? '<div class="t-desc">' + esc(ev.description) + '</div>' : '') + '</td>' +
      cell(ev.venue, '') +
      cell(ev.time, 't-time') +
      cell(ev.price, 't-money') +
      cell(ev.age, '') +
      '<td>' + tags + '</td>' +
      '</tr>';
  }

  // Tags on an event are buttons, not labels: clicking one filters to it.
  // A real <button> so it is reachable by keyboard and announced as a control.
  function tagButton(tag) {
    var on = state.tags.length === 1 && state.tags[0] === tag;
    return '<button type="button" class="badge badge--tag" data-tag="' + esc(tag) + '"' +
      ' style="--tag-bg:' + tagColourVar(tag) + '"' +
      ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
      ' title="' + (on ? 'Clear this filter' : 'Show only ' + esc(tag) + ' events') + '">' +
      esc(tag) + '</button>';
  }

  function dayHeadHTML(iso, n, colourIndex, isToday) {
    return '<div class="day__head" style="--day:' + dayVar(colourIndex) + '">' +
      '<span class="day__name">' + esc(dayLabel(iso)) + '</span>' +
      (isToday ? '<span class="day__today">Today</span>' : '') +
      '<span class="day__count">' + n + ' event' + (n === 1 ? '' : 's') + '</span>' +
      '</div>';
  }

  function renderCards(map, order) {
    var t = today(), html = '', i = 0;
    function block(days, past) {
      days.forEach(function (iso) {
        var evs = map[iso];
        var isToday = iso !== 'all-month' && parseISO(iso).getTime() === t.getTime();
        html += '<section class="day' + (past ? ' is-past' : '') + '" style="--day:' + dayVar(i) + '">' +
          dayHeadHTML(iso, evs.length, i, isToday) +
          '<div class="cards">' + evs.map(cardHTML).join('') + '</div></section>';
        i++;
      });
    }
    block(order.upcoming, false);
    if (order.past.length) {
      html += pastHeadHTML(order.past, map);
      block(order.past, true);
    }
    return html;
  }

  function renderTable(map, order) {
    var t = today(), i = 0;
    var head = '<table class="dtable"><thead><tr>' +
      '<th>Name</th><th>Location</th><th>Time</th><th>Price</th><th>Age</th><th>Tags</th>' +
      '</tr></thead>';
    var body = '';
    function block(days, past) {
      days.forEach(function (iso) {
        var evs = map[iso];
        var isToday = iso !== 'all-month' && parseISO(iso).getTime() === t.getTime();
        body += '<tbody' + (past ? ' class="is-past"' : '') + ' style="--day:' + dayVar(i) + '">' +
          '<tr class="dtable__day"><td colspan="6">' +
            '<span class="dtable__day-name">' + esc(dayLabel(iso)) + '</span>' +
            (isToday ? '<span class="dtable__day-today">Today</span>' : '') +
            '<span class="dtable__day-count">' + evs.length + '</span>' +
          '</td></tr>' +
          evs.map(rowHTML).join('') +
          '</tbody>';
        i++;
      });
    }
    block(order.upcoming, false);

    // Past days are NOT emitted here — pastTableBody renders them into their
    // own table below the heading. Calling block() for them as well would
    // list every elapsed day twice.
    var past = order.past.length ? pastHeadHTML(order.past, map) : '';

    // The heading sits outside the table so it is not a stray row.
    return '<div class="tablewrap">' + head + body + '</table></div>' +
      (past ? past + '<div class="tablewrap"><table class="dtable">' +
              pastTableBody(map, order, t) + '</table></div>' : '');
  }

  // Past days render as their own table so the heading can sit between them.
  function pastTableBody(map, order, t) {
    var i = order.upcoming.length, body = '';
    order.past.forEach(function (iso) {
      var evs = map[iso];
      body += '<tbody class="is-past" style="--day:' + dayVar(i) + '">' +
        '<tr class="dtable__day"><td colspan="6">' +
          '<span class="dtable__day-name">' + esc(dayLabel(iso)) + '</span>' +
          '<span class="dtable__day-count">' + evs.length + '</span>' +
        '</td></tr>' + evs.map(rowHTML).join('') + '</tbody>';
      i++;
    });
    return body;
  }

  function pastHeadHTML(past, map) {
    var n = past.reduce(function (sum, k) { return sum + map[k].length; }, 0);
    return '<div class="past-head"><h2>Past Events</h2>' +
      '<p>' + n + ' event' + (n === 1 ? '' : 's') + ' on ' + past.length +
      ' day' + (past.length === 1 ? '' : 's') + ' already gone</p></div>';
  }

  function render() {
    var shown = state.events.filter(matches);
    var map = groupByDay(shown);
    var order = orderedDays(map);

    els.sub.textContent = state.events.length + ' events · ' +
      (state.events.length ? dayLabel(minDate()) + ' – ' + dayLabel(maxDate()) : '');

    var active = (state.when !== 'all' ? 1 : 0) + state.tags.length +
                 (state.maxPrice !== null ? 1 : 0) +
                 (state.maxAge !== null ? 1 : 0) + (state.search ? 1 : 0);
    els.count.hidden = active === 0;
    els.count.textContent = active;
    els.clear.hidden = active === 0;
    els.result.textContent = active
      ? shown.length + ' of ' + state.events.length + ' events'
      : state.events.length + ' events';

    if (!shown.length) {
      els.status.hidden = false;
      els.status.textContent = 'No events match those filters.';
      els.results.innerHTML = '';
      return;
    }

    els.status.hidden = true;
    els.results.innerHTML = state.view === 'table'
      ? renderTable(map, order)
      : renderCards(map, order);
  }

  function minDate() {
    return state.events.map(function (e) { return e.date; })
      .filter(function (d) { return d !== 'all-month'; }).sort()[0];
  }
  function maxDate() {
    var d = state.events.map(function (e) { return e.date; })
      .filter(function (x) { return x !== 'all-month'; }).sort();
    return d[d.length - 1];
  }

  /* ── filter dropdowns ─────────────────────────────────────────────── */

  var TICK = '<svg class="opt__tick" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="3" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

  function opt(label, value, pressed, cls, count, style) {
    return '<button type="button" class="opt' + (cls ? ' ' + cls : '') + '"' +
      (style ? ' style="' + style + '"' : '') +
      ' aria-pressed="' + (pressed ? 'true' : 'false') + '"' +
      ' data-value="' + esc(value) + '">' +
      (cls ? '' : (pressed ? TICK : '<span class="opt__tick"></span>')) +
      '<span>' + esc(label) + '</span>' +
      (count != null ? ' <span class="opt__count">' + count + '</span>' : '') +
      '</button>';
  }

  // Tag -> colour index, fixed by the order the tags appear in the dropdown
  // (most used first). Computed from ALL events, never the filtered set, so a
  // tag keeps its colour no matter what is on screen.
  var tagOrder = [];

  function computeTagOrder() {
    var counts = tagCounts();
    tagOrder = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b);
    });
  }

  function tagColourVar(tag) {
    var i = tagOrder.indexOf(tag);
    return i === -1 ? 'var(--tag)' : 'var(--day-' + ((i % DAY_COLOURS) + 1) + ')';
  }

  function tagCounts() {
    var counts = {};
    state.events.forEach(function (e) {
      e.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    return counts;
  }

  function ageValues() {
    // UNKNOWN_AGE is always offered: without it there would be no way back to
    // seeing the events that have no stated policy.
    var seen = [UNKNOWN_AGE];
    state.events.forEach(function (e) {
      if (e.age_min !== null && seen.indexOf(e.age_min) === -1) seen.push(e.age_min);
    });
    return seen.sort(function (a, b) { return a - b; });
  }

  function ageLabel(a) { return a === 0 ? 'All ages' : a + '+'; }

  function buildPanels() {
    if (!tagOrder.length) computeTagOrder();

    els.panelWhen.innerHTML =
      opt('All dates', 'all', state.when === 'all') +
      opt('Today', 'today', state.when === 'today') +
      opt('This weekend', 'weekend', state.when === 'weekend');

    var counts = tagCounts();
    var tags = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b);
    });
    els.panelTags.innerHTML = tags.length
      ? tags.map(function (t) {
          return opt(t, t, state.tags.indexOf(t) !== -1, 'opt--tag', counts[t],
                     '--tag-bg:' + tagColourVar(t));
        }).join('')
      : '<span class="filters__result">No tags yet.</span>';

    els.panelPrice.innerHTML = PRICE_TIERS.map(function (t) {
      return opt(t.label, t.max === null ? 'any' : String(t.max),
                 state.maxPrice === t.max);
    }).join('') +
      '<p class="fdrop__note">Events with no listed price are only shown ' +
      'under&nbsp;All.</p>';

    els.panelAge.innerHTML = opt('Any age', 'any', state.maxAge === null) +
      ageValues().map(function (a) {
        return opt(ageLabel(a), String(a), state.maxAge === a);
      }).join('') +
      '<p class="fdrop__note">Events with no listed age are treated as ' +
      UNKNOWN_AGE + '+.</p>';

    syncLabels();
  }

  function syncLabels() {
    els.valWhen.textContent =
      state.when === 'today' ? 'Today'
      : state.when === 'weekend' ? 'This weekend'
      : 'All dates';
    els.dropWhen.classList.toggle('is-set', state.when !== 'all');

    els.valTags.textContent =
      state.tags.length === 0 ? 'Any'
      : state.tags.length === 1 ? state.tags[0]
      : state.tags.length + ' selected';
    els.dropTags.classList.toggle('is-set', state.tags.length > 0);

    var tier = null;
    for (var i = 0; i < PRICE_TIERS.length; i++) {
      if (PRICE_TIERS[i].max === state.maxPrice) { tier = PRICE_TIERS[i]; break; }
    }
    els.valPrice.textContent = tier ? tier.label : 'All';
    els.dropPrice.classList.toggle('is-set', state.maxPrice !== null);

    els.valAge.textContent = state.maxAge === null ? 'Any age' : ageLabel(state.maxAge);
    els.dropAge.classList.toggle('is-set', state.maxAge !== null);
  }

  function setDrop(drop, open) {
    drop.classList.toggle('is-open', open);
    drop.querySelector('.fdrop__btn').setAttribute('aria-expanded', String(open));
    drop.querySelector('.fdrop__panel').hidden = !open;
  }

  function closeAllDrops(except) {
    [els.dropWhen, els.dropTags, els.dropPrice, els.dropAge].forEach(function (d) {
      if (d !== except) setDrop(d, false);
    });
  }

  function toggleDrop(drop) {
    var open = !drop.classList.contains('is-open');
    closeAllDrops(drop);
    setDrop(drop, open);
  }

  function wireDrop(drop, onPick, closeOnPick) {
    drop.querySelector('.fdrop__btn').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDrop(drop);
    });
    drop.querySelector('.fdrop__panel').addEventListener('click', function (e) {
      var btn = e.target.closest('.opt');
      if (!btn) return;
      e.stopPropagation();
      onPick(btn.getAttribute('data-value'));
      buildPanels();
      render();
      // Close explicitly rather than toggling, so a picked option can never
      // reopen a panel because the open flag drifted out of sync.
      if (closeOnPick) setDrop(drop, false);
    });
  }

  function setView(view) {
    state.view = view;
    // Drives the card-view-only background texture in the stylesheet.
    document.body.setAttribute('data-view', view);
    els.cardsBtn.classList.toggle('is-active', view === 'cards');
    els.tableBtn.classList.toggle('is-active', view === 'table');
    els.cardsBtn.setAttribute('aria-pressed', String(view === 'cards'));
    els.tableBtn.setAttribute('aria-pressed', String(view === 'table'));
    try { localStorage.setItem(VIEW_KEY, view); } catch (err) { /* private mode */ }
    render();
  }

  /* ── about modal ──────────────────────────────────────────────────── */

  var lastFocus = null;

  function openAbout() {
    lastFocus = document.activeElement;
    els.about.hidden = false;
    els.aboutClose.focus();
  }

  // Plain dismissal — backdrop click or Escape. No animation.
  function closeAbout() {
    els.about.hidden = true;
    els.about.classList.remove('zapping');
    // Send focus back where it came from, or the modal leaves keyboard users
    // stranded at the top of the document.
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  // ZAP! — the festival app's dismissal: run the 700ms animation, then hide.
  function zapAbout() {
    els.about.classList.add('zapping');
    setTimeout(function () {
      els.about.hidden = true;
      els.about.classList.remove('zapping');
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    }, 700);
  }

  function aboutIsOpen() { return els.about && !els.about.hidden; }

  /* ── sticky offsets ───────────────────────────────────────────────── */

  // The table's sticky header has to sit exactly under the masthead and the
  // filter bar. Those heights depend on the font, the breakpoint and whether
  // the filter drawer is open, so measure rather than hardcode.
  function measureStick() {
    var root = document.documentElement;
    var mast = document.querySelector('.masthead');
    var filters = els.filters;
    var mh = mast ? mast.getBoundingClientRect().height : 0;
    // A statically-positioned filter bar (phone drawer) scrolls away, so it
    // must not be counted in the sticky offset.
    var stuck = filters && getComputedStyle(filters).position === 'sticky'
      ? filters.getBoundingClientRect().height : 0;

    // Always round DOWN and take another pixel off, so each sticky bar
    // OVERLAPS the one above it instead of leaving a seam. Rounding to
    // nearest can round up on a fractional height, which parks the bar a
    // pixel low and lets rows scroll visibly through the gap. The overlap
    // is hidden because the bars stack by z-index: masthead 30 > filters
    // 20 > table header 10.
    var mastTop = Math.max(0, Math.floor(mh) - 1);
    root.style.setProperty('--masthead-h', mastTop + 'px');
    root.style.setProperty('--sticky-top',
      Math.max(0, mastTop + Math.floor(stuck) - 1) + 'px');
  }

  /* ── boot ─────────────────────────────────────────────────────────── */

  function init() {
    els = {
      sub: $('masthead-sub'), status: $('status'), results: $('results'),
      dropWhen: $('drop-when'), dropTags: $('drop-tags'),
      dropPrice: $('drop-price'), dropAge: $('drop-age'),
      panelWhen: $('panel-when'), panelTags: $('panel-tags'),
      panelPrice: $('panel-price'), panelAge: $('panel-age'),
      valWhen: $('val-when'), valTags: $('val-tags'),
      valPrice: $('val-price'), valAge: $('val-age'),
      result: $('filters-result'),
      about: $('modal-about'), aboutBtn: $('btn-about'),
      aboutClose: $('btn-close-about'),
      search: $('filter-search'), clear: $('btn-clear'), count: $('filters-count'),
      cardsBtn: $('btn-view-cards'), tableBtn: $('btn-view-table'),
      filters: $('filters'), filtersBtn: $('btn-filters')
    };

    try {
      var saved = localStorage.getItem(VIEW_KEY);
      if (saved === 'table' || saved === 'cards') state.view = saved;
    } catch (err) { /* private mode: keep the default */ }

    closeAllDrops(null);   // hidden by default, whatever the markup says
    wireDrop(els.dropWhen, function (v) { state.when = v; }, true);
    wireDrop(els.dropTags, function (v) {
      var i = state.tags.indexOf(v);
      if (i === -1) state.tags.push(v); else state.tags.splice(i, 1);
    }, false);
    wireDrop(els.dropPrice, function (v) {
      state.maxPrice = v === 'any' ? null : parseFloat(v);
    }, true);
    wireDrop(els.dropAge, function (v) {
      state.maxAge = v === 'any' ? null : parseInt(v, 10);
    }, true);

    // Clicking a tag on an event filters to just that tag; clicking the same
    // one again clears it. Replacing rather than adding matches what the tag
    // looks like it promises — "show me the drag events".
    els.results.addEventListener('click', function (e) {
      var btn = e.target.closest('.badge--tag');
      if (!btn) return;
      var tag = btn.getAttribute('data-tag');
      var onlyThis = state.tags.length === 1 && state.tags[0] === tag;
      state.tags = onlyThis ? [] : [tag];
      buildPanels();
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    els.aboutBtn.addEventListener('click', openAbout);
    els.aboutClose.addEventListener('click', zapAbout);
    // Backdrop only — a click inside the dialog must not close it.
    els.about.addEventListener('click', function (e) {
      if (e.target === els.about) closeAbout();
    });

    // Click-away and Escape close whichever panel is open.
    document.addEventListener('click', function () { closeAllDrops(null); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // The modal sits above everything, so it takes Escape first.
      if (aboutIsOpen()) closeAbout();
      else closeAllDrops(null);
    });
    els.cardsBtn.addEventListener('click', function () { setView('cards'); });
    els.tableBtn.addEventListener('click', function () { setView('table'); });

    var timer;
    els.search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.search = els.search.value.trim().toLowerCase();
        render();
      }, 120);
    });

    els.clear.addEventListener('click', function () {
      state.when = 'all'; state.tags = []; state.maxPrice = null;
      state.maxAge = null; state.search = '';
      els.search.value = '';
      buildPanels(); render();
    });

    els.filtersBtn.addEventListener('click', function () {
      var open = els.filters.classList.toggle('is-open');
      els.filtersBtn.setAttribute('aria-expanded', String(open));
      measureStick();
    });

    measureStick();
    window.addEventListener('resize', measureStick);
    if (document.fonts && document.fonts.ready) {
      // Barlow Condensed changes the masthead's height once it loads.
      document.fonts.ready.then(measureStick);
    }

    fetch('events.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.events = data.filter(function (e) { return e.status !== 'cancelled'; });
        computeTagOrder();
        setView(state.view);
        buildPanels();
        render();
      })
      .catch(function (err) {
        els.status.hidden = false;
        els.status.textContent = 'Could not load the event list. ' + err.message;
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
