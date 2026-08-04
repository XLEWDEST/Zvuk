const { invoke } = window.__TAURI__.core;
const opener = window.__TAURI__.opener;

let _actEmitting = false;
['mousemove', 'click', 'keydown', 'wheel', 'touchstart'].forEach((evt) => {
  document.addEventListener(
    evt,
    () => {
      if (_actEmitting) return;
      _actEmitting = true;
      setTimeout(() => {
        _actEmitting = false;
        invoke('user_active').catch(() => {});
      }, 5000);
    },
    { passive: true }
  );
});

const $ = (sel) => document.querySelector(sel);
const audio = $('#audio');

const state = {
  view: 'search',
  queue: [],
  queueIndex: -1,
  streams: new Map(),
  liked: new Set(),
  currentTrackId: null,
  searchTimer: null,
  lastSearch: '',
  lastSearchData: null,
  silaGenres: [],
  fullSilaQueue: [],
};

const wave = { active: false, source: null, count: 0, name: null };
let hls = null;

/* ---------------- settings ---------------- */

const MAX_QUEUE = 10;

const defaultSettings = {
  volume: 80,
  hifi: false,
  discordRpc: true,
  hotkeys: {
    playPause: null,
    prev: null,
    next: null,
  },
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('zvuk.settings')) || {};
    const hotkeys = { ...defaultSettings.hotkeys, ...(raw.hotkeys || {}) };
    for (const k of Object.keys(hotkeys)) {
      if (!(k in defaultSettings.hotkeys)) delete hotkeys[k];
    }
    return { ...defaultSettings, ...raw, hotkeys };
  } catch {
    return JSON.parse(JSON.stringify(defaultSettings));
  }
}

let settings = loadSettings();
function saveSettings() {
  localStorage.setItem('zvuk.settings', JSON.stringify(settings));
}

const LAST_KEY = 'zvuk.lastTrack';

function saveLastState() {
  try {
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({ q: state.queue, i: state.queueIndex })
    );
  } catch (e) {
    /* ignore */
  }
}

function restoreLastState() {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.q) || !d.q[d.i]) return;
    state.queue = d.q;
    state.queueIndex = d.i;
    const track = d.q[d.i];
    state.currentTrackId = track.id;
    updatePlayerUI(track);
    discordStatus(track, false);
    highlightQueue();
  } catch (e) {
    /* ignore */
  }
}

function applyHotkeys() {
  invoke('set_hotkeys', { hotkeys: settings.hotkeys }).catch(() => {});
}

/* ---------------- helpers ---------------- */

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function coverUrl(src, size = '300x300') {
  if (!src) return '';
  let url = src;
  if (url.startsWith('/')) url = 'https://zvuk.com' + url;
  if (url.includes('{size}')) url = url.split('{size}').join(size);
  else if (/size=\d+x\d+/.test(url)) url = url.replace(/size=\d+x\d+/, `size=${size}`);
  return url;
}

function artistString(track) {
  const artists = (track && track.artists) || [];
  if (artists.length) return artists.map((a) => a.title).filter(Boolean).join(', ');
  const template = (track && track.artistTemplate) || '';
  const names = (track && track.artistNames) || [];
  let i = 0;
  return template.replace(/\{(\d+)\}/g, (_, n) => names[Number(n)] || names[i++] || '');
}

function trackImage(track, size) {
  if (track.release && track.release.image) return coverUrl(track.release.image.src, size);
  const artists = track.artists || [];
  if (artists.length && artists[0].image) return coverUrl(artists[0].image.src, size);
  return '';
}

function playlistImage(p, size) {
  if (p.image && p.image.src) return coverUrl(p.image.src, size);
  const tracks = (p.tracks || []).filter((t) => t && t.id);
  for (const t of tracks) {
    const src = trackImage(t, size);
    if (src) return src;
  }
  return '';
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function markActive(view) {
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === view);
  });
}

let toastTimer;
function toast(msg, ok = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.color = ok ? 'var(--accent)' : 'var(--text)';
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ---------------- auth ---------------- */

function setLoginStatus(msg, ok = false) {
  const el = $('#login-status');
  el.textContent = msg;
  el.classList.toggle('ok', !!ok);
}

function setLoginLoading(on) {
  $('#login-btn').disabled = on;
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}

async function enterApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  try {
    const d = await invoke('user_tracks');
    const ids = ((d && d.collection && d.collection.tracks) || []).map((t) => t.id).filter(Boolean);
    state.liked = new Set(ids);
  } catch (e) {
    /* ignore */
  }
  restoreLastState();
  showView('home');
}

function addToQueue(track) {
  if (state.queue.some(t => t.id === track.id)) return;
  state.queue.push(track);
  if (state.queue.length > MAX_QUEUE) {
    if (state.queueIndex > 0) {
      state.queue.shift();
      state.queueIndex--;
    } else {
      state.queue.pop();
    }
  }
}

async function loadMoreTracks() {
  const lastTrack = state.queue[state.queue.length - 1];
  if (!lastTrack) return;
  try {
    const data = await invoke('get_similar_tracks', { trackId: lastTrack.id, limit: 5 });
    const newTracks = (data && data.tracks) || [];
    for (const t of newTracks) {
      if (!state.queue.some(q => q.id === t.id)) {
        state.queue.push(t);
      }
    }
    while (state.queue.length > MAX_QUEUE + 5) {
      if (state.queueIndex > 0) {
        state.queue.shift();
        state.queueIndex--;
      } else {
        state.queue.pop();
      }
    }
  } catch (e) { /* ignore */ }
}

async function loadMoreSilaTracks() {
  if (!state.fullSilaQueue || state.fullSilaQueue.length === 0) return;
  const nextTrack = state.fullSilaQueue[state.queue.length];
  if (nextTrack) state.queue.push(nextTrack);
  if (state.queue.length === state.fullSilaQueue.length) {
    const currentTrack = state.queue[state.queueIndex];
    if (currentTrack) {
      const newTracks = await generateSilaQueue();
      state.fullSilaQueue = newTracks;
      for (const t of newTracks) {
        if (!state.queue.some(q => q.id === t.id)) {
          state.queue.push(t);
        }
      }
    }
  }
}

async function init() {
  audio.volume = settings.volume / 100;
  $('#volume').value = settings.volume;
  renderHotkeys();
  applyHotkeys();
  try {
    const hasToken = await invoke('saved_token_exists');
    if (hasToken) {
      enterApp();
      invoke('verify_session').catch(() => {});
      return;
    }
  } catch (e) {
    /* no session */
  }
  showLogin();
}

