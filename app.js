/* Nimbus Noir — zero-backend client engine (ES Modules, vanilla) */
'use strict';

const $ = (sel) => document.querySelector(sel);

/* ================= Units (spec Gap 3) ================= */
const UNIT_KEY = 'nimbus_units';
function defaultUnits() {
  try {
    const lang = navigator.language || 'en-US';
    return /-(US|LR|MM)$/i.test(lang) ? 'imperial' : 'metric';
  } catch { return 'imperial'; }
}
function getUnits() {
  try { return localStorage.getItem(UNIT_KEY) || defaultUnits(); }
  catch { return defaultUnits(); }
}
function setUnits(u) { try { localStorage.setItem(UNIT_KEY, u); } catch { /* ignore */ } }
function unitParams(u) {
  return u === 'metric'
    ? { temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' }
    : { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' };
}
const degLabel = () => (getUnits() === 'metric' ? '°C' : '°F');
const speedLabel = () => (getUnits() === 'metric' ? 'km/h' : 'mph');
function fmtPrecip(v) {
  if (v == null) return '—';
  return getUnits() === 'metric' ? `${Number(v).toFixed(1)} mm` : `${Number(v).toFixed(2)} in`;
}

/* ================= Cache (units are part of the key) ================= */
const CACHE_TTL_MS = 15 * 60 * 1000;
const FOREGROUND_REVALIDATE_MS = 20 * 60 * 1000;
const PIN_KEY = 'nimbus_pinned_locations';
const LAST_LOC_KEY = 'nimbus_last_location';

const state = { lat: null, lon: null, name: 'Locating...', payload: null, fetchedAt: 0, liveMode: true };

function cacheKey(lat, lon) {
  return `nimbus_forecast_${Number(lat).toFixed(3)}_${Number(lon).toFixed(3)}_${getUnits()}`;
}
function readCache(lat, lon) {
  try { const raw = localStorage.getItem(cacheKey(lat, lon)); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function writeCache(lat, lon, payload) {
  try { localStorage.setItem(cacheKey(lat, lon), JSON.stringify({ timestamp: Date.now(), payload })); }
  catch { /* private mode — non-fatal */ }
}
function getPinned() {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); }
  catch { return []; }
}
function setPinned(list) { try { localStorage.setItem(PIN_KEY, JSON.stringify(list)); } catch { /* ignore */ } }
function buzz() { try { if (navigator.vibrate) navigator.vibrate(10); } catch { /* ignore */ } }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= WMO mapping ================= */
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

/* ================= API contracts ================= */
function forecastURL(lat, lon) {
  const p = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    models: 'best_match', // HRRR 3km (0–48h) → ECMWF IFS 9km (48–240h)
    current: 'temperature_2m,apparent_temperature,weather_code',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,uv_index,surface_pressure',
    minutely_15: 'precipitation,precipitation_probability,weather_code', // Gap 1: sub-hourly
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_gusts_10m_max',
    forecast_days: '10',
    ...unitParams(getUnits()),
    timezone: 'auto',
  });
  return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}
