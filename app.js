/* Nimbus Noir — zero-backend client engine (ES Modules, vanilla) */
'use strict';

const $ = (sel) => document.querySelector(sel);

const CACHE_TTL_MS = 15 * 60 * 1000;
const FOREGROUND_REVALIDATE_MS = 20 * 60 * 1000;
const PIN_KEY = 'nimbus_pinned_locations';
const LAST_LOC_KEY = 'nimbus_last_location';

const state = {
  lat: null,
  lon: null,
  name: 'Current Location',
  payload: null,
  fetchedAt: 0,
  liveMode: true,
};

function cacheKey(lat, lon) {
  return `nimbus_forecast_${Number(lat).toFixed(3)}_${Number(lon).toFixed(3)}`;
}

function readCache(lat, lon) {
  try {
    const raw = localStorage.getItem(cacheKey(lat, lon));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function writeCache(lat, lon, payload) {
  try {
    localStorage.setItem(cacheKey(lat, lon), JSON.stringify({ timestamp: Date.now(), payload }));
  } catch { /* storage full / private mode — non-fatal */ }
}

function getPinned() {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); }
  catch { return []; }
}
function setPinned(list) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/* ---------- WMO mapping (spec §7) ---------- */
function wmoInfo(code, isDay = true) {
  const c = Number(code);
  if (c === 0) return { text: 'Clear skies', icon: isDay ? 'i-sun' : 'i-moon' };
  if (c === 1 || c === 2) return { text: c === 1 ? 'Mostly clear' : 'Partly cloudy', icon: isDay ? 'i-cloud-sun' : 'i-cloud-moon' };
  if (c === 3) return { text: 'Overcast', icon: 'i-cloud' };
  if (c === 45 || c === 48) return { text: 'Foggy with reduced visibility', icon: 'i-fog' };
  if (c === 51 || c === 53 || c === 55) return { text: 'Light to dense drizzle', icon: 'i-drizzle' };
  if (c === 61 || c === 63 || c === 65) return { text: c === 61 ? 'Slight rain' : c === 63 ? 'Rain' : 'Heavy rain', icon: 'i-rain' };
  if (c === 71 || c === 73 || c === 75) return { text: c === 71 ? 'Slight snowfall' : c === 73 ? 'Snowfall' : 'Heavy snowfall', icon: 'i-snow' };
  if (c === 77) return { text: 'Snow grains', icon: 'i-snow' };
  if (c === 80 || c === 81 || c === 82) return { text: 'Rain showers', icon: 'i-shower' };
  if (c === 85 || c === 86) return { text: 'Snow showers', icon: 'i-snow' };
  if (c === 95 || c === 96 || c === 99) return { text: c === 99 ? 'Thunderstorms with hail' : 'Thunderstorms', icon: 'i-storm' };
  return { text: 'Unknown', icon: 'i-cloud' };
}

/* ---------- API contracts (spec §4) ---------- */
function forecastURL(lat, lon) {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    models: 'best_match',
    current: 'temperature_2m,apparent_temperature,weather_code',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,uv_index',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_gusts_10m_max',
    forecast_days: '10',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
  });
  return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}

function archiveURL(lat, lon, date) {
  const p = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    start_date: date, end_date: date,
    hourly: 'temperature_2m,precipitation,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph',
    precipitation_unit: 'inch', timezone: 'auto',
  });
  return `https://archive-api.open-meteo.com/v1/archive?${p.toString()}`;
}

function geocodeURL(q) {
  const p = new URLSearchParams({ name: q, count: '5', language: 'en', format: 'json' });
  return `https://geocoding-api.open-meteo.com/v1/search?${p.toString()}`;
}

/* ---------- Fetch + cache lifecycle (spec §6) ---------- */
async function loadForecast(lat, lon, { force = false } = {}) {
  const cached = readCache(lat, lon);
  const age = cached ? Date.now() - cached.timestamp : Infinity;

  if (!force && cached && age < CACHE_TTL_MS) {
    return { payload: cached.payload, fetchedAt: cached.timestamp, offline: false, fromCache: true };
  }
  try {
    const res = await fetch(forecastURL(lat, lon));
    if (!res.ok) throw new Error(`Forecast HTTP ${res.status}`);
    const payload = await res.json();
    const now = Date.now();
    writeCache(lat, lon, payload);
    return { payload, fetchedAt: now, offline: false, fromCache: false };
  } catch (err) {
    if (cached) return { payload: cached.payload, fetchedAt: cached.timestamp, offline: true, fromCache: true };
    throw err;
  }
}