$('#login-btn').addEventListener('click', async () => {
  const token = $('#token-input').value.trim();
  if (!token) {
    setLoginStatus('Введите токен');
    return;
  }
  setLoginLoading(true);
  try {
    await invoke('set_token', { token });
    setLoginStatus('Авторизация успешна', true);
    enterApp();
  } catch (e) {
    setLoginStatus(String(e));
  } finally {
    setLoginLoading(false);
  }
});

$('#open-token-btn').addEventListener('click', () => {
  opener.openUrl('https://zvuk.com/api/tiny/profile');
});

async function logout() {
  try {
    await invoke('clear_token');
  } catch (e) {
    /* ignore */
  }
  invoke('discord_clear').catch(() => {});
  state.queue = [];
  state.queueIndex = -1;
  state.streams.clear();
  state.currentTrackId = null;
  state.liked = new Set();
  wave.active = false;
  wave.source = null;
  wave.count = 0;
  wave.name = null;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  localStorage.removeItem(LAST_KEY);
  closeQueue();
  $('#search-input').value = '';
  state.lastSearchData = null;
  showLogin();
}

/* ---------------- tray events ---------------- */

if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('tray-play-pause', () => togglePlay());
  window.__TAURI__.event.listen('tray-prev', () => prev());
  window.__TAURI__.event.listen('tray-next', () => next());
  window.__TAURI__.event.listen('hotkey', (e) => {
    if (captureHotkey) return;
    const action = e.payload;
    if (action === 'playPause') togglePlay();
    else if (action === 'prev') prev();
    else if (action === 'next') next();
  });
}

/* ---------------- views ---------------- */

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    showView(item.dataset.view);
  });
});

function showView(view) {
  state.view = view;
  document
    .querySelectorAll('.nav-item[data-view="settings"]')
    .forEach((n) => n.classList.remove('active'));
  markActive(view);
  if (view === 'home') {
    renderHome();
  } else if (view === 'search') {
    if (state.lastSearchData) renderSearchResults(state.lastSearchData);
    else
      renderPlaceholder(
        '🔎',
        'Начните вводить запрос, чтобы найти треки, артистов, альбомы и плейлисты'
      );
    $('#search-input').focus();
  } else if (view === 'library') {
    loadLibrary();
  } else if (view === 'playlists') {
    loadPlaylists();
  } else if (view === 'settings') {
    renderSettings();
  }
}

function renderPlaceholder(icon, text) {
  const content = $('#content');
  content.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'placeholder';
  const big = document.createElement('div');
  big.className = 'big';
  big.textContent = icon;
  const t = document.createElement('div');
  t.textContent = text || '';
  p.append(big, t);
  content.append(p);
}

function spinnerBlock() {
  const p = document.createElement('div');
  p.className = 'placeholder';
  p.innerHTML = '<div class="spinner" style="position:static;transform:none;margin:0 auto 14px;"></div>';
  return p;
}

function renderError(e) {
  const content = $('#content');
  content.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'placeholder';
  p.innerHTML = `<div class="big">⚠️</div><div>${esc(String(e))}</div>`;
  content.append(p);
}

function section(title, count) {
  const s = document.createElement('div');
  s.className = 'section';
  const h = document.createElement('div');
  h.className = 'section-header';
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = title;
  const c = document.createElement('div');
  c.className = 'section-count';
  c.textContent = count;
  h.append(t, c);
  s.append(h);
  return s;
}

/* ---------------- home / Сила звука ---------------- */

const GENRES = ['Поп', 'Рок', 'Хип-хоп', 'Электроника', 'Джаз', 'Классика', 'Лоу-фай', 'Инди', 'Танцевальная'];

async function renderHome() {
  const content = $('#content');
  content.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'view-title';
  title.textContent = 'Главное';
  content.append(title);

  content.append(silaPanel());

  const aw = section('Волны по артистам', '');
  const aGrid = document.createElement('div');
  aGrid.className = 'card-grid';
  aw.append(aGrid);
  content.append(aw);

  try {
    const coll = await invoke('user_collection');
    const ids = ((coll && coll.collection && coll.collection.artists) || [])
      .map((a) => a.id)
      .filter(Boolean);
    if (ids.length) {
      const data = await invoke('get_artists', { ids });
      const arts = ((data && data.getArtists) || []).filter((a) => a && a.id);
      aGrid.append(...arts.map(artistWaveCard));
    } else {
      const p = document.createElement('div');
      p.className = 'placeholder';
      p.style.padding = '30px 20px';
      p.textContent = 'Лайкните артистов на zvuk.com, чтобы включить волны по ним';
      aGrid.append(p);
    }
  } catch (e) {
    /* ignore */
  }
}

function silaPanel() {
  const panel = document.createElement('div');
  panel.className = 'sila-panel';

  const header = document.createElement('div');
  header.className = 'sila-header';
  const left = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'sila-title';
  t.innerHTML = 'Сила звука <span class="badge">волна</span>';
  const d = document.createElement('div');
  d.className = 'sila-desc';
  d.textContent = 'Волна строится из ваших любимых треков и артистов. Настройте параметры и запустите — Звук подберёт подходящую музыку.';
  left.append(t, d);
  header.append(left);
  panel.append(header);

  const controls = document.createElement('div');
  controls.className = 'sila-controls';
  controls.append(silaSlider('sila-energy', 'Энергичность', 'спокойная', 'энергичная', 50));
  controls.append(silaSlider('sila-mood', 'Настроение', 'грустная', 'весёлая', 50));
  controls.append(silaSlider('sila-pop', 'Популярность', 'редкая', 'хиты', 50));

  const langBlock = document.createElement('div');
  langBlock.className = 'sila-slider';
  const llabel = document.createElement('label');
  llabel.innerHTML = '<span>Язык</span>';
  const sel = document.createElement('select');
  sel.className = 'sila-select';
  sel.id = 'sila-lang';
  sel.innerHTML =
    '<option value="any">Любой</option><option value="ru">Русский</option><option value="en">Английский</option>';
  langBlock.append(llabel, sel);
  controls.append(langBlock);

  const genreBlock = document.createElement('div');
  genreBlock.className = 'sila-slider';
  const glabel = document.createElement('label');
  glabel.innerHTML = '<span>Жанры</span>';
  const chips = document.createElement('div');
  chips.className = 'chips';
  GENRES.forEach((g) => {
    const c = document.createElement('div');
    c.className = 'chip';
    c.textContent = g;
    c.addEventListener('click', () => {
      c.classList.toggle('on');
      const i = state.silaGenres.indexOf(g);
      if (i >= 0) state.silaGenres.splice(i, 1);
      else state.silaGenres.push(g);
    });
    chips.append(c);
  });
  genreBlock.append(glabel, chips);
  controls.append(genreBlock);

  panel.append(controls);

  const actions = document.createElement('div');
  actions.className = 'sila-actions';
  
  const leftGroup = document.createElement('div');
  leftGroup.className = 'sila-left-group';
  
  const start = document.createElement('button');
  start.id = 'sila-start';
  start.className = 'btn btn-primary';
  start.textContent = 'Запустить волну';
  start.addEventListener('click', () => startSilaWave());
  
  const reset = document.createElement('button');
  reset.id = 'sila-reset';
  reset.className = 'btn hidden';
  reset.textContent = 'Сбросить';
  reset.addEventListener('click', resetSila);
  
  const status = document.createElement('div');
  status.id = 'sila-status';
  status.className = 'wave-status';
  
  leftGroup.append(start, reset, status);
  actions.append(leftGroup);
  panel.append(actions);

  if (wave.active) {
    if (wave.source === 'sila') start.textContent = 'Перезапустить волну';
    reset.classList.remove('hidden');
    status.innerHTML = `Волна играет · <b>${wave.count} треков</b>`;
  }

  return panel;
}