function archiveURL(lat, lon, date) {
  const p = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), start_date: date, end_date: date,
    hourly: 'temperature_2m,precipitation,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    ...unitParams(getUnits()),
    timezone: 'auto',
  });
  return `https://archive-api.open-meteo.com/v1/archive?${p.toString()}`;
}
function geocodeURL(q) {
  return `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '5', language: 'en', format: 'json' }).toString()}`;
}
function reverseURL(lat, lon) {
  return `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
}

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

/* ================= Helpers ================= */
function hourIndex(hourlyTime, now = new Date()) {
  let best = 0;
  for (let i = 0; i < hourlyTime.length; i++) {
    if (new Date(hourlyTime[i]) <= now) best = i; else break;
  }
  return best;
}
function fmtHour(iso) {
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  return `${h} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}
function fmtDay(iso, idx) {
  if (idx === 0) return 'Today';
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
}
function timeAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? 'Updated just now' : m === 1 ? 'Updated 1m ago' : `Updated ${m}m ago`;
}
function precipClass(p) {
  if (p == null || p < 15) return 'dry';
  if (p < 40) return 'light';
  if (p < 70) return 'medium';
  return 'heavy';
}
function synthesizeSummary(hourly, startIdx) {
  const slice = [];
  for (let i = startIdx; i < Math.min(startIdx + 12, hourly.time.length); i++) {
    slice.push({ code: hourly.weather_code[i], prob: hourly.precipitation_probability?.[i] ?? 0, time: hourly.time[i] });
  }
  if (!slice.length) return 'Forecast unavailable.';
  const counts = {};
  for (const s of slice) { const t = wmoInfo(s.code).text; counts[t] = (counts[t] || 0) + 1; }
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const first = wmoInfo(slice[0].code).text;
  let sentence = (slice[0].prob < 15 && slice[0].code <= 3 && first !== dominant)
    ? `${first} to start, turning ${dominant.toLowerCase()} later.`
    : `${dominant} throughout the day.`;
  const wet = slice.find((s) => (s.prob ?? 0) >= 30);
  if (wet) {
    const kind = wet.code >= 71 && wet.code <= 77 ? 'snow' : wet.code >= 95 ? 'thunderstorms' : wet.code >= 51 && wet.code <= 55 ? 'drizzle' : 'rain';
    const strength = wet.prob >= 70 ? 'Heavy' : wet.prob >= 40 ? 'Steady' : 'Light';
    sentence += ` ${strength} ${kind} starting around ${fmtHour(wet.time)}.`;
  } else if ((slice[0].prob ?? 0) < 15) {
    sentence += ' No meaningful precipitation expected.';
  }
  return sentence;
}

/* ================= Moon + solar (spec 2.3, pure client-side) ================= */
const SYNODIC = 29.53058867;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14) / 864e5;
const MOON_NAMES = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
const MOON_ICONS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
function moonPhase(nowMs = Date.now()) {
  const age = (((nowMs / 864e5 - NEW_MOON_REF) % SYNODIC) + SYNODIC) % SYNODIC;
  const idx = Math.floor((age / SYNODIC) * 8 + 0.5) % 8;
  return { age, idx, name: MOON_NAMES[idx], icon: MOON_ICONS[idx] };
}
function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 36e5), m = Math.round((ms % 36e5) / 6e4);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function solarCountdown(daily) {
  try {
    const now = Date.now();
    const sr = new Date(daily.sunrise[0]).getTime();
    const ss = new Date(daily.sunset[0]).getTime();
    if (now < sr) return `Sunrise in ${fmtCountdown(sr - now)}`;
    if (now < ss) return `Sunset in ${fmtCountdown(ss - now)}`;
    return `Sunrise in ${fmtCountdown(sr + 864e5 - now)}`;
  } catch { return '—'; }
}

/* ================= Pressure vector (spec 2.2) ================= */
function pressureTrend(hourly, idx) {
  const p = hourly.surface_pressure;
  if (!p || p[idx] == null || p[idx - 3] == null) return null;
  const d = p[idx] - p[idx - 3];
  if (d >= 1.5) return { arrow: '↑', prose: 'Rising rapidly (clearing skies)' };
  if (d >= 0.5) return { arrow: '↗', prose: 'Rising' };
  if (d > -0.5) return { arrow: '→', prose: 'Steady' };
  if (d >= -1.5) return { arrow: '↘', prose: 'Falling' };
  return { arrow: '↓', prose: 'Falling rapidly (storm approaching)' };
}

/* ================= Render ================= */
function setIcon(useEl, iconId) { useEl.setAttribute('href', `#${iconId}`); }