/* ---------- Helpers ---------- */
function hourIndex(hourlyTime, now = new Date()) {
  let best = 0;
  for (let i = 0; i < hourlyTime.length; i++) {
    if (new Date(hourlyTime[i]) <= now) best = i;
    else break;
  }
  return best;
}

function fmtHour(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h} ${ampm}`;
}

function fmtDay(iso, idx) {
  if (idx === 0) return 'Today';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function timeAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'Updated just now';
  if (m === 1) return 'Updated 1m ago';
  return `Updated ${m}m ago`;
}

function precipClass(p) {
  if (p == null) return 'dry';
  if (p < 15) return 'dry';
  if (p < 40) return 'light';
  if (p < 70) return 'medium';
  return 'heavy';
}

/* Dark Sky prose: scan next 12h of WMO + precip probability */
function synthesizeSummary(hourly, startIdx) {
  const slice = [];
  for (let i = startIdx; i < Math.min(startIdx + 12, hourly.time.length); i++) {
    slice.push({
      code: hourly.weather_code[i],
      prob: hourly.precipitation_probability?.[i] ?? 0,
      time: hourly.time[i],
    });
  }
  if (!slice.length) return 'Forecast unavailable.';

  const first = wmoInfo(slice[0].code).text;
  const wet = slice.find((s) => (s.prob ?? 0) >= 30);
  const dominant = (() => {
    const counts = {};
    for (const s of slice) {
      const t = wmoInfo(s.code).text;
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  })();

  let sentence = `${dominant} throughout the day.`;
  // Capitalize first descriptor
  if (slice[0].prob < 15 && slice[0].code <= 3) {
    sentence = `${first} to start, turning ${dominant.toLowerCase()} later.`;
    if (first === dominant) sentence = `${dominant} throughout the day.`;
  }
  if (wet) {
    const kind = wet.code >= 71 && wet.code <= 77 ? 'snow' : wet.code >= 95 ? 'thunderstorms' : wet.code >= 51 && wet.code <= 55 ? 'drizzle' : 'rain';
    const strength = wet.prob >= 70 ? 'heavy' : wet.prob >= 40 ? 'steady' : 'light';
    sentence += ` ${strength[0].toUpperCase() + strength.slice(1)} ${kind} starting around ${fmtHour(wet.time)}.`;
  } else if ((slice[0].prob ?? 0) < 15) {
    sentence += ' No meaningful precipitation expected.';
  }
  return sentence;
}

/* ---------- Render ---------- */
function setIcon(useEl, iconId) {
  useEl.setAttribute('href', `#${iconId}`);
}