function silaSlider(id, label, low, high, value) {
  const block = document.createElement('div');
  block.className = 'sila-slider';
  const l = document.createElement('label');
  l.innerHTML = `<span>${label}</span><b id="${id}-val">${value}</b>`;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.value = String(value);
  input.addEventListener('input', () => {
    document.getElementById(`${id}-val`).textContent = input.value;
  });
  const ends = document.createElement('div');
  ends.className = 'ends';
  const a = document.createElement('span');
  a.textContent = low;
  const b = document.createElement('span');
  b.textContent = high;
  ends.append(a, b);
  block.append(l, input, ends);
  return block;
}

function artistWaveCard(a) {
  const card = document.createElement('div');
  card.className = 'card artist-wave-card';
  const isArtistActive = wave.active && wave.source === 'artist' && wave.name === a.title;
  if (isArtistActive) card.classList.add('active');
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = a.image ? coverUrl(a.image.src, '300x300') : '';
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = a.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = isArtistActive ? `Волна играет · ${wave.count} треков` : 'Артист';
  const play = document.createElement('button');
  play.className = 'wave-play';
  play.textContent = '▶';
  play.title = 'Запустить волну';
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    startArtistWave(a.id, a.title);
  });
  card.append(img, t, sub, play);
  card.addEventListener('click', () => openArtist(a.id));
  return card;
}

/* ---------------- wave logic ---------------- */

function silaVal(id, fallback) {
  const el = document.getElementById(id);
  return el ? Number(el.value) : fallback;
}
function silaLang() {
  const el = document.getElementById('sila-lang');
  return el ? el.value : 'any';
}

async function generateSilaQueue() {
  const [tracksData, coll] = await Promise.all([invoke('user_tracks'), invoke('user_collection')]);
  const likedIds = ((tracksData && tracksData.collection && tracksData.collection.tracks) || [])
    .map((t) => t.id)
    .filter(Boolean);
  const artistIds = ((coll && coll.collection && coll.collection.artists) || [])
    .map((a) => a.id)
    .filter(Boolean);

  const pool = [];
  const seen = new Set();
  const add = (t, src) => {
    if (t && t.id && !seen.has(t.id)) {
      seen.add(t.id);
      pool.push(Object.assign({}, t, { _src: src }));
    }
  };

  if (likedIds.length) {
    try {
      const tr = await invoke('get_tracks', { ids: likedIds.slice(0, 60) });
      ((tr && tr.getTracks) || []).forEach((t) => add(t, 'like'));
    } catch (e) {
      /* ignore */
    }
  }

  if (artistIds.length) {
    try {
      const art = await invoke('get_artists', { ids: artistIds.slice(0, 5), withPopTracks: true });
      ((art && art.getArtists) || []).forEach((a) =>
        ((a && a.popularTracks) || []).forEach((t) => add(t, 'artist'))
      );
    } catch (e) {
      /* ignore */
    }
  }

  const queries = [];
  const energy = silaVal('sila-energy', 50);
  const mood = silaVal('sila-mood', 50);
  if (energy > 60) queries.push('энергичная музыка');
  else if (energy < 40) queries.push('спокойная музыка');
  if (mood > 60) queries.push('весёлая музыка');
  else if (mood < 40) queries.push('грустная музыка');
  state.silaGenres.slice(0, 2).forEach((g) => queries.push(g));
  for (const q of queries) {
    try {
      const s = await invoke('search', { query: q, limit: 8 });
      ((s && s.search && s.search.tracks && s.search.tracks.items) || []).forEach((t) => add(t, 'other'));
    } catch (e) {
      /* ignore */
    }
  }

  const lang = silaLang();
  let result = pool;
  if (lang !== 'any') {
    result = pool.filter((t) => {
      const text = ((t.title || '') + ' ' + artistString(t)).toLowerCase();
      const hasCyr = /[а-яё]/.test(text);
      return lang === 'ru' ? hasCyr : !hasCyr;
    });
  }

  const pop = silaVal('sila-pop', 50);
  const likedOnly = result.filter((t) => t._src === 'like');
  const artistOnly = result.filter((t) => t._src === 'artist');
  const other = result.filter((t) => t._src !== 'like' && t._src !== 'artist');
  if (pop >= 65) result = [...artistOnly, ...shuffle(other), ...shuffle(likedOnly)];
  else if (pop <= 35) result = [...likedOnly, ...shuffle(other), ...shuffle(artistOnly)];
  else shuffle(result);

  return result;
}

