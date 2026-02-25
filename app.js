/**
 * Fest Wizard
 * Web app for filtering, sampling, and rating festival artists.
 */

(function () {
  'use strict';

  // ---- STATE ----
  let allArtists = [];          // Full artist list (official + unofficial)
  let ratings = {};             // { artistKey: 1-4 }
  let notes = {};               // { artistKey: 'user note string' }
  let genreTiers = {};          // { genre: 'high'|'medium'|'low'|'hide' }
  let subgenreTiers = {};       // { subgenre: 'high'|'medium'|'low'|'hide' }
  let userArtists = [];         // User-submitted artists (added via form)
  let currentFilters = {
    search: '',
    rated: 'all',       // all | unrated | rated | 3+
    source: 'all',      // all | official | unofficial | user
    sort: 'name',       // name | genre | rating | country
    genre: null,        // null = all genres
    subgenre: null,     // null = all subgenres
  };

  // ---- STORAGE ----
  const STATE_KEY = 'sxsw2026_state';
  const STORAGE_KEYS = {
    theme: 'sxsw2026_theme',
  };

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.ratings) ratings = data.ratings;
        if (data.notes) notes = data.notes;
        if (data.genreTiers) genreTiers = data.genreTiers;
        if (data.subgenreTiers) subgenreTiers = data.subgenreTiers;
        if (data.userArtists) userArtists = data.userArtists;
        // Migrate 'skip' → 'hide' tier value
        let migrated = false;
        for (const k in genreTiers)    { if (genreTiers[k]    === 'skip') { genreTiers[k]    = 'hide'; migrated = true; } }
        for (const k in subgenreTiers) { if (subgenreTiers[k] === 'skip') { subgenreTiers[k] = 'hide'; migrated = true; } }
        if (migrated) saveToLocalStorage();
      } else {
        // One-time migration from pre-consolidation individual keys
        migrateOldStorageKeys();
      }
    } catch (e) {
      console.warn('Error loading state:', e);
    }
  }

  function migrateOldStorageKeys() {
    const oldRatings = localStorage.getItem('sxsw2026_ratings');
    if (!oldRatings) return; // nothing to migrate
    try {
      ratings     = JSON.parse(oldRatings) || {};
      notes       = JSON.parse(localStorage.getItem('sxsw2026_notes')        || '{}');
      genreTiers  = JSON.parse(localStorage.getItem('sxsw2026_genreTiers')   || '{}');
      subgenreTiers = JSON.parse(localStorage.getItem('sxsw2026_subgenreTiers') || '{}');
      saveToLocalStorage();
      console.log(`Migrated ${Object.keys(ratings).length} ratings from old storage keys.`);
    } catch (e) {
      console.warn('Migration from old storage keys failed:', e);
    }
  }

  function saveToLocalStorage() {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      ratings,
      notes,
      genreTiers,
      subgenreTiers,
      userArtists: userArtists,
    }));
  }

  function saveAll() {
    saveToLocalStorage();
  }

  function saveRatings() { saveAll(); }
  function saveNotes() { saveAll(); }
  function saveGenreTiers() { saveAll(); }
  function saveSubgenreTiers() { saveAll(); }

  // ---- ARTIST KEY ----
  function artistKey(artist) {
    // Use entity_id for official artists, name-based key for unofficial
    if (artist.entity_id) return 'eid_' + artist.entity_id;
    return 'name_' + artist.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  }

  // ---- LINK DISPLAY ORDER ----
  const LINK_ORDER = ['bandcamp', 'youtube', 'apple_music', 'soundcloud', 'spotify', 'website', 'sxsw'];
  const LINK_LABELS = {
    bandcamp: 'Bandcamp',
    youtube: 'YouTube',
    apple_music: 'Apple Music',
    soundcloud: 'SoundCloud',
    spotify: 'Spotify',
    website: 'Website',
    sxsw: 'Official',
  };

  // ---- DATA LOADING ----
  async function loadArtists() {
    try {
      const ts = '?_=' + Date.now();
      const [artistsResp, unofficialResp] = await Promise.all([
        fetch('artists.json' + ts),
        fetch('unofficial_artists.json' + ts),
      ]);
      if (!artistsResp.ok) throw new Error(`HTTP ${artistsResp.status}`);
      const data = await artistsResp.json();
      allArtists = Array.isArray(data) ? data : [];

      // Merge developer-curated unofficial artists from static file
      if (unofficialResp.ok) {
        const uData = await unofficialResp.json();
        if (Array.isArray(uData)) {
          for (const ua of uData) {
            const exists = allArtists.some(
              a => a.name.toLowerCase() === ua.name.toLowerCase() && a.source === 'unofficial'
            );
            if (!exists) allArtists.push(ua);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load artists.json:', e);
      allArtists = [];
      document.getElementById('loading').innerHTML =
        'Could not load artists.json. Run a local server:<br><br>' +
        '<code style="color:var(--accent)">cd "' + window.location.pathname.replace(/\/[^/]*$/, '') +
        '" && python3 -m http.server 8000</code><br><br>' +
        'Then open <a href="http://localhost:8000" style="color:var(--accent)">http://localhost:8000</a>';
      document.getElementById('loading').style.display = 'block';
    }

    // Merge user-submitted artists from localStorage state
    for (const ua of userArtists) {
      const exists = allArtists.some(
        a => a.name.toLowerCase() === ua.name.toLowerCase() && a.source === 'unofficial'
      );
      if (!exists) allArtists.push(ua);
    }

    document.getElementById('loading').style.display = 'none';
    buildGenreList();
    buildSubgenreList();
    renderArtists();
    updateStats();
  }

  // ---- GENRE LIST ----
  function getGenres() {
    const counts = {};
    for (const a of allArtists) {
      const g = a.genre || 'Unknown';
      counts[g] = (counts[g] || 0) + 1;
    }
    const tierOrder = { high: 0, medium: 1, low: 2, hide: 3 };
    return Object.entries(counts).sort((a, b) => {
      const ta = tierOrder[genreTiers[a[0]]] ?? 99;
      const tb = tierOrder[genreTiers[b[0]]] ?? 99;
      if (ta !== tb) return ta - tb;
      return b[1] - a[1];
    });
  }

  function buildGenreList() {
    const list = document.getElementById('genre-list');
    const genres = getGenres();

    list.innerHTML = '';

    // "All genres" option
    const allItem = document.createElement('li');
    allItem.className = 'genre-item';
    allItem.innerHTML = `
      <span class="genre-item__tier genre-item__tier--none"></span>
      <span class="genre-item__name" style="font-weight:600">All Genres</span>
      <span class="genre-item__count">${allArtists.length}</span>
    `;
    allItem.addEventListener('click', () => {
      currentFilters.genre = null;
      buildGenreList();
      renderArtists();
      updateStats();
    });
    if (currentFilters.genre === null) {
      allItem.style.color = 'var(--accent)';
    }
    list.appendChild(allItem);

    for (const [genre, count] of genres) {
      const tier = genreTiers[genre] || 'none';
      const li = document.createElement('li');
      li.className = 'genre-item';
      li.innerHTML = `
        <span class="genre-item__tier genre-item__tier--${tier}"></span>
        <span class="genre-item__name">${escHtml(genre)}</span>
        <span class="genre-item__count">${count}</span>
      `;
      if (currentFilters.genre === genre) {
        li.style.color = 'var(--accent)';
      }
      li.addEventListener('click', () => {
        currentFilters.genre = currentFilters.genre === genre ? null : genre;
        buildGenreList();
        renderArtists();
        updateStats();
      });
      list.appendChild(li);
    }
  }

  // ---- SUBGENRE LIST ----
  function getSubgenres() {
    const counts = {};
    for (const a of allArtists) {
      const sg = a.subgenre;
      if (sg) {
        counts[sg] = (counts[sg] || 0) + 1;
      }
    }
    const tierOrder = { high: 0, medium: 1, low: 2, hide: 3 };
    return Object.entries(counts).sort((a, b) => {
      const ta = tierOrder[subgenreTiers[a[0]]] ?? 99;
      const tb = tierOrder[subgenreTiers[b[0]]] ?? 99;
      if (ta !== tb) return ta - tb;
      return b[1] - a[1];
    });
  }

  function buildSubgenreList() {
    const list = document.getElementById('subgenre-list');
    const subgenres = getSubgenres();

    list.innerHTML = '';

    // "All subgenres" option
    const allItem = document.createElement('li');
    allItem.className = 'genre-item';
    allItem.innerHTML = `
      <span class="genre-item__tier genre-item__tier--none"></span>
      <span class="genre-item__name" style="font-weight:600">All Subgenres</span>
      <span class="genre-item__count">${allArtists.filter(a => a.subgenre).length}</span>
    `;
    allItem.addEventListener('click', () => {
      currentFilters.subgenre = null;
      buildSubgenreList();
      renderArtists();
      updateStats();
    });
    if (currentFilters.subgenre === null) {
      allItem.style.color = 'var(--accent)';
    }
    list.appendChild(allItem);

    for (const [subgenre, count] of subgenres) {
      const tier = subgenreTiers[subgenre] || 'none';
      const li = document.createElement('li');
      li.className = 'genre-item';
      li.innerHTML = `
        <span class="genre-item__tier genre-item__tier--${tier}"></span>
        <span class="genre-item__name">${escHtml(subgenre)}</span>
        <span class="genre-item__count">${count}</span>
      `;
      if (currentFilters.subgenre === subgenre) {
        li.style.color = 'var(--accent)';
      }
      li.addEventListener('click', () => {
        currentFilters.subgenre = currentFilters.subgenre === subgenre ? null : subgenre;
        buildSubgenreList();
        renderArtists();
        updateStats();
      });
      list.appendChild(li);
    }
  }

  // ---- FILTERING & SORTING ----
  function getFilteredArtists() {
    let list = allArtists;

    // Genre filter
    if (currentFilters.genre) {
      list = list.filter(a => a.genre === currentFilters.genre);
    }

    // Subgenre filter
    if (currentFilters.subgenre) {
      list = list.filter(a => a.subgenre === currentFilters.subgenre);
    }

    // Hide "hide" tier genres (unless a specific genre is selected, or searching)
    if (!currentFilters.genre && !currentFilters.search) {
      list = list.filter(a => genreTiers[a.genre] !== 'hide');
    }

    // Hide "hide" tier subgenres (unless a specific subgenre is selected, or searching)
    if (!currentFilters.subgenre && !currentFilters.search) {
      list = list.filter(a => !a.subgenre || subgenreTiers[a.subgenre] !== 'hide');
    }

    // Search
    if (currentFilters.search) {
      const q = currentFilters.search.toLowerCase();
      list = list.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.genre || '').toLowerCase().includes(q) ||
        (a.subgenre || '').toLowerCase().includes(q) ||
        (a.location || '').toLowerCase().includes(q) ||
        (a.country || '').toLowerCase().includes(q) ||
        (a.city || '').toLowerCase().includes(q)
      );
    }

    // Rated filter
    if (currentFilters.rated === 'unrated') {
      list = list.filter(a => !ratings[artistKey(a)]);
    } else if (currentFilters.rated === 'rated') {
      list = list.filter(a => ratings[artistKey(a)]);
    } else if (currentFilters.rated === '3+') {
      list = list.filter(a => (ratings[artistKey(a)] || 0) >= 3);
    }

    // Source filter
    if (currentFilters.source === 'official') {
      list = list.filter(a => !a.source || a.source === 'official');
    } else if (currentFilters.source === 'unofficial') {
      list = list.filter(a => a.source === 'unofficial');
    } else if (currentFilters.source === 'user') {
      list = list.filter(a => a.source === 'user');
    }

    // Sorting
    const tierOrder = { high: 0, medium: 1, low: 2, none: 3, hide: 4 };

    list = [...list].sort((a, b) => {
      switch (currentFilters.sort) {
        case 'subgenre': {
          // Primary: subgenre tier, secondary: subgenre name, tertiary: artist name
          const stA = tierOrder[subgenreTiers[a.subgenre] || 'none'];
          const stB = tierOrder[subgenreTiers[b.subgenre] || 'none'];
          if (stA !== stB) return stA - stB;
          return (a.subgenre || '').localeCompare(b.subgenre || '') || a.name.localeCompare(b.name);
        }
        case 'rating':
          // Primary: rating (highest first), secondary: artist name
          return (ratings[artistKey(b)] || 0) - (ratings[artistKey(a)] || 0) || a.name.localeCompare(b.name);
        case 'country':
          return (a.country || '').localeCompare(b.country || '') || a.name.localeCompare(b.name);
        case 'genre': {
          // Primary: genre tier, secondary: genre name, tertiary: artist name
          const gtA = tierOrder[genreTiers[a.genre] || 'none'];
          const gtB = tierOrder[genreTiers[b.genre] || 'none'];
          if (gtA !== gtB) return gtA - gtB;
          return (a.genre || '').localeCompare(b.genre || '') || a.name.localeCompare(b.name);
        }
        default: {
          // Name sort: use genre tier as primary so high-priority genres appear first
          const gtA = tierOrder[genreTiers[a.genre] || 'none'];
          const gtB = tierOrder[genreTiers[b.genre] || 'none'];
          if (gtA !== gtB) return gtA - gtB;
          return a.name.localeCompare(b.name);
        }
      }
    });

    return list;
  }

  // ---- RENDERING ----
  function renderArtists() {
    const main = document.getElementById('main-content');
    const filtered = getFilteredArtists();

    // Clear old content (keep loading div hidden)
    const loading = document.getElementById('loading');
    main.innerHTML = '';
    main.appendChild(loading);

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'loading';
      empty.textContent = 'No artists match the current filters.';
      main.appendChild(empty);
      document.getElementById('stat-showing').textContent = '0';
      return;
    }

    document.getElementById('stat-showing').textContent = filtered.length;

    const sort = currentFilters.sort;
    if (sort === 'rating') {
      renderGroupedByRating(main, filtered);
    } else if (sort === 'genre') {
      renderGrouped(main, filtered, 'genre');
    } else if (sort === 'subgenre') {
      renderGrouped(main, filtered, 'subgenre');
    } else {
      const grid = document.createElement('div');
      grid.className = 'artist-grid';
      for (const artist of filtered) {
        grid.appendChild(createArtistCard(artist));
      }
      main.appendChild(grid);
    }
  }

  function renderGrouped(main, artists, groupBy) {
    const field = groupBy || 'genre';
    const groups = {};
    for (const a of artists) {
      const g = (field === 'subgenre' ? a.subgenre : a.genre) || 'Unknown';
      if (!groups[g]) groups[g] = [];
      groups[g].push(a);
    }

    for (const [groupName, items] of Object.entries(groups)) {
      const section = document.createElement('div');
      section.className = 'genre-section';

      const ratedCount = items.filter(a => ratings[artistKey(a)]).length;

      const header = document.createElement('div');
      header.className = 'genre-section__header';
      header.innerHTML = `
        <span class="genre-section__title">${escHtml(groupName)}</span>
        <span class="genre-section__count">${items.length} artists</span>
        <span class="genre-section__progress">${ratedCount}/${items.length} rated</span>
      `;

      const grid = document.createElement('div');
      grid.className = 'artist-grid';
      for (const artist of items) {
        grid.appendChild(createArtistCard(artist));
      }

      section.appendChild(header);
      section.appendChild(grid);
      main.appendChild(section);
    }
  }

  function renderGroupedByRating(main, artists) {
    const ratingMeta = [
      { r: 4, label: '4 \u2013 Hell yeah' },
      { r: 3, label: '3 \u2013 Psyched' },
      { r: 2, label: '2 \u2013 Sure' },
      { r: 1, label: '1 \u2013 Nope' },
      { r: 0, label: 'Unrated' },
    ];
    const groups = { 4: [], 3: [], 2: [], 1: [], 0: [] };
    for (const a of artists) {
      const r = ratings[artistKey(a)] || 0;
      groups[r].push(a);
    }
    for (const { r, label } of ratingMeta) {
      const items = groups[r];
      if (items.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'genre-section';

      const header = document.createElement('div');
      header.className = 'genre-section__header';
      header.innerHTML = `
        <span class="genre-section__title">${label}</span>
        <span class="genre-section__count">${items.length} artist${items.length !== 1 ? 's' : ''}</span>
      `;

      const grid = document.createElement('div');
      grid.className = 'artist-grid';
      for (const artist of items) {
        grid.appendChild(createArtistCard(artist));
      }

      section.appendChild(header);
      section.appendChild(grid);
      main.appendChild(section);
    }
  }

  function createArtistCard(artist) {
    const key = artistKey(artist);
    const rating = ratings[key] || 0;

    const card = document.createElement('div');
    card.className = 'artist-card';

    if (rating === 0) {
      card.classList.add('artist-card--unrated');
    } else {
      card.classList.add(`artist-card--rated-${rating}`);
    }

    const location = artist.location || [artist.city, artist.state, artist.country].filter(Boolean).join(', ');
    const genreDisplay = [artist.genre, artist.subgenre].filter(Boolean).join(' / ');
    const desc = artist.description || '';
    const descShort = desc.length > 200 ? desc.substring(0, 200) + '...' : desc;

    // Build links HTML — include SXSW detail page link if available
    const linksObj = { ...(artist.links || {}) };
    if (artist.detail_url) {
      linksObj.sxsw = artist.detail_url;
    }
    let linksHtml = '';
    for (const type of LINK_ORDER) {
      if (linksObj[type]) {
        const label = LINK_LABELS[type] || type;
        linksHtml += `<a href="${escAttr(linksObj[type])}" target="_blank" rel="noopener" class="music-link music-link--${type}">${label}</a>`;
      }
    }

    // Source badge — shown for all artists
    const badgeClass = artist.source === 'unofficial' ? 'unofficial'
      : artist.source === 'user' ? 'user'
      : 'official';
    const badgeLabel = artist.source === 'unofficial' ? 'Unofficial'
      : artist.source === 'user' ? 'User-Submitted'
      : 'Official';
    const badge = `<span class="artist-card__badge artist-card__badge--${badgeClass}">${badgeLabel}</span>`;

    card.innerHTML = `
      ${badge}
      <div class="artist-card__header">
        <div class="artist-card__name">${escHtml(artist.name)}</div>
      </div>
      <div class="artist-card__meta">
        ${genreDisplay ? `<span class="artist-card__genre">${escHtml(genreDisplay)}</span>` : ''}
        ${location ? `${genreDisplay ? ' &middot; ' : ''}${escHtml(location)}` : ''}
      </div>
      <div class="artist-card__body">
        ${descShort ? `<div class="artist-card__desc">${escHtml(descShort)}</div>` : ''}
        ${linksHtml ? `<div class="artist-card__links">${linksHtml}</div>` : ''}
        <div class="rating-bar">
          <button class="rating-btn rating-btn--1 ${rating === 1 ? 'active' : ''}" data-rating="1">1 Nope</button>
          <button class="rating-btn rating-btn--2 ${rating === 2 ? 'active' : ''}" data-rating="2">2 Sure</button>
          <button class="rating-btn rating-btn--3 ${rating === 3 ? 'active' : ''}" data-rating="3">3 Psyched</button>
          <button class="rating-btn rating-btn--4 ${rating === 4 ? 'active' : ''}" data-rating="4">4 Hell yeah</button>
        </div>
        <div class="artist-card__notes">
          <input type="text" class="notes-input" placeholder="Describe it..." value="${escAttr(notes[key] || '')}" data-key="${escAttr(key)}">
        </div>
      </div>
    `;

    // Notes handler
    const notesInput = card.querySelector('.notes-input');
    notesInput.addEventListener('input', () => {
      const val = notesInput.value;
      if (val) {
        notes[key] = val;
      } else {
        delete notes[key];
      }
      saveNotes();
    });

    // Rating button handlers
    card.querySelectorAll('.rating-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newRating = parseInt(btn.dataset.rating);

        // Toggle off if clicking the same rating
        if (ratings[key] === newRating) {
          delete ratings[key];
        } else {
          ratings[key] = newRating;
        }

        saveRatings();
        updateCardStyle(card, key);
        updateStats();
      });
    });

    return card;
  }

  function updateCardStyle(card, key) {
    const rating = ratings[key] || 0;

    // Remove all rating classes
    card.classList.remove('artist-card--unrated', 'artist-card--rated-1', 'artist-card--rated-2', 'artist-card--rated-3', 'artist-card--rated-4');

    if (rating === 0) {
      card.classList.add('artist-card--unrated');
    } else {
      card.classList.add(`artist-card--rated-${rating}`);
    }

    // Update button active states
    card.querySelectorAll('.rating-btn').forEach(btn => {
      const r = parseInt(btn.dataset.rating);
      btn.classList.toggle('active', r === rating);
    });
  }

  // ---- STATS ----
  function updateStats() {
    const total = allArtists.length;
    const ratedCount = allArtists.filter(a => ratings[artistKey(a)]).length;

    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-rated').textContent = ratedCount;
    document.getElementById('stat-remaining').textContent = total - ratedCount;
  }

  // ---- FILTER UI ----
  function setupCollapsibles() {
    document.querySelectorAll('.sidebar__heading--toggle').forEach(heading => {
      heading.classList.add('collapsed');
      heading.addEventListener('click', () => {
        heading.classList.toggle('collapsed');
      });
    });
  }

  function setupFilters() {
    // Search
    document.getElementById('search-input').addEventListener('input', (e) => {
      currentFilters.search = e.target.value;
      renderArtists();
    });

    // Rated filter
    setupFilterGroup('filter-rated', 'rated', 'filter');

    // Source filter
    setupFilterGroup('filter-source', 'source', 'filter');

    // Sort
    setupFilterGroup('filter-sort', 'sort', 'sort');
  }

  function setupFilterGroup(containerId, filterKey, attrName) {
    const container = document.getElementById(containerId);
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;

      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      currentFilters[filterKey] = btn.dataset[attrName];
      renderArtists();
      updateStats();
    });
  }

  // ---- ADD ARTIST MODAL ----
  function setupAddArtist() {
    const modal = document.getElementById('modal-add-artist');

    document.getElementById('btn-add-artist').addEventListener('click', () => {
      modal.classList.add('visible');
    });

    document.getElementById('btn-cancel-add').addEventListener('click', () => {
      modal.classList.remove('visible');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('visible');
    });

    document.getElementById('btn-save-add').addEventListener('click', () => {
      const name = document.getElementById('add-name').value.trim();
      if (!name) {
        alert('Artist name is required.');
        return;
      }

      const links = {};
      const linkFields = [
        ['add-bandcamp', 'bandcamp'],
        ['add-youtube', 'youtube'],
        ['add-apple-music', 'apple_music'],
        ['add-soundcloud', 'soundcloud'],
        ['add-spotify', 'spotify'],
        ['add-website', 'website'],
      ];
      for (const [id, key] of linkFields) {
        const val = document.getElementById(id).value.trim();
        if (val) links[key] = val;
      }

      const artist = {
        name: name,
        genre: document.getElementById('add-genre').value.trim() || 'Unknown',
        subgenre: document.getElementById('add-subgenre').value.trim() || '',
        location: document.getElementById('add-location').value.trim() || '',
        description: document.getElementById('add-description').value.trim() || '',
        links: links,
        source: 'user',
        city: '',
        country: '',
        state: '',
        entity_id: null,
        detail_url: '',
        events_raw: [],
      };

      allArtists.push(artist);
      userArtists.push(artist);
      saveAll();

      // Clear form
      modal.querySelectorAll('input, textarea').forEach(el => el.value = '');
      modal.classList.remove('visible');

      buildGenreList();
      renderArtists();
      updateStats();
    });
  }

  // ---- GENRE TIERS MODAL ----
  function setupGenreTiers() {
    const modal = document.getElementById('modal-genre-tiers');

    document.getElementById('btn-genre-tiers').addEventListener('click', () => {
      renderTierList();
      modal.classList.add('visible');
    });

    document.getElementById('btn-close-tiers').addEventListener('click', () => {
      modal.classList.remove('visible');
      buildGenreList();
      renderArtists();
      updateStats();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('visible');
        buildGenreList();
        renderArtists();
        updateStats();
      }
    });
  }

  function renderTierList() {
    const container = document.getElementById('genre-tier-list');
    const genres = getGenres();
    container.innerHTML = '';

    for (const [genre, count] of genres) {
      const tier = genreTiers[genre] || '';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border);';
      row.innerHTML = `
        <span style="flex:1; font-size:14px;">${escHtml(genre)} <span style="color:var(--text-muted); font-size:12px;">(${count})</span></span>
        <div class="tier-selector">
          <button class="tier-btn ${tier === 'high' ? 'active--high' : ''}" data-tier="high">High</button>
          <button class="tier-btn ${tier === 'medium' ? 'active--medium' : ''}" data-tier="medium">Medium</button>
          <button class="tier-btn ${tier === 'low' ? 'active--low' : ''}" data-tier="low">Low</button>
          <button class="tier-btn ${tier === 'hide' ? 'active--hide' : ''}" data-tier="hide">Hide</button>
        </div>
      `;

      row.querySelectorAll('.tier-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const newTier = btn.dataset.tier;
          if (genreTiers[genre] === newTier) {
            delete genreTiers[genre];
          } else {
            genreTiers[genre] = newTier;
          }
          saveGenreTiers();
          renderTierList();
          buildGenreList();
        });
      });

      container.appendChild(row);
    }
  }

  // ---- SUBGENRE TIERS ----
  function setupSubgenreTiers() {
    const modal = document.getElementById('modal-subgenre-tiers');

    document.getElementById('btn-subgenre-tiers').addEventListener('click', () => {
      renderSubgenreTierList();
      modal.classList.add('visible');
    });

    document.getElementById('btn-close-subgenre-tiers').addEventListener('click', () => {
      modal.classList.remove('visible');
      buildSubgenreList();
      renderArtists();
      updateStats();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('visible');
        buildSubgenreList();
        renderArtists();
        updateStats();
      }
    });
  }

  function renderSubgenreTierList() {
    const container = document.getElementById('subgenre-tier-list');
    const subgenres = getSubgenres();
    container.innerHTML = '';

    for (const [subgenre, count] of subgenres) {
      const tier = subgenreTiers[subgenre] || '';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border);';
      row.innerHTML = `
        <span style="flex:1; font-size:14px;">${escHtml(subgenre)} <span style="color:var(--text-muted); font-size:12px;">(${count})</span></span>
        <div class="tier-selector">
          <button class="tier-btn ${tier === 'high' ? 'active--high' : ''}" data-tier="high">High</button>
          <button class="tier-btn ${tier === 'medium' ? 'active--medium' : ''}" data-tier="medium">Medium</button>
          <button class="tier-btn ${tier === 'low' ? 'active--low' : ''}" data-tier="low">Low</button>
          <button class="tier-btn ${tier === 'hide' ? 'active--hide' : ''}" data-tier="hide">Hide</button>
        </div>
      `;

      row.querySelectorAll('.tier-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const newTier = btn.dataset.tier;
          if (subgenreTiers[subgenre] === newTier) {
            delete subgenreTiers[subgenre];
          } else {
            subgenreTiers[subgenre] = newTier;
          }
          saveSubgenreTiers();
          renderSubgenreTierList();
          buildSubgenreList();
        });
      });

      container.appendChild(row);
    }
  }

  // ---- EXPORT / IMPORT ----
  function setupExportImport() {
    const exportModal = document.getElementById('modal-export-choice');

    function closeExportModal() { exportModal.classList.remove('visible'); }

    document.getElementById('btn-export').addEventListener('click', () => {
      exportModal.classList.add('visible');
    });

    document.getElementById('btn-cancel-export').addEventListener('click', closeExportModal);
    exportModal.addEventListener('click', (e) => { if (e.target === exportModal) closeExportModal(); });

    document.getElementById('btn-export-all').addEventListener('click', () => {
      closeExportModal();
      const data = {
        exportDate: new Date().toISOString(),
        ratings: ratings,
        notes: notes,
        genreTiers: genreTiers,
        subgenreTiers: subgenreTiers,
        userArtists: userArtists,
      };
      downloadJson(data, 'festwiz_backup.json');
    });

    document.getElementById('btn-export-shortlist').addEventListener('click', () => {
      closeExportModal();
      const shortlist = allArtists
        .filter(a => (ratings[artistKey(a)] || 0) >= 3)
        .map(a => {
          const linksObj = { ...(a.links || {}) };
          if (a.detail_url) linksObj.sxsw = a.detail_url;
          let url = '';
          for (const type of LINK_ORDER) {
            if (linksObj[type]) { url = linksObj[type]; break; }
          }
          return { name: a.name, url, rating: ratings[artistKey(a)] };
        })
        .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));

      const csvRows = [['Artist', 'URL']].concat(
        shortlist.map(({ name, url }) => [name, url])
      );
      const csv = csvRows.map(row =>
        row.map(cell => {
          const s = String(cell ?? '');
          return (s.includes(',') || s.includes('"') || s.includes('\n'))
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
        }).join(',')
      ).join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'festwiz_shortlist.csv';
      a.click();
      URL.revokeObjectURL(blobUrl);
    });

    document.getElementById('btn-import').addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });

    document.getElementById('import-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.ratings) {
            ratings = { ...ratings, ...data.ratings };
            saveRatings();
          }
          if (data.notes) {
            notes = { ...notes, ...data.notes };
            saveNotes();
          }
          if (data.genreTiers) {
            genreTiers = { ...genreTiers, ...data.genreTiers };
            saveGenreTiers();
          }
          if (data.subgenreTiers) {
            subgenreTiers = { ...subgenreTiers, ...data.subgenreTiers };
            saveSubgenreTiers();
          }
          // Support both new 'userArtists' key and legacy 'unofficialArtists' key from old backups
          const importedUserArtists = data.userArtists || data.unofficialArtists;
          if (importedUserArtists && Array.isArray(importedUserArtists)) {
            for (const ua of importedUserArtists) {
              const exists = userArtists.some(
                u => u.name.toLowerCase() === ua.name.toLowerCase()
              );
              if (!exists) {
                userArtists.push(ua);
                allArtists.push(ua);
              }
            }
          }
          buildGenreList();
          buildSubgenreList();
          renderArtists();
          updateStats();
          alert('Import successful!');
        } catch (err) {
          alert('Error importing file: ' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- HELPERS ----
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- THEME ----
  function applyTheme(mode) {
    if (mode === 'light') {
      document.body.classList.add('light');
    } else if (mode === 'dark') {
      document.body.classList.remove('light');
    } else {
      // system: follow prefers-color-scheme
      document.body.classList.toggle('light', window.matchMedia('(prefers-color-scheme: light)').matches);
    }
  }

  function setupTheme() {
    const saved = localStorage.getItem(STORAGE_KEYS.theme) || 'system';
    applyTheme(saved);
    updateThemeButton();

    // Keep system mode in sync if OS theme changes
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if ((localStorage.getItem(STORAGE_KEYS.theme) || 'system') === 'system') {
        applyTheme('system');
        updateThemeButton();
      }
    });

    document.getElementById('btn-theme').addEventListener('click', (e) => {
      const seg = e.target.closest('.theme-seg');
      if (!seg) return;
      const mode = seg.dataset.theme;
      if (mode === 'system') {
        localStorage.removeItem(STORAGE_KEYS.theme);
      } else {
        localStorage.setItem(STORAGE_KEYS.theme, mode);
      }
      applyTheme(mode);
      updateThemeButton();
    });
  }

  function updateThemeButton() {
    const mode = localStorage.getItem(STORAGE_KEYS.theme) || 'system';
    document.querySelectorAll('#btn-theme .theme-seg').forEach(seg => {
      seg.classList.toggle('active', seg.dataset.theme === mode);
    });
  }

  // ---- URL SHARE ----
  async function encodeStateForUrl(state) {
    const json = JSON.stringify(state);
    try {
      const stream = new CompressionStream('gzip');
      const writer = stream.writable.getWriter();
      writer.write(new TextEncoder().encode(json));
      writer.close();
      const buf = await new Response(stream.readable).arrayBuffer();
      return btoa(String.fromCharCode(...new Uint8Array(buf)));
    } catch {
      return btoa(encodeURIComponent(json));
    }
  }

  async function decodeStateFromUrl(encoded) {
    try {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const stream = new DecompressionStream('gzip');
      const writer = stream.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const buf = await new Response(stream.readable).arrayBuffer();
      return JSON.parse(new TextDecoder().decode(buf));
    } catch {
      try {
        return JSON.parse(decodeURIComponent(atob(encoded)));
      } catch {
        return null;
      }
    }
  }

  function checkSearchParam() {
    const params = new URLSearchParams(window.location.search);
    const search = params.get('search');
    if (!search) return;
    currentFilters.search = search;
    const input = document.getElementById('search-input');
    if (input) input.value = search;
    history.replaceState({}, '', window.location.pathname);
  }

  async function checkUrlImport() {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get('import');
    if (!encoded) return;

    const data = await decodeStateFromUrl(encoded);
    history.replaceState({}, '', window.location.pathname);
    if (!data) return;

    const incomingCount = data.ratings ? Object.keys(data.ratings).filter(k => data.ratings[k] > 0).length : 0;
    if (!confirm(`Import shared ratings? (${incomingCount} ratings) — This will merge with your existing data.`)) return;

    if (data.ratings) ratings = { ...ratings, ...data.ratings };
    if (data.notes) notes = { ...notes, ...data.notes };
    if (data.genreTiers) genreTiers = { ...genreTiers, ...data.genreTiers };
    if (data.subgenreTiers) subgenreTiers = { ...subgenreTiers, ...data.subgenreTiers };
    saveAll();
  }

  function setupShare() {
    const btn = document.getElementById('btn-share');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const state = { ratings, notes, genreTiers, subgenreTiers };
      const encoded = await encodeStateForUrl(state);
      const url = `${window.location.origin}${window.location.pathname}?import=${encodeURIComponent(encoded)}`;
      const ratingCount = Object.keys(ratings).filter(k => ratings[k] > 0).length;
      try {
        await navigator.clipboard.writeText(url);
        alert(`Share URL copied! (${ratingCount} ratings)`);
      } catch {
        prompt(`Share URL (${ratingCount} ratings) — copy this:`, url);
      }
    });
  }

  // ---- ARTIST PAGE HAMBURGER ----
  function setupArtistHamburger() {
    const btn = document.getElementById('artist-hamburger-btn');
    const controls = document.querySelector('.artist-controls');
    const backdrop = document.getElementById('artist-drawer-backdrop');
    if (!btn || !controls || !backdrop) return;

    function closeArtistDrawer() {
      controls.classList.remove('open');
      btn.classList.remove('open');
      backdrop.classList.remove('open');
    }

    btn.addEventListener('click', () => {
      const isOpen = controls.classList.contains('open');
      if (isOpen) {
        closeArtistDrawer();
      } else {
        controls.classList.add('open');
        btn.classList.add('open');
        backdrop.classList.add('open');
      }
    });

    backdrop.addEventListener('click', closeArtistDrawer);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeArtistDrawer();
    });
  }

  // ---- ANNOUNCEMENTS ----
  function setupAnnouncements(announcements) {
    if (!announcements || announcements.length === 0) return;

    const modal    = document.getElementById('modal-announcements');
    const titleEl  = document.getElementById('ann-title');
    const dateEl   = document.getElementById('ann-date');
    const bodyEl   = document.getElementById('ann-body');
    const counter  = document.getElementById('ann-counter');
    const prevBtn  = document.getElementById('ann-prev');
    const nextBtn  = document.getElementById('ann-next');
    const closeBtn = document.getElementById('ann-close');
    let idx = 0;

    function render(i) {
      idx = i;
      const ann = announcements[i];
      titleEl.textContent = ann.title || '';
      dateEl.textContent  = ann.date  || '';
      bodyEl.innerHTML    = ann.body  || '';
      counter.textContent = `${i + 1} / ${announcements.length}`;
      prevBtn.disabled    = i === 0;
      nextBtn.disabled    = i === announcements.length - 1;
    }

    prevBtn.addEventListener('click', () => { if (idx > 0) render(idx - 1); });
    nextBtn.addEventListener('click', () => { if (idx < announcements.length - 1) render(idx + 1); });

    function close() {
      modal.classList.remove('visible');
      localStorage.setItem('fw_announcement_seen', announcements[0].id);
    }
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    if (localStorage.getItem('fw_announcement_seen') !== announcements[0].id) {
      render(0);
      modal.classList.add('visible');
    }
  }

  // ---- TUTORIAL ----
  function setupTutorial(announcements) {
    const modal    = document.getElementById('modal-tutorial');
    const closeBtn = document.getElementById('btn-close-tutorial');
    const helpBtn  = document.getElementById('btn-help');

    function markSeen() {
      localStorage.setItem('fw_tutorial_seen', '1');
      // First-time users: mark all current announcements as seen so they
      // don't immediately get an announcement popup after the tutorial.
      if (announcements && announcements.length > 0 && !localStorage.getItem('fw_announcement_seen')) {
        localStorage.setItem('fw_announcement_seen', announcements[0].id);
      }
    }

    function close() {
      modal.classList.remove('visible');
      markSeen();
    }

    closeBtn.addEventListener('click', () => {
      modal.classList.add('zapping');
      setTimeout(() => {
        modal.classList.remove('visible', 'zapping');
        markSeen();
      }, 700);
    });

    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    helpBtn.addEventListener('click', () => modal.classList.add('visible'));

    if (!localStorage.getItem('fw_tutorial_seen')) {
      modal.classList.add('visible');
    }
  }

  // ---- INIT ----
  async function init() {
    loadFromLocalStorage();
    await checkUrlImport();
    setupTheme();
    setupArtistHamburger();
    setupCollapsibles();
    setupFilters();
    checkSearchParam();
    setupAddArtist();
    setupGenreTiers();
    setupSubgenreTiers();
    setupExportImport();
    setupShare();
    const announcements = await fetch('announcements.json').then(r => r.json()).catch(() => []);
    setupTutorial(announcements);
    if (localStorage.getItem('fw_tutorial_seen')) {
      setupAnnouncements(announcements);
    }
    loadArtists();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