function render(payload, fetchedAt, opts = {}) {
  state.payload = payload;
  state.fetchedAt = fetchedAt;
  const { hourly, daily } = payload;
  const nowIdx = hourIndex(hourly.time);
  const isDayNow = true; // Open-Meteo hourly lacks is_day; keep day icons by default

  // Hero: prefer `current` block when present
  const curTemp = payload.current ? Math.round(payload.current.temperature_2m)
    : Math.round(hourly.temperature_2m[nowIdx]);
  const curCode = payload.current ? payload.current.weather_code : hourly.weather_code[nowIdx];
  const feels = payload.current ? payload.current.apparent_temperature
    : hourly.apparent_temperature?.[nowIdx];
  const info = wmoInfo(curCode, isDayNow);

  $('#hero-temp').textContent = `${curTemp}°`;
  $('#hero-hilo').innerHTML = `H: ${Math.round(daily.temperature_2m_max[0])}°&nbsp;&nbsp;L: ${Math.round(daily.temperature_2m_min[0])}°`;
  setIcon($('#hero-icon-use'), info.icon);
  $('#hero-icon').style.color = curCode === 0 ? '#f59e0b' : curCode >= 95 ? '#c084fc' : '#fff';
  $('#hero-summary').textContent = synthesizeSummary(hourly, nowIdx);
  $('#feels-like').textContent = feels != null ? `Feels like ${Math.round(feels)}° · ${info.text}` : info.text;
  $('#updated-label').textContent = timeAgo(fetchedAt);

  // Precip bar (next 24h)
  const bar = $('#precip-bar');
  bar.innerHTML = '';
  let maxProb = 0;
  for (let i = nowIdx; i < Math.min(nowIdx + 24, hourly.time.length); i++) {
    const p = hourly.precipitation_probability?.[i] ?? 0;
    maxProb = Math.max(maxProb, p);
    const seg = document.createElement('div');
    const cls = precipClass(p);
    seg.className = `precip-seg ${cls}`;
    const h = 12 + Math.round((p / 100) * 32);
    seg.style.height = `${h}px`;
    seg.title = `${fmtHour(hourly.time[i])}: ${p}%`;
    bar.appendChild(seg);
  }
  $('#precip-label').textContent = maxProb < 15 ? 'Dry for the next 24 hours.'
    : maxProb < 40 ? `Light chance of rain — peak ${maxProb}% in the next 24h.`
    : maxProb < 70 ? `Rain likely — peak ${maxProb}% in the next 24h.` : `Heavy precipitation window — peak ${maxProb}%.`;

  // Hourly carousel (24h)
  const hw = $('#hourly');
  hw.innerHTML = '';
  for (let i = nowIdx; i < Math.min(nowIdx + 24, hourly.time.length); i++) {
    const col = document.createElement('div');
    col.className = 'hour-col' + (i === nowIdx ? ' now' : '');
    const prob = hourly.precipitation_probability?.[i] ?? 0;
    const hi = wmoInfo(hourly.weather_code[i], true);
    col.innerHTML = `<div class="h">${i === nowIdx ? 'Now' : fmtHour(hourly.time[i])}</div>` +
      `<svg class="icon" aria-hidden="true"><use href="#${hi.icon}"/></svg>` +
      `<div class="r${prob > 20 ? ' wet' : ''}">${prob > 5 ? prob + '%' : ''}</div>` +
      `<div class="t">${Math.round(hourly.temperature_2m[i])}°</div>`;
    hw.appendChild(col);
  }

  // 10-day list with floating range bars
  const lows = daily.temperature_2m_min;
  const highs = daily.temperature_2m_max;
  const gMin = Math.min(...lows);
  const gMax = Math.max(...highs);
  const span = Math.max(1, gMax - gMin);
  const ul = $('#daily');
  ul.innerHTML = '';
  daily.time.forEach((dateISO, d) => {
    const di = wmoInfo(daily.weather_code[d], true);
    const prob = daily.precipitation_probability_max?.[d] ?? 0;
    const left = ((lows[d] - gMin) / span) * 100;
    const width = Math.max(4, ((highs[d] - lows[d]) / span) * 100);
    const li = document.createElement('li');
    li.className = 'day-row';
    li.innerHTML =
      `<button class="day-main" aria-expanded="false">` +
      `<span>${fmtDay(dateISO, d)}</span>` +
      `<svg class="icon" aria-hidden="true"><use href="#${di.icon}"/></svg>` +
      `<span class="rain${prob > 20 ? ' wet' : ''}">${prob > 5 ? prob + '%' : ''}</span>` +
      `<span class="range-track"><span class="range-fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></span>` +
      `<span><span class="day-lo">${Math.round(lows[d])}°</span> <span class="day-hi">${Math.round(highs[d])}°</span></span>` +
      `</button>` +
      `<div class="day-detail" hidden></div>`;
    const btn = li.querySelector('.day-main');
    const detail = li.querySelector('.day-detail');
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      detail.hidden = open;
      if (!open) {
        const gust = daily.wind_gusts_10m_max?.[d];
        const uv = daily.uv_index_max?.[d];
        const hum = hourly.relative_humidity_2m
          ? Math.round(avgForDay(hourly, d, daily.time[d], 'relative_humidity_2m'))
          : null;
        const fmtT = (iso) => iso ? fmtHour(iso) : '—';
        detail.innerHTML =
          `<span>Precip: ${daily.precipitation_sum?.[d] ?? 0} in</span>` +
          `<span>UV max: ${uv != null ? Number(uv).toFixed(1) : '—'}</span>` +
          (hum != null ? `<span>Humidity: ~${hum}%</span>` : '') +
          (gust != null ? `<span>Wind gusts: ${Math.round(gust)} mph</span>` : '') +
          `<span>Sunrise: ${fmtT(daily.sunrise?.[d])}</span>` +
          `<span>Sunset: ${fmtT(daily.sunset?.[d])}</span>`;
      }
    });
    ul.appendChild(li);
  });

  $('#offline-badge').hidden = !opts.offline;
  const badge = $('#cache-badge');
  if (opts.fromCache && !opts.offline) {
    badge.hidden = false;
    badge.textContent = `Served instantly from on-device cache (${timeAgo(fetchedAt).toLowerCase()})`;
  } else {
    badge.hidden = true;
  }

  updatePinUI();
}