async function startSilaWave() {
  const btn = document.getElementById('sila-start');
  if (btn) btn.disabled = true;
  try {
    const q = await generateSilaQueue();
    if (!q.length) {
      toast('Не удалось собрать волну: добавьте треки в избранное или поищите что-нибудь');
      return;
    }
    const limitedQueue = q.slice(0, MAX_QUEUE);
    state.queue = limitedQueue;
    state.queueIndex = 0;
    state.fullSilaQueue = q;
    wave.active = true;
    wave.source = 'sila';
    wave.count = q.length;
    wave.name = null;
    await playCurrent();  
    const status = document.getElementById('sila-status');
    if (status) status.innerHTML = `Волна играет · <b>${q.length} треков</b>`;
    if (btn) btn.textContent = 'Перезапустить волну';
    const reset = document.getElementById('sila-reset');
    if (reset) reset.classList.remove('hidden');
  } catch (e) {
    toast(String(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetSila() {
  wave.active = false;
  wave.source = null;
  wave.count = 0;
  wave.name = null;
  $('#sila-energy').value = 50;
  $('#sila-mood').value = 50;
  $('#sila-pop').value = 50;
  $('#sila-lang').value = 'any';
  $('#sila-energy-val').textContent = '50';
  $('#sila-mood-val').textContent = '50';
  $('#sila-pop-val').textContent = '50';
  state.silaGenres = [];
  document.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
  const start = $('#sila-start');
  if (start) start.textContent = 'Запустить волну';
  $('#sila-reset').classList.add('hidden');
  const status = $('#sila-status');
  if (status) status.innerHTML = '';
}

async function startArtistWave(artistId, name) {
  try {
    const data = await invoke('get_artists', {
      ids: [String(artistId)],
      withPopTracks: true,
      withRelated: true,
    });
    const a = (data && data.getArtists && data.getArtists[0]) || null;
    if (!a) {
      toast('Не удалось загрузить артиста');
      return;
    }
    const tracks = [...((a.popularTracks || []).filter((t) => t && t.id))];
    const rel = (a.relatedArtists || [])[0];
    if (rel && rel.id) {
      try {
        const syn = await invoke('synthesis_build', { first: String(artistId), second: String(rel.id) });
        const st = (syn && syn.synthesisPlaylistBuild && syn.synthesisPlaylistBuild.tracks) || [];
        const seen = new Set(tracks.map((t) => t.id));
        st.forEach((t) => {
          if (t && t.id && !seen.has(t.id)) {
            seen.add(t.id);
            tracks.push(t);
          }
        });
      } catch (e) {
        /* synthesis может быть недоступен */
      }
    }
    if (!tracks.length) {
      toast('У артиста нет доступных треков');
      return;
    }
    wave.active = true;
    wave.source = 'artist';
    wave.count = tracks.length;
    wave.name = a.title || name;
    playQueue(shuffle(tracks), 0);
    toast(`Волна по артисту: ${name || a.title}`, true);
  } catch (e) {
    toast(String(e));
  }
}

function regenerateWave() {
  if (wave.source === 'sila') {
    startSilaWave();
  } else {
    shuffle(state.queue);
    state.queueIndex = 0;
    playCurrent();
  }
}

/* ---------------- search ---------------- */

function doSearch(query) {
  clearTimeout(state.searchTimer);
  const q = (query || $('#search-input').value).trim();
  if (!q) return;
  $('#search-spinner').classList.remove('hidden');
  state.searchTimer = setTimeout(async () => {
    try {
      const data = await invoke('search', { query: q, limit: 12 });
      state.lastSearch = q;
      state.lastSearchData = data;
      markActive('search');
      renderSearchResults(data);
    } catch (e) {
      renderError(e);
    } finally {
      $('#search-spinner').classList.add('hidden');
    }
  }, 300);
}

$('#search-input').addEventListener('input', () => {
  const q = $('#search-input').value.trim();
  if (!q) {
    state.lastSearch = '';
    state.lastSearchData = null;
    renderPlaceholder(
      '🔎',
      'Начните вводить запрос, чтобы найти треки, артистов, альбомы и плейлисты'
    );
    return;
  }
  doSearch(q);
});

function renderSearchResults(data) {
  const content = $('#content');
  content.innerHTML = '';
  const search = (data && data.search) || {};
  const tracks = (search.tracks && search.tracks.items) || [];
  const artists = (search.artists && search.artists.items) || [];
  const releases = (search.releases && search.releases.items) || [];
  const playlists = (search.playlists && search.playlists.items) || [];

  if (!tracks.length && !artists.length && !releases.length && !playlists.length) {
    renderPlaceholder('🙈', `Ничего не найдено по запросу «${esc(state.lastSearch)}»`);
    return;
  }

  if (tracks.length) {
    const sec = section('Треки', `${tracks.length}`);
    renderTrackList(tracks, sec);
    content.append(sec);
  }
  if (artists.length) {
    const sec = section('Артисты', `${artists.length}`);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...artists.map(artistCard));
    sec.append(grid);
    content.append(sec);
  }
  if (releases.length) {
    const sec = section('Альбомы', `${releases.length}`);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...releases.map(releaseCard));
    sec.append(grid);
    content.append(sec);
  }
  if (playlists.length) {
    const sec = section('Плейлисты', `${playlists.length}`);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...playlists.map(playlistCard));
    sec.append(grid);
    content.append(sec);
  }
}

/* ---------------- library & playlists ---------------- */

async function loadLibrary() {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const [tracksData, coll] = await Promise.all([invoke('user_tracks'), invoke('user_collection')]);
    const trackIds = ((tracksData && tracksData.collection && tracksData.collection.tracks) || [])
      .map((t) => t.id)
      .filter(Boolean);
    const collPlaylists = (coll && coll.collection && coll.collection.playlists) || [];
    const collReleases = (coll && coll.collection && coll.collection.releases) || [];
    const playlistIds = collPlaylists.map((p) => p.id).filter(Boolean);
    const releaseIds = collReleases.map((r) => r.id).filter(Boolean);

    content.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'view-title';
    title.textContent = 'Моя музыка';
    content.append(title);

    if (!trackIds.length && !releaseIds.length && !playlistIds.length) {
      renderPlaceholder(
        '🎵',
        'Здесь появятся треки, альбомы и плейлисты, которые вы добавите в избранное на zvuk.com'
      );
      return;
    }

    if (trackIds.length) {
      const sec = section('Любимые треки', `${trackIds.length}`);
      const tr = await invoke('get_tracks', { ids: trackIds });
      const items = ((tr && tr.getTracks) || []).filter((t) => t && t.id);
      items.forEach((t) => state.liked.add(t.id));
      renderTrackList(items, sec);
      content.append(sec);
    }

    if (releaseIds.length) {
      const sec = section('Любимые альбомы', `${releaseIds.length}`);
      const rd = await invoke('get_releases', { ids: releaseIds, withTracks: false });
      const rels = ((rd && rd.getReleases) || []).filter((r) => r && r.id);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...rels.map(releaseCard));
      sec.append(grid);
      content.append(sec);
    }

    if (playlistIds.length) {
      const sec = section('Любимые плейлисты', `${playlistIds.length}`);
      const pd = await invoke('get_playlists', { ids: playlistIds });
      const pls = ((pd && pd.playlists) || []).filter((p) => p && p.id);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...pls.map(playlistCard));
      sec.append(grid);
      content.append(sec);
    }
  } catch (e) {
    content.innerHTML = '';
    renderError(e);
  }
}