function render(payload, fetchedAt, opts = {}) {
  state.payload = payload;
  state.fetchedAt = fetchedAt;
  const { hourly, daily } = payload;
  const nowIdx = hourIndex(hourly.time);

  const curTemp = payload.current ? Math.round(payload.current.temperature_2m) : Math.round(hourly.temperature_2m[nowIdx]);
  const curCode = payload.current ? payload.current.weather_code : hourly.weather_code[nowIdx];
  const feels = payload.current ? payload.current.apparent_temperature : hourly.apparent_temperature?.[nowIdx];
  const info = wmoInfo(curCode, true);

  $('#hero-temp').textContent = `${curTemp}`;
  $('#hero-unit-label').textContent = getUnits() === 'metric' ? '°C' : '°';
  $('#hero-high').textContent = `H: ${Math.round(daily.temperature_2m_max[0])}°`;
  $('#hero-low').textContent = `L: ${Math.round(daily.temperature_2m_min[0])}°`;
  setIcon($('#hero-icon-use'), info.icon);
  $('#hero-icon').style.color = curCode === 0 ? '#f59e0b' : curCode >= 95 ? '#c084fc' : '#fff';
  $('#hero-prose').textContent = synthesizeSummary(hourly, nowIdx);
  $('#feels-like').textContent = feels != null ? `Feels like ${Math.round(feels)}° · ${info.text}` : info.text;
  $('#hero-updated').textContent = timeAgo(fetchedAt);
  $('#btn-unit-toggle').textContent = getUnits() === 'metric' ? '°C' : '°F';

  drawMinutely(payload.minutely_15);

  // 24h hourly precip bar
  const bar = $('#precip-bar');
  bar.innerHTML = '';
  let maxProb = 0;
  for (let i = nowIdx; i < Math.min(nowIdx + 24, hourly.time.length); i++) {
    const p = hourly.precipitation_probability?.[i] ?? 0;
    maxProb = Math.max(maxProb, p);
    const seg = document.createElement('div');
    seg.className = `precip-seg ${precipClass(p)}`;
    seg.style.height = `${12 + Math.round((p / 100) * 32)}px`;
    seg.title = `${fmtHour(hourly.time[i])}: ${p}%`;
    bar.appendChild(seg);
  }
  $('#precip-label').textContent = maxProb < 15 ? 'Dry for the next 24 hours.'
    : maxProb < 40 ? `Light chance — peak ${maxProb}% in the next 24h.`
    : maxProb < 70 ? `Rain likely — peak ${maxProb}% in the next 24h.` : `Heavy precipitation window — peak ${maxProb}%.`;

  // Barometer
  const trend = pressureTrend(hourly, nowIdx);
  const presNow = hourly.surface_pressure?.[nowIdx];
  $('#val-pressure').textContent = presNow != null ? `${Math.round(presNow)} hPa` : '--';
  $('#val-pressure-trend').textContent = trend ? trend.arrow : '--';
  $('#val-pressure-prose').textContent = trend ? `${trend.prose} (ΔP/3h)` : 'Calculating 3h delta';

  // Moon + solar
  const moon = moonPhase();
  $('#val-moon-icon').textContent = moon.icon;
  $('#val-moon-name').textContent = moon.name;
  $('#val-solar-countdown').textContent = solarCountdown(daily);

  // Hourly carousel
  const hw = $('#hourly-carousel');
  hw.innerHTML = '';
  for (let i = nowIdx; i < Math.min(nowIdx + 24, hourly.time.length); i++) {
    const prob = hourly.precipitation_probability?.[i] ?? 0;
    const hi = wmoInfo(hourly.weather_code[i], true);
    const col = document.createElement('div');
    col.className = 'hour-col' + (i === nowIdx ? ' now' : '');
    col.innerHTML = `<div class="h">${i === nowIdx ? 'Now' : fmtHour(hourly.time[i])}</div>` +
      `<svg class="icon" aria-hidden="true"><use href="#${hi.icon}"/></svg>` +
      `<div class="r${prob > 20 ? ' wet' : ''}">${prob > 5 ? prob + '%' : ''}</div>` +
      `<div class="t">${Math.round(hourly.temperature_2m[i])}°</div>`;
    hw.appendChild(col);
  }

  // 10-day list
  const lows = daily.temperature_2m_min, highs = daily.temperature_2m_max;
  const gMin = Math.min(...lows), gMax = Math.max(...highs);
  const span = Math.max(1, gMax - gMin);
  const ul = $('#daily-list');
  ul.innerHTML = '';
  daily.time.forEach((dateISO, d) => {
    const di = wmoInfo(daily.weather_code[d], true);
    const prob = daily.precipitation_probability_max?.[d] ?? 0;
    const left = ((lows[d] - gMin) / span) * 100;
    const width = Math.max(4, ((highs[d] - lows[d]) / span) * 100);
    const li = document.createElement('li');
    li.className = 'day-row';
    li.innerHTML = `<button class="day-main" aria-expanded="false">` +
      `<span>${fmtDay(dateISO, d)}</span>` +
      `<svg class="icon" aria-hidden="true"><use href="#${di.icon}"/></svg>` +
      `<span class="rain${prob > 20 ? ' wet' : ''}">${prob > 5 ? prob + '%' : ''}</span>` +
      `<span class="range-track"><span class="range-fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></span>` +
      `<span><span class="day-lo">${Math.round(lows[d])}°</span> <span class="day-hi">${Math.round(highs[d])}°</span></span>` +
      `</button><div class="day-detail" hidden></div>`;
    const btn = li.querySelector('.day-main');
    const detail = li.querySelector('.day-detail');
    btn.addEventListener('click', () => {
      buzz();
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      detail.hidden = open;
      if (!open) {
        const gust = daily.wind_gusts_10m_max?.[d];
        const uv = daily.uv_index_max?.[d];
        const hum = hourly.relative_humidity_2m ? Math.round(avgForDay(hourly, daily.time[d], 'relative_humidity_2m')) : NaN;
        const fmtT = (iso) => (iso ? fmtHour(iso) : '—');
        detail.innerHTML =
          `<span>Precip: ${daily.precipitation_sum?.[d] != null ? fmtPrecip(daily.precipitation_sum[d]) : '—'}</span>` +
          `<span>UV max: ${uv != null ? Number(uv).toFixed(1) : '—'}</span>` +
          (Number.isFinite(hum) ? `<span>Humidity: ~${hum}%</span>` : '') +
          (gust != null ? `<span>Gusts: ${Math.round(gust)} ${speedLabel()}</span>` : '') +
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
  } else badge.hidden = true;

  updatePinUI();
}

/* ---- Gap 1: sub-hourly canvas (first 8 minutely_15 points = 2h) ---- */
function drawMinutely(minutely) {
  const canvas = $('#precip-timeline');
  const labels = canvas.closest('.precip-card').querySelector('.precip-labels');
  if (!minutely || !minutely.time || !minutely.time.length) {
    canvas.closest('.canvas-container').style.display = 'none';
    labels.style.display = 'none';
    $('#precip-summary-flag').textContent = '—';
    return;
  }
  canvas.closest('.canvas-container').style.display = '';
  labels.style.display = '';
  const now = Date.now();
  let start = 0;
  while (start < minutely.time.length - 1 && new Date(minutely.time[start]).getTime() < now - 15 * 6e4) start++;
  const N = Math.min(8, minutely.time.length - start);
  const probs = [], amounts = [];
  for (let i = 0; i < N; i++) {
    probs.push(minutely.precipitation_probability?.[start + i] ?? 0);
    amounts.push(minutely.precipitation?.[start + i] ?? 0);
  }
  const maxP = Math.max(...probs);
  $('#precip-summary-flag').textContent = maxP < 5 ? 'Dry' : `${maxP}% Chance`;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 320, h = 64;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const gap = 3, bw = (w - gap * (N - 1)) / N;
  const maxAmt = Math.max(0.02, ...amounts);
  probs.forEach((p, i) => {
    const bh = 6 + (p / 100) * (h - 10);
    const x = i * (bw + gap), y = h - bh;
    const cls = precipClass(p);
    ctx.fillStyle = cls === 'dry' ? '#202936'
      : cls === 'light' ? 'rgba(56,189,248,0.45)'
      : cls === 'medium' ? 'rgba(56,189,248,0.75)' : '#38bdf8';
    // Intensity alpha scaled by actual amount
    ctx.globalAlpha = cls === 'dry' ? 1 : 0.55 + 0.45 * (amounts[i] / maxAmt);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, bw, bh, 3) : ctx.rect(x, y, bw, bh);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  // Dynamic axis labels matching the N×15m window
  labels.innerHTML = '';
  for (let k = 0; k <= 4; k++) {
    const mins = Math.round((k * N * 15) / 4);
    const s = document.createElement('span');
    s.textContent = mins === 0 ? 'Now' : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
    labels.appendChild(s);
  }
}

function avgForDay(hourly, dateISO, field) {
  let sum = 0, n = 0;
  hourly.time.forEach((t, i) => {
    if (t.startsWith(dateISO) && hourly[field]?.[i] != null) { sum += hourly[field][i]; n++; }
  });
  return n ? sum / n : NaN;
}

/* ================= Severe alerts via NWS (spec 2.1) ================= */
async function loadAlerts(lat, lon) {
  const banner = $('#severe-alert');
  banner.hidden = true;
  try {
    const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, {
      headers: { Accept: 'application/geo+json' },
    });
    if (!res.ok) return; // off-US or unavailable — stay silent
    const data = await res.json();
    const feats = (data.features || []).map((f) => f.properties).filter(Boolean);
    if (!feats.length) return;
    $('#alert-title').textContent = feats[0].event || 'Weather Advisory Active';
    $('#alert-count').textContent = feats.length > 1 ? `+${feats.length - 1} more` : '';
    $('#alert-body').textContent = feats
      .map((p) => `${p.event}${p.headline ? ` — ${p.headline}` : ''}`)
      .join('\n\n') + (feats[0].description ? `\n\n${feats[0].description.trim().slice(0, 800)}` : '');
    banner.hidden = false;
  } catch { /* offline — stay silent */ }
}

/* ================= Locations ================= */
function coordFallback(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}
async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(reverseURL(lat, lon));
    if (!res.ok) throw new Error('reverse failed');
    const j = await res.json();
    const place = j.locality || j.city || j.principalSubdivision || '';
    const code = (j.principalSubdivisionCode || '').split('-')[1] || j.countryCode || '';
    if (!place) throw new Error('empty');
    return code ? `${place}, ${code}` : place;
  } catch {
    return coordFallback(lat, lon); // spec fallback
  }
}

function setLocation(lat, lon, name, { save = true } = {}) {
  state.lat = lat; state.lon = lon; state.name = name; state.liveMode = true;
  $('#display-location').textContent = name;
  if (save) { try { localStorage.setItem(LAST_LOC_KEY, JSON.stringify({ lat, lon, name })); } catch { /* ignore */ } }
  return refresh(false);
}

async function refresh(force = false) {
  if (state.lat == null) return;
  try {
    const { payload, fetchedAt, offline, fromCache } = await loadForecast(state.lat, state.lon, { force });
    render(payload, fetchedAt, { offline, fromCache });
    loadAlerts(state.lat, state.lon);
  } catch {
    $('#hero-prose').textContent = 'No network and no cached data. Connect once to cache this location.';
  }
}

function requestGPS() {
  if (!('geolocation' in navigator)) { openModal('search-modal'); return; }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      state.lat = latitude; state.lon = longitude; state.liveMode = true;
      $('#display-location').textContent = 'Locating...';
      refresh(false); // instant paint from cache/network
      const name = await reverseGeocode(latitude, longitude); // Gap 2
      state.name = name;
      $('#display-location').textContent = name;
      try { localStorage.setItem(LAST_LOC_KEY, JSON.stringify({ lat: latitude, lon: longitude, name })); } catch { /* ignore */ }
      updatePinUI();
    },
    () => {
      try {
        const last = JSON.parse(localStorage.getItem(LAST_LOC_KEY) || 'null');
        if (last) { setLocation(last.lat, last.lon, last.name); return; }
      } catch { /* ignore */ }
      const pinned = getPinned();
      if (pinned.length) { setLocation(pinned[0].lat, pinned[0].lon, pinned[0].name); return; }
      $('#display-location').textContent = 'Search for a city';
      openModal('search-modal');
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
  );
}

/* ================= Pinned ================= */
function updatePinUI() {
  const pinned = getPinned();
  const isPinned = state.lat != null && pinned.some((p) => Math.abs(p.lat - state.lat) < 0.01 && Math.abs(p.lon - state.lon) < 0.01);
  $('#pin-toggle').setAttribute('aria-pressed', String(isPinned));
  const ul = $('#pinned-list');
  ul.innerHTML = '';
  if (!pinned.length) {
    ul.innerHTML = '<li class="dim small" style="padding:4px 2px">No pinned locations yet. Tap the pin icon to save this one.</li>';
    return;
  }
  pinned.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<button class="drawer-item"><span class="grow">${escapeHtml(p.name)}<span class="sub">${escapeHtml(p.country || '')} · ${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</span></span><span class="unpin" role="button" aria-label="Unpin" tabindex="0">×</span></button>`;
    li.querySelector('.drawer-item').addEventListener('click', (e) => {
      buzz();
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

/* ================= Modals / drawer ================= */
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) {
  document.getElementById(id).hidden = true;
  if (id === 'radar-modal') stopRadar();
}
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

/* ================= Search ================= */
let searchTimer = null;
async function runSearch(q) {
  const box = $('#search-results');
  if (!q.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = '<li class="dim small">Searching…</li>';
  try {
    const res = await fetch(geocodeURL(q.trim()));
    if (!res.ok) throw new Error('search failed');
    const items = (await res.json()).results || [];
    if (!items.length) { box.innerHTML = '<li class="dim small">No results.</li>'; return; }
    box.innerHTML = '';
    items.forEach((r) => {
      const label = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ' (' + r.country + ')' : ''}`;
      const li = document.createElement('li');
      li.innerHTML = `<button>${escapeHtml(label)}</button>`;
      li.querySelector('button').addEventListener('click', () => {
        buzz();
        closeModal('search-modal');
        setLocation(r.latitude, r.longitude, r.name);
      });
      box.appendChild(li);
    });
  } catch { box.innerHTML = '<li class="dim small">Search failed while offline.</li>'; }
}