function avgForDay(hourly, dayIdx, dateISO, field) {
  const prefix = dateISO; // YYYY-MM-DD
  let sum = 0, n = 0;
  hourly.time.forEach((t, i) => {
    if (t.startsWith(prefix) && hourly[field]?.[i] != null) { sum += hourly[field][i]; n++; }
  });
  return n ? sum / n : NaN;
}

/* ---------- Location flows ---------- */
function setLocation(lat, lon, name, { save = true } = {}) {
  state.lat = lat; state.lon = lon; state.name = name;
  state.liveMode = true;
  $('#location-title').textContent = name;
  if (save) {
    try { localStorage.setItem(LAST_LOC_KEY, JSON.stringify({ lat, lon, name })); } catch { /* ignore */ }
  }
  return refresh(false);
}

async function refresh(force = false) {
  if (state.lat == null) return;
  try {
    const { payload, fetchedAt, offline, fromCache } = await loadForecast(state.lat, state.lon, { force });
    render(payload, fetchedAt, { offline, fromCache });
  } catch {
    $('#hero-summary').textContent = 'No network and no cached data. Connect once to cache this location.';
  }
}

function requestGPS() {
  if (!('geolocation' in navigator)) {
    openModal('search-modal');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, 'Current Location'),
    () => {
      // Fallback: last location → pinned → search modal
      try {
        const last = JSON.parse(localStorage.getItem(LAST_LOC_KEY) || 'null');
        if (last) { setLocation(last.lat, last.lon, last.name); return; }
      } catch { /* ignore */ }
      const pinned = getPinned();
      if (pinned.length) { setLocation(pinned[0].lat, pinned[0].lon, pinned[0].name); return; }
      $('#location-title').textContent = 'Search for a city';
      openModal('search-modal');
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
  );
}

/* ---------- Pinned locations ---------- */
function updatePinUI() {
  const pinned = getPinned();
  const isPinned = pinned.some((p) => Math.abs(p.lat - state.lat) < 0.01 && Math.abs(p.lon - state.lon) < 0.01);
  $('#pin-toggle').setAttribute('aria-pressed', String(isPinned));
  const ul = $('#pinned-list');
  ul.innerHTML = '';
  if (!pinned.length) {
    ul.innerHTML = '<li class="dim small" style="padding:4px 2px">No pinned locations yet. Tap the pin icon to save this one.</li>';
    return;
  }
  pinned.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<button class="drawer-item"><span class="grow">${escapeHtml(p.name)}<span class="sub">${escapeHtml(p.country || '')} · ${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</span></span><span class="unpin" role="button" aria-label="Unpin ${escapeHtml(p.name)}" tabindex="0">×</span></button>`;
    const btn = li.querySelector('.drawer-item');
    btn.addEventListener('click', (e) => {
      if (e.target.classList.contains('unpin')) {
        setPinned(getPinned().filter((x) => !(x.lat === p.lat && x.lon === p.lon)));
        updatePinUI();
        return;
      }
      closeDrawer();
      setLocation(p.lat, p.lon, p.name);
    });
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Modals / drawer ---------- */
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').hidden = false;
  updatePinUI();
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-scrim').hidden = true;
}

/* ---------- Search ---------- */
let searchTimer = null;
async function runSearch(q) {
  const box = $('#search-results');
  if (!q.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = '<li class="dim small">Searching…</li>';
  try {
    const res = await fetch(geocodeURL(q.trim()));
    if (!res.ok) throw new Error('search failed');
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) { box.innerHTML = '<li class="dim small">No results.</li>'; return; }
    box.innerHTML = '';
    items.forEach((r) => {
      const li = document.createElement('li');
      const label = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ' (' + r.country + ')' : ''}`;
      li.innerHTML = `<button>${escapeHtml(label)}</button>`;
      li.querySelector('button').addEventListener('click', () => {
        closeModal('search-modal');
        setLocation(r.latitude, r.longitude, r.name);
      });
      box.appendChild(li);
    });
  } catch {
    box.innerHTML = '<li class="dim small">Search failed while offline.</li>';
  }
}