async function loadPlaylists() {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const pd = await invoke('user_playlists');
    const ids = ((pd && pd.collection && pd.collection.playlists) || [])
      .map((p) => p.id)
      .filter(Boolean);
    content.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'view-head';
    const title = document.createElement('div');
    title.className = 'view-title';
    title.textContent = 'Плейлисты';
    const create = document.createElement('button');
    create.className = 'btn btn-primary';
    create.textContent = 'Создать плейлист';
    create.addEventListener('click', () => openCreatePlaylist());
    head.append(title, create);
    content.append(head);

    if (!ids.length) {
      renderPlaceholder('🗂️', 'Плейлистов пока нет. Создайте первый — это удобно');
      return;
    }
    const data = await invoke('get_playlists', { ids });
    const pls = ((data && data.playlists) || []).filter((p) => p && p.id);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    grid.append(...pls.map(playlistCard));
    content.append(grid);
  } catch (e) {
    content.innerHTML = '';
    renderError(e);
  }
}

/* ---------------- playlist modal ---------------- */

let modalState = { track: null };

function openModal() {
  $('#playlist-modal').classList.remove('hidden');
}

function closeModal() {
  $('#playlist-modal').classList.add('hidden');
  $('#modal-new-name').value = '';
  modalState = { track: null };
}

