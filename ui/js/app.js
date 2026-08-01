const { invoke } = window.__TAURI__.core;
const opener = window.__TAURI__.opener;

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
};

let hls = null;

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
  $('#anon-btn').disabled = on;
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
  showView('library');
}

async function init() {
  try {
    const hasToken = await invoke('saved_token_exists');
    if (hasToken) {
      await invoke('verify_session');
      enterApp();
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

$('#anon-btn').addEventListener('click', async () => {
  setLoginLoading(true);
  try {
    const token = await invoke('get_anonymous_token');
    await invoke('set_token', { token });
    setLoginStatus('Анонимный вход выполнен', true);
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

$('#logout-btn').addEventListener('click', async () => {
  try {
    await invoke('clear_token');
  } catch (e) {
    /* ignore */
  }
  state.queue = [];
  state.queueIndex = -1;
  state.streams.clear();
  state.currentTrackId = null;
  state.liked = new Set();
  if (hls) {
    hls.destroy();
    hls = null;
  }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  $('#player').classList.add('hidden');
  $('#search-input').value = '';
  state.lastSearchData = null;
  showLogin();
});

/* ---------------- views ---------------- */

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => showView(item.dataset.view));
});

function showView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  if (view === 'search') {
    if (state.lastSearchData) renderSearchResults(state.lastSearchData);
    else
      renderPlaceholder(
        'Поиск',
        '🔎',
        'Начните вводить запрос, чтобы найти треки, артистов, альбомы и плейлисты'
      );
    $('#search-input').focus();
  } else if (view === 'library') {
    loadLibrary();
  } else if (view === 'playlists') {
    loadPlaylists();
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
      'Поиск',
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
    renderPlaceholder('Поиск', '🙈', `Ничего не найдено по запросу «${esc(state.lastSearch)}»`);
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
    const title = document.createElement('div');
    title.className = 'view-title';
    title.textContent = 'Плейлисты';
    content.append(title);
    if (!ids.length) {
      renderPlaceholder('🗂️', 'Плейлисты не найдены. Создайте их на zvuk.com');
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
  img.src = item.image ? coverUrl(item.image.src, '400x400') : '';
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
  renderTrackList(tracks, content);
}

/* ---------------- cards ---------------- */

function playlistCard(p) {
  const card = document.createElement('div');
  card.className = 'card';
  const img = document.createElement('img');
  img.className = 'card-cover';
  img.src = p.image ? coverUrl(p.image.src, '300x300') : '';
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
  card.addEventListener('click', () => {
    $('#search-input').value = a.title;
    state.lastSearch = a.title;
    doSearch(a.title);
    showView('search');
  });
  return card;
}

/* ---------------- track list ---------------- */

function renderTrackList(tracks, container) {
  const list = document.createElement('div');
  list.className = 'track-list';
  tracks.forEach((t, i) => list.append(trackRow(t, i, tracks)));
  container.append(list);
}

function trackRow(track, index, list) {
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

  const like = document.createElement('button');
  like.className = 'like-btn';
  const liked = state.liked.has(track.id);
  like.textContent = liked ? '♥' : '♡';
  like.classList.toggle('liked', liked);
  like.dataset.id = track.id;
  like.title = liked ? 'Убрать из избранного' : 'В избранное';

  const dur = document.createElement('span');
  dur.className = 'track-duration';
  dur.textContent = fmtTime(track.duration);

  row.append(num, cover, main, like, dur);

  row.addEventListener('click', () => playQueue(list, index));
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
    b.textContent = isLiked ? '♥' : '♡';
    b.classList.toggle('liked', isLiked);
    b.title = isLiked ? 'Убрать из избранного' : 'В избранное';
  });
  const pb = $('#player-like');
  if (state.currentTrackId) {
    const isLiked = liked.has(state.currentTrackId);
    pb.textContent = isLiked ? '♥' : '♡';
    pb.classList.toggle('liked', isLiked);
  }
}

/* ---------------- player ---------------- */

async function playQueue(list, index) {
  const track = list[index];
  if (track && state.currentTrackId === track.id) {
    if (audio.paused) audio.play();
    else audio.pause();
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
  highlightQueue();
  let url = state.streams.get(track.id);
  if (!url) {
    try {
      const data = await invoke('get_stream', { ids: [track.id] });
      const items = (data && data.mediaContents) || [];
      const stream = items[0] && items[0].stream;
      url = (stream && (stream.high || stream.mid || stream.flac)) || null;
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

function highlightQueue() {
  const currentId = state.currentTrackId;
  document.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('playing', row.dataset.id === currentId);
  });
}

function next() {
  if (!state.queue.length) return;
  if (state.queueIndex < state.queue.length - 1) state.queueIndex++;
  else state.queueIndex = 0;
  playCurrent();
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

$('#btn-play').addEventListener('click', () => {
  if (audio.paused) audio.play();
  else audio.pause();
});
$('#btn-next').addEventListener('click', next);
$('#btn-prev').addEventListener('click', prev);

$('#player-like').addEventListener('click', () => {
  const track = state.queue[state.queueIndex];
  if (track) toggleLike(track, $('#player-like'));
});

audio.addEventListener('timeupdate', () => {
  if (!audio.duration || !isFinite(audio.duration)) return;
  $('#seek').value = (audio.currentTime / audio.duration) * 100;
  $('#pos-current').textContent = fmtTime(audio.currentTime);
  $('#pos-total').textContent = fmtTime(audio.duration);
});

audio.addEventListener('loadedmetadata', () => {
  $('#pos-total').textContent = fmtTime(audio.duration);
});

audio.addEventListener('ended', next);
audio.addEventListener('play', updatePlayBtn);
audio.addEventListener('pause', updatePlayBtn);
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
  audio.volume = Number($('#volume').value) / 100;
});

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

document.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('#btn-play').click();
  } else if (e.key === 'ArrowRight' && e.ctrlKey) {
    next();
  } else if (e.key === 'ArrowLeft' && e.ctrlKey) {
    prev();
  } else if ((e.key === 'f' || e.key === 'F') && e.ctrlKey) {
    e.preventDefault();
    showView('search');
  }
});

init();