/* ================= Time Machine ================= */
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
    const desc = data.daily.weather_code?.[0] != null ? wmoInfo(data.daily.weather_code[0]).text : '—';
    state.liveMode = false;
    out.innerHTML = `<strong style="color:#fff">${escapeHtml(date)}</strong> @ ${escapeHtml(state.name)} — H: ${hi}${degLabel()} L: ${lo}${degLabel()}, precip ${escapeHtml(fmtPrecip(pr))}. ${escapeHtml(desc)}.<br><span class="small">Live forecast untouched; tap “Back to live”.</span>`;
  } catch { out.textContent = 'Archive unavailable offline or for future dates.'; }
}

/* ================= Radar (RainViewer, Gap 4, on-demand) ================= */
const radar = { frames: [], i: 0, timer: null };
function lon2x(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function lat2y(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
async function openRadar() {
  buzz();
  if (state.lat == null) return;
  openModal('radar-modal');
  const map = $('#radar-map');
  if (!radar.frames.length) {
    $('#radar-time').textContent = 'Loading…';
    try {
      const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
      if (!res.ok) throw new Error('radar unavailable');
      const j = await res.json();
      radar.frames = [...(j.radar?.past || []), ...(j.radar?.nowcast || [])];
    } catch {
      $('#radar-time').textContent = 'Radar unavailable offline.';
      return;
    }
    if (!radar.frames.length) { $('#radar-time').textContent = 'No radar frames.'; return; }
    buildRadarTiles();
  }
  startRadar();
}
function buildRadarTiles() {
  const z = 8, cx = lon2x(state.lon, z), cy = lat2y(state.lat, z);
  const map = $('#radar-map');
  map.innerHTML = '';
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = cx + dx, y = cy + dy;
      const base = document.createElement('img');
      base.className = 'tile';
      base.alt = '';
      base.loading = 'lazy';
      base.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
      base.style.left = `${(dx + 1) * 33.3334}%`;
      base.style.top = `${(dy + 1) * 33.3334}%`;
      base.style.filter = 'grayscale(1) brightness(0.55) contrast(1.1)';
      map.appendChild(base);
      const ov = document.createElement('img');
      ov.className = 'tile radar-ov';
      ov.alt = '';
      ov.dataset.x = x; ov.dataset.y = y;
      ov.style.left = base.style.left;
      ov.style.top = base.style.top;
      map.appendChild(ov);
    }
  }
  const pin = document.createElement('div');
  pin.className = 'radar-pin';
  map.appendChild(pin);
  const attr = document.createElement('div');
  attr.setAttribute('style', 'position:absolute;right:6px;bottom:4px;font-size:10px;color:#8b98a5;background:rgba(17,22,29,.7);padding:1px 6px;border-radius:6px;z-index:6;');
  attr.innerHTML = '© <a href="https://www.openstreetmap.org/copyright" rel="noopener" style="color:#8b98a5">OSM</a> · <a href="https://www.rainviewer.com/" rel="noopener" style="color:#8b98a5">RainViewer</a>';
  map.appendChild(attr);
}
function paintRadarFrame() {
  const f = radar.frames[radar.i];
  if (!f) return;
  document.querySelectorAll('#radar-map img.radar-ov').forEach((img) => {
    img.src = `https://tilecache.rainviewer.com${f.path}/256/8/${img.dataset.x}/${img.dataset.y}/2/1_1.png`;
  });
  $('#radar-time').textContent = new Date(f.time * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function startRadar() {
  stopRadar(true);
  radar.i = Math.max(0, radar.frames.length - 1);
  paintRadarFrame();
  $('#radar-play').textContent = 'Pause';
  radar.timer = setInterval(() => {
    radar.i = (radar.i + 1) % radar.frames.length;
    paintRadarFrame();
  }, 900);
  radar.playing = true;
}
function stopRadar(keepOpen = false) {
  if (radar.timer) clearInterval(radar.timer);
  radar.timer = null;
  radar.playing = false;
  if (!keepOpen) {
    const btn = $('#radar-play');
    if (btn) btn.textContent = 'Play';
  }
}

/* ================= Share (spec 2.4) ================= */
async function shareSnapshot() {
  buzz();
  const temp = $('#hero-temp').textContent;
  const prose = $('#hero-prose').textContent;
  const text = `${state.name}: ${temp}${getUnits() === 'metric' ? '°C' : '°'} — ${prose} (via Nimbus Noir)`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Nimbus Noir', text, url: location.href }); } catch { /* dismissed */ }
  } else if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      const badge = $('#cache-badge');
      badge.hidden = false;
      badge.textContent = 'Snapshot copied to clipboard';
      setTimeout(() => { badge.hidden = true; }, 2500);
    } catch { /* ignore */ }
  }
}