async function openAddToPlaylist(track) {
  modalState = { track };
  $('#modal-title').textContent = 'Добавить в плейлист';
  $('#modal-new-btn').textContent = 'Создать и добавить';
  openModal();
  const listEl = $('#modal-playlists');
  listEl.innerHTML = '<div class="modal-playlist-empty">Загрузка…</div>';
  try {
    const pd = await invoke('user_playlists');
    const ids = ((pd && pd.collection && pd.collection.playlists) || [])
      .map((p) => p.id)
      .filter(Boolean);
    if (!ids.length) {
      listEl.innerHTML =
        '<div class="modal-playlist-empty">Плейлистов пока нет — создайте первый ниже</div>';
      return;
    }
    const data = await invoke('get_playlists', { ids });
    const pls = ((data && data.playlists) || []).filter((p) => p && p.id);
    listEl.innerHTML = '';
    pls.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'modal-playlist-item';
      const img = document.createElement('img');
      img.src = playlistImage(p, '100x100');
      img.alt = '';
      const meta = document.createElement('div');
      meta.style.minWidth = '0';
      meta.style.flex = '1';
      const t = document.createElement('div');
      t.className = 'pl-title';
      t.textContent = p.title || '';
      const s = document.createElement('div');
      s.className = 'pl-sub';
      s.textContent = p.tracks && p.tracks.length ? `${p.tracks.length} треков` : 'Плейлист';
      meta.append(t, s);
      row.append(img, meta);
      row.addEventListener('click', () => addToPlaylist(p.id, p.title));
      listEl.append(row);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="modal-playlist-empty">${esc(String(e))}</div>`;
  }
}

function openCreatePlaylist() {
  modalState = { track: null };
  $('#modal-title').textContent = 'Новый плейлист';
  $('#modal-new-btn').textContent = 'Создать';
  $('#modal-playlists').innerHTML =
    '<div class="modal-playlist-empty">Введите название нового плейлиста</div>';
  openModal();
  $('#modal-new-name').focus();
}

async function addToPlaylist(playlistId, title) {
  if (!modalState.track) return;
  try {
    await invoke('add_tracks_to_playlist', {
      id: String(playlistId),
      items: [{ type: 'track', item_id: modalState.track.id }],
    });
    toast(`Добавлено в «${title}»`, true);
    closeModal();
  } catch (e) {
    toast(String(e));
  }
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal-new-btn').addEventListener('click', async () => {
  const name = $('#modal-new-name').value.trim();
  if (!name) {
    toast('Введите название');
    return;
  }
  const items = modalState.track ? [{ type: 'track', item_id: modalState.track.id }] : [];
  try {
    await invoke('create_playlist', { name, items });
    toast(`Плейлист «${name}» создан`, true);
    closeModal();
    if (state.view === 'playlists') loadPlaylists();
  } catch (e) {
    toast(String(e));
  }
});

$('#playlist-modal').addEventListener('click', (e) => {
  if (e.target.id === 'playlist-modal') closeModal();
});

/* ---------------- detail views ---------------- */

async function openPlaylist(id) {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const data = await invoke('get_playlists', { ids: [String(id)] });
    const pl = (data && data.playlists && data.playlists[0]) || null;
    if (!pl || !pl.id) {
      content.innerHTML = '';
      renderError('Плейлист не найден');
      return;
    }
    renderDetail(content, { kind: 'playlist', item: pl });
  } catch (e) {
    content.innerHTML = '';
    renderError(e);
  }
}

async function openRelease(id) {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const data = await invoke('get_releases', { ids: [String(id)], withTracks: true });
    const rel = (data && data.getReleases && data.getReleases[0]) || null;
    if (!rel || !rel.id) {
      content.innerHTML = '';
      renderError('Альбом не найден');
      return;
    }
    renderDetail(content, { kind: 'release', item: rel });
  } catch (e) {
    content.innerHTML = '';
    renderError(e);
  }
}

function renderDetail(content, { kind, item }) {
  content.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'detail-header';
  const img = document.createElement('img');
  img.className = 'detail-cover';
  img.src = playlistImage(item, '400x400');
  img.alt = '';
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const type = document.createElement('div');
  type.className = 'detail-type';
  type.textContent = kind === 'playlist' ? 'Плейлист' : (item.type || 'Альбом');
  const title = document.createElement('div');
  title.className = 'detail-title';
  title.textContent = item.title || '';
  const sub = document.createElement('div');
  sub.className = 'detail-sub';
  sub.textContent = artistString(item);
  meta.append(type, title, sub);
  if (kind === 'playlist') {
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const del = document.createElement('button');
    del.className = 'btn btn-danger';
    del.textContent = 'Удалить плейлист';
    let armed = false;
    let armTimer = null;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Точно удалить?';
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armed = false;
          del.textContent = 'Удалить плейлист';
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      try {
        await invoke('delete_playlist', { id: String(item.id) });
        toast('Плейлист удалён', true);
        showView('playlists');
        loadPlaylists();
      } catch (e) {
        toast(String(e));
      }
    });
    actions.append(del);
    meta.append(actions);
  }
  header.append(img, meta);
  content.append(header);

  const tracks = (item.tracks || []).filter((t) => t && t.id);
  if (!tracks.length) {
    renderPlaceholder('📻', 'В этом плейлисте пока нет треков');
    return;
  }
  tracks.forEach((t) => {
    const stream = t.stream || {};
    const url = stream.high || stream.mid || stream.flac;
    if (url) state.streams.set(t.id, url);
  });
  const opts =
    kind === 'playlist' ? { remove: (track) => removeFromPlaylist(item, track) } : {};
  renderTrackList(tracks, content, opts);
}

async function removeFromPlaylist(playlist, track) {
  const remaining = (playlist.tracks || [])
    .filter((t) => t && t.id && t.id !== track.id)
    .map((t) => ({ type: 'track', item_id: t.id }));
  try {
    await invoke('update_playlist', {
      id: String(playlist.id),
      items: remaining,
      isPublic: !!playlist.isPublic,
      name: playlist.title || '',
    });
    toast(`Удалено из «${playlist.title || ''}»`, true);
    openPlaylist(playlist.id);
  } catch (e) {
    toast(String(e));
  }
}

/* ---------------- artist page ---------------- */

async function openArtist(id) {
  const content = $('#content');
  content.innerHTML = '';
  content.append(spinnerBlock());
  try {
    const data = await invoke('get_artists', {
      ids: [String(id)],
      withReleases: true,
      withPopTracks: true,
      withRelated: true,
      withDesc: true,
    });
    const a = (data && data.getArtists && data.getArtists[0]) || null;
    if (!a || !a.id) {
      content.innerHTML = '';
      renderError('Артист не найден');
      return;
    }
    content.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'detail-header';
    const img = document.createElement('img');
    img.className = 'detail-cover';
    img.src = a.image ? coverUrl(a.image.src, '400x400') : '';
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    const type = document.createElement('div');
    type.className = 'detail-type';
    type.textContent = 'Артист';
    const title = document.createElement('div');
    title.className = 'detail-title';
    title.textContent = a.title || '';
    const sub = document.createElement('div');
    sub.className = 'detail-sub';
    const trackCount = (a.popularTracks || []).length;
    sub.textContent = trackCount ? `${trackCount} популярных треков` : '';
    meta.append(type, title, sub);
    if (a.description) {
      const bio = document.createElement('div');
      bio.className = 'artist-bio';
      bio.textContent = a.description;
      const toggle = document.createElement('button');
      toggle.className = 'btn btn-ghost bio-toggle';
      toggle.textContent = 'Подробнее';
      let expanded = false;
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        bio.classList.toggle('expanded', expanded);
        toggle.textContent = expanded ? 'Скрыть' : 'Подробнее';
      });
      bio.style.marginTop = '10px';
      meta.append(bio, toggle);
    }
    header.append(img, meta);
    content.append(header);

    const tracks = (a.popularTracks || []).filter((t) => t && t.id);
    if (tracks.length) {
      const sec = section('Популярные треки', `${tracks.length}`);
      renderTrackList(tracks, sec);
      content.append(sec);
    }

    const rels = (a.releases || []).filter((r) => r && r.id);
    if (rels.length) {
      const sec = section('Альбомы', `${rels.length}`);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...rels.map(releaseCard));
      sec.append(grid);
      content.append(sec);
    }

    const related = (a.relatedArtists || []).filter((r) => r && r.id);
    if (related.length) {
      const sec = section('Похожие артисты', `${related.length}`);
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.append(...related.map(artistCard));
      sec.append(grid);
      content.append(sec);
    }
  } catch (e) {
    content.innerHTML = '';
    renderError(e);
  }
}

/* ---------------- cards ---------------- */

function playlistCard(p) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = playlistImage(p, '300x300');
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = p.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = p.tracks && p.tracks.length ? `${p.tracks.length} треков` : 'Плейлист';
  card.append(img, t, sub);
  card.addEventListener('click', () => openPlaylist(p.id));
  return card;
}

function releaseCard(r) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = r.image ? coverUrl(r.image.src, '300x300') : '';
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = r.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = artistString(r) || 'Альбом';
  card.append(img, t, sub);
  card.addEventListener('click', () => openRelease(r.id));
  return card;
}

function artistCard(a) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = a.image ? coverUrl(a.image.src, '300x300') : '';
  img.alt = '';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = a.title || '';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = 'Артист';
  card.append(img, t, sub);
  card.addEventListener('click', () => openArtist(a.id));
  return card;
}

/* ---------------- track list ---------------- */

function renderTrackList(tracks, container, opts = {}) {
  const list = document.createElement('div');
  list.className = 'track-list';
  tracks.forEach((t, i) => list.append(trackRow(t, i, tracks, opts)));
  container.append(list);
}

function trackRow(track, index, list, opts = {}) {
  const row = document.createElement('div');
  row.className = 'track-row';
  if (track.id === state.currentTrackId) row.classList.add('playing');
  row.dataset.id = track.id;

  const num = document.createElement('span');
  num.className = 'track-num';
  num.textContent = '♫';

  const cover = document.createElement('img');
  cover.className = 'track-cover';
  cover.src = trackImage(track, '84x84');
  cover.alt = '';

  const main = document.createElement('div');
  main.className = 'track-main';
  const title = document.createElement('div');
  title.className = 'track-title';
  title.textContent = track.title || '';
  const artist = document.createElement('div');
  artist.className = 'track-artist';
  artist.textContent = artistString(track);
  main.append(title, artist);

  const pl = document.createElement('button');
  pl.className = 'pl-btn';
  pl.title = 'В плейлист';
  pl.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm10-5l7 4-7 4v-8z"/></svg>`;
  pl.dataset.id = track.id;

  const like = document.createElement('button');
  like.className = 'like-btn';
  const liked = state.liked.has(track.id);
  like.innerHTML = liked 
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

  const dur = document.createElement('span');
  dur.className = 'track-duration';
  dur.textContent = fmtTime(track.duration);

  let rem = null;
  if (opts.remove) {
    rem = document.createElement('button');
    rem.className = 'remove-btn';
    rem.textContent = '✕';
    rem.title = 'Удалить из плейлиста';
    rem.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.remove(track);
    });
  }

  row.append(num, cover, main, pl, like, rem || dur);
  if (rem) row.append(dur);

  row.addEventListener('click', () => playQueue(list, index));
  pl.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddToPlaylist(track);
  });
  like.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLike(track, like);
  });
  return row;
}

/* ---------------- likes ---------------- */

async function toggleLike(track, btn) {
  const id = track.id;
  const liked = state.liked.has(id);
  try {
    if (liked) {
      await invoke('remove_from_collection', { id, itemType: 'track' });
      state.liked.delete(id);
    } else {
      await invoke('add_to_collection', { id, itemType: 'track' });
      state.liked.add(id);
    }
    syncLikeButtons();
  } catch (e) {
    toast(String(e));
  }
}