/* ---------- Time Machine ---------- */
async function runTimeMachine() {
  const date = $('#time-input').value;
  const out = $('#time-result');
  if (!date) { out.textContent = 'Pick a date first.'; return; }
  if (state.lat == null) { out.textContent = 'Set a location first.'; return; }
  out.textContent = 'Loading archive…';
  try {
    const res = await fetch(archiveURL(state.lat, state.lon, date));
    if (!res.ok) throw new Error(`Archive HTTP ${res.status}`);
    const data = await res.json();
    const hi = Math.round(data.daily.temperature_2m_max[0]);
    const lo = Math.round(data.daily.temperature_2m_min[0]);
    const pr = data.daily.precipitation_sum?.[0] ?? 0;
    const code = data.daily.weather_code?.[0];
    const desc = code != null ? wmoInfo(code).text : '—';
    state.liveMode = false;
    out.innerHTML = `<strong style="color:#fff">${escapeHtml(date)}</strong> @ ${escapeHtml(state.name)} — H: ${hi}° L: ${lo}°, precip ${pr} in. ${escapeHtml(desc)}. <br><span class="small">Live forecast untouched; tap “Back to live”.</span>`;
  } catch {
    out.textContent = 'Archive unavailable offline or for future dates.';
  }
}

/* ---------- Wiring ---------- */
function wire() {
  $('#drawer-btn').addEventListener('click', openDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#use-gps').addEventListener('click', () => { closeDrawer(); $('#location-title').textContent = 'Locating…'; requestGPS(); });

  $('#search-btn').addEventListener('click', () => { openModal('search-modal'); setTimeout(() => $('#search-input').focus(), 50); });
  $('#timemachine-btn').addEventListener('click', () => {
    openModal('time-modal');
    const input = $('#time-input');
    const today = new Date();
    const max = new Date(today.getTime() - 6 * 864e5).toISOString().slice(0, 10); // ERA5 latency ~5 days
    input.max = max;
    if (!input.value) input.value = max;
  });

  document.querySelectorAll('.modal-close').forEach((b) =>
    b.addEventListener('click', () => closeModal(b.dataset.close)));
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)); closeDrawer(); }
  });

  $('#pin-toggle').addEventListener('click', () => {
    if (state.lat == null) return;
    const pinned = getPinned();
    const idx = pinned.findIndex((p) => Math.abs(p.lat - state.lat) < 0.01 && Math.abs(p.lon - state.lon) < 0.01);
    if (idx >= 0) pinned.splice(idx, 1);
    else pinned.push({ name: state.name, lat: state.lat, lon: state.lon, country: '' });
    setPinned(pinned);
    updatePinUI();
  });

  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 350);
  });

  $('#time-go').addEventListener('click', runTimeMachine);
  $('#time-back').addEventListener('click', () => { closeModal('time-modal'); refresh(true); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.lat != null && state.liveMode) {
      if (Date.now() - state.fetchedAt > FOREGROUND_REVALIDATE_MS) refresh(true);
    }
  });

  setInterval(() => {
    if (state.fetchedAt) $('#updated-label').textContent = timeAgo(state.fetchedAt);
  }, 60000);
}

/* ---------- Boot ---------- */
function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline-first optional */ });
    });
  }
}

wire();
registerSW();
requestGPS();