/* ================= Wiring ================= */
function wire() {
  $('#drawer-btn').addEventListener('click', () => { buzz(); openDrawer(); });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#use-gps').addEventListener('click', () => { buzz(); closeDrawer(); $('#display-location').textContent = 'Locating...'; requestGPS(); });

  const openSearch = () => { buzz(); openModal('search-modal'); setTimeout(() => $('#search-input').focus(), 50); };
  $('#btn-open-search').addEventListener('click', (e) => {
    if (e.target.closest('#pin-toggle')) return; // pin has its own handler
    openSearch();
  });
  $('#btn-open-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') openSearch(); });

  $('#timemachine-btn').addEventListener('click', () => {
    buzz();
    openModal('time-modal');
    const input = $('#time-input');
    const max = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10); // ERA5 latency ~5d
    input.max = max;
    if (!input.value) input.value = max;
  });

  $('#btn-unit-toggle').addEventListener('click', async () => {
    buzz();
    setUnits(getUnits() === 'metric' ? 'imperial' : 'metric');
    $('#btn-unit-toggle').textContent = getUnits() === 'metric' ? '°C' : '°F';
    await refresh(true); // new units = new cache key = refetch
  });

  $('#btn-radar').addEventListener('click', openRadar);
  $('#radar-play').addEventListener('click', () => {
    buzz();
    if (radar.playing) { stopRadar(); $('#radar-play').textContent = 'Play'; }
    else startRadar();
  });

  $('#btn-share').addEventListener('click', shareSnapshot);

  $('#alert-toggle').addEventListener('click', () => {
    const body = $('#alert-body');
    const open = body.hidden;
    body.hidden = !open;
    $('#alert-toggle').setAttribute('aria-expanded', String(open));
  });

  document.querySelectorAll('.modal-close').forEach((b) =>
    b.addEventListener('click', () => { buzz(); closeModal(b.dataset.close); }));
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach((m) => { if (!m.hidden) closeModal(m.id); }); closeDrawer(); }
  });

  $('#pin-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    buzz();
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

  $('#time-go').addEventListener('click', () => { buzz(); runTimeMachine(); });
  $('#time-back').addEventListener('click', () => { closeModal('time-modal'); refresh(true); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.lat != null && state.liveMode) {
      if (Date.now() - state.fetchedAt > FOREGROUND_REVALIDATE_MS) refresh(true);
    }
  });
  setInterval(() => { if (state.fetchedAt) $('#hero-updated').textContent = timeAgo(state.fetchedAt); }, 60000);
  window.addEventListener('resize', () => { if (state.payload) drawMinutely(state.payload.minutely_15); });
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* optional */ });
    });
  }
}

wire();
registerSW();
requestGPS();