function syncLikeButtons() {
  const liked = state.liked;
  document.querySelectorAll('.like-btn[data-id]').forEach((b) => {
    const isLiked = liked.has(b.dataset.id);
    b.innerHTML = isLiked 
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    b.classList.toggle('liked', isLiked);
    b.title = isLiked ? 'Убрать из избранного' : 'В избранное';
  });
  const pb = $('#player-like');
  if (state.currentTrackId) {
    const isLiked = liked.has(state.currentTrackId);
    pb.innerHTML = isLiked 
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    pb.classList.toggle('liked', isLiked);
  }
}

/* ---------------- player ---------------- */

async function playQueue(list, index) {
  const track = list[index];
  if (track && state.currentTrackId === track.id) {
    togglePlay();
    return;
  }
  state.queue = list;
  state.queueIndex = index;
  await playCurrent();
}

async function playCurrent() {
  const track = state.queue[state.queueIndex];
  if (!track) return;
  state.currentTrackId = track.id;
  updatePlayerUI(track);
  discordStatus(track, true);
  highlightQueue();
  saveLastState();
  let url = state.streams.get(track.id);
  if (!url) {
    try {
      const data = await invoke('get_stream', { ids: [track.id] });
      const items = (data && data.mediaContents) || [];
      const stream = items[0] && items[0].stream;
      url = settings.hifi
        ? (stream && (stream.flac || stream.high || stream.mid)) || null
        : (stream && (stream.high || stream.mid || stream.flac)) || null;
      if (url) state.streams.set(track.id, url);
    } catch (e) {
      toast(String(e));
      return;
    }
  }
  if (!url) {
    toast('Не удалось получить поток трека');
    return;
  }
  setupSource(url);
  audio.play().then(updatePlayBtn).catch(() => toast('Не удалось начать воспроизведение'));
  updatePlayBtn();
}

function setupSource(url) {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  const isHls = /\.m3u8($|\?)/i.test(url);
  if (isHls && window.Hls && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.ERROR, (e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else {
        toast('Ошибка воспроизведения стрима');
        hls.destroy();
        hls = null;
      }
    });
  } else {
    audio.src = url;
  }
}

function updatePlayerUI(track) {
  $('#player').classList.remove('hidden');
  $('#player-cover').src = trackImage(track, '200x200');
  $('#player-title').textContent = track.title || '';
  $('#player-artist').textContent = artistString(track);
  syncLikeButtons();
  if (navigator.mediaSession) {
    const art = trackImage(track, '512x512');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || '',
      artist: artistString(track),
      album: (track.release && track.release.title) || '',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }
}

function discordStatus(track, playing) {
  if (!track || !settings.discordRpc) return;
  invoke('discord_update', {
    status: {
      title: track.title || '',
      artist: artistString(track) || '',
      cover: trackImage(track, '512x512') || '',
      playing: !!playing,
    },
  }).catch(() => {});
}

function highlightQueue() {
  const currentId = state.currentTrackId;
  document.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('playing', row.dataset.id === currentId);
  });
}

function next() {
  if (!state.queue.length) return;
  if (state.queueIndex >= state.queue.length - 2) {
    if (wave.active && wave.source === 'sila') {
      loadMoreSilaTracks();
    } else {
      loadMoreTracks();
    }
  }
  if (state.queueIndex < state.queue.length - 1) {
    state.queueIndex++;
    playCurrent();
  } else if (wave.active) {
    regenerateWave();
  } else {
    state.queueIndex = 0;
    playCurrent();
  }
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (state.queueIndex > 0) state.queueIndex--;
  else state.queueIndex = 0;
  playCurrent();
}

function updatePlayBtn() {
  const btn = $('#btn-play');
  const playing = !audio.paused;
  btn.textContent = playing ? '❚❚' : '▶';
}

function togglePlay() {
  if (audio.paused) audio.play();
  else audio.pause();
}

audio.addEventListener('timeupdate', () => {
  if (!audio.duration || !isFinite(audio.duration)) return;
  const progress = (audio.currentTime / audio.duration) * 100;
  $('#seek').value = progress;
  $('#seek').style.setProperty('--progress', progress + '%');
  $('#pos-current').textContent = fmtTime(audio.currentTime);
  $('#pos-total').textContent = fmtTime(audio.duration);
});

audio.addEventListener('loadedmetadata', () => {
  $('#pos-total').textContent = fmtTime(audio.duration);
  $('#seek').style.setProperty('--progress', '0%');
});

audio.addEventListener('ended', next);
audio.addEventListener('play', () => {
  updatePlayBtn();
  discordStatus(state.queue[state.queueIndex], true);
});
audio.addEventListener('pause', () => {
  updatePlayBtn();
  discordStatus(state.queue[state.queueIndex], false);
});
audio.addEventListener('error', () => {
  toast('Ошибка воспроизведения');
  updatePlayBtn();
});

$('#seek').addEventListener('input', () => {
  if (audio.duration && isFinite(audio.duration)) {
    audio.currentTime = (Number($('#seek').value) / 100) * audio.duration;
  }
});

$('#volume').addEventListener('input', () => {
  const v = Number($('#volume').value);
  audio.volume = v / 100;
  settings.volume = v;
  saveSettings();
  $('#volume').style.setProperty('--volume-progress', v + '%');
});

$('#volume').style.setProperty('--volume-progress', settings.volume + '%');

if (navigator.mediaSession) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', next);
  ms.setActionHandler('stop', () => audio.pause());
  ms.setActionHandler('seekto', (d) => {
    if (d.seekTime != null) audio.currentTime = d.seekTime;
  });
}

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-next').addEventListener('click', next);
$('#btn-prev').addEventListener('click', prev);

$('#player-like').addEventListener('click', () => {
  const track = state.queue[state.queueIndex];
  if (track) toggleLike(track, $('#player-like'));
});

$('#player-add-playlist').addEventListener('click', () => {
  const track = state.queue[state.queueIndex];
  if (track) openAddToPlaylist(track);
});

$('#player-download').addEventListener('click', () => {
  toast('Скачивание треков появится позже');
});

$('#player-queue').addEventListener('click', toggleQueue);
$('#queue-close').addEventListener('click', closeQueue);

function toggleQueue() {
  if ($('#queue-panel').classList.contains('hidden')) openQueue();
  else closeQueue();
}

function openQueue() {
  renderQueue();
  $('#queue-panel').classList.remove('hidden');
}

function closeQueue() {
  $('#queue-panel').classList.add('hidden');
}

