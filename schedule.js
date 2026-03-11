/* FestWiz — schedule.js */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  const FESTIVAL_FIRST_DAY = '2026-03-10';
  const FESTIVAL_LAST_DAY  = '2026-03-18';

  let allShows = [];        // raw shows.json array + unofficial shows from localStorage
  let venueOrder = {};      // venues.json: { "2026-03-10": [...], aliases: {...} }
  let venueAliases = {};   // full name → display name
  let ratings = {};         // from localStorage sxsw2026_state (read-only on this page)
  let hidePicks = 'show';   // mirrors Rate mode setting ('show' | 'hide')
  let artistEntityIdMap = {}; // artist name (lowercase) → entity_id, for rating key resolution
  let artistMetaMap = {};    // artist name (lowercase) → { genre, subgenre, location, country }
  let searchFilter = '';     // free-text search across name/genre/subgenre/location
  let selectedDay = null;   // "2026-03-10"
  let selectedView = 'grid';
  let showFilter = 'all'; // 'all' | 'rated' | 'top'
  let admissionFilter = new Set(['badge', 'cover', 'free']); // all visible by default
  let viewNow = null;        // current Now view time
  let viewNowShifted = false; // true when user has manually shifted away from system clock
  let nowNextTimer = null;
  let agendaFilter = { r4: true, r3: false, picks: false };
  let checkins = {};
  let agendaTimer = null;
  let gridZoom = parseFloat(localStorage.getItem('sxsw2026_grid_zoom') || '1');
  let pendingCsvShows = []; // parsed shows waiting for confirmation
  let detailShow = null;    // show currently open in detail modal
  let recommendedEntityIds = new Set();
  let recommendedNames = new Set();    // lowercase artist names

  // ── Helpers ────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(s) { return escHtml(s); }

  // Normalise '&' → 'and' so unofficial/official artist names match regardless of convention.
  function normForMatch(s) {
    return (s || '').toLowerCase().replace(/ & /g, ' and ');
  }

  // Matches app.js: eid_NNNN for official artists, name_slug for unofficial.
  // For unofficial shows (entity_id null), fall back to artistEntityIdMap so that
  // official artists playing unofficial showcases still match their stored rating.
  function showRatingKey(show) {
    if (show.entity_id) return 'eid_' + show.entity_id;
    const name = normForMatch(show.artist_name);
    const eid = artistEntityIdMap[name];
    if (eid) return 'eid_' + eid;
    return 'name_' + name.replace(/[^a-z0-9]/g, '_');
  }

  function getRating(show) {
    return ratings[showRatingKey(show)] || 0;
  }

  const ADMISSION_LABELS = { badge: 'Badge', cover: 'Paid', free: 'Free' };

  function getAdmission(show) {
    if (show.admission) return show.admission;
    return show.source === 'official' ? 'badge' : 'free';
  }

  // Compact 12h time: "9", "9:40", "12", "1" (no AM/PM — grid context makes it clear)
  function formatCompactTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const h12 = h % 12 || 12;
    const mStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
    return `${h12}${mStr}`;
  }

  function formatPillTime(show) {
    if (show.no_set_time) return '';
    const start = formatCompactTime(show.start_time);
    if (!show.end_time) return start;
    return `${start}\u2013${formatCompactTime(show.end_time)}`;
  }

  // Parse "HH:MM" on a given YYYY-MM-DD into a Date (handles past-midnight)
  function parseShowTime(day, timeStr) {
    if (!day || !timeStr) return null;
    const [h, m] = timeStr.split(':').map(Number);
    const base = new Date(day + 'T00:00:00');
    // Shows after midnight (00:00–06:00) belong to the "night" of the previous calendar date
    // but are stored on the day they logically belong to — add hours directly
    base.setHours(h, m, 0, 0);
    // If h < 6, assume it's after midnight on the same "night" (add 24h offset handled by storing correctly)
    return base;
  }

  function formatTime12(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  }

  function formatDayLabel(isoDate) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const d = new Date(isoDate + 'T12:00:00');
    const month = d.getMonth() + 1;
    const date = d.getDate();
    return `${days[d.getDay()]} ${month}/${date}`;
  }

  // All unique days in shows.json, sorted
  function allDays() {
    const days = [...new Set(allShows.map(s => s.day))].sort();
    return days;
  }

  function isRecommended(show) {
    // Direct entity_id on the show record
    if (show.entity_id && recommendedEntityIds.has(String(show.entity_id))) return true;
    const name = normForMatch(show.artist_name);
    // Official artist appearing at an unofficial show (entity_id null on show)
    const eid = artistEntityIdMap[name];
    if (eid && recommendedEntityIds.has(String(eid))) return true;
    // Name-based match for unofficial picks
    return recommendedNames.has(name);
  }

  function matchesSearch(show) {
    if (!searchFilter) return true;
    const q = searchFilter.toLowerCase();
    if (show.artist_name.toLowerCase().includes(q)) return true;
    if ((show.venue || '').toLowerCase().includes(q)) return true;
    const meta = artistMetaMap[normForMatch(show.artist_name)];
    if (!meta) return false;
    return meta.genre.includes(q) || meta.subgenre.includes(q) || meta.location.includes(q);
  }

  function checkinKey(show) {
    return `${show.day}|${show.venue}|${show.start_time || ''}|${show.artist_name}`;
  }

  function venueMapUrl(name) {
    return `https://maps.google.com/maps?q=${encodeURIComponent(name + ' Austin TX')}`;
  }

  function todayShows() {
    if (!selectedDay) return [];
    let shows = allShows.filter(s => s.day === selectedDay);
    if (showFilter === 'rated') shows = shows.filter(s => getRating(s) > 0 || (hidePicks !== 'hide' && isRecommended(s)));
    else if (showFilter === 'top') shows = shows.filter(s => getRating(s) >= 3);
    shows = shows.filter(s => admissionFilter.has(getAdmission(s)));
    shows = shows.filter(matchesSearch);
    return shows;
  }

  // Parse a user-typed time string (12h or 24h) to "HH:MM"
  function parseUserTime(str) {
    str = (str || '').trim();
    // 24h: HH:MM
    let m = str.match(/^(\d{1,2}):(\d{2})$/);
    if (m) return `${String(parseInt(m[1])).padStart(2, '0')}:${m[2]}`;
    // 12h: H:MM AM/PM or H AM/PM
    m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (m) {
      let h = parseInt(m[1]);
      const mins = m[2] || '00';
      const period = m[3].toUpperCase();
      if (period === 'PM' && h !== 12) h += 12;
      if (period === 'AM' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${mins}`;
    }
    return null;
  }

  // ── Unofficial shows localStorage ─────────────────────────────────────────

  const USER_SHOWS_KEY = 'sxsw2026_user_shows';

  function loadUserShows() {
    try {
      return JSON.parse(localStorage.getItem(USER_SHOWS_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveUserShows(userShows) {
    localStorage.setItem(USER_SHOWS_KEY, JSON.stringify(userShows));
  }

  // ── Agenda state persistence ───────────────────────────────────────────────

  function loadAgendaState() {
    try {
      const raw = localStorage.getItem('sxsw2026_agenda');
      if (raw) {
        const d = JSON.parse(raw);
        if (d.filter) agendaFilter = { r4: true, r3: false, picks: false, ...d.filter };
        if (d.checkins) checkins = d.checkins;
      }
    } catch (e) {}
  }

  function saveAgendaState() {
    localStorage.setItem('sxsw2026_agenda', JSON.stringify({ filter: agendaFilter, checkins }));
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async function loadAll() {
    try {
      const [showsRes, unofficialShowsRes, venuesRes, artistsRes, recommendedRes] = await Promise.all([
        fetch('shows.json'),
        fetch('unofficial_shows.json'),
        fetch('venues.json'),
        fetch('artists.json'),
        fetch('recommended.json'),
      ]);
      allShows = await showsRes.json();
      venueOrder = await venuesRes.json();

      // Build name→entity_id map so unofficial shows of official artists
      // resolve to the same rating key as on the artist rating page.
      if (artistsRes.ok) {
        const artistsData = await artistsRes.json();
        for (const a of artistsData) {
          if (a.name) {
            const key = normForMatch(a.name);
            if (a.entity_id) artistEntityIdMap[key] = a.entity_id;
            artistMetaMap[key] = {
              genre:    (a.genre    || '').toLowerCase(),
              subgenre: (a.subgenre || '').toLowerCase(),
              location: (a.location || [a.city, a.state, a.country].filter(Boolean).join(', ')).toLowerCase(),
              displayGenre:    a.genre    || '',
              displaySubgenre: a.subgenre || '',
            };
          }
        }
      }
      venueAliases = venueOrder.aliases || {};

      // Load developer-curated recommended artists
      if (recommendedRes.ok) {
        const rData = await recommendedRes.json();
        recommendedEntityIds = new Set((rData.entity_ids || []).map(id => String(id)));
        recommendedNames     = new Set((rData.names || []).map(n => normForMatch(n)));
      }

      // Merge developer-curated unofficial shows from static file
      if (unofficialShowsRes.ok) {
        const unofficialShows = await unofficialShowsRes.json();
        if (Array.isArray(unofficialShows) && unofficialShows.length > 0) {
          // Option A: build a slot map so official shows can inherit unofficial admission
          const unofficialBySlot = new Map();
          for (const s of unofficialShows) {
            const slotKey = `${s.venue}|${s.day}|${s.start_time}`;
            if (!unofficialBySlot.has(slotKey)) unofficialBySlot.set(slotKey, s);
          }
          // Override admission on official shows where an unofficial entry exists at the same slot
          for (const s of allShows) {
            const match = unofficialBySlot.get(`${s.venue}|${s.day}|${s.start_time}`);
            if (match) s.admission = match.admission;
          }

          // Option B: fuzzy name normalisation for dedup
          // Strips leading articles and collapses non-alphanumeric chars so
          // "The Family Battenberg" and "Family Battenberg" share the same key.
          function normName(n) {
            return n.toLowerCase()
              .replace(/ & /g, ' and ')
              .replace(/^(the|a|an)\s+/, '')
              .replace(/[^a-z0-9]/g, '');
          }
          const existingKeys = new Set(allShows.map(s =>
            `${normName(s.artist_name)}|${s.venue}|${s.day}|${s.start_time}`
          ));
          for (const show of unofficialShows) {
            if (!existingKeys.has(`${normName(show.artist_name)}|${show.venue}|${show.day}|${show.start_time}`)) {
              allShows.push(show);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load data:', e);
    }

    // Load ratings from localStorage (read-only on schedule page)
    try {
      const raw = localStorage.getItem('sxsw2026_state');
      if (raw) {
        const state = JSON.parse(raw);
        ratings = state.ratings || {};
        hidePicks = state.hidePicks || 'show';
      }
    } catch (e) { /* ignore */ }

    loadAgendaState();

    // Merge user-submitted shows from localStorage
    const userShows = loadUserShows();
    const existingKeys = new Set(allShows.map(s =>
      `${s.artist_name}|${s.venue}|${s.day}|${s.start_time}`
    ));
    for (const show of userShows) {
      if (!existingKeys.has(`${show.artist_name}|${show.venue}|${show.day}|${show.start_time}`)) {
        allShows.push(show);
      }
    }

    buildDayTabs();
    populateDaySelects();
    populateVenueDatalist();

    // Apply any URL params passed in from the artist detail modal
    const params = new URLSearchParams(window.location.search);
    const paramDay    = params.get('day');
    const paramSearch = params.get('search');
    if (paramDay && allShows.some(s => s.day === paramDay)) {
      selectedDay = paramDay;
      document.querySelectorAll('.day-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.day === paramDay);
      });
    }
    if (paramSearch) {
      searchFilter = paramSearch;
      const input = document.getElementById('sched-search');
      if (input) input.value = paramSearch;
      const clear = document.getElementById('sched-search-clear');
      if (clear) clear.classList.add('visible');
    }
    if (paramDay || paramSearch) {
      // Arrived from rate page — stay on grid, don't restore saved view
      history.replaceState({}, '', window.location.pathname);
    } else {
      const savedView = localStorage.getItem('sxsw2026_last_view');
      if (savedView && ['nownext', 'grid', 'agenda'].includes(savedView)) {
        selectedView = savedView;
        document.querySelectorAll('.view-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.view === selectedView);
        });
      }
    }

    renderCurrentView();
  }

  // ── Day tabs ───────────────────────────────────────────────────────────────

  function buildDayTabs() {
    const bar = document.getElementById('sched-day-bar');
    bar.innerHTML = '';
    const days = allDays();

    if (days.length === 0) {
      bar.style.display = 'none';
      return;
    }

    // Auto-select today if present, else first day
    const todayIso = new Date().toISOString().slice(0, 10);
    selectedDay = days.includes(todayIso) ? todayIso : days[0];

    const hasPre   = days[0] < FESTIVAL_FIRST_DAY;
    let addedPreDivider   = false;
    let addedBonusDivider = false;

    for (const day of days) {
      // Divider between pre-festival and festival days
      if (hasPre && !addedPreDivider && day >= FESTIVAL_FIRST_DAY) {
        bar.appendChild(makeDayDivider());
        addedPreDivider = true;
      }
      // Divider between festival and post-festival days
      if (!addedBonusDivider && day > FESTIVAL_LAST_DAY) {
        bar.appendChild(makeDayDivider());
        addedBonusDivider = true;
      }

      const isBonus = day > FESTIVAL_LAST_DAY;
      const isPre   = day < FESTIVAL_FIRST_DAY;

      const btn = document.createElement('button');
      btn.className = 'day-tab' + (day === selectedDay ? ' active' : '');
      if (isBonus) btn.classList.add('day-tab--bonus');
      if (isPre)   btn.classList.add('day-tab--pre');
      btn.dataset.day = day;
      btn.textContent = formatDayLabel(day);
      btn.addEventListener('click', () => {
        selectedDay = day;
        if (selectedView === 'nownext') {
          // Shift viewNow to the clicked day, keep same time-of-day
          if (!viewNow) viewNow = new Date();
          const [y, mo, d] = day.split('-').map(Number);
          viewNow = new Date(viewNow);
          viewNow.setFullYear(y, mo - 1, d);
          viewNowShifted = true;
        }
        document.querySelectorAll('.day-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updatePostFestivalBanner();
        renderCurrentView();
      });
      bar.appendChild(btn);
    }

    updatePostFestivalBanner();
  }

  function makeDayDivider() {
    const sep = document.createElement('span');
    sep.className = 'day-tab-divider';
    sep.textContent = '///';
    sep.setAttribute('aria-hidden', 'true');
    return sep;
  }

  function updatePostFestivalBanner() {
    const banner = document.getElementById('post-festival-banner');
    if (!banner) return;
    banner.hidden = !selectedDay || selectedDay <= FESTIVAL_LAST_DAY;
  }

  function populateDaySelects() {
    const days = allDays();
    const todayIso = new Date().toISOString().slice(0, 10);

    for (const selId of ['add-show-day', 'import-csv-day']) {
      const sel = document.getElementById(selId);
      if (!sel) continue;
      sel.innerHTML = '';
      // Always include a few festival days even if shows.json is empty
      const options = days.length > 0 ? days : [
        '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15',
      ];
      for (const d of options) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = formatDayLabel(d) + ` (${d})`;
        if (d === (selectedDay || todayIso)) opt.selected = true;
        sel.appendChild(opt);
      }
    }
  }

  function populateVenueDatalist() {
    const dl = document.getElementById('venue-datalist');
    if (!dl) return;
    const venues = new Set(Object.values(venueOrder).flat());
    allShows.forEach(s => venues.add(s.venue));
    dl.innerHTML = '';
    for (const v of [...venues].sort()) {
      const opt = document.createElement('option');
      opt.value = v;
      dl.appendChild(opt);
    }
  }

  // ── View switching ─────────────────────────────────────────────────────────

  function renderCurrentView() {
    if (nowNextTimer) { clearInterval(nowNextTimer); nowNextTimer = null; }
    if (agendaTimer)  { clearInterval(agendaTimer);  agendaTimer  = null; }

    document.querySelectorAll('.sched-view').forEach(el => el.classList.add('sched-view--hidden'));
    const viewEl = document.getElementById(`view-${selectedView}`);
    if (viewEl) viewEl.classList.remove('sched-view--hidden');

    switch (selectedView) {
      case 'nownext':   renderNowNext(); break;
      case 'agenda':    renderAgenda();  break;
      case 'grid':      renderGrid();    break;
      case 'manage':    renderManage();  break;
    }
  }

  // ── Now / Next view ────────────────────────────────────────────────────────

  function formatTestTime(d) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const h = d.getHours();
    const m = d.getMinutes();
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 || 12;
    const mStr = String(m).padStart(2, '0');
    return `${days[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()} · ${h12}:${mStr} ${period}`;
  }

  function renderNowNext() {
    if (!viewNowShifted) viewNow = new Date(); // always track real time unless user shifted

    const el = document.getElementById('view-nownext');
    el.innerHTML = '';

    // Time navigation banner
    const banner = document.createElement('div');
    banner.className = 'nownext-test-banner';
    banner.innerHTML =
      `<span class="nownext-test-time">${escHtml(formatTestTime(viewNow))}</span>` +
      `<div class="nownext-test-controls">` +
        `<button class="nownext-test-btn" data-shift="-120">−2h</button>` +
        `<button class="nownext-test-btn" data-shift="-60">−1h</button>` +
        `<button class="nownext-test-btn" data-shift="-15">−15m</button>` +
        `<span class="nownext-test-sep"></span>` +
        `<button class="nownext-test-btn" data-shift="15">+15m</button>` +
        `<button class="nownext-test-btn" data-shift="60">+1h</button>` +
        `<button class="nownext-test-btn" data-shift="120">+2h</button>` +
      `</div>`;
    banner.addEventListener('click', e => {
      const btn = e.target.closest('.nownext-test-btn');
      if (!btn) return;
      viewNow = new Date(viewNow.getTime() + parseInt(btn.dataset.shift) * 60000);
      viewNowShifted = true;
      renderNowNext();
    });
    el.appendChild(banner);

    // Keep day bar in sync with viewNow (use local date, not UTC)
    const viewDayIso = `${viewNow.getFullYear()}-${String(viewNow.getMonth() + 1).padStart(2, '0')}-${String(viewNow.getDate()).padStart(2, '0')}`;
    document.querySelectorAll('.day-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.day === viewDayIso);
    });

    const now = viewNow;
    const shows = allShows.filter(s => {
      if (showFilter === 'rated' && getRating(s) === 0 && !(hidePicks !== 'hide' && isRecommended(s))) return false;
      if (showFilter === 'top' && getRating(s) < 3) return false;
      if (!admissionFilter.has(getAdmission(s))) return false;
      if (!matchesSearch(s)) return false;
      const start = parseShowTime(s.day, s.start_time);
      if (!start) return false;
      const end = s.end_time ? parseShowTime(s.day, s.end_time) : new Date(start.getTime() + 60 * 60000);
      // Include shows that have started within the last 30 min or start within 2 hrs
      return end > now && start <= new Date(now.getTime() + 2 * 60 * 60000);
    });

    if (shows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'nownext-empty';
      empty.innerHTML = allShows.length === 0
        ? 'No shows loaded yet.<br>Use <strong>+ Shows</strong> to import your schedule.'
        : 'Nothing playing in the next 2 hours.<br>Switch to Timeline to see the full day or select a day above to preview what will be happening.';
      el.appendChild(empty);
      return;
    }

    // Sort by start time
    shows.sort((a, b) => parseShowTime(a.day, a.start_time) - parseShowTime(b.day, b.start_time));

    const groups = [
      { label: 'NOW', className: 'nownext-section-label--now', shows: [] },
      { label: 'SOON  (< 45 min)', className: 'nownext-section-label--soon', shows: [] },
      { label: 'LATER  (< 2 hrs)', className: '', shows: [] },
    ];

    for (const show of shows) {
      const start = parseShowTime(show.day, show.start_time);
      const end = show.end_time ? parseShowTime(show.day, show.end_time) : new Date(start.getTime() + 60 * 60000);
      const minsUntil = (start - now) / 60000;
      if (start <= now && end > now) {
        groups[0].shows.push(show);
      } else if (minsUntil <= 45) {
        groups[1].shows.push(show);
      } else {
        groups[2].shows.push(show);
      }
    }

    for (const group of groups) {
      if (group.shows.length === 0) continue;
      const section = document.createElement('div');
      section.className = 'nownext-section';
      const label = document.createElement('div');
      label.className = `nownext-section-label ${group.className}`;
      label.textContent = group.label;
      section.appendChild(label);

      for (const show of group.shows) {
        section.appendChild(createNowNextCard(show, now));
      }
      el.appendChild(section);
    }

    // Auto-refresh every 60s
    nowNextTimer = setInterval(() => {
      if (selectedView === 'nownext') renderNowNext();
    }, 60000);
  }

  function createNowNextCard(show, now) {
    const rating = getRating(show);
    const start = parseShowTime(show.day, show.start_time);
    const minsUntil = Math.round((start - now) / 60000);

    let countdown;
    if (minsUntil <= 0) {
      const end = show.end_time ? parseShowTime(show.day, show.end_time) : null;
      const minsLeft = end ? Math.round((end - now) / 60000) : null;
      countdown = minsLeft !== null ? `${minsLeft}m left` : 'Now';
    } else {
      countdown = minsUntil < 60 ? `in ${minsUntil}m` : `in ${Math.round(minsUntil / 60)}h`;
    }

    const admission = getAdmission(show);
    const isPick = rating === 0 && hidePicks !== 'hide' && isRecommended(show);
    const card = document.createElement('div');
    card.className = `nownext-card${rating ? ` nownext-card--rated-${rating}` : isPick ? ' nownext-card--fw-pick' : ''}`;
    card.innerHTML = `
      <div class="nownext-rating${rating ? ` nownext-rating--${rating}` : isPick ? ' nownext-rating--fw-pick' : ''}">${rating || (isPick ? '★' : '?')}</div>
      <div class="nownext-info">
        <div class="nownext-artist">${escHtml(show.artist_name)}</div>
        <a class="nownext-venue venue-map-link" href="${escAttr(venueMapUrl(show.venue))}" target="_blank" rel="noopener noreferrer">${escHtml(show.venue)}</a>
        ${show.showcase ? `<div class="nownext-showcase">${escHtml(show.showcase)}</div>` : ''}
        <div class="nownext-time">${formatTime12(show.start_time)}${show.end_time ? ' – ' + formatTime12(show.end_time) : ''}</div>
        <div class="nownext-admission nownext-admission--${admission}">${escHtml(ADMISSION_LABELS[admission])}</div>
      </div>
      <div class="nownext-countdown">${escHtml(countdown)}</div>
    `;
    card.addEventListener('click', () => openDetail(show));
    card.querySelector('.nownext-venue').addEventListener('click', e => e.stopPropagation());
    return card;
  }

  // ── Timeline view ──────────────────────────────────────────────────────────

  const PX_PER_MIN = 2;
  const DAY_START_HOUR = 9; // 9 AM

  function minutesFromDayStart(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    // After midnight (0-6 AM) is treated as continuing the night
    let effectiveH = h;
    if (h < DAY_START_HOUR) effectiveH = h + 24;
    return (effectiveH - DAY_START_HOUR) * 60 + m;
  }

  function renderTimeline() {
    const el = document.getElementById('view-timeline');
    el.innerHTML = '';

    const shows = todayShows().filter(s => s.start_time && !s.no_set_time);
    const now = new Date();

    // Total height: 9 AM to 2 AM = 17 hours = 1020 min
    const totalMins = 17 * 60;
    const totalHeight = totalMins * PX_PER_MIN;

    if (shows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sched-loading';
      empty.textContent = selectedDay
        ? 'No shows for this day. Import a CSV or add shows manually.'
        : 'Select a day above.';
      el.appendChild(empty);
      return;
    }

    const outer = document.createElement('div');
    outer.className = 'timeline-outer';
    outer.style.overflow = 'auto';

    // Hours column
    const hoursCol = document.createElement('div');
    hoursCol.className = 'timeline-hours';
    hoursCol.style.height = `${totalHeight}px`;

    // Body
    const body = document.createElement('div');
    body.className = 'timeline-body';
    body.style.height = `${totalHeight}px`;

    // Hour labels + grid lines
    for (let i = 0; i <= 17; i++) {
      const hour = (DAY_START_HOUR + i) % 24;
      const top = i * 60 * PX_PER_MIN;
      const label = document.createElement('div');
      label.className = 'timeline-hour-label';
      label.style.top = `${top}px`;
      label.textContent = hour === 0 ? '12am' : hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`;
      hoursCol.appendChild(label);

      const line = document.createElement('div');
      line.className = 'timeline-gridline';
      line.style.top = `${top}px`;
      body.appendChild(line);
    }

    // "Now" line
    if (selectedDay) {
      const dayDate = new Date(selectedDay + 'T' + String(DAY_START_HOUR).padStart(2, '0') + ':00:00');
      const minsNow = (now - dayDate) / 60000;
      if (minsNow >= 0 && minsNow <= totalMins) {
        const nowLine = document.createElement('div');
        nowLine.className = 'timeline-now-line';
        nowLine.style.top = `${minsNow * PX_PER_MIN}px`;
        body.appendChild(nowLine);
      }
    }

    // Conflict detection: find pairs of rated shows that overlap
    const ratedShows = shows.filter(s => getRating(s) > 0);
    const conflicting = new Set();
    for (let i = 0; i < ratedShows.length; i++) {
      for (let j = i + 1; j < ratedShows.length; j++) {
        const a = ratedShows[i], b = ratedShows[j];
        const aStart = minutesFromDayStart(a.start_time);
        const aEnd = a.end_time ? minutesFromDayStart(a.end_time) : aStart + 45;
        const bStart = minutesFromDayStart(b.start_time);
        const bEnd = b.end_time ? minutesFromDayStart(b.end_time) : bStart + 45;
        if (aStart < bEnd && aEnd > bStart) {
          conflicting.add(a.artist_name + a.venue + a.start_time);
          conflicting.add(b.artist_name + b.venue + b.start_time);
        }
      }
    }

    // Group shows by start time slot into columns for overlap display
    const columns = layoutColumns(shows);

    const STACK_VW = 4; // vw offset per overlapping layer — scales with screen width
    for (const { show, col, totalCols } of columns) {
      const rating = getRating(show);
      const startMin = minutesFromDayStart(show.start_time);
      const endMin = show.end_time ? minutesFromDayStart(show.end_time) : startMin + 45;
      const height = Math.max((endMin - startMin) * PX_PER_MIN - 2, 22);

      const isOverlapping = totalCols > 1;
      const blockLeft   = isOverlapping ? `${col * STACK_VW}vw` : '0';
      const blockWidth  = isOverlapping ? `calc(100% - ${(totalCols - 1) * STACK_VW}vw)` : '100%';
      const blockZ      = getRating(show) * 10 + (totalCols - col); // higher rating on top; col as tiebreaker
      const blockOpacity = isOverlapping ? 0.75 : 1;

      const isConflict = conflicting.has(show.artist_name + show.venue + show.start_time);

      const isPick = rating === 0 && hidePicks !== 'hide' && isRecommended(show);
      const block = document.createElement('div');
      block.className = `timeline-show${rating ? ` timeline-show--rated-${rating}` : isPick ? ' timeline-show--fw-pick' : ''}${isConflict ? ' timeline-show--conflict' : ''}`;
      block.style.cssText = `top:${startMin * PX_PER_MIN}px;height:${height}px;left:${blockLeft};width:${blockWidth};z-index:${blockZ};opacity:${blockOpacity};`;
      block.innerHTML = `
        <div class="timeline-show-name">${escHtml(show.artist_name)}</div>
        ${height > 40 ? `<div class="timeline-show-venue">${escHtml(show.venue)}</div>` : ''}
        ${height > 55 && show.showcase ? `<div class="timeline-show-showcase">${escHtml(show.showcase)}</div>` : ''}
      `;
      block.addEventListener('click', () => openDetail(show));
      body.appendChild(block);
    }

    outer.appendChild(hoursCol);
    outer.appendChild(body);
    el.appendChild(outer);

    // Size to viewport and scroll to bottom
    requestAnimationFrame(() => {
      const top = outer.getBoundingClientRect().top;
      outer.style.height = `${window.innerHeight - top}px`;
      outer.scrollTop = outer.scrollHeight;
    });
  }

  // Simple column layout: group overlapping shows into side-by-side columns
  function layoutColumns(shows) {
    const sorted = [...shows].sort((a, b) =>
      minutesFromDayStart(a.start_time) - minutesFromDayStart(b.start_time)
    );
    const result = [];
    const active = []; // { endMin, col }

    for (const show of sorted) {
      const startMin = minutesFromDayStart(show.start_time);
      const endMin = show.end_time ? minutesFromDayStart(show.end_time) : startMin + 45;

      // Remove expired
      const still = active.filter(a => a.endMin > startMin);
      active.length = 0;
      still.forEach(a => active.push(a));

      // Find free column
      const usedCols = new Set(active.map(a => a.col));
      let col = 0;
      while (usedCols.has(col)) col++;
      active.push({ endMin, col });

      result.push({ show, col, totalCols: 1 }); // totalCols updated below
    }

    // Second pass: set totalCols = max col+1 among overlapping shows
    for (let i = 0; i < result.length; i++) {
      const startI = minutesFromDayStart(result[i].show.start_time);
      const endI = result[i].show.end_time
        ? minutesFromDayStart(result[i].show.end_time) : startI + 45;
      let maxCol = result[i].col;
      for (let j = 0; j < result.length; j++) {
        const startJ = minutesFromDayStart(result[j].show.start_time);
        const endJ = result[j].show.end_time
          ? minutesFromDayStart(result[j].show.end_time) : startJ + 45;
        if (startI < endJ && endI > startJ) maxCol = Math.max(maxCol, result[j].col);
      }
      result[i].totalCols = maxCol + 1;
    }

    return result;
  }

  // ── Agenda (My Day) view ───────────────────────────────────────────────────

  function goAgendaDay(delta) {
    const days = allDays();
    const idx = days.indexOf(selectedDay);
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0 || next >= days.length) return;
    selectedDay = days[next];
    document.querySelectorAll('.day-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.day === selectedDay)
    );
    updatePostFestivalBanner();
    renderAgenda();
  }

  function agendaShows() {
    if (!selectedDay) return [];
    let shows = allShows.filter(s => s.day === selectedDay);

    // Apply agenda filter (union of enabled tiers)
    shows = shows.filter(s => {
      const r = getRating(s);
      if (agendaFilter.r4 && r === 4) return true;
      if (agendaFilter.r3 && r === 3) return true;
      if (agendaFilter.picks && r === 0 && hidePicks !== 'hide' && isRecommended(s)) return true;
      return false;
    });

    // Chronological: timed shows first (by start_time), then no-set-time shows
    const timed = shows.filter(s => s.start_time && !s.no_set_time)
      .sort((a, b) => minutesFromDayStart(a.start_time) - minutesFromDayStart(b.start_time));
    const untimed = shows.filter(s => !s.start_time || s.no_set_time);
    return [...timed, ...untimed];
  }

  function createAgendaCard(show) {
    const rating  = getRating(show);
    const isPick  = rating === 0 && hidePicks !== 'hide' && isRecommended(show);
    const key     = checkinKey(show);
    const attended = !!checkins[key];
    const admission = getAdmission(show);
    const now = new Date();
    const isPast = !!(show.start_time && !show.no_set_time &&
      parseShowTime(show.day, show.start_time) < now);

    const card = document.createElement('div');
    const classes = ['agenda-card'];
    if (rating === 4)    classes.push('agenda-card--rated-4');
    else if (rating === 3) classes.push('agenda-card--rated-3');
    else if (isPick)     classes.push('agenda-card--fw-pick');
    if (isPast && !attended) classes.push('agenda-card--past');
    if (attended)        classes.push('agenda-card--attended');
    card.className = classes.join(' ');

    // Check circle
    const check = document.createElement('div');
    check.className = 'agenda-check';
    if (attended) check.textContent = '✓';
    check.addEventListener('click', e => {
      e.stopPropagation();
      if (checkins[key]) { delete checkins[key]; } else { checkins[key] = true; }
      saveAgendaState();
      renderAgenda();
    });
    card.appendChild(check);

    // Rating circle (reuse nownext-rating classes)
    const ratingEl = document.createElement('div');
    ratingEl.className = `nownext-rating${rating ? ` nownext-rating--${rating}` : isPick ? ' nownext-rating--fw-pick' : ''}`;
    ratingEl.textContent = rating || (isPick ? '★' : '?');
    card.appendChild(ratingEl);

    // Info section
    const info = document.createElement('div');
    info.className = 'agenda-info';

    const artistEl = document.createElement('div');
    artistEl.className = 'agenda-artist';
    artistEl.textContent = show.artist_name;
    info.appendChild(artistEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'agenda-meta';
    const venueLink = document.createElement('a');
    venueLink.href = venueMapUrl(show.venue);
    venueLink.target = '_blank';
    venueLink.rel = 'noopener noreferrer';
    venueLink.className = 'venue-map-link';
    venueLink.textContent = show.venue;
    venueLink.addEventListener('click', e => e.stopPropagation());
    metaEl.appendChild(venueLink);
    metaEl.appendChild(document.createTextNode(` · ${ADMISSION_LABELS[admission]}`));
    info.appendChild(metaEl);

    if (attended) {
      const badge = document.createElement('div');
      badge.className = 'agenda-attended-badge';
      badge.textContent = '✓ Attended';
      info.appendChild(badge);
    }
    card.appendChild(info);

    // Right: time
    const right = document.createElement('div');
    right.className = 'agenda-right';
    const timeEl = document.createElement('div');
    timeEl.className = 'agenda-time';
    if (show.no_set_time || !show.start_time) {
      timeEl.textContent = 'No set time';
    } else {
      timeEl.textContent = show.end_time
        ? `${formatTime12(show.start_time)} – ${formatTime12(show.end_time)}`
        : formatTime12(show.start_time);
    }
    right.appendChild(timeEl);
    card.appendChild(right);

    card.addEventListener('click', () => openDetail(show));
    return card;
  }

  function renderAgenda() {
    if (agendaTimer) { clearInterval(agendaTimer); agendaTimer = null; }

    const el = document.getElementById('view-agenda');
    el.innerHTML = '';

    // Sticky filter bar
    const filterBar = document.createElement('div');
    filterBar.className = 'agenda-filter-bar';
    const filterLabel = document.createElement('span');
    filterLabel.className = 'agenda-filter-label';
    filterLabel.textContent = 'Show:';
    filterBar.appendChild(filterLabel);

    for (const f of [{ key: 'r4', label: '★★★★' }, { key: 'r3', label: '★★★' }, { key: 'picks', label: 'FW Picks' }]) {
      const btn = document.createElement('button');
      btn.className = 'agenda-filter-btn' + (agendaFilter[f.key] ? ' agenda-filter-btn--active' : '');
      btn.textContent = f.label;
      btn.addEventListener('click', () => {
        agendaFilter[f.key] = !agendaFilter[f.key];
        saveAgendaState();
        renderAgenda();
      });
      filterBar.appendChild(btn);
    }

    // Day navigation: [←] [Thu 3/13] [→]
    const days = allDays();
    const dayIdx = days.indexOf(selectedDay);
    const dayNav = document.createElement('div');
    dayNav.className = 'agenda-day-nav';
    const prevBtn = document.createElement('button');
    prevBtn.className = 'agenda-day-nav-btn';
    prevBtn.textContent = '←';
    prevBtn.disabled = dayIdx <= 0;
    prevBtn.addEventListener('click', () => goAgendaDay(-1));
    const dayLabel = document.createElement('span');
    dayLabel.className = 'agenda-day-label';
    dayLabel.textContent = selectedDay ? formatDayLabel(selectedDay) : '';
    const nextBtn = document.createElement('button');
    nextBtn.className = 'agenda-day-nav-btn';
    nextBtn.textContent = '→';
    nextBtn.disabled = dayIdx < 0 || dayIdx >= days.length - 1;
    nextBtn.addEventListener('click', () => goAgendaDay(1));
    dayNav.appendChild(prevBtn);
    dayNav.appendChild(dayLabel);
    dayNav.appendChild(nextBtn);
    filterBar.appendChild(dayNav);

    el.appendChild(filterBar);

    // Swipe left/right to change day
    let touchStartX = 0, touchStartY = 0;
    el.ontouchstart = e => {
      touchStartX = e.changedTouches[0].clientX;
      touchStartY = e.changedTouches[0].clientY;
    };
    el.ontouchend = e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        goAgendaDay(dx < 0 ? 1 : -1);
      }
    };

    const shows = agendaShows();

    if (shows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sched-loading';
      empty.innerHTML = 'No shows match your filters for this day.<br><small>Try enabling ★★★ or FW Picks above.</small>';
      el.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'agenda-list';
    for (const show of shows) {
      list.appendChild(createAgendaCard(show));
    }
    el.appendChild(list);

    agendaTimer = setInterval(() => renderAgenda(), 60000);
  }

  // ── Grid venue ordering ─────────────────────────────────────────────────────
  // Groups venues by cluster (related spaces stay adjacent), then sorts groups
  // by the highest rating the user has given any show at that venue/cluster today.
  // Result: 4-star venues first, then 3-star, 2-star, 1-star, unrated.

  function getOrderedVenuesForDay(dayShows) {
    const venueSet = new Set(dayShows.map(s => s.venue));
    const clusterDefs = venueOrder.clusters || [];

    // Build venue → cluster lookup (keyed by first cluster member)
    const venueToClusterKey = {};
    const clusterByKey = {};
    for (const cluster of clusterDefs) {
      const key = cluster[0];
      clusterByKey[key] = cluster;
      for (const v of cluster) venueToClusterKey[v] = key;
    }

    // Score per venue: rated shows use their rating (1–4),
    // unrated FestWiz Picks use 0.5 (above plain unrated 0)
    const venueScore = {};
    for (const show of dayShows) {
      const r = getRating(show);
      const score = r > 0 ? r : (hidePicks !== 'hide' && isRecommended(show)) ? 0.5 : 0;
      if (score > (venueScore[show.venue] || 0)) venueScore[show.venue] = score;
    }

    // Build groups: each is { venues: [...], maxScore: N }
    const processed = new Set();
    const groups = [];

    for (const v of [...venueSet].sort()) {
      if (processed.has(v)) continue;
      const clusterKey = venueToClusterKey[v];
      if (clusterKey) {
        const members = (clusterByKey[clusterKey] || [v]).filter(m => venueSet.has(m));
        const maxScore = Math.max(0, ...members.map(m => venueScore[m] || 0));
        groups.push({ venues: members, maxScore });
        members.forEach(m => processed.add(m));
      } else {
        groups.push({ venues: [v], maxScore: venueScore[v] || 0 });
        processed.add(v);
      }
    }

    // Stable sort: highest score first, ties keep alphabetical order
    groups.sort((a, b) => b.maxScore - a.maxScore);
    return groups.flatMap(g => g.venues);
  }

  // ── Grid view ──────────────────────────────────────────────────────────────

  function renderGrid() {
    const el = document.getElementById('view-grid');
    el.innerHTML = '';

    // Zoom controls
    const zoomBar = document.createElement('div');
    zoomBar.className = 'grid-zoom-bar';
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'grid-zoom-label';
    zoomLabel.textContent = 'Zoom:';
    const zoomOut = document.createElement('button');
    zoomOut.className = 'grid-zoom-btn';
    zoomOut.textContent = '−';
    zoomOut.disabled = gridZoom <= 0.6;
    const zoomPct = document.createElement('span');
    zoomPct.className = 'grid-zoom-pct';
    zoomPct.textContent = gridZoom === 1 ? '100%' : gridZoom === 0.75 ? '75%' : '60%';
    const zoomIn = document.createElement('button');
    zoomIn.className = 'grid-zoom-btn';
    zoomIn.textContent = '+';
    zoomIn.disabled = gridZoom >= 1;
    zoomOut.addEventListener('click', () => {
      gridZoom = gridZoom >= 1 ? 0.75 : 0.6;
      localStorage.setItem('sxsw2026_grid_zoom', gridZoom);
      renderCurrentView();
    });
    zoomIn.addEventListener('click', () => {
      gridZoom = gridZoom <= 0.6 ? 0.75 : 1;
      localStorage.setItem('sxsw2026_grid_zoom', gridZoom);
      renderCurrentView();
    });
    zoomBar.appendChild(zoomLabel);
    zoomBar.appendChild(zoomOut);
    zoomBar.appendChild(zoomPct);
    zoomBar.appendChild(zoomIn);
    el.appendChild(zoomBar);

    const shows = todayShows().filter(s => s.start_time || s.no_set_time);

    if (shows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sched-loading';
      empty.textContent = selectedDay
        ? 'No shows for this day. Import a CSV or add shows manually.'
        : 'Select a day above.';
      el.appendChild(empty);
      return;
    }

    const venues = getOrderedVenuesForDay(shows);

    // Separate timed shows from no-set-time shows
    const timedShows  = shows.filter(s => !s.no_set_time);
    const noSetShows  = shows.filter(s =>  s.no_set_time);

    // Build lookup: venue → { slotKey → [timed shows] }
    const lookup = {};
    for (const v of venues) lookup[v] = {};
    for (const show of timedShows) {
      const v = show.venue;
      if (!lookup[v]) lookup[v] = {};
      const slotKey = nearestSlot(show.start_time);
      if (!lookup[v][slotKey]) lookup[v][slotKey] = [];
      lookup[v][slotKey].push(show);
    }

    // No-set-time shows per venue (all pills go in one rowspan cell)
    const noSetByVenue = {};
    for (const show of noSetShows) {
      const v = show.venue;
      if (!noSetByVenue[v]) noSetByVenue[v] = [];
      noSetByVenue[v].push(show);
    }

    // For venues with a no-set-time block, absorb any timed shows whose start_time
    // falls within that block's window. They'll render inside the block with their
    // time shown inline, preventing the rowspan from crushing their individual slots.
    const timedWithinNoSet = {};
    for (const v of Object.keys(noSetByVenue)) {
      const noSetStart = noSetByVenue[v].map(s => s.start_time).filter(Boolean).sort()[0];
      if (!noSetStart) continue;
      const noSetEndRaw = noSetByVenue[v].map(s => s.end_time).filter(Boolean).sort().pop();
      const noSetStartMin = minutesFromDayStart(noSetStart);
      const noSetEndMin = noSetEndRaw ? minutesFromDayStart(noSetEndRaw) : noSetStartMin + 240;
      timedWithinNoSet[v] = [];
      for (const slot of Object.keys(lookup[v] || {})) {
        const absorbed = [];
        const remaining = [];
        for (const show of lookup[v][slot]) {
          const showMin = minutesFromDayStart(show.start_time);
          if (showMin >= noSetStartMin && showMin < noSetEndMin) {
            absorbed.push(show);
          } else {
            remaining.push(show);
          }
        }
        if (absorbed.length) {
          timedWithinNoSet[v].push(...absorbed);
          if (remaining.length) lookup[v][slot] = remaining;
          else delete lookup[v][slot];
        }
      }
      // Sort absorbed shows by start_time for display order
      timedWithinNoSet[v].sort((a, b) =>
        minutesFromDayStart(a.start_time) - minutesFromDayStart(b.start_time));
    }

    // Generate 30-min slots from 9:00 AM to 2:00 AM
    const slots = [];
    for (let h = DAY_START_HOUR; h < DAY_START_HOUR + 17; h++) {
      const hh = h % 24;
      slots.push(`${String(hh).padStart(2, '0')}:00`);
      slots.push(`${String(hh).padStart(2, '0')}:30`);
    }

    // Find the slot where each venue's no-set-time cell will be placed.
    // If the venue has any timed shows, place the block in the slot immediately
    // AFTER the last timed show — this prevents the rowspan from overwriting
    // cells where a timed show should appear (the "announced set time" case).
    // If the venue has only no-set-time shows, use the showcase's start_time.
    const lastSlotPerVenue = {};
    for (const v of venues) {
      if (!noSetByVenue[v] || !noSetByVenue[v].length) continue;

      // Find last slot that has a timed show at this venue
      let lastTimedSlot = null;
      for (const slot of slots) {
        if (lookup[v][slot] && lookup[v][slot].length > 0) lastTimedSlot = slot;
      }

      if (lastTimedSlot) {
        // Mixed venue: check if the no-set-time block belongs before the timed shows
        const tbStart = noSetByVenue[v][0].start_time;
        let firstTimedSlot = null;
        for (const slot of slots) {
          if (lookup[v][slot] && lookup[v][slot].length > 0) { firstTimedSlot = slot; break; }
        }
        const noSetIsBeforeTimed = tbStart && firstTimedSlot &&
          minutesFromDayStart(tbStart) < minutesFromDayStart(firstTimedSlot);

        if (noSetIsBeforeTimed) {
          // No-set-time block is a daytime window before the timed shows — place at its own start_time
          const preferred = nearestSlot(tbStart);
          if (slots.includes(preferred)) lastSlotPerVenue[v] = preferred;
        } else {
          // No-set-time block follows the timed shows — place right after the last timed show
          const nextIdx = slots.indexOf(lastTimedSlot) + 1;
          if (nextIdx < slots.length) lastSlotPerVenue[v] = slots[nextIdx];
          // else: last timed show hits end of grid — no room left for the block
        }
      } else {
        // Only no-set-time shows: use showcase's start_time or fall back to first slot
        const tbStart = noSetByVenue[v][0].start_time;
        const preferred = tbStart ? nearestSlot(tbStart) : null;
        if (preferred && slots.includes(preferred)) {
          lastSlotPerVenue[v] = preferred;
        } else {
          lastSlotPerVenue[v] = slots[0];
        }
      }
    }

    // Calculate rowspan for each no-set-time cell:
    // span from placement slot to end_time (or assume 4 h if unknown)
    const noSetRowspans = {};
    for (const v of venues) {
      if (!noSetByVenue[v]) continue;
      const startSlot = lastSlotPerVenue[v];
      if (!startSlot) continue;
      const endTime = noSetByVenue[v].map(s => s.end_time).filter(Boolean).sort().pop();
      const startMin = minutesFromDayStart(startSlot);
      const endMin   = endTime ? minutesFromDayStart(endTime) : startMin + 240;
      // Ensure enough rows to display all pills (2 slots per show minimum)
      noSetRowspans[v] = Math.max(4, noSetByVenue[v].length * 2, Math.round((endMin - startMin) / 30));
    }

    const wrap = document.createElement('div');
    wrap.className = 'grid-wrap' +
      (gridZoom === 0.75 ? ' grid-wrap--zoom-sm' : gridZoom === 0.6 ? ' grid-wrap--zoom-xs' : '');

    const table = document.createElement('table');
    table.className = 'grid-table';

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'grid-corner';
    corner.textContent = 'Time';
    headerRow.appendChild(corner);
    for (const v of venues) {
      const th = document.createElement('th');
      th.className = 'grid-venue-th';
      const thLink = document.createElement('a');
      thLink.href = venueMapUrl(v);
      thLink.target = '_blank';
      thLink.rel = 'noopener noreferrer';
      thLink.className = 'venue-map-link';
      thLink.textContent = venueAliases[v] || v;
      th.appendChild(thLink);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Track remaining rowspan rows to skip per venue
    const activeRowspans = {};
    for (const v of venues) activeRowspans[v] = 0;

    // Body
    const tbody = document.createElement('tbody');
    for (const slot of slots) {
      const tr = document.createElement('tr');
      tr.dataset.slot = slot;
      const [h, m] = slot.split(':').map(Number);
      const isHour = m === 0;

      const timeTd = document.createElement('td');
      timeTd.className = `grid-time-td${isHour ? ' grid-time-td--hour' : ''}`;
      if (isHour) {
        const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
        timeTd.textContent = label;
      }
      tr.appendChild(timeTd);

      for (const v of venues) {
        // Skip cells covered by an earlier rowspan
        if (activeRowspans[v] > 0) {
          activeRowspans[v]--;
          continue;
        }

        const td = document.createElement('td');
        td.className = 'grid-cell';
        td.dataset.venue = v;
        const cellShows = lookup[v][slot] || [];
        for (const show of cellShows) {
          td.appendChild(createGridPill(show));
        }

        // No-set-time cell: apply rowspan so it expands vertically
        if (slot === lastSlotPerVenue[v] && noSetByVenue[v] && noSetByVenue[v].length > 0) {
          const rowspan = noSetRowspans[v] || 4;
          td.rowSpan = rowspan;
          activeRowspans[v] = rowspan - 1;
          // Render any timed shows absorbed into this block first (show their individual times)
          for (const show of (timedWithinNoSet[v] || [])) td.appendChild(createGridPill(show));
          // Then the no-set-time header and untimed artists
          const noTimeHdr = document.createElement('div');
          noTimeHdr.className = 'grid-no-set-time-header';
          noTimeHdr.textContent = '(No Set Times)';
          td.appendChild(noTimeHdr);
          for (const show of noSetByVenue[v]) td.appendChild(createGridPill(show));
        }

        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    el.appendChild(wrap);

    // Set wrap height to fill remaining viewport, then scroll to bottom
    requestAnimationFrame(() => {
      const top = wrap.getBoundingClientRect().top;
      wrap.style.height = `${window.innerHeight - top}px`;
      wrap.scrollTop = wrap.scrollHeight;
      renderShowcaseOverlays(wrap, table, shows, venues);
    });
  }

  function nearestSlot(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const roundedM = m < 30 ? '00' : '30';
    return `${String(h).padStart(2, '0')}:${roundedM}`;
  }

  function prevSlotKey(slotStr) {
    const [h, m] = slotStr.split(':').map(Number);
    if (m === 0) return `${String((h - 1 + 24) % 24).padStart(2, '0')}:30`;
    return `${String(h).padStart(2, '0')}:00`;
  }

  function createGridPill(show) {
    const rating = getRating(show);
    const admission = getAdmission(show);
    const isPick = rating === 0 && hidePicks !== 'hide' && isRecommended(show);
    const pill = document.createElement('div');
    pill.className = `grid-show-pill${rating ? ` grid-show-pill--rated-${rating}` : isPick ? ' grid-show-pill--fw-pick' : ''}`;
    const timeStr = formatPillTime(show);
    const admissionSpan = !show.showcase
      ? `<span class="grid-show-admission grid-show-admission--${admission}">${ADMISSION_LABELS[admission]}</span>`
      : '';
    const metaHtml = (timeStr || admissionSpan)
      ? `<div class="grid-show-meta">${timeStr ? `<span class="grid-show-time">${escHtml(timeStr)}</span>` : ''}${admissionSpan}</div>`
      : '';
    pill.innerHTML = `
      <div class="grid-show-name">${escHtml(show.artist_name)}</div>
      ${metaHtml}
    `;
    pill.addEventListener('click', () => openDetail(show));
    return pill;
  }

  function renderShowcaseOverlays(wrap, table, shows, venues) {
    // Group shows by showcase + venue
    const byKey = new Map();
    for (const show of shows) {
      if (!show.showcase || !show.start_time) continue;
      const key = show.showcase.toLowerCase() + '\x00' + show.venue;
      if (!byKey.has(key)) byKey.set(key, { showcase: show.showcase, venue: show.venue, shows: [] });
      byKey.get(key).shows.push(show);
    }
    if (byKey.size === 0) return;

    const overlay = document.createElement('div');
    overlay.className = 'grid-overlay-container';
    wrap.appendChild(overlay);

    const wrapRect = wrap.getBoundingClientRect();
    const venueHeaders = [...table.querySelectorAll('th.grid-venue-th')];
    const allBodyRows = [...table.querySelectorAll('tbody tr')];
    const lastBodyRow = allBodyRows[allBodyRows.length - 1];

    for (const [, { showcase, venue, shows: grpShows }] of byKey) {
      const venueIdx = venues.indexOf(venue);
      if (venueIdx < 0) continue;
      const venueTh = venueHeaders[venueIdx];
      if (!venueTh) continue;

      const starts = grpShows.map(s => s.start_time).filter(Boolean)
        .sort((a, b) => minutesFromDayStart(a) - minutesFromDayStart(b));
      const ends = grpShows.map(s => s.end_time).filter(Boolean)
        .sort((a, b) => minutesFromDayStart(a) - minutesFromDayStart(b));
      if (!starts.length) continue;

      const startSlot = nearestSlot(starts[0]);
      let endSlot;
      if (ends.length) {
        // End times known: span to the last one
        endSlot = nearestSlot(ends[ends.length - 1]);
      } else if (grpShows.every(s => s.no_set_time)) {
        // No-set-time shows with no end times: size by performer count
        const fallbackMins = minutesFromDayStart(startSlot) + grpShows.length * 30;
        const fH = (DAY_START_HOUR + Math.floor(fallbackMins / 60)) % 24;
        const fM = fallbackMins % 60 >= 30 ? 30 : 0;
        endSlot = `${String(fH).padStart(2, '0')}:${fM === 0 ? '00' : '30'}`;
      } else {
        // Timed shows without end times: span to the last known start_time
        endSlot = nearestSlot(starts[starts.length - 1]);
      }

      const startTr = table.querySelector(`tr[data-slot="${startSlot}"]`);
      if (!startTr) continue;
      const endTr = table.querySelector(`tr[data-slot="${endSlot}"]`) || lastBodyRow;

      // Extend the box up one row to give the label its own header area
      const headerTr = table.querySelector(`tr[data-slot="${prevSlotKey(startSlot)}"]`);

      const startRect  = startTr.getBoundingClientRect();
      const endRect    = endTr.getBoundingClientRect();
      const thRect     = venueTh.getBoundingClientRect();
      const headerRect = headerTr ? headerTr.getBoundingClientRect() : startRect;

      const top    = headerRect.top - wrapRect.top  + wrap.scrollTop;
      const bottom = endRect.bottom - wrapRect.top  + wrap.scrollTop;
      const left   = thRect.left    - wrapRect.left + wrap.scrollLeft;
      const right  = thRect.right   - wrapRect.left + wrap.scrollLeft;

      const admission = getAdmission(grpShows[0]);
      const box = document.createElement('div');
      box.className = `showcase-box showcase-box--${admission}`;
      box.style.cssText = `top:${top}px;left:${left}px;width:${right - left}px;height:${bottom - top}px`;

      const label = document.createElement('div');
      label.className = 'showcase-box-label';
      const admBadge = `<span class="grid-showcase-admission grid-showcase-admission--${admission}">${ADMISSION_LABELS[admission]}</span>`;
      label.innerHTML = `<em>${escHtml(showcase)}</em>${admBadge}`;
      box.appendChild(label);
      overlay.appendChild(box);
    }
  }

  // ── Manage / Import view ───────────────────────────────────────────────────

  function renderManage() {
    const el = document.getElementById('view-manage');
    el.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'manage-section';
    section.innerHTML = `
      <h3>Add Shows</h3>
      <button class="manage-btn" id="manage-btn-import">
        <div class="manage-btn-title">Import CSV from Google Sheet</div>
        <div class="manage-btn-desc">Export a day tab as CSV and import it here. Existing shows are preserved.</div>
      </button>
      <button class="manage-btn" id="manage-btn-add">
        <div class="manage-btn-title">+ Add a Single Show</div>
        <div class="manage-btn-desc">Manually enter a show — useful for last-minute additions.</div>
      </button>
      <h3 style="margin-top:24px;">Loaded Shows (${allShows.length})</h3>
    `;

    // Show list for the selected day
    const dayShows = selectedDay ? allShows.filter(s => s.day === selectedDay) : [];
    if (dayShows.length > 0) {
      const list = document.createElement('div');
      list.className = 'manage-shows-list';
      const sorted = [...dayShows].sort((a, b) =>
        (a.start_time || '').localeCompare(b.start_time || '')
      );
      for (const show of sorted) {
        const row = document.createElement('div');
        row.className = 'manage-show-row';
        row.innerHTML = `
          <div class="manage-show-info">
            <div class="manage-show-name">${escHtml(show.artist_name)}</div>
            <div class="manage-show-meta">${escHtml(formatTime12(show.start_time))} · ${escHtml(show.venue)}${show.source === 'user' ? ' · user-submitted' : ''}</div>
          </div>
          <button class="manage-show-delete" title="Remove show">×</button>
        `;
        row.querySelector('.manage-show-delete').addEventListener('click', () => deleteShow(show));
        list.appendChild(row);
      }
      section.appendChild(list);
    } else {
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-muted);font-size:13px;padding:12px 0;';
      note.textContent = selectedDay
        ? `No shows loaded for ${formatDayLabel(selectedDay)}.`
        : 'No shows loaded yet.';
      section.appendChild(note);
    }

    el.appendChild(section);

    document.getElementById('manage-btn-import').addEventListener('click', openImportModal);
    document.getElementById('manage-btn-add').addEventListener('click', openAddShowModal);
  }

  // ── Show detail modal ──────────────────────────────────────────────────────

  function openDetail(show) {
    detailShow = show;
    const rating = getRating(show);

    const admission = getAdmission(show);
    const searchParam = encodeURIComponent(show.artist_name);
    document.getElementById('detail-artist').innerHTML =
      `${escHtml(show.artist_name)} <a href="/?search=${searchParam}" class="detail-artist-edit-link">(edit in artists)</a>`;
    if (hidePicks !== 'hide' && isRecommended(show)) {
      const pick = document.createElement('span');
      pick.className = 'artist-detail-badge--fw-pick';
      pick.textContent = '★ FestWiz Pick';
      document.getElementById('detail-artist').appendChild(pick);
    }

    // Genre / subgenre from artist metadata
    const meta = artistMetaMap[show.artist_name.toLowerCase()];
    const genreEl = document.getElementById('detail-genre');
    if (meta) {
      const parts = [meta.displayGenre, meta.displaySubgenre].filter(Boolean);
      genreEl.textContent = parts.join(' / ');
      genreEl.style.display = parts.length ? '' : 'none';
    } else {
      genreEl.style.display = 'none';
    }

    const metaEl = document.getElementById('detail-meta');
    metaEl.innerHTML =
      `${escHtml(formatTime12(show.start_time))}${show.end_time ? ' – ' + escHtml(formatTime12(show.end_time)) : ''} · ${escHtml(show.venue)} · ${escHtml(formatDayLabel(show.day))} <span class="detail-admission detail-admission--${admission}">${escHtml(ADMISSION_LABELS[admission])}</span>`;
    metaEl.onclick = () => {
      closeModal('modal-show-detail');
      selectedDay = show.day;
      document.querySelectorAll('.day-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.day === show.day)
      );
      searchFilter = show.venue;
      const input = document.getElementById('sched-search');
      if (input) input.value = show.venue;
      const clear = document.getElementById('sched-search-clear');
      if (clear) clear.classList.add('visible');
      selectedView = 'grid';
      localStorage.setItem('sxsw2026_last_view', 'grid');
      document.querySelectorAll('.view-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.view === 'grid')
      );
      renderCurrentView();
    };
    document.getElementById('detail-showcase').textContent = show.showcase || '';

    // Rating display (read-only — change ratings on the Artist page)
    const ratingEl = document.getElementById('detail-rating');
    const labels = ['', 'Nope', 'Sure', 'Psyched', 'Hell yeah'];
    if (rating > 0) {
      ratingEl.innerHTML = `<span class="detail-rating-label">Rating:</span> <span class="detail-rating-btn active-${rating}">${rating} ${labels[rating]}</span>`;
    } else {
      const searchParam = encodeURIComponent(show.artist_name);
      ratingEl.innerHTML = `<span class="detail-rating-label">Rating:</span> <span style="color:var(--text-muted);font-size:13px;">Unrated — <a href="/?search=${searchParam}" class="detail-artist-link">go to Artist page</a> to rate</span>`;
    }

    // Link to SxSW page (official) or artist website (unofficial)
    const linkEl = document.getElementById('detail-link');
    linkEl.innerHTML = '';
    if (show.source === 'official' && show.entity_id) {
      const a = document.createElement('a');
      a.href = `https://schedule.sxsw.com/2026/artists/${show.entity_id}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'btn btn--outline detail-link-btn';
      a.textContent = 'Official Page \u2197';
      linkEl.appendChild(a);
    } else if (show.website) {
      const a = document.createElement('a');
      a.href = show.website;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'btn btn--outline detail-link-btn';
      a.textContent = 'Website \u2197';
      linkEl.appendChild(a);
    }

    // Other upcoming shows for the same artist
    const otherEl = document.getElementById('detail-other-shows');
    otherEl.innerHTML = '';
    const now = new Date();
    const otherShows = allShows
      .filter(s => {
        if (s === show) return false;
        if (s.artist_name.toLowerCase() !== show.artist_name.toLowerCase()) return false;
        const start = parseShowTime(s.day, s.start_time);
        return start && start > now;
      })
      .sort((a, b) => {
        const aStart = parseShowTime(a.day, a.start_time);
        const bStart = parseShowTime(b.day, b.start_time);
        return (aStart - now) - (bStart - now);
      })
      .slice(0, 2);
    if (otherShows.length > 0) {
      const label = document.createElement('div');
      label.className = 'detail-other-label';
      label.textContent = 'Also appearing at:';
      otherEl.appendChild(label);
      otherShows.forEach(s => {
        const row = document.createElement('a');
        row.className = 'detail-other-row';
        row.href = `/schedule.html?search=${encodeURIComponent(s.venue)}&day=${encodeURIComponent(s.day)}`;
        row.innerHTML = `<span class="detail-other-venue">${escHtml(s.venue)}</span><span class="detail-other-time">${escHtml(formatDayLabel(s.day))} · ${escHtml(formatTime12(s.start_time))}</span>`;
        row.addEventListener('click', e => {
          e.preventDefault();
          closeModal('modal-show-detail');
          selectedDay = s.day;
          document.querySelectorAll('.day-tab').forEach(b =>
            b.classList.toggle('active', b.dataset.day === s.day)
          );
          searchFilter = s.venue;
          const input = document.getElementById('sched-search');
          if (input) input.value = s.venue;
          const clear = document.getElementById('sched-search-clear');
          if (clear) clear.classList.add('visible');
          selectedView = 'grid';
          localStorage.setItem('sxsw2026_last_view', 'grid');
          document.querySelectorAll('.view-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.view === 'grid')
          );
          renderCurrentView();
        });
        otherEl.appendChild(row);
      });
    }

    // Only show delete button for unofficial shows
    const deleteBtn = document.getElementById('btn-delete-show');
    deleteBtn.style.display = show.source === 'user' ? '' : 'none';

    document.getElementById('modal-show-detail').classList.add('visible');
  }

  function deleteShow(show) {
    allShows = allShows.filter(s =>
      !(s.artist_name === show.artist_name && s.venue === show.venue &&
        s.day === show.day && s.start_time === show.start_time)
    );
    // Filter from localStorage user shows
    const updated = loadUserShows().filter(s =>
      !(s.artist_name === show.artist_name && s.venue === show.venue &&
        s.day === show.day && s.start_time === show.start_time)
    );
    saveUserShows(updated);
    closeModal('modal-show-detail');
    renderCurrentView();
  }

  // ── Add Show modal ─────────────────────────────────────────────────────────

  function openAddShowModal() {
    document.getElementById('add-show-artist').value = '';
    document.getElementById('add-show-venue').value = '';
    document.getElementById('add-show-start').value = '';
    document.getElementById('add-show-end').value = '';
    document.getElementById('add-show-showcase').value = '';
    document.getElementById('add-show-website').value = '';
    document.getElementById('add-show-admission').value = 'free';
    document.getElementById('add-show-no-set-time').checked = false;
    document.getElementById('add-show-start-label').textContent = 'Start Time * (e.g. 9:30 PM or 21:30)';
    document.getElementById('modal-add-show').classList.add('visible');
    document.getElementById('add-show-artist').focus();
  }

  function setupAddShow() {
    document.getElementById('btn-cancel-add-show').addEventListener('click', () =>
      closeModal('modal-add-show')
    );

    document.getElementById('btn-save-add-show').addEventListener('click', () => {
      const artist = document.getElementById('add-show-artist').value.trim();
      const venue = document.getElementById('add-show-venue').value.trim();
      const day = document.getElementById('add-show-day').value;
      const startRaw = document.getElementById('add-show-start').value.trim();
      const endRaw = document.getElementById('add-show-end').value.trim();
      const showcase = document.getElementById('add-show-showcase').value.trim();
      const website = document.getElementById('add-show-website').value.trim();
      const admission = document.getElementById('add-show-admission').value;
      const source = document.getElementById('add-show-source').value;

      if (!artist || !venue || !day || !startRaw) {
        alert('Artist, venue, day, and start time are required.');
        return;
      }

      const startTime = parseUserTime(startRaw);
      if (!startTime) {
        alert('Could not parse start time. Try "9:30 PM" or "21:30".');
        return;
      }

      const endTime = endRaw ? parseUserTime(endRaw) : null;

      const noSetTime = document.getElementById('add-show-no-set-time').checked;

      const show = {
        id: `manual_${Date.now()}`,
        artist_name: artist,
        venue,
        day,
        start_time: startTime,
        end_time: endTime,
        no_set_time: noSetTime || false,
        admission,
        source,
        showcase,
        website: website || '',
        notes: '',
      };

      allShows.push(show);
      appendUserShows([show]);
      closeModal('modal-add-show');
      buildDayTabs();
      renderCurrentView();
    });

    document.getElementById('add-show-no-set-time').addEventListener('change', (e) => {
      document.getElementById('add-show-start-label').textContent = e.target.checked
        ? 'Event Start Time * — used for grid placement (e.g. 6:00 PM)'
        : 'Start Time * (e.g. 9:30 PM or 21:30)';
    });

    document.getElementById('modal-add-show').addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-add-show')) closeModal('modal-add-show');
    });
  }

  // ── CSV Import ─────────────────────────────────────────────────────────────

  function openImportModal() {
    document.getElementById('import-csv-file').value = '';
    document.getElementById('import-preview').textContent = '';
    document.getElementById('import-preview').classList.remove('visible');
    document.getElementById('btn-confirm-import').disabled = true;
    pendingCsvShows = [];
    document.getElementById('modal-import-csv').classList.add('visible');
  }

  function setupCsvImport() {
    document.getElementById('btn-cancel-import').addEventListener('click', () =>
      closeModal('modal-import-csv')
    );

    document.getElementById('modal-import-csv').addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-import-csv')) closeModal('modal-import-csv');
    });

    document.getElementById('import-csv-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const day = document.getElementById('import-csv-day').value;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          pendingCsvShows = parseScheduleCsv(ev.target.result, day);
          const preview = document.getElementById('import-preview');
          preview.textContent = `Parsed ${pendingCsvShows.length} shows. First 5:\n` +
            pendingCsvShows.slice(0, 5).map(s =>
              `${formatTime12(s.start_time)}  ${s.artist_name}  @  ${s.venue}`
            ).join('\n');
          preview.classList.add('visible');
          document.getElementById('btn-confirm-import').disabled = pendingCsvShows.length === 0;
        } catch (err) {
          alert('Failed to parse CSV: ' + err.message);
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('btn-confirm-import').addEventListener('click', () => {
      if (!pendingCsvShows.length) return;
      // Merge: add only shows not already in allShows
      const existingKeys = new Set(allShows.map(s =>
        `${s.artist_name}|${s.venue}|${s.day}|${s.start_time}`
      ));
      const newShows = pendingCsvShows.filter(s =>
        !existingKeys.has(`${s.artist_name}|${s.venue}|${s.day}|${s.start_time}`)
      );
      allShows.push(...newShows);
      appendUserShows(newShows);
      closeModal('modal-import-csv');
      buildDayTabs();
      populateDaySelects();
      renderCurrentView();
      alert(`Added ${newShows.length} shows (${pendingCsvShows.length - newShows.length} duplicates skipped).`);
    });
  }

  function parseScheduleCsv(csvText, day) {
    // Parse the Google Sheets "venue × time" format
    // Row 0: "Venue / Time", venue1, venue2, ...  (with > > / < < arrows)
    // Row 1: navigation hint row (skip)
    // Subsequent rows: time label in col 0 (e.g. "9:00 AM"), or empty for 2nd slot in hour
    //                  artist names (possibly "Name (315)" for specific time) in venue cols

    const rows = csvText.split(/\r?\n/).map(row => {
      // Simple CSV split (handles quoted fields)
      const result = [];
      let current = '';
      let inQuotes = false;
      for (const char of row) {
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
        else { current += char; }
      }
      result.push(current.trim());
      return result;
    });

    if (rows.length === 0) return [];

    // Extract venue names from header row, stripping directional arrows
    const venues = rows[0].slice(1).map(v =>
      v.replace(/[<>]/g, '').trim()
    );

    const shows = [];
    let currentBaseTime = null; // "HH:MM" of the current hour
    let slotOffset = 0;         // 0 = first 30-min slot, 1 = second

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every(c => !c)) continue;

      const timeLabel = (row[0] || '').trim();

      // Detect hour-marker rows: "9:00 AM", "12:00 PM", "1:00 AM", etc.
      const hourMatch = timeLabel.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (hourMatch) {
        let h = parseInt(hourMatch[1]);
        const period = hourMatch[3].toUpperCase();
        if (period === 'PM' && h !== 12) h += 12;
        if (period === 'AM' && h === 12) h = 0;
        currentBaseTime = `${String(h).padStart(2, '0')}:${hourMatch[2]}`;
        slotOffset = 0;
        continue;
      }

      // Second slot row: empty label or label that isn't a time
      if (timeLabel === '') {
        slotOffset = 1;
      }

      // Skip navigation hints and header rows
      if (timeLabel && !hourMatch && timeLabel !== '') {
        // Could be a day label like "Day 2" or a multi-venue showcase name — skip
        if (/^(day\s*\d|<|>)/i.test(timeLabel)) continue;
      }

      if (!currentBaseTime) continue;

      // Compute slot time
      const [baseH, baseM] = currentBaseTime.split(':').map(Number);
      const slotTotalMin = baseH * 60 + baseM + slotOffset * 30;
      const slotHH = Math.floor(slotTotalMin / 60) % 24;
      const slotMM = slotTotalMin % 60;
      const defaultSlotTime = `${String(slotHH).padStart(2, '0')}:${String(slotMM).padStart(2, '0')}`;

      for (let c = 1; c < row.length; c++) {
        const cell = (row[c] || '').trim();
        if (!cell) continue;

        const venue = venues[c - 1];
        if (!venue) continue;

        // Skip meta cells like "(no set times yet)" or multi-venue labels
        if (cell.startsWith('(') || /^[<>]/.test(cell) || cell.toLowerCase().includes('no set times')) continue;

        // Detect specific time in parens: "Draag (315)" → 3:15 PM
        const timeOverride = cell.match(/\((\d{3,4})\)\s*$/);
        let startTime = defaultSlotTime;
        let artistName = cell;

        if (timeOverride) {
          artistName = cell.replace(/\s*\(\d{3,4}\)\s*$/, '').trim();
          const t = timeOverride[1].padStart(4, '0');
          let h = parseInt(t.slice(0, 2));
          const m = t.slice(2);
          // Afternoon heuristic: if hour < 9, it's PM (e.g. "215" = 2:15 PM → 14:15)
          if (h < 9) h += 12;
          startTime = `${String(h).padStart(2, '0')}:${m}`;
        }

        if (!artistName) continue;

        shows.push({
          id: `csv_${Date.now()}_${shows.length}`,
          artist_name: artistName,
          venue,
          day,
          start_time: startTime,
          end_time: null,
          source: 'user',
          showcase: '',
          notes: '',
        });
      }
    }

    return shows;
  }

  // ── Show persistence (localStorage) ───────────────────────────────────────

  function appendUserShows(newShows) {
    const existing = loadUserShows();
    const existingKeys = new Set(existing.map(s =>
      `${s.artist_name}|${s.venue}|${s.day}|${s.start_time}`
    ));
    const toAdd = newShows.filter(s =>
      !existingKeys.has(`${s.artist_name}|${s.venue}|${s.day}|${s.start_time}`)
    );
    saveUserShows([...existing, ...toAdd]);
  }

  // ── Modal helpers ──────────────────────────────────────────────────────────

  function closeModal(id) {
    document.getElementById(id).classList.remove('visible');
  }

  function setupDetailModal() {
    document.getElementById('btn-close-detail').addEventListener('click', () =>
      closeModal('modal-show-detail')
    );
    document.getElementById('btn-delete-show').addEventListener('click', () => {
      if (detailShow) deleteShow(detailShow);
    });
    document.getElementById('modal-show-detail').addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-show-detail')) closeModal('modal-show-detail');
    });
  }

  // ── Theme ──────────────────────────────────────────────────────────────────

  const THEME_KEY = 'sxsw2026_theme';

  function applyTheme(mode) {
    if (mode === 'light') {
      document.body.classList.add('light');
    } else if (mode === 'dark') {
      document.body.classList.remove('light');
    } else {
      document.body.classList.toggle('light', window.matchMedia('(prefers-color-scheme: light)').matches);
    }
  }

  function setupTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'system';
    applyTheme(saved);
    updateThemeButton();

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') {
        applyTheme('system');
        updateThemeButton();
      }
    });

    document.getElementById('btn-theme').addEventListener('click', (e) => {
      const seg = e.target.closest('.theme-seg');
      if (!seg) return;
      const mode = seg.dataset.theme;
      if (mode === 'system') {
        localStorage.removeItem(THEME_KEY);
      } else {
        localStorage.setItem(THEME_KEY, mode);
      }
      applyTheme(mode);
      updateThemeButton();
      closeDrawer();
    });
  }

  function updateThemeButton() {
    const mode = localStorage.getItem(THEME_KEY) || 'system';
    document.querySelectorAll('#btn-theme .theme-seg').forEach(seg => {
      seg.classList.toggle('active', seg.dataset.theme === mode);
    });
  }

  // ── Rated-only toggle ──────────────────────────────────────────────────────

  function updateRatedOnlyButton() {
    document.querySelectorAll('#btn-rated-only .theme-seg').forEach(seg => {
      seg.classList.toggle('active', seg.dataset.filter === showFilter);
    });
  }

  function setupRatedOnly() {
    updateRatedOnlyButton();
    document.getElementById('btn-rated-only').addEventListener('click', (e) => {
      const seg = e.target.closest('.theme-seg');
      if (!seg) return;
      showFilter = seg.dataset.filter;
      updateRatedOnlyButton();
      closeDrawer();
      renderCurrentView();
    });
  }

  // ── Admission filter ───────────────────────────────────────────────────────

  function updateAdmissionButtons() {
    document.querySelectorAll('#btn-admission-filter .theme-seg').forEach(seg => {
      seg.classList.toggle('active', admissionFilter.has(seg.dataset.admission));
    });
  }

  function setupAdmissionFilter() {
    updateAdmissionButtons();
    document.getElementById('btn-admission-filter').addEventListener('click', (e) => {
      const seg = e.target.closest('.theme-seg');
      if (!seg) return;
      const type = seg.dataset.admission;
      if (admissionFilter.has(type)) {
        if (admissionFilter.size > 1) admissionFilter.delete(type); // keep at least one active
      } else {
        admissionFilter.add(type);
      }
      updateAdmissionButtons();
      renderCurrentView();
    });
  }

  // ── Search filter ──────────────────────────────────────────────────────────

  function setupSearch() {
    const input = document.getElementById('sched-search');
    const clear = document.getElementById('sched-search-clear');
    if (!input) return;
    input.addEventListener('input', () => {
      searchFilter = input.value.trim();
      clear.classList.toggle('visible', input.value.length > 0);
      renderCurrentView();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') closeDrawer();
    });
    clear.addEventListener('click', () => {
      input.value = '';
      searchFilter = '';
      clear.classList.remove('visible');
      input.focus();
      renderCurrentView();
    });
  }

  // ── Hamburger drawer ───────────────────────────────────────────────────────

  function closeDrawer() {
    document.getElementById('sched-controls')?.classList.remove('open');
    document.getElementById('hamburger-btn')?.classList.remove('open');
    document.getElementById('hamburger-backdrop')?.classList.remove('open');
  }

  function setupHamburger() {
    const btn = document.getElementById('hamburger-btn');
    const controls = document.getElementById('sched-controls');
    const backdrop = document.getElementById('hamburger-backdrop');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const isOpen = controls.classList.toggle('open');
      btn.classList.toggle('open', isOpen);
      backdrop.classList.toggle('open', isOpen);
    });
    backdrop.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  }

  // ── View nav ───────────────────────────────────────────────────────────────

  function setupViewNav() {
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.view === 'nownext') { viewNow = null; viewNowShifted = false; } // reset to system clock
        selectedView = btn.dataset.view;
        if (['nownext', 'grid', 'agenda'].includes(selectedView)) {
          localStorage.setItem('sxsw2026_last_view', selectedView);
        }
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        closeDrawer();
        renderCurrentView();
      });
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function setupAbout() {
    const overlay = document.getElementById('modal-about');
    const open = () => overlay.classList.add('visible');
    const zap  = () => {
      overlay.classList.add('zapping');
      setTimeout(() => overlay.classList.remove('visible', 'zapping'), 700);
    };
    document.getElementById('btn-about').addEventListener('click', open);
    document.getElementById('btn-about-drawer').addEventListener('click', open);
    document.getElementById('btn-close-about').addEventListener('click', zap);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('visible'); });
  }

  async function init() {
    setupTheme();
    setupViewNav();
    setupHamburger();
    setupAbout();
    setupRatedOnly();
    setupAdmissionFilter();
    setupSearch();
    setupDetailModal();
    setupAddShow();
    setupCsvImport();
    let _resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => { if (selectedView === 'grid') renderCurrentView(); }, 200);
    });
    await loadAll();
  }

  document.addEventListener('DOMContentLoaded', init);

})();
