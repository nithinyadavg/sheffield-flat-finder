/* Find the flat that fits - Sheffield
 * Open source (MIT). No build step, no API keys.
 * Live data: OpenStreetMap via Overpass, data.police.uk, postcodes.io.
 */
(() => {
  'use strict';

  // ---------- constants ----------
  const CENTRE = [53.381, -1.47];
  const BBOX = [53.30, -1.60, 53.45, -1.32]; // south, west, north, east
  const STATION = [53.3781, -1.4620];
  const M1_JUNCTIONS = [[53.3937, -1.3866], [53.4156, -1.4137], [53.3703, -1.3043]]; // J33, J34, J31 (approx)
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  const CACHE_HOURS = 24;

  const PRIORITIES = [
    { k: 'transport', label: 'Buses & trams nearby', def: 3 },
    { k: 'shops', label: 'Supermarkets & pharmacies', def: 2 },
    { k: 'gym', label: 'Gyms & leisure', def: 1 },
    { k: 'quiet', label: 'Quiet (fewer students)', def: 2 },
    { k: 'safety', label: 'Fewer crime reports', def: 3 },
    { k: 'station', label: 'Close to train station', def: 1 },
    { k: 'motorway', label: 'Close to the M1', def: 1 },
    { k: 'work', label: 'Close to work', def: 3 },
  ];
  const LEVELS = ['Ignore', 'A little', 'Matters', 'Top priority'];

  const LAYER_STYLE = {
    bus: { label: 'Bus stops', color: '#f2c14e', r: 1.6, op: 0.55, on: true },
    tram: { label: 'Tram stops', color: '#fff3c4', r: 3.2, op: 0.95, on: true },
    shop: { label: 'Shops', color: '#ff9f43', r: 2.2, op: 0.8, on: true },
    gym: { label: 'Gyms', color: '#7fd1c7', r: 2.6, op: 0.85, on: false },
    crime: { label: 'Crime reports', color: '#e2725b', r: 1.8, op: 0.35, on: false },
  };

  // ---------- state ----------
  const state = {
    type: 'room',
    budget: 650,
    musts: new Set(['bills']),
    weights: Object.fromEntries(PRIORITIES.map(p => [p.k, p.def])),
    work: null, // {pc, lat, lng}
  };
  let AREAS = [];
  const live = { points: { bus: [], tram: [], shop: [], gym: [], crime: [] }, crime: {}, crimeMonth: null, osmOk: false, crimeOk: false };

  // ---------- helpers ----------
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const km = (a, b) => {
    const R = 6371, toR = x => x * Math.PI / 180;
    const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const store = {
    get(k) { try { const v = JSON.parse(localStorage.getItem(k)); if (v && Date.now() - v.t < CACHE_HOURS * 3600e3) return v.d; } catch (e) {} return null; },
    set(k, d) { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch (e) {} },
  };
  const setStatus = t => { $('#status').textContent = t; };

  // ---------- share state through the URL hash ----------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('t') === 'studio' || p.get('t') === 'room') state.type = p.get('t');
    if (+p.get('b')) state.budget = Math.min(1200, Math.max(300, +p.get('b')));
    if (p.has('m')) state.musts = new Set(p.get('m').split(',').filter(Boolean));
    if (p.get('w')) state.pendingWork = p.get('w');
    if (p.get('p')) p.get('p').split(',').forEach(pair => { const [k, v] = pair.split(':'); if (k in state.weights) state.weights[k] = Math.max(0, Math.min(3, +v || 0)); });
  }
  function writeHash() {
    const p = new URLSearchParams();
    p.set('t', state.type); p.set('b', state.budget); p.set('m', [...state.musts].join(','));
    p.set('p', Object.entries(state.weights).map(([k, v]) => `${k}:${v}`).join(','));
    if (state.work) p.set('w', state.work.pc);
    history.replaceState(null, '', '#' + p.toString());
  }

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(CENTRE, 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  const canvas = L.canvas({ padding: 0.5 });
  const dotLayers = Object.fromEntries(Object.keys(LAYER_STYLE).map(k => [k, L.layerGroup()]));
  const areaLayer = L.layerGroup().addTo(map);
  let workMarker = null;
  const areaShapes = {};

  function drawDots(kind) {
    const g = dotLayers[kind], s = LAYER_STYLE[kind];
    g.clearLayers();
    for (const [lat, lng] of live.points[kind]) {
      L.circleMarker([lat, lng], { renderer: canvas, radius: s.r, stroke: false, fillColor: s.color, fillOpacity: s.op, interactive: false }).addTo(g);
    }
  }

  // ---------- live data: OpenStreetMap ----------
  // 1) browser cache, 2) snapshot in data/osm.json (refreshed weekly by a GitHub Action), 3) Overpass API live.
  async function loadOSM() {
    const cached = store.get('sff-osm-v2');
    if (cached) { Object.assign(live.points, cached); live.osmOk = true; return; }
    try {
      const r = await fetch('data/osm.json', { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        Object.assign(live.points, { bus: j.bus, tram: j.tram, shop: j.shop, gym: j.gym });
        live.osmOk = true; live.osmDate = (j.fetched || '').slice(0, 10);
        return;
      }
    } catch (err) { /* no snapshot yet, go live */ }
    setStatus('fetching live OpenStreetMap data (~30 s first time)…');
    const [s, w, n, e] = BBOX;
    const bb = `(${s},${w},${n},${e})`;
    // "make sep" rows mark where each category starts, so we can skip tags and keep the download small.
    const q = `[out:json][timeout:90];
      node["highway"="bus_stop"]${bb};out skel qt;
      make sep kind="tram";out;
      node["railway"="tram_stop"]${bb};out skel qt;
      make sep kind="shop";out;
      (nwr["shop"~"^(supermarket|convenience)$"]${bb};nwr["amenity"="pharmacy"]${bb};);out center qt;
      make sep kind="gym";out;
      nwr["leisure"~"^(fitness_centre|sports_centre)$"]${bb};out center qt;`;
    let json = null;
    for (const url of OVERPASS) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90000);
      try {
        const r = await fetch(url, { method: 'POST', signal: ac.signal, body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (r.ok) { json = await r.json(); break; }
      } catch (err) { /* try next mirror */ } finally { clearTimeout(timer); }
    }
    if (!json) throw new Error('OpenStreetMap data unavailable');
    const pts = { bus: [], tram: [], shop: [], gym: [] };
    let kind = 'bus';
    for (const x of json.elements) {
      if (x.type === 'sep') { kind = x.tags.kind; continue; }
      const lat = x.lat ?? x.center?.lat, lng = x.lon ?? x.center?.lon;
      if (lat == null || !pts[kind]) continue;
      pts[kind].push([+lat.toFixed(5), +lng.toFixed(5)]);
    }
    Object.assign(live.points, pts);
    live.osmOk = true; live.osmDate = new Date().toISOString().slice(0, 10);
    store.set('sff-osm-v2', pts);
  }

  // ---------- live data: police.uk street crime ----------
  function crimePoly(a) {
    const dLat = 0.0055, dLng = 0.009; // ~1.2 km x 1.2 km box around the area centre
    return [[a.lat - dLat, a.lng - dLng], [a.lat - dLat, a.lng + dLng], [a.lat + dLat, a.lng + dLng], [a.lat + dLat, a.lng - dLng]]
      .map(p => p.map(v => v.toFixed(4)).join(',')).join(':');
  }
  async function loadCrime() {
    const cached = store.get('sff-crime-v1');
    if (cached) { live.crime = cached.counts; live.points.crime = cached.pts; live.crimeMonth = cached.month; live.crimeOk = true; return; }
    try {
      const r = await fetch('data/crime.json', { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        if (j.counts && Object.keys(j.counts).length) { live.crime = j.counts; live.points.crime = j.pts || []; live.crimeMonth = j.month; live.crimeOk = true; return; }
      }
    } catch (err) { /* fall back to the live API */ }
    const counts = {}, pts = [];
    let month = null;
    const queue = [...AREAS];
    async function worker() {
      while (queue.length) {
        const a = queue.shift();
        try {
          const r = await fetch(`https://data.police.uk/api/crimes-street/all-crime?poly=${crimePoly(a)}`);
          if (!r.ok) continue;
          const list = await r.json();
          counts[a.id] = list.length;
          for (const c of list) {
            if (!month && c.month) month = c.month;
            if (c.location) pts.push([+c.location.latitude, +c.location.longitude]);
          }
        } catch (err) { /* skip this area */ }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (!Object.keys(counts).length) throw new Error('Crime data unavailable');
    live.crime = counts; live.points.crime = pts; live.crimeMonth = month; live.crimeOk = true;
    store.set('sff-crime-v1', { counts, pts, month });
  }

  // ---------- metrics & scoring ----------
  const countNear = (pts, c, radiusKm) => pts.reduce((n, p) => n + (km(c, p) <= radiusKm ? 1 : 0), 0);

  function computeMetrics() {
    for (const a of AREAS) {
      const c = [a.lat, a.lng];
      const m = a.m = {};
      m.bus = countNear(live.points.bus, c, 0.6);
      m.tram = countNear(live.points.tram, c, 0.8);
      m.shops = countNear(live.points.shop, c, 0.8);
      m.gyms = countNear(live.points.gym, c, 1.2);
      m.crime = live.crime[a.id];
      m.stationKm = km(c, STATION);
      m.m1Km = Math.min(...M1_JUNCTIONS.map(j => km(c, j)));
      m.workKm = state.work ? km(c, [state.work.lat, state.work.lng]) : null;
    }
  }

  function raw(a, k) {
    const m = a.m;
    switch (k) {
      case 'transport': return live.osmOk ? m.bus + m.tram * 6 + (a.tram ? 4 : 0) : (a.tram ? 1 : 0);
      case 'shops': return live.osmOk ? m.shops : null;
      case 'gym': return live.osmOk ? m.gyms : null;
      case 'quiet': return 2 - a.students;
      case 'safety': return m.crime == null ? null : -m.crime;
      case 'station': return -m.stationKm;
      case 'motorway': return -m.m1Km;
      case 'work': return m.workKm == null ? null : -m.workKm;
    }
    return null;
  }

  function score() {
    const norms = {};
    for (const p of PRIORITIES) {
      const vals = AREAS.map(a => raw(a, p.k)).filter(v => v != null);
      if (!vals.length) continue;
      const lo = Math.min(...vals), hi = Math.max(...vals);
      norms[p.k] = a => { const v = raw(a, p.k); return v == null ? null : (hi === lo ? 1 : (v - lo) / (hi - lo)); };
    }
    for (const a of AREAS) {
      let sum = 0, wsum = 0;
      for (const p of PRIORITIES) {
        const w = state.weights[p.k];
        if (!w || !norms[p.k]) continue;
        const n = norms[p.k](a);
        if (n == null) continue;
        sum += w * n; wsum += w;
      }
      let s = wsum ? (sum / wsum) * 100 : 50;
      const [lo, hi] = a[state.type];
      a.fits = state.budget >= lo;
      a.budgetNote = state.budget >= hi ? 'Comfortably in budget' : a.fits ? 'Some options in budget' : 'Usually over budget';
      if (a.fits && state.budget < hi) s -= 6 * (hi - state.budget) / (hi - lo || 1);
      if (state.musts.has('parking')) s -= a.parking === 'permit' ? 18 : a.parking === 'mixed' ? 6 : 0;
      a.score = Math.max(0, Math.round(s));
    }
    AREAS.sort((x, y) => (y.fits - x.fits) || (y.score - x.score));
  }

  // ---------- listings links ----------
  function links(a) {
    const out = a.outcode, low = out.toLowerCase(), b = state.budget;
    const sr = new URLSearchParams({ flatshare_type: 'offered', location_type: 'area', search: out, miles_from_max: '1', max_rent: b, per: 'pcm', searchtype: 'advanced', action: 'search' });
    if (state.type === 'room') sr.set('showme_rooms', 'Y'); else sr.set('showme_1beds', 'Y');
    if (state.musts.has('bills')) sr.set('bills_inc', 'Yes');
    if (state.musts.has('ensuite') && state.type === 'room') sr.set('ensuite', 'Y');
    if (state.musts.has('female') && state.type === 'room') sr.set('genderfilter', 'females');
    if (state.musts.has('parking')) sr.set('parking', 'Y');
    const or = new URLSearchParams({ term: `Sheffield, ${out}`, prices_max: b, bedrooms_max: '1' });
    const zp = new URLSearchParams({ price_frequency: 'per_month', price_max: b, search_source: 'to-rent' });
    if (state.type === 'studio') zp.set('beds_max', '1');
    return {
      spareroom: `https://www.spareroom.co.uk/flatshare/search.pl?${sr}`,
      openrent: `https://www.openrent.co.uk/properties-to-rent/sheffield-${low}?${or}`,
      zoopla: `https://www.zoopla.co.uk/to-rent/property/${low}/?${zp}`,
    };
  }

  // ---------- rendering ----------
  function tags(a) {
    const t = [];
    if (a.tram) t.push(['Tram', 'good']);
    if (a.parking === 'easy') t.push(['Easy parking', 'good']);
    if (a.parking === 'permit') t.push(['Permit parking', state.musts.has('parking') ? 'warn' : '']);
    if (a.students === 2) t.push(['Student-heavy', state.weights.quiet >= 2 ? 'warn' : '']);
    if (a.students === 0) t.push(['Quiet', 'good']);
    if (a.m.m1Km < 3) t.push(['Near M1', 'good']);
    if (a.m.workKm != null) t.push([`${a.m.workKm.toFixed(1)} km to work`, a.m.workKm < 3 ? 'good' : '']);
    return t.map(([s, c]) => `<span class="tag ${c}">${esc(s)}</span>`).join('');
  }

  function popupHtml(a) {
    const m = a.m, l = links(a), [lo, hi] = a[state.type];
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    const typeLabel = state.type === 'room' ? 'Room (share, usually bills inc.)' : 'Studio / 1-bed (bills often extra)';
    return `<div class="pop">
      <h3>${esc(a.name)}</h3><div class="muted">${esc(a.outcode)} · ${esc(a.budgetNote)}</div>
      <p>${esc(a.note)}</p>
      <table>
        ${row(typeLabel, `£${lo}–£${hi}`)}
        ${live.osmOk ? row('Bus stops within 600 m', m.bus) + row('Tram stops within 800 m', m.tram) + row('Shops & pharmacies within 800 m', m.shops) + row('Gyms within 1.2 km', m.gyms) : ''}
        ${m.crime != null ? row(`Crime reports, ~1.2 km² (${esc(live.crimeMonth || 'latest')})`, m.crime) : ''}
        ${row('To Sheffield station', `${m.stationKm.toFixed(1)} km`)}
        ${row('To nearest M1 junction', `${m.m1Km.toFixed(1)} km`)}
        ${m.workKm != null ? row('To work (straight line)', `${m.workKm.toFixed(1)} km`) : ''}
      </table>
      <div class="muted">Search live listings with your filters:</div>
      <div class="btns">
        <a href="${l.spareroom}" target="_blank" rel="noopener">SpareRoom</a>
        <a class="alt" href="${l.openrent}" target="_blank" rel="noopener">OpenRent</a>
        <a class="alt" href="${l.zoopla}" target="_blank" rel="noopener">Zoopla</a>
      </div>
      ${state.work ? `<p class="muted"><a href="https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${state.work.lat},${state.work.lng}&travelmode=transit" target="_blank" rel="noopener">Check the bus/tram commute ↗</a></p>` : ''}
    </div>`;
  }

  function focusArea(a) {
    map.once('moveend', () => areaShapes[a.id]?.openPopup());
    map.flyTo([a.lat, a.lng], 14, { duration: 0.6 });
    document.querySelectorAll('#results li').forEach(li => li.classList.toggle('active', li.dataset.id === a.id));
    if (window.innerWidth <= 760) $('#panel').classList.add('collapsed');
  }

  function render() {
    computeMetrics();
    score();
    writeHash();

    // list
    const ol = $('#results');
    ol.innerHTML = '';
    for (const a of AREAS) {
      const [lo, hi] = a[state.type];
      const li = el('li', { className: a.fits ? '' : 'out' });
      li.dataset.id = a.id;
      li.innerHTML = `<div class="r-top"><span class="r-name">${esc(a.name)}</span><span class="r-score">${a.fits ? a.score + '/100' : 'over budget'}</span></div>
        <div class="r-meta">${esc(a.outcode)} · £${lo}–£${hi} · ${esc(a.budgetNote)}</div>
        <div class="tags">${tags(a)}</div>
        <div class="bar"><i style="width:${a.fits ? a.score : 0}%"></i></div>`;
      li.addEventListener('click', () => focusArea(a));
      ol.appendChild(li);
    }

    // area circles
    areaLayer.clearLayers();
    const best = AREAS.find(a => a.fits);
    for (const a of AREAS) {
      const t = a.fits ? a.score / 100 : 0;
      const shape = L.circle([a.lat, a.lng], {
        radius: 650,
        color: a.fits ? '#f2c14e' : '#555',
        weight: a === best ? 3 : 1.2,
        dashArray: a.fits ? null : '4 4',
        fillColor: '#f2c14e',
        fillOpacity: a.fits ? 0.05 + 0.3 * t : 0.02,
      }).bindPopup(() => popupHtml(a), { maxWidth: 320 })
        .bindTooltip(`${a.name}${a.fits ? ' · ' + a.score : ''}`, { permanent: true, direction: 'center', className: 'area-label' });
      shape.on('click', () => document.querySelectorAll('#results li').forEach(li => li.classList.toggle('active', li.dataset.id === a.id)));
      shape.addTo(areaLayer);
      areaShapes[a.id] = shape;
    }
  }

  // ---------- controls ----------
  function buildControls() {
    // type
    document.querySelectorAll('#type button').forEach(b => {
      const on = b.dataset.v === state.type;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
      b.addEventListener('click', () => {
        state.type = b.dataset.v;
        document.querySelectorAll('#type button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
        render();
      });
    });
    // budget
    const bud = $('#budget'), out = $('#budget-out');
    bud.value = state.budget; out.textContent = '£' + state.budget;
    bud.addEventListener('input', () => { state.budget = +bud.value; out.textContent = '£' + state.budget; render(); });
    // musts
    document.querySelectorAll('#musts button').forEach(b => {
      b.classList.toggle('on', state.musts.has(b.dataset.k));
      b.addEventListener('click', () => {
        state.musts.has(b.dataset.k) ? state.musts.delete(b.dataset.k) : state.musts.add(b.dataset.k);
        b.classList.toggle('on'); render();
      });
    });
    // priorities
    const box = $('#prios');
    for (const p of PRIORITIES) {
      const lab = el('label');
      lab.innerHTML = `<span>${p.label}</span><span class="lvl">${LEVELS[state.weights[p.k]]}</span><input type="range" min="0" max="3" step="1" value="${state.weights[p.k]}">`;
      const input = lab.querySelector('input'), lvl = lab.querySelector('.lvl');
      input.addEventListener('input', () => { state.weights[p.k] = +input.value; lvl.textContent = LEVELS[+input.value]; render(); });
      box.appendChild(lab);
    }
    // work postcode
    $('#work-form').addEventListener('submit', e => { e.preventDefault(); setWork($('#work').value); });
    // layers
    const lb = $('#layers');
    for (const [k, s] of Object.entries(LAYER_STYLE)) {
      const b = el('button', { textContent: s.label, className: s.on ? 'on' : '' });
      b.style.setProperty('--c', s.color);
      if (s.on) dotLayers[k].addTo(map);
      b.addEventListener('click', () => {
        s.on = !s.on; b.classList.toggle('on', s.on);
        s.on ? dotLayers[k].addTo(map) : map.removeLayer(dotLayers[k]);
      });
      lb.appendChild(b);
    }
    // mobile sheet toggle
    $('#panel-toggle').addEventListener('click', () => $('#panel').classList.toggle('collapsed'));
    const zoomClass = () => map.getContainer().classList.toggle('far', map.getZoom() < 12);
    map.on('zoomend', zoomClass); zoomClass();
  }

  async function setWork(input) {
    const q = String(input || '').trim();
    const hint = $('#work-hint');
    if (!q) { state.work = null; if (workMarker) map.removeLayer(workMarker); hint.textContent = 'Optional. Or remote? Leave blank.'; render(); return; }
    hint.textContent = 'Looking up…';
    try {
      const compact = q.replace(/\s+/g, '');
      let r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`);
      if (!r.ok) r = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(compact)}`);
      if (!r.ok) throw new Error('not found');
      const { result } = await r.json();
      state.work = { pc: q.toUpperCase(), lat: result.latitude, lng: result.longitude };
      $('#work').value = state.work.pc;
      if (workMarker) map.removeLayer(workMarker);
      workMarker = L.circleMarker([state.work.lat, state.work.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#e2725b', fillOpacity: 1 })
        .bindTooltip('Work', { permanent: true, direction: 'right', className: 'area-label' }).addTo(map);
      const d = km(CENTRE, [state.work.lat, state.work.lng]);
      hint.textContent = d > 25 ? `Work is ${Math.round(d)} km from Sheffield centre. Areas near the M1 or the station may suit better.` : 'Areas now ranked by distance to work too.';
      render();
    } catch (err) {
      hint.textContent = "Couldn't find that postcode. Try the full postcode, e.g. S1 2HE.";
    }
  }

  // ---------- boot ----------
  async function boot() {
    readHash();
    const res = await fetch('data/areas.json');
    AREAS = (await res.json()).areas;
    buildControls();
    render();
    if (state.pendingWork) { $('#work').value = state.pendingWork; setWork(state.pendingWork); }

    setStatus('loading map data…');
    const osm = loadOSM().then(() => { ['bus', 'tram', 'shop', 'gym'].forEach(drawDots); render(); }).catch(() => {});
    const crime = loadCrime().then(() => { drawDots('crime'); render(); }).catch(() => {});
    await Promise.all([osm, crime]);
    const bits = [];
    if (live.osmOk) bits.push(`${live.points.bus.length.toLocaleString()} bus stops, ${live.points.shop.length} shops${live.osmDate ? ' (' + live.osmDate + ')' : ''}`);
    if (live.crimeOk) bits.push(`crime ${live.crimeMonth || ''}`);
    setStatus(bits.length ? 'live: ' + bits.join(' · ') : 'live data offline, using guide only');
  }

  if (window.innerWidth <= 760) $('#panel').classList.add('collapsed');
  boot();
})();