function renderQueue() {
  const list = $('#queue-list');
  list.innerHTML = '';
  if (!state.queue.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'Очередь пуста. Включите трек или запустите волну.';
    list.append(empty);
    return;
  }
  state.queue.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    if (i === state.queueIndex) row.classList.add('playing');
    const img = document.createElement('img');
    img.src = trackImage(t, '72x72');
    img.alt = '';
    const main = document.createElement('div');
    main.className = 'queue-main';
    const name = document.createElement('div');
    name.className = 'queue-name';
    name.textContent = t.title || '';
    const artist = document.createElement('div');
    artist.className = 'queue-artist';
    artist.textContent = artistString(t);
    main.append(name, artist);
    row.append(img, main);
    row.addEventListener('click', () => {
      if (i === state.queueIndex && !audio.paused) {
        closeQueue();
        return;
      }
      playQueue(state.queue, i);
      closeQueue();
    });
    list.append(row);
  });
}

/* ---------------- settings / hotkeys ---------------- */

const HOTKEY_ACTIONS = [
  { key: 'playPause', name: 'Пауза / Плей' },
  { key: 'prev', name: 'Предыдущий трек' },
  { key: 'next', name: 'Следующий трек' },
];

let captureHotkey = null;

function prettyCombo(combo) {
  if (!combo) return '—';
  return combo
    .split('+')
    .map((p) => (p === 'Space' ? 'Пробел' : p === 'ArrowRight' ? '→' : p === 'ArrowLeft' ? '←' : p === 'ArrowUp' ? '↑' : p === 'ArrowDown' ? '↓' : p))
    .join('+');
}

function renderHotkeys() {
  const list = $('#hotkey-list');
  if (!list) return;
  list.innerHTML = '';
  HOTKEY_ACTIONS.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'hotkey-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = a.name;
    const combo = document.createElement('button');
    combo.className = 'combo';
    const active = !settings.hotkeys[a.key];
    combo.classList.toggle('active', active);
    combo.textContent = prettyCombo(settings.hotkeys[a.key]);
    if (captureHotkey === a.key) combo.classList.add('capture');
    combo.addEventListener('click', () => {
      if (captureHotkey === a.key) {
        captureHotkey = null;
        renderHotkeys();
        return;
      }
      captureHotkey = a.key;
      renderHotkeys();
    });
    row.append(name, combo);
    list.append(row);
  });
}

function setHotkey(action, combo) {
  for (const k of Object.keys(settings.hotkeys)) {
    if (k !== action && settings.hotkeys[k] === combo) settings.hotkeys[k] = null;
  }
  settings.hotkeys[action] = combo;
  saveSettings();
  applyHotkeys();
  captureHotkey = null;
  renderHotkeys();
  toast('Горячая клавиша обновлена', true);
}

function eventCombo(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return parts.length ? parts.join('+') : '';
  if (key === ' ') return [...parts, 'Space'].join('+');
  if (key === 'Escape') return [...parts, 'Escape'].join('+');
  if (key.length === 1) return [...parts, key.toLowerCase()].join('+');
  return [...parts, key].join('+');
}

function renderSettings() {
  const content = $('#content');
  content.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'view-title';
  title.textContent = 'Настройки';
  content.append(title);

  const body = document.createElement('div');
  body.className = 'settings-body';

  const qGroup = document.createElement('div');
  qGroup.className = 'settings-group';
  const qTitle = document.createElement('div');
  qTitle.className = 'settings-group-title';
  qTitle.textContent = 'Качество звука';
  const qRow = document.createElement('label');
  qRow.className = 'switch-row';
  const qSpan = document.createElement('span');
  const qSmall = document.createElement('small');
  qSmall.textContent = '(FLAC, если доступен)';
  qSpan.append('Hi-Fi звук ', qSmall);
  const qInput = document.createElement('input');
  qInput.type = 'checkbox';
  qInput.id = 'setting-hifi';
  qInput.checked = settings.hifi;
  qInput.addEventListener('change', () => {
    settings.hifi = qInput.checked;
    saveSettings();
    state.streams.clear();
    toast(settings.hifi ? 'Hi-Fi включён (FLAC)' : 'Обычное качество', true);
  });
  qRow.append(qSpan, qInput);
  qGroup.append(qTitle, qRow);
  body.append(qGroup);

  const hGroup = document.createElement('div');
  hGroup.className = 'settings-group';
  const hTitle = document.createElement('div');
  hTitle.className = 'settings-group-title';
  hTitle.textContent = 'Горячие клавиши';
  const hotkeys = document.createElement('div');
  hotkeys.className = 'hotkey-list';
  hotkeys.id = 'hotkey-list';
  hGroup.append(hTitle, hotkeys);
  body.append(hGroup);

  const dGroup = document.createElement('div');
  dGroup.className = 'settings-group';
  const dTitle = document.createElement('div');
  dTitle.className = 'settings-group-title';
  dTitle.textContent = 'Discord';
  const dRow = document.createElement('label');
  dRow.className = 'switch-row';
  const dSpan = document.createElement('span');
  dSpan.append('Показывать статус в Discord');
  const dInput = document.createElement('input');
  dInput.type = 'checkbox';
  dInput.id = 'setting-discord';
  dInput.checked = settings.discordRpc;
  dInput.addEventListener('change', () => {
    settings.discordRpc = dInput.checked;
    saveSettings();
    if (!settings.discordRpc) {
      invoke('discord_clear').catch(() => {});
    } else {
      discordStatus(state.queue[state.queueIndex], !audio.paused);
    }
    toast(settings.discordRpc ? 'Discord RPC включён' : 'Discord RPC выключен', true);
  });
  dRow.append(dSpan, dInput);
  dGroup.append(dTitle, dRow);
  body.append(dGroup);

  const lGroup = document.createElement('div');
  lGroup.className = 'settings-group';
  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'btn btn-danger';
  logoutBtn.style.alignSelf = 'flex-start';
  logoutBtn.textContent = 'Выйти из аккаунта';
  logoutBtn.addEventListener('click', logout);
  lGroup.append(logoutBtn);
  body.append(lGroup);

  content.append(body);
  renderHotkeys();
}

document.addEventListener('keydown', (e) => {
  if (captureHotkey) {
    e.preventDefault();
    e.stopPropagation();
    const combo = eventCombo(e);
    if (combo === 'Escape') {
      captureHotkey = null;
      renderHotkeys();
      return;
    }
    if (combo && !['Ctrl', 'Alt', 'Shift'].includes(combo)) setHotkey(captureHotkey, combo);
  }
});

init();
