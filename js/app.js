/* Geo Attendance - single-page client */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // api() goes to the Apps Script API (web-src/bridge.js -> Web.gs#doPost).
  function api(path, opts = {}) { return geoRpc(path, opts, showLogin); }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3800);
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtMin = (m) => { if (!m) return '0m'; const h = Math.floor(m / 60); const r = m % 60; return h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`; };
  const fmtHrs = (m) => (m / 60).toFixed(2);
  const fmtDist = (m) => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const hmToLabel = (hm) => { const [h, m] = hm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monthStart = () => { const d = new Date(); return isoDate(new Date(d.getFullYear(), d.getMonth(), 1)); };
  const todayIso = () => isoDate(new Date());

  function distanceM(lat1, lng1, lat2, lng2) {
    const r = (d) => (d * Math.PI) / 180;
    const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }

  const STATUS_LABEL = { ok: 'Verified', flagged: 'Needs review', approved: 'Approved', rejected: 'Rejected' };
  const SITE_KINDS = {
    branch: 'Branch', project: 'Project site', office: 'Office',
    classroom: 'Classroom', laboratory: 'Laboratory', sports_complex: 'Sports complex',
  };
  // Short label for a shift's own location rule ('' = follows the employee default).
  const ruleLabel = (sh) => (sh.work_type === 'multi' ? 'Any site' : sh.work_type === 'field' ? 'Anywhere'
    : sh.site_name ? `At ${sh.site_name}` : '');
  const WORK_LABEL = { site: 'Site-bound', multi: 'Multi-site', field: 'Field' };
  const STATE_LABEL = { in: 'On duty', out: 'Checked out', absent: 'Absent', upcoming: 'Not yet', off: 'Day off' };
  const badge = (cls, text) => `<span class="badge b-${cls}">${esc(text)}</span>`;
  const statusBadge = (s) => badge(s, STATUS_LABEL[s] || s);

  // A stable per-browser id, used to spot one phone clocking in several people.
  function deviceId() {
    try {
      let id = localStorage.getItem('geo.device');
      if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now(); localStorage.setItem('geo.device', id); }
      return id;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- maps
  const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_ATTR = '&copy; OpenStreetMap contributors';
  const maps = {};

  function getMap(id, center = [13.9621, 121.1633], zoom = 15) {
    if (maps[id]) { setTimeout(() => maps[id].invalidateSize(), 0); return maps[id]; }
    const m = L.map(id, { zoomControl: true, attributionControl: true }).setView(center, zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(m);
    m._layer = L.layerGroup().addTo(m);
    maps[id] = m;
    return m;
  }
  const pinIcon = (cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
  const fence = (site) => L.circle([site.lat, site.lng], { radius: site.radius_m, color: '#0F6B51', weight: 1.5, fillColor: '#0F6B51', fillOpacity: 0.08 });
  function fit(map, layers, fallbackZoom = 16) {
    const pts = layers.flatMap((l) => (l.getBounds ? [l.getBounds()] : l.getLatLng ? [l.getLatLng()] : []));
    if (!pts.length) return;
    const b = L.latLngBounds(pts.flatMap((p) => (p.getNorthEast ? [p.getNorthEast(), p.getSouthWest()] : [p])));
    if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), fallbackZoom);
    else map.fitBounds(b, { padding: [28, 28], maxZoom: 17 });
  }

  // ---------------------------------------------------------------- state
  const state = { me: null, sites: [], current: null };
  const MANAGER_TABS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'records', label: 'Records', count: true },
    { id: 'payroll', label: 'Payroll' },
    { id: 'employees', label: 'Employees' },
    { id: 'sites', label: 'Sites' },
  ];
  const STAFF_TABS = [
    { id: 'clock', label: 'Clock in/out' },
    { id: 'history', label: 'My attendance' },
  ];
  const ICONS = {
    clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-1 3v5.4l4.3 2.6 1-1.7-3.3-2V7h-2Z"/>',
    history: '<path d="M4 4h16v2H4V4Zm0 5h16v2H4V9Zm0 5h10v2H4v-2Zm0 5h10v2H4v-2Zm13-4.5 5 3.5-5 3.5v-7Z"/>',
    dashboard: '<path d="M3 3h8v10H3V3Zm10 0h8v6h-8V3ZM3 15h8v6H3v-6Zm10-4h8v10h-8V11Z"/>',
    records: '<path d="M6 2h9l5 5v15H6V2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z"/>',
    payroll: '<path d="M3 5h18v14H3V5Zm2 2v10h14V7H5Zm7 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z"/>',
    employees: '<path d="M9 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm8 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM1 20c0-3.3 3.6-6 8-6s8 2.7 8 6H1Zm17.5 0c0-1.9-.8-3.6-2.1-4.9 3.3.3 5.6 2.2 5.6 4.9h-3.5Z"/>',
    sites: '<path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/>',
  };
  const icon = (id) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg>`;


  function tabsFor(role) {
    if (role === 'admin') return MANAGER_TABS;
    if (role === 'manager') return [...STAFF_TABS, ...MANAGER_TABS];
    return STAFF_TABS;
  }

  // A class QR read by the phone's own camera app opens /?qr=<code>. Keep the code (through the
  // sign-in, if one is needed) until the Clock screen can check it, and clear the address bar.
  const QR_KEY = 'geo.pendingQr';
  const qrCodeIn = (text) => /(?:^GEOQR:|[?&#]qr=)([A-Za-z0-9_-]{22})(?:$|&)/.exec(String(text || '').trim())?.[1] || null;
  (() => {
    const code = qrCodeIn(location.search);
    if (!code) return;
    try { sessionStorage.setItem(QR_KEY, JSON.stringify({ code, at: Date.now() })); } catch { /* private mode */ }
    history.replaceState(null, '', `${location.pathname}#clock`);
  })();
  function takePendingQr() {
    try {
      const p = JSON.parse(sessionStorage.getItem(QR_KEY) || 'null');
      sessionStorage.removeItem(QR_KEY);
      return p && Date.now() - p.at < 15 * 60 * 1000 ? p.code : null; // a stale read isn't trusted
    } catch { return null; }
  }

  // ---------------------------------------------------------------- auth
  // Sign-in is the visitor's DLSL Google account (Google button, then a 30-day session).
  function showLogin(message) {
    stopCamera(); stopLocation();
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-error').textContent = message || '';
    geoSignIn(() => boot());
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/auth/login', { method: 'POST', body: { email: $('#login-email').value, password: $('#login-password').value } });
      $('#login-password').value = '';
      await boot();
    } catch (err) { $('#login-error').textContent = err.message; }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.hash = '';
    showLogin();
  });

  $('#btn-password').addEventListener('click', () => {
    openModal('Change password', `
      <form id="pw-form" class="form-grid">
        <div class="field full"><label for="pw-cur">Current password</label><input id="pw-cur" type="password" required autocomplete="current-password"></div>
        <div class="field full"><label for="pw-new">New password</label><input id="pw-new" type="password" minlength="8" required autocomplete="new-password"><span class="hint">At least 8 characters</span></div>
        <p class="form-error full" id="pw-err"></p>
        <div class="form-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Update password</button></div>
      </form>`);
    $('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/change-password', { method: 'POST', body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
        closeModal(); toast('Password updated');
      } catch (err) { $('#pw-err').textContent = err.message; }
    });
  });

  async function boot() {
    try {
      const { user } = await api('/auth/me');
      state.me = user;
    } catch (err) { return showLogin(/Sign in with/.test(err.message) ? '' : err.message); }

    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#user-name').textContent = state.me.name;
    $('#user-role').textContent = state.me.role;
    $('#user-initials').textContent = initials(state.me.name);
    $('#menu-name').textContent = state.me.name;
    $('#menu-email').textContent = state.me.email;
    $('#drawer-initials').textContent = initials(state.me.name);
    $('#drawer-name').textContent = state.me.name;
    $('#drawer-email').textContent = state.me.email;
    $('#drawer-role').textContent = state.me.role;
    $$('.admin-only').forEach((el) => { el.hidden = state.me.role !== 'admin'; });

    const tabs = tabsFor(state.me.role);
    $('#tabs').innerHTML = tabs.map((t) => `<button class="tab" data-tab="${t.id}">${esc(t.label)}${t.count ? '<span class="count" hidden></span>' : ''}</button>`).join('');
    $$('#tabs .tab').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));

    // Phone navigation: the same sections in a slide-in drawer behind the hamburger.
    $('#drawer-nav').innerHTML = tabs.map((t) => `
      <button class="drawer-item" data-tab="${t.id}">${icon(t.id)}<span>${esc(t.label)}</span>${t.count ? '<span class="count" hidden></span>' : ''}</button>`).join('');
    $$('#drawer-nav [data-tab]').forEach((b) => b.addEventListener('click', () => { setDrawer(false); location.hash = b.dataset.tab; }));

    if (state.me.role !== 'employee') {
      const { sites } = await api('/sites');
      state.sites = sites;
      const opts = '<option value="">All sites</option>' + sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      $('#rec-site').innerHTML = opts; $('#pay-site').innerHTML = opts;
    }
    route();
  }

  // Mobile drawer
  function setDrawer(open) {
    const d = $('#drawer');
    d.classList.toggle('open', open);
    d.setAttribute('aria-hidden', String(!open));
    d.inert = !open;
    $('#drawer-backdrop').hidden = !open;
    $('#btn-menu').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('no-scroll', open);
    if (open) ($('#drawer-nav .active') || $('#drawer-nav .drawer-item'))?.focus();
    else if (document.activeElement && d.contains(document.activeElement)) $('#btn-menu').focus();
  }
  $('#btn-menu').addEventListener('click', () => setDrawer(true));
  $('#drawer-close').addEventListener('click', () => setDrawer(false));
  $('#drawer-backdrop').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#drawer').classList.contains('open')) setDrawer(false); });
  $('#drawer-password').addEventListener('click', () => { setDrawer(false); $('#btn-password').click(); });
  $('#drawer-logout').addEventListener('click', () => { setDrawer(false); $('#btn-logout').click(); });
  // Rotating to a wide screen while open shouldn't leave the page locked.
  window.matchMedia('(min-width: 721px)').addEventListener('change', (m) => { if (m.matches) setDrawer(false); });

  // Account menu
  function setMenu(open) {
    $('#account-menu').hidden = !open;
    $('#btn-account').setAttribute('aria-expanded', String(open));
  }
  $('#btn-account').addEventListener('click', (e) => { e.stopPropagation(); setMenu($('#account-menu').hidden); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.account')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  $('#account-menu').addEventListener('click', () => setMenu(false));

  // Tables become stacked cards on phones; each cell needs its column name as a label.
  function labelCells(table) {
    const heads = $$('thead th', table).map((th) => th.textContent.trim());
    $$('tbody tr, tfoot tr', table).forEach((tr) => {
      let col = 0;
      [...tr.children].forEach((td) => {
        if (!td.hasAttribute('data-label')) td.setAttribute('data-label', heads[col] || '');
        col += td.colSpan || 1;
      });
    });
  }
  $$('.table').forEach((t) => new MutationObserver(() => labelCells(t)).observe(t, { childList: true }));

  // ---------------------------------------------------------------- routing
  window.addEventListener('hashchange', route);
  function route() {
    if (!state.me) return;
    const tabs = tabsFor(state.me.role);
    const id = tabs.some((t) => t.id === location.hash.slice(1)) ? location.hash.slice(1) : tabs[0].id;
    if (!$('#modal').hidden) closeModal();
    if (state.current === 'clock' && id !== 'clock') { stopCamera(); stopLocation(); clock.photo = null; clock.qr = null; showPhoto(false); }
    state.current = id;
    $$('#tabs .tab, #drawer-nav [data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === id);
      if (b.dataset.tab === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const current = tabs.find((t) => t.id === id);
    document.title = `${current.label} · Geo Attendance`;
    window.scrollTo(0, 0);
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === id));
    clearInterval(state.poll);
    ({ clock: initClock, history: loadHistory, dashboard: loadDashboard, records: loadRecords,
      payroll: loadPayroll, employees: loadEmployees, sites: loadSites })[id]();
    if (state.me.role !== 'employee') refreshReviewCount();
  }

  async function refreshReviewCount() {
    try {
      const { records } = await api('/attendance?status=flagged&from=2000-01-01');
      $$('[data-tab="records"] .count').forEach((el) => { el.textContent = records.length; el.hidden = !records.length; });
    } catch { /* non-critical */ }
  }

  // ---------------------------------------------------------------- modal
  function openModal(title, html, wide = false) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('.modal-panel').style.maxWidth = wide ? '820px' : '';
    $('#modal').hidden = false;
  }
  function closeModal() {
    const onClose = state.onModalClose;
    state.onModalClose = null;
    $('#modal').hidden = true;
    $('#modal-body').innerHTML = '';
    Object.keys(maps).filter((k) => k.startsWith('modal-')).forEach((k) => { maps[k].remove(); delete maps[k]; });
    onClose?.();
  }
  $('#modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  // ================================================================ CLOCK
  const clock = { stream: null, watch: null, fix: null, today: null, busy: false, tick: null, photo: null, photoAt: 0, qr: null };

  async function initClock() {
    clearInterval(clock.tick);
    const tickNow = () => {
      const d = new Date();
      $('#clock-time').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('#clock-date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    };
    tickNow();
    clock.tick = setInterval(() => { tickNow(); if (clock.today) updatePunchState(); }, 1000);

    try {
      await loadToday(true);
    } catch (err) { return toast(err.message, true); }
    renderClock();
    startCamera();
    startLocation();
    const pending = takePendingQr();
    if (pending) useQr(`GEOQR:${pending}`).then((r) => toast(`Class QR read · ${r.site.name}. Tap ${punchVerb()} to record your attendance.`), (err) => toast(err.message, true));

    // Re-check every 30 s (and when the phone wakes) so the shift — and the site it must be
    // checked in at — switches on time without a reload.
    clearInterval(clock.refresh);
    clock.refresh = setInterval(refreshToday, 30000);
  }

  async function loadToday(throwOnError = false) {
    try {
      const sentAt = Date.now();
      const t = await api('/attendance/today');
      clock.skew = Date.parse(t.now) - (sentAt + Date.now()) / 2; // server − phone clock
      clock.today = t;
      // Re-check right when a window opens or a shift ends, not just on the 30 s poll.
      clearTimeout(clock.edgeTimer);
      if (t.changeAt) {
        const wait = Date.parse(t.changeAt) - serverNow() + 1000;
        if (wait > 0 && wait < 6 * 3600 * 1000) clock.edgeTimer = setTimeout(refreshToday, wait);
      }
      return t;
    } catch (err) {
      if (throwOnError) throw err;
      return null;
    }
  }

  const planKey = (t) => `${t.next.kind}|${t.next.shift?.id ?? ''}|${t.next.record?.id ?? ''}|${t.place.label}|${t.records.length}`;
  async function refreshToday() {
    if (state.current !== 'clock' || clock.busy || !clock.today) return;
    const prev = clock.today;
    const fresh = await loadToday();
    if (!fresh) return;
    const changed = planKey(fresh) !== planKey(prev);
    if (!changed) return;
    clock.fitted = false; // re-frame the map on the new site
    renderClock();
    if (clock.fix) renderLocation();
    if (fresh.next.kind === 'done') stopCamera(); else startCamera();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshToday(); });

  const shiftLabel = (start, end) => (start ? `${hmToLabel(start)} – ${hmToLabel(end)}` : 'Unscheduled');

  function renderClock() {
    const t = clock.today;
    const { next, open } = t;
    const done = next.kind === 'done';

    // Where to be right now: the site of the shift that applies at this time.
    const openShift = open && (t.shifts.find((sh) => sh.id === open.shift_id) || null);
    const nowShift = next.kind === 'in' ? next.shift : openShift;
    const verb = next.kind === 'out' ? 'Time out at' : 'Time in at';
    $('#clock-shift').innerHTML = done
      ? (t.shifts.length ? `${t.shifts.length} shift${t.shifts.length > 1 ? 's' : ''} today · all done` : 'No shift scheduled today')
      : `${verb} <strong class="place">${esc(t.place.label)}</strong><br>${nowShift ? `${esc(shiftLabel(nowShift.start, nowShift.end))} shift` : next.kind === 'out' ? esc(shiftLabel(open.shift_start, open.shift_end)) : 'No scheduled shift right now'}`;

    const pill = $('#clock-status');
    if (open) { pill.textContent = `On duty since ${fmtTime(open.in_at)}`; pill.className = 'status-pill in'; }
    else if (done) { pill.textContent = t.records.length ? 'All shifts complete' : next.reason; pill.className = 'status-pill done'; }
    else if (t.records.length) { pill.textContent = `Next: ${shiftLabel(next.shift?.start, next.shift?.end)}`; pill.className = 'status-pill'; }
    else { pill.textContent = 'Not timed in'; pill.className = 'status-pill'; }

    $('#camera').hidden = done;

    // Today card: one line per scheduled shift, plus any unscheduled sessions.
    const lines = t.shifts.map((sh) => ({
      label: shiftLabel(sh.start, sh.end), site: sh.place?.label, rec: t.records.find((r) => r.shift_id === sh.id),
      now: nowShift?.id === sh.id, missed: sh.ended,
    }));
    t.records.filter((r) => !r.shift_id || !t.shifts.some((sh) => sh.id === r.shift_id))
      .forEach((r) => lines.push({ label: shiftLabel(r.shift_start, r.shift_end), rec: r }));
    if (open && !t.records.some((r) => r.id === open.id)) lines.push({ label: `${shiftLabel(open.shift_start, open.shift_end)} (yesterday)`, rec: open });

    $('#today-list').innerHTML = lines.length ? lines.map(({ label, site, rec, now, missed }) => `
      <li class="${now ? 'is-now' : ''}">
        <div>
          <div class="cell-main">${esc(label)}${site ? ` <span class="muted">· ${esc(site)}</span>` : ''}</div>
          <div class="cell-sub num">${rec ? `In ${fmtTime(rec.in_at)} · Out ${rec.out_at ? fmtTime(rec.out_at) : '—'}${rec.late_min ? ` · Late ${fmtMin(rec.late_min)}` : ''}` : missed ? 'No check-in' : 'Not yet'}</div>
        </div>
        ${rec ? (rec.out_at ? statusBadge(rec.status) : badge('in', 'On duty')) : now ? badge('now', 'Now') : missed ? badge('absent', 'Missed') : badge('upcoming', 'Pending')}
      </li>`).join('') : '<li class="muted">No shifts today.</li>';

    updatePunchState();
  }

  // Camera -----------------------------------------------------------
  const PHOTO_MAX_AGE_MS = 2 * 60 * 1000;

  function camMsg(text, retry = false) {
    $('#cam-msg').textContent = text;
    $('#cam-fallback').hidden = !retry;
  }

  function cameraError(err) {
    if (!window.isSecureContext) return 'Camera needs a secure connection. Open the app via https:// or http://localhost.';
    switch (err?.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'Camera access was blocked. Click the camera icon in the address bar, allow it, then try again.';
      case 'NotFoundError': case 'OverconstrainedError':
        return 'No camera found on this device.';
      case 'NotReadableError': case 'AbortError':
        return 'The camera is being used by another app (Zoom, Teams, FaceTime…). Close it, then try again.';
      default:
        return `Could not start the camera (${err?.name || 'unknown error'}).`;
    }
  }

  // Some hosts (Google Apps Script's wrapper iframe) never grant the live camera to the page.
  // There the phone's own camera app (a file input) is the photo path instead of a dead error.
  const liveCameraBlocked = () => !navigator.mediaDevices?.getUserMedia
    || (document.featurePolicy?.allowsFeature && !document.featurePolicy.allowsFeature('camera'));

  function useNativeCamera() {
    stopStream();
    clock.native = true;
    $('#camera').classList.add('native');
    $('#cam-video').hidden = true;
    $('#cam-fallback').hidden = true;
    if (!clock.photo) camMsg('Tap “Take photo” to open the camera.');
    updatePunchState();
  }

  async function startCamera() {
    if (clock.today.next.kind === 'done') { stopCamera(); return; }
    if (clock.stream || clock.native) { updatePunchState(); return; }
    if (liveCameraBlocked()) { useNativeCamera(); return; }

    camMsg('Starting camera…');
    const v = $('#cam-video');
    try {
      try {
        clock.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
        clock.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); // relaxed fallback
      }
      v.srcObject = clock.stream;
      // Wait until frames actually arrive, otherwise a capture comes out blank.
      if (v.readyState < 2) await new Promise((res) => v.addEventListener('loadeddata', res, { once: true }));
      await v.play().catch(() => {});
      clock.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        clock.stream = null; camMsg('Camera disconnected.', true); updatePunchState();
      });
      if (!clock.photo) camMsg('Centre your face in the outline');
    } catch (err) {
      stopStream();
      // Blocked by the page's host or the browser: fall back to the phone's camera app.
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') { useNativeCamera(); return; }
      camMsg(cameraError(err), true);
    }
    updatePunchState();
  }

  function stopStream() {
    clock.stream?.getTracks().forEach((t) => t.stop());
    clock.stream = null;
  }
  function stopCamera() {
    stopStream();
    clearInterval(clock.tick);
    clearInterval(clock.refresh);
    clearTimeout(clock.edgeTimer);
  }

  $('#cam-retry').addEventListener('click', () => startCamera());

  // Square JPEG straight from the live video stream (no file picker by design), with name + time burned in.
  function captureFrame(v = $('#cam-video')) {
    if (!v.srcObject || !v.videoWidth) return { error: 'Camera is not ready yet — give it a second.' };
    const size = Math.min(v.videoWidth, v.videoHeight);
    const c = $('#cam-canvas');
    c.width = 640; c.height = 640;
    const ctx = c.getContext('2d');
    // Mirror so the saved photo matches the preview the person saw.
    ctx.save(); ctx.translate(640, 0); ctx.scale(-1, 1);
    ctx.drawImage(v, (v.videoWidth - size) / 2, (v.videoHeight - size) / 2, size, size, 0, 0, 640, 640);
    ctx.restore();

    // Reject an all-dark frame (lens covered, camera still warming up).
    const px = ctx.getImageData(0, 0, 640, 640).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4 * 97) sum += px[i] + px[i + 1] + px[i + 2];
    if (sum / (px.length / (4 * 97)) / 3 < 12) return { error: 'The photo is too dark. Check that the camera is uncovered and your face is lit.' };

    const stamp = new Date().toLocaleString();
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 600, 640, 40);
    ctx.fillStyle = '#fff'; ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText(`${state.me.name} · ${stamp}`, 14, 627);
    return { dataUrl: c.toDataURL('image/jpeg', 0.85) };
  }

  function showPhoto(on) {
    $('#cam-still').hidden = !on;
    $('#cam-video').hidden = on || !!clock.native;
    $('#camera').classList.toggle('captured', on);
    $('#btn-snap span').textContent = on ? 'Retake photo' : 'Take photo';
    $('#btn-snap').classList.toggle('btn-primary', !!clock.native && !on);
    $('#btn-snap').classList.toggle('btn-ghost', !clock.native || on);
  }

  function clearPhoto() {
    clock.autoPunch = false;
    clock.photo = null;
    clock.photoAt = 0;
    showPhoto(false);
    if (clock.stream) camMsg('Centre your face in the outline');
    else if (clock.native) camMsg('Tap “Take photo” to open the camera.');
  }

  // Fallback when the live camera can't start (blocked inside an embedded page, older browser):
  // the phone's own camera app through a file input. The picture must be brand new, so a saved
  // one (older than a minute) is refused, and it gets the same name + time stamp as a live capture.
  $('#cam-native').addEventListener('click', () => $('#cam-file').click());
  $('#camera').addEventListener('click', (e) => { if (clock.native && !e.target.closest('button')) $('#cam-file').click(); });
  $('#cam-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type) || Date.now() - file.lastModified > 2 * 60 * 1000) {
      toast('Take a new photo with the camera. Saved pictures cannot be used.', true);
      return;
    }
    try {
      const bmp = await createImageBitmap(file);
      const size = Math.min(bmp.width, bmp.height);
      const c = $('#cam-canvas');
      c.width = 640; c.height = 640;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, (bmp.width - size) / 2, (bmp.height - size) / 2, size, size, 0, 0, 640, 640);
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 600, 640, 40);
      ctx.fillStyle = '#fff'; ctx.font = '600 18px system-ui, sans-serif';
      ctx.fillText(`${state.me.name} · ${new Date().toLocaleString()}`, 14, 627);
      clock.photo = c.toDataURL('image/jpeg', 0.85);
      clock.photoAt = Date.now();
      $('#cam-still').src = clock.photo;
      showPhoto(true);
      camMsg('Photo ready');
      clock.autoPunch = true;
      updatePunchState();
    } catch {
      toast('Could not read that photo. Try again.', true);
    }
  });

  $('#btn-snap').addEventListener('click', () => {
    if (clock.native) { $('#cam-file').click(); return; }
    if (clock.photo) { clearPhoto(); updatePunchState(); return; }
    const shot = captureFrame();
    if (shot.error) { toast(shot.error, true); return; }
    clock.photo = shot.dataUrl;
    clock.photoAt = Date.now();
    $('#cam-still').src = shot.dataUrl;
    showPhoto(true);
    camMsg('Photo ready');
    clock.autoPunch = true;
    updatePunchState();
  });

  // Location -----------------------------------------------------------
  function startLocation() {
    if (clock.watch != null) return;
    if (!navigator.geolocation) { setLoc('bad', 'Location not supported', 'This browser cannot share location.'); return; }
    setLoc('', 'Getting your location…', 'Stay near a window or outdoors for a better fix.');
    clock.watch = navigator.geolocation.watchPosition(
      (pos) => { clock.fix = pos; renderLocation(); },
      (err) => {
        clock.fix = null;
        const why = err.code === 1 ? 'Location blocked. Allow location access in your browser settings.' : 'Could not get a location fix. Retrying…';
        setLoc('bad', 'Location unavailable', why);
        updatePunchState();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  }
  function stopLocation() {
    if (clock.watch != null) navigator.geolocation.clearWatch(clock.watch);
    clock.watch = null;
  }
  function setLoc(level, primary, secondary) {
    $('#loc-dot').className = `dot ${level}`;
    $('#loc-primary').textContent = primary;
    $('#loc-secondary').textContent = secondary;
  }

  function locationVerdict() {
    const t = clock.today;
    const f = clock.fix;
    if (!f) return null;
    const { latitude: lat, longitude: lng, accuracy } = f.coords;
    const ranked = t.sites.map((s) => ({ s, d: distanceM(lat, lng, s.lat, s.lng) })).sort((a, b) => a.d - b.d);
    const inside = ranked.find((r) => r.d <= r.s.radius_m);
    const nearest = ranked[0];
    return { lat, lng, accuracy, inside, nearest, field: t.schedule.work_type === 'field', poor: accuracy > t.maxAccuracy };
  }

  function renderLocation() {
    const v = locationVerdict();
    if (!v) return;
    const acc = `±${Math.round(v.accuracy)} m accuracy`;
    if (v.inside) setLoc(v.poor ? 'warn' : 'ok', `Inside ${v.inside.s.name}`, `${fmtDist(v.inside.d)} from centre · ${acc}`);
    else if (v.field) setLoc(v.poor ? 'warn' : 'ok', 'Field check-in', `${v.nearest ? `${fmtDist(v.nearest.d)} from ${v.nearest.s.name} · ` : ''}${acc}`);
    else if (v.nearest) setLoc('bad', 'Outside allowed area', `${fmtDist(v.nearest.d - v.nearest.s.radius_m)} beyond ${v.nearest.s.name} · ${acc}`);
    else setLoc('bad', 'No site assigned', 'Ask your administrator to assign you a site.');

    const map = getMap('clock-map', [v.lat, v.lng], 16);
    map._layer.clearLayers();
    const layers = clock.today.sites.map((s) => fence(s).bindTooltip(s.name).addTo(map._layer));
    const me = L.marker([v.lat, v.lng], { icon: pinIcon('pin-me') }).bindTooltip('You').addTo(map._layer);
    L.circle([v.lat, v.lng], { radius: v.accuracy, color: '#1D5790', weight: 1, fillOpacity: 0.08 }).addTo(map._layer);
    if (!clock.fitted) { fit(map, [me, ...(v.inside ? [layers[clock.today.sites.indexOf(v.inside.s)]] : [])]); clock.fitted = true; }
    updatePunchState();
  }

  // Server time, so the button unlocks when the server will actually accept the check-in,
  // even if the phone's clock is a few minutes off.
  const serverNow = () => Date.now() + (clock.skew || 0);
  const tooEarly = () => {
    const n = clock.today?.next;
    return n?.kind === 'in' && !!n.opensAt && serverNow() < Date.parse(n.opensAt);
  };
  const countdown = (ms) => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const sec = t % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
  };

  function updatePunchState() {
    const btn = $('#btn-punch');
    const help = $('#punch-help');
    const t = clock.today;
    const next = t?.next;
    if (!next) return;
    const done = next.kind === 'done';
    const out = next.kind === 'out';
    const early = tooEarly();
    const v = locationVerdict();
    const qrSite = done ? null : qrSiteFor(v);
    const qrOk = qrSite && qrValid(qrSite);
    renderQrStep(qrSite, done);

    // Before the early check-in window opens nothing can be done yet — not even the photo.
    const camOk = !!(clock.stream || clock.native || clock.photo);
    $('#btn-snap').disabled = done || early || clock.busy || !camOk;
    $('#cam-actions').hidden = done;

    if (!clock.busy) {
      btn.textContent = done ? 'No time-in available'
        : out ? 'Time out'
        : early ? `Time-in opens at ${fmtTime(next.opensAt)}`
        : t.shifts.length > 1 ? `Time in · ${hmToLabel(next.shift.start)} shift` : 'Time in';
    }

    let reason = '';
    if (done) reason = next.reason || 'All of your shifts today are complete.';
    else if (early) reason = `Opens in ${countdown(Date.parse(next.opensAt) - serverNow())} — ${next.shift.early_min ?? t.schedule.early_min} min before your ${hmToLabel(next.shift.start)} shift.`;
    else if (!camOk) reason = 'Camera is required to time in.';
    else if (clock.native && !clock.photo) reason = `Take your photo first, then tap ${out ? 'Time out' : 'Time in'}.`;
    else if (!v) reason = 'Waiting for your location…';
    else if (!v.inside && !v.field && !out) reason = `You are outside ${t.place.label}. Move inside it to time in.`;
    else if (!v.inside && !v.field && out) reason = 'You are outside your site — your time-out will be flagged for review.';
    else if (qrSite && !qrOk) reason = `Read your class QR on the ${qrSite.name} screen to ${out ? 'time out' : 'time in'}.`;
    else if (v.poor) reason = 'GPS accuracy is low — your record will be flagged for review.';
    else if (!clock.photo) reason = `Tap ${out ? 'Time out' : 'Time in'} — your photo is taken automatically, or take it first.`;

    // Active exactly when the check-in window is open (and the camera + location can back it up).
    const blocked = done || early || !camOk || (clock.native && !clock.photo) || !v || (!v.inside && !v.field && !out) || (qrSite && !qrOk);
    btn.disabled = blocked || clock.busy;
    // A fresh photo records the punch by itself as soon as nothing else blocks it
    // (location fix, class QR); it fires once, and a refused punch needs a new tap.
    if (clock.autoPunch && clock.photo && !blocked && !clock.busy) {
      clock.autoPunch = false;
      setTimeout(() => btn.click(), 0);
    } else if (clock.autoPunch && clock.photo && !done && reason) {
      reason = `${reason} Your ${out ? 'time-out' : 'time-in'} will be recorded automatically.`;
    }
    btn.classList.toggle('is-waiting', early);
    help.textContent = reason;
  }

  $('#btn-punch').addEventListener('click', async () => {
    const v = locationVerdict();
    if (!v || clock.busy || tooEarly()) return;
    if (clock.photo && Date.now() - clock.photoAt > PHOTO_MAX_AGE_MS) {
      clearPhoto();
      if (clock.native) { updatePunchState(); toast('Your photo was over 2 minutes old. Take a new one.', true); return; }
      toast('Your earlier photo was over 2 minutes old, so a new one was taken.');
    }
    // No photo yet: take it now from the live camera.
    if (!clock.photo && clock.native) { $('#cam-file').click(); return; }
    if (!clock.photo) {
      const shot = captureFrame();
      if (shot.error) { toast(shot.error, true); return; }
      clock.photo = shot.dataUrl; clock.photoAt = Date.now();
      $('#cam-still').src = shot.dataUrl; showPhoto(true);
    }
    const photo = clock.photo;
    const kind = clock.today.next.kind === 'out' ? 'check-out' : 'check-in';

    clock.busy = true; updatePunchState();
    const btn = $('#btn-punch');
    btn.textContent = 'Verifying…';
    try {
      const { record: r } = await api(`/attendance/${kind}`, {
        method: 'POST',
        body: { lat: v.lat, lng: v.lng, accuracy: v.accuracy, fixAt: clock.fix.timestamp, photo, device: deviceId(), qr: clock.qr?.payload },
      });
      clearPhoto();
      clock.qr = null;
      const verb = kind === 'check-in' ? 'Timed in' : 'Timed out';
      toast(r.status === 'flagged' ? `${verb} — flagged for review: ${r.flags}` : `${verb} at ${fmtTime(kind === 'check-in' ? r.in_at : r.out_at)}`, r.status === 'flagged');
    } catch (err) {
      if (/QR/.test(err.message)) clock.qr = null; // wrong or reset code: scan again
      toast(err.message, true);
    } finally {
      clock.busy = false;
      await loadToday();
      renderClock();
      if (clock.today.next.kind === 'done') stopCamera();
    }
  });

  // Class QR -----------------------------------------------------------
  // A site can require the class QR: its display (a screen in the room) shows one random code
  // per class open now, and each teacher scans the code of their own class. The server only
  // accepts the code of the session being punched, so a scan is kept until that session changes.

  // The site whose QR this punch needs: the one the phone is inside, if that site requires it.
  const qrSiteFor = (v) => (v && !v.field && v.inside?.s.qr_required ? v.inside.s : null);
  // Whether the reader should be offered at all: a QR site is among the places this punch may
  // happen, so the teacher can read the code before the GPS fix settles.
  const qrNeeded = () => clock.today?.schedule.work_type !== 'field' && !!clock.today?.sites.some((s) => s.qr_required);
  const punchVerb = () => (clock.today?.next.kind === 'out' ? 'Time out' : 'Time in');
  const sessionKey = () => {
    const n = clock.today?.next;
    return n?.kind === 'in' ? `in:${n.shift.id}` : n?.kind === 'out' ? `out:${n.record.id}` : null;
  };
  function qrValid(site) {
    if (!clock.qr) return false;
    if (clock.qr.session !== sessionKey()) { clock.qr = null; return false; }
    return !site || clock.qr.siteId === site.id;
  }

  // Checks a read code with the server and keeps it for the next Time in / Time out.
  async function useQr(payload) {
    const r = await api('/attendance/qr-check', { method: 'POST', body: { qr: payload } });
    clock.qr = { payload, siteId: r.site.id, siteName: r.site.name, schedule: r.schedule, session: r.session };
    updatePunchState();
    return r;
  }

  function renderQrStep(site, done) {
    const show = !done && (!!site || qrNeeded());
    $('#qr-step').hidden = !show;
    if (!show) return;
    const ok = qrValid(site);
    const wrongSite = clock.qr && site && clock.qr.siteId !== site.id;
    $('#qr-dot').className = `dot ${ok ? 'ok' : ''}`;
    $('#qr-primary').textContent = ok ? `Class QR read · ${clock.qr.siteName}` : 'Read your class QR';
    $('#qr-secondary').textContent = ok
      ? `Your ${hmToLabel(clock.qr.schedule.start)} – ${hmToLabel(clock.qr.schedule.end)} class · tap ${punchVerb()}`
      : wrongSite ? `That code is for ${clock.qr.siteName}, not ${site.name}.`
      : "Point your phone's camera at your class's code on the room screen, or tap Scan.";
    $('#btn-scan span').textContent = ok ? 'Rescan' : 'Scan';
    $('#btn-scan').disabled = clock.busy;
    $('#btn-scan').classList.toggle('btn-primary', !ok);
    $('#btn-scan').classList.toggle('btn-ghost', ok);
  }

  let jsQrLoading = null;
  function loadJsQr() {
    if (window.jsQR) return Promise.resolve();
    jsQrLoading ||= new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
      el.onload = resolve;
      el.onerror = () => { jsQrLoading = null; reject(new Error('Could not load the QR scanner. Check your connection.')); };
      document.head.append(el);
    });
    return jsQrLoading;
  }

  $('#btn-scan').addEventListener('click', openScanner);

  // No live camera (embedded host): photograph the QR with the camera app and decode the still.
  const qrFile = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
  qrFile.setAttribute('capture', 'environment');
  document.body.append(qrFile);
  qrFile.addEventListener('change', async () => {
    const file = qrFile.files?.[0];
    qrFile.value = '';
    if (!file) return;
    try {
      await loadJsQr();
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const hit = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      const payload = hit?.data?.trim();
      if (!payload) return toast('No QR code found in that photo. Hold the phone steady and try again.', true);
      if (!qrCodeIn(payload)) return toast('That is not a Geo Attendance class QR code. Scan the one on the room screen.', true);
      const r = await useQr(payload);
      toast(`Class QR read · ${r.site.name}. Tap ${punchVerb()} to record your attendance.`);
    } catch (err) {
      toast(err.message || 'Could not read that photo. Try again.', true);
    }
  });

  async function openScanner() {
    if (clock.native || liveCameraBlocked()) { qrFile.click(); return; }
    const scan = { stream: null, raf: 0, busy: false, done: false };
    openModal('Scan class QR', `
      <div class="scanner">
        <video id="qr-video" playsinline muted autoplay></video>
        <div class="scanner-frame" aria-hidden="true"></div>
      </div>
      <p class="scanner-msg" id="qr-msg" role="status">Starting the back camera…</p>`);
    const msg = (text, bad = false) => { const el = $('#qr-msg'); if (el) { el.textContent = text; el.classList.toggle('bad', bad); } };

    // Phones generally allow one camera at a time: pause the selfie camera while scanning.
    stopStream();
    state.onModalClose = () => {
      scan.done = true;
      cancelAnimationFrame(scan.raf);
      scan.stream?.getTracks().forEach((t) => t.stop());
      // Deferred: when a tab switch closed the modal, the route has moved on by then.
      setTimeout(() => { if (state.current === 'clock' && clock.today) startCamera(); }, 0);
    };

    try {
      await loadJsQr();
      if (scan.done) return;
      try {
        scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
        scan.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      if (scan.done) { scan.stream.getTracks().forEach((t) => t.stop()); return; }
    } catch (err) {
      msg(err.message?.startsWith('Could not load') ? err.message : cameraError(err), true);
      return;
    }

    const video = $('#qr-video');
    video.srcObject = scan.stream;
    await video.play().catch(() => {});
    msg('Point the camera at the QR code for your class on the room display.');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const frame = () => {
      if (scan.done) return;
      scan.raf = requestAnimationFrame(frame);
      if (scan.busy || video.readyState < 2 || !video.videoWidth) return;
      const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * k);
      canvas.height = Math.round(video.videoHeight * k);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const hit = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (hit?.data) accept(hit.data.trim());
    };

    async function accept(payload) {
      scan.busy = true;
      if (!qrCodeIn(payload)) {
        msg('That is not a Geo Attendance class QR code. Scan the one on the room screen.', true);
        setTimeout(() => { scan.busy = false; }, 1500);
        return;
      }
      msg('Checking code…');
      try {
        const r = await useQr(payload);
        closeModal();
        toast(`Class QR read · ${r.site.name}. Tap ${punchVerb()} to record your attendance.`);
      } catch (err) {
        msg(err.message, true);
        setTimeout(() => { scan.busy = false; }, 1500);
      }
    }
    frame();
  }

  // ================================================================ HISTORY
  $('#hist-from').value = monthStart(); $('#hist-to').value = todayIso();
  ['#hist-from', '#hist-to'].forEach((s) => $(s).addEventListener('change', loadHistory));

  async function loadHistory() {
    const { records } = await api(`/attendance/mine?from=${$('#hist-from').value}&to=${$('#hist-to').value}`);
    $('#hist-table').innerHTML = `
      <thead><tr><th>Date</th><th>Shift</th><th>In</th><th>Out</th><th>Site</th><th class="num">Late</th><th class="num">Regular</th><th class="num">OT</th><th>Status</th></tr></thead>
      <tbody>${records.length ? records.map((r) => `
        <tr>
          <td class="cell-main">${fmtDate(r.log_date)}</td>
          <td>${esc(shiftLabel(r.shift_start, r.shift_end))}</td>
          <td class="num">${fmtTime(r.in_at)}</td>
          <td class="num">${fmtTime(r.out_at)}</td>
          <td>${esc(r.in_site_name || 'Field')}</td>
          <td class="num">${r.late_min ? fmtMin(r.late_min) : '—'}</td>
          <td class="num">${r.out_at ? fmtMin(r.regular_min) : '—'}</td>
          <td class="num">${r.overtime_min ? fmtMin(r.overtime_min) : '—'}</td>
          <td>${statusBadge(r.status)}${r.review_note ? `<div class="cell-sub">${esc(r.review_note)}</div>` : ''}</td>
        </tr>`).join('') : '<tr class="empty"><td colspan="9">No attendance in this period.</td></tr>'}</tbody>`;
  }

  // ================================================================ DASHBOARD
  const dash = { filter: 'all', data: null };
  $('#dash-refresh').addEventListener('click', () => loadDashboard());
  $$('#dash-seg button').forEach((b) => b.addEventListener('click', () => {
    dash.filter = b.dataset.f;
    $$('#dash-seg button').forEach((x) => x.classList.toggle('on', x === b));
    renderPeople();
  }));

  async function loadDashboard() {
    try { dash.data = await api('/dashboard'); } catch (err) { return toast(err.message, true); }
    const { stats, date } = dash.data;
    $('#dash-date').textContent = fmtDate(date);
    const tiles = [
      ['On duty now', stats.onDuty, 'lead'],
      ['Present today', `${stats.present} / ${stats.headcount}`, ''],
      ['Late', stats.late, stats.late ? 'warn' : ''],
      ['Absent', stats.absent, stats.absent ? 'bad' : ''],
      ['Needs review', stats.pendingReview, `${stats.pendingReview ? 'warn' : ''} link`, 'records'],
      ['Refused attempts', stats.refusedToday, `${stats.refusedToday ? 'bad' : ''} link`, 'records'],
    ];
    $('#dash-stats').innerHTML = tiles.map(([l, v, c, go]) => `<div class="stat ${c}" ${go ? `data-go="${go}"` : ''}><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join('');
    $$('#dash-stats [data-go]').forEach((el) => el.addEventListener('click', () => {
      if (el.textContent.includes('review')) $('#rec-status').value = 'flagged';
      location.hash = el.dataset.go;
    }));
    renderPeople();
    renderDashMap();
    state.poll = setInterval(() => { if (state.current === 'dashboard' && $('#modal').hidden) loadDashboard(); }, 60000);
  }

  function renderPeople() {
    const list = dash.data.people.filter((p) => dash.filter === 'all' || p.state === dash.filter);
    const order = { in: 0, absent: 1, out: 2, upcoming: 3, off: 4 };
    list.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
    $('#dash-people').innerHTML = list.length ? list.map((p) => {
      const r = p.record;
      const late = p.sessions.reduce((t, x) => t + x.late_min, 0);
      const flagged = p.sessions.some((x) => x.status === 'flagged');
      const progress = p.shifts.length > 1 ? `${p.sessions.filter((x) => x.shift_id).length}/${p.shifts.length} shifts · ` : '';
      const when = r
        ? `${progress}${fmtTime(r.in_at)}${r.out_at ? ` – ${fmtTime(r.out_at)}` : ''}`
        : p.shifts.length ? `${progress}Starts ${hmToLabel(p.shifts[0].start)}` : 'No shift today';
      return `<li class="${r ? 'clickable' : ''}" ${r ? `data-id="${r.id}"` : ''}>
        <div class="avatar">${r ? `<img data-photo="${r.id}/in" alt="" loading="lazy">` : initials(p.name)}</div>
        <div class="who">
          <div class="cell-main">${esc(p.name)}</div>
          <div class="cell-sub">${esc(r?.in_site_name || p.site_name || WORK_LABEL[p.work_type])}${p.position ? ` · ${esc(p.position)}` : ''}</div>
        </div>
        <div class="when">
          <div>${badge(p.state, STATE_LABEL[p.state])}${late ? ` ${badge('late', `+${fmtMin(late)}`)}` : ''}${p.missed && p.state !== 'absent' ? ` ${badge('absent', `${p.missed} missed`)}` : ''}${flagged ? ` ${badge('flagged', '!')}` : ''}</div>
          <div style="margin-top:4px">${when}</div>
        </div>
      </li>`;
    }).join('') : '<li class="empty-list">Nobody here.</li>';
    $$('#dash-people [data-id]').forEach((li) => li.addEventListener('click', () => openRecord(li.dataset.id)));
  }

  function renderDashMap() {
    const { sites, people } = dash.data;
    const map = getMap('dash-map');
    map._layer.clearLayers();
    const layers = sites.map((s) => fence(s).bindTooltip(s.name).addTo(map._layer));
    people.filter((p) => p.record).forEach((p) => {
      const r = p.record;
      const out = !!r.out_at;
      const lat = out ? r.out_lat : r.in_lat;
      const lng = out ? r.out_lng : r.in_lng;
      const cls = r.status === 'flagged' ? 'pin-flag' : out ? 'pin-out' : 'pin-in';
      const m = L.marker([lat, lng], { icon: pinIcon(cls) })
        .bindTooltip(`${esc(p.name)} · ${out ? 'out' : 'in'} ${fmtTime(out ? r.out_at : r.in_at)}`)
        .on('click', () => openRecord(r.id))
        .addTo(map._layer);
      layers.push(m);
    });
    if (!dash.fitted) { fit(map, layers); dash.fitted = true; }
  }

  // ================================================================ RECORDS
  $('#rec-from').value = todayIso(); $('#rec-to').value = todayIso();
  ['#rec-from', '#rec-to', '#rec-status', '#rec-site'].forEach((s) => $(s).addEventListener('change', loadRecords));
  $('#rec-export').addEventListener('click', () => {
    geoDownload(`/reports/attendance.csv?from=${$('#rec-from').value}&to=${$('#rec-to').value}`);
  });

  async function loadRecords() {
    // "Needs review" shows the whole backlog, not just the selected days.
    const status = $('#rec-status').value;
    const from = status === 'flagged' ? '2000-01-01' : $('#rec-from').value;
    const q = new URLSearchParams({ from, to: $('#rec-to').value, status, site_id: $('#rec-site').value });
    const [{ records }, { attempts }] = await Promise.all([
      api(`/attendance?${q}`),
      api(`/attendance/attempts?from=${$('#rec-from').value}&to=${$('#rec-to').value}`),
    ]);
    $('#rec-table').innerHTML = `
      <thead><tr><th>Employee</th><th>Date</th><th>Shift</th><th>In</th><th>Out</th><th>Site</th><th class="num">Distance</th><th class="num">Late</th><th class="num">OT</th><th>Status</th><th>Flags</th></tr></thead>
      <tbody>${records.length ? records.map((r) => `
        <tr data-id="${r.id}">
          <td><div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${esc(r.employee_no || '')}</div></td>
          <td>${fmtDate(r.log_date)}</td>
          <td>${esc(shiftLabel(r.shift_start, r.shift_end))}</td>
          <td class="num">${fmtTime(r.in_at)}</td>
          <td class="num">${fmtTime(r.out_at)}</td>
          <td>${esc(r.in_site_name || '—')}${r.work_type === 'field' ? ` ${badge('field', 'Field')}` : ''}</td>
          <td class="num">${fmtDist(r.in_distance_m)}</td>
          <td class="num">${r.late_min ? fmtMin(r.late_min) : '—'}</td>
          <td class="num">${r.overtime_min ? fmtMin(r.overtime_min) : '—'}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="wrap">${esc(r.flags)}</td>
        </tr>`).join('') : '<tr class="empty"><td colspan="11">No records match these filters.</td></tr>'}</tbody>`;
    $$('#rec-table tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openRecord(tr.dataset.id)));

    $('#att-table').innerHTML = `
      <thead><tr><th>When</th><th>Employee</th><th>Type</th><th>Reason</th><th class="num">Accuracy</th><th>Location</th></tr></thead>
      <tbody>${attempts.length ? attempts.map((a) => `
        <tr>
          <td class="num">${fmtDateTime(a.at)}</td>
          <td><div class="cell-main">${esc(a.name)}</div><div class="cell-sub">${esc(a.employee_no || '')}</div></td>
          <td>${a.kind === 'in' ? 'Check-in' : 'Check-out'}</td>
          <td class="wrap">${esc(a.reason)}</td>
          <td class="num">${a.accuracy_m != null ? `±${Math.round(a.accuracy_m)} m` : '—'}</td>
          <td>${a.lat != null ? `<a href="https://www.google.com/maps?q=${a.lat},${a.lng}" target="_blank" rel="noopener">View map</a>` : '—'}</td>
        </tr>`).join('') : '<tr class="empty"><td colspan="6">No refused attempts in this period.</td></tr>'}</tbody>`;
  }

  async function openRecord(id) {
    let data;
    try { data = await api(`/attendance/${id}`); } catch (err) { return toast(err.message, true); }
    const { record: r, employee: e, sites } = data;
    const siteName = (sid) => sites.find((s) => s.id === sid)?.name || (e.work_type === 'field' ? 'Field' : '—');
    const flags = r.flags ? r.flags.split('; ').filter(Boolean) : [];
    const canReview = state.me.role !== 'employee' && e.id !== state.me.id && r.status !== 'ok';
    const canOverride = state.me.role !== 'employee' && e.id !== state.me.id && r.status === 'ok';
    const photo = (kind, at, site, dist, acc) => `
      <figure class="photo">
        ${at ? `<a href="#" data-photo-open="${r.id}/${kind}" title="Open full photo"><img data-photo="${r.id}/${kind}" alt="${kind === 'in' ? 'Check-in' : 'Check-out'} photo of ${esc(e.name)}"></a>` : '<div class="ph-empty">No check-out yet</div>'}
        <figcaption><strong>${kind === 'in' ? 'In' : 'Out'} · ${fmtTime(at)}</strong>${at ? `${esc(site)} · ${fmtDist(dist)} · ±${Math.round(acc)} m` : ''}</figcaption>
      </figure>`;

    openModal('Attendance record', `
      <div class="detail-top">
        <div class="avatar">${initials(e.name)}</div>
        <div class="who"><div class="cell-main">${esc(e.name)}</div><div class="cell-sub">${esc(e.employee_no || '')} · ${esc(e.position || '')} · ${fmtDate(r.log_date)}</div></div>
        ${statusBadge(r.status)}
      </div>
      <div class="photos">
        ${photo('in', r.in_at, siteName(r.in_site_id), r.in_distance_m, r.in_accuracy_m)}
        ${photo('out', r.out_at, siteName(r.out_site_id), r.out_distance_m, r.out_accuracy_m)}
      </div>
      ${flags.length ? `<ul class="flags">${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      <div class="map map-md" id="modal-rec-map"></div>
      <div class="metrics">
        <div class="metric"><div class="stat-label">Shift</div><div class="v">${esc(shiftLabel(r.shift_start, r.shift_end))}</div></div>
        <div class="metric"><div class="stat-label">Late</div><div class="v">${fmtMin(r.late_min)}</div></div>
        <div class="metric"><div class="stat-label">Regular</div><div class="v">${fmtMin(r.regular_min)}</div></div>
        <div class="metric"><div class="stat-label">Overtime</div><div class="v">${fmtMin(r.overtime_min)}</div></div>
      </div>
      ${r.reviewed_by ? `<p class="muted small">Reviewed by ${esc(r.reviewer_name)} on ${fmtDateTime(r.reviewed_at)}${r.review_note ? ` — “${esc(r.review_note)}”` : ''}</p>` : ''}
      ${canReview || canOverride ? `
        <div class="review">
          <div class="field"><label for="rev-note">Review note</label><input id="rev-note" placeholder="${canOverride ? 'Reason for rejecting this verified record' : 'Required when rejecting'}" value="${esc(r.review_note || '')}"></div>
          <div class="review-actions">
            <button class="btn btn-danger" data-rev="rejected">Reject</button>
            ${canReview ? '<button class="btn btn-primary" data-rev="approved">Approve</button>' : ''}
          </div>
        </div>` : ''}
    `, true);

    $$('#modal-body [data-rev]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/attendance/${r.id}/review`, { method: 'POST', body: { status: b.dataset.rev, note: $('#rev-note').value } });
        closeModal(); toast(`Record ${b.dataset.rev}`);
        route();
      } catch (err) { toast(err.message, true); }
    }));

    const map = getMap('modal-rec-map', [r.in_lat, r.in_lng], 16);
    const layers = sites.map((s) => fence(s).bindTooltip(s.name).addTo(map._layer));
    layers.push(L.marker([r.in_lat, r.in_lng], { icon: pinIcon('pin-in') }).bindTooltip(`In ${fmtTime(r.in_at)}`).addTo(map._layer));
    if (r.out_at) layers.push(L.marker([r.out_lat, r.out_lng], { icon: pinIcon('pin-out') }).bindTooltip(`Out ${fmtTime(r.out_at)}`).addTo(map._layer));
    setTimeout(() => { map.invalidateSize(); fit(map, layers); }, 50);
  }

  // ================================================================ PAYROLL
  $('#pay-from').value = monthStart(); $('#pay-to').value = todayIso();
  ['#pay-from', '#pay-to', '#pay-site'].forEach((s) => $(s).addEventListener('change', loadPayroll));
  $('#pay-export').addEventListener('click', () => {
    geoDownload(`/reports/payroll.csv?from=${$('#pay-from').value}&to=${$('#pay-to').value}&site_id=${$('#pay-site').value}`);
  });

  async function loadPayroll() {
    const q = new URLSearchParams({ from: $('#pay-from').value, to: $('#pay-to').value, site_id: $('#pay-site').value });
    const { lines } = await api(`/reports/payroll?${q}`);
    const tot = (k) => lines.reduce((t, l) => t + l[k], 0);
    const pending = tot('pending');
    $('#pay-stats').innerHTML = [
      ['Regular hours', fmtHrs(tot('regular_min')), 'lead'],
      ['Overtime hours', fmtHrs(tot('overtime_min')), ''],
      ['Late (total)', fmtMin(tot('late_min')), tot('late_min') ? 'warn' : ''],
      ['Undertime (total)', fmtMin(tot('undertime_min')), tot('undertime_min') ? 'warn' : ''],
      ['Pending review', pending, pending ? 'warn' : ''],
    ].map(([l, v, c]) => `<div class="stat ${c}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join('');

    $('#pay-table').innerHTML = `
      <thead><tr><th>Employee</th><th>Site</th><th class="num">Days</th><th class="num">Shifts</th><th class="num">Regular h</th><th class="num">OT h</th><th class="num">Late</th><th class="num">Undertime</th><th>Attention</th></tr></thead>
      <tbody>${lines.length ? lines.map((l) => {
        const notes = [l.pending && badge('flagged', `${l.pending} pending`), l.rejected && badge('rejected', `${l.rejected} rejected`), l.incomplete && badge('late', `${l.incomplete} no check-out`)].filter(Boolean).join(' ');
        return `<tr>
          <td><div class="cell-main">${esc(l.name)}</div><div class="cell-sub">${esc(l.employee_no || '')}</div></td>
          <td>${esc(l.site_name || '—')}</td>
          <td class="num">${l.days}</td>
          <td class="num">${l.sessions}</td>
          <td class="num cell-main">${fmtHrs(l.regular_min)}</td>
          <td class="num">${fmtHrs(l.overtime_min)}</td>
          <td class="num">${l.late_min ? fmtMin(l.late_min) : '—'}</td>
          <td class="num">${l.undertime_min ? fmtMin(l.undertime_min) : '—'}</td>
          <td>${notes || '<span class="muted">—</span>'}</td>
        </tr>`;
      }).join('') : '<tr class="empty"><td colspan="9">No employees in scope.</td></tr>'}</tbody>
      ${lines.length ? `<tfoot><tr><td colspan="2">Total</td><td class="num">${tot('days')}</td><td class="num">${tot('sessions')}</td><td class="num">${fmtHrs(tot('regular_min'))}</td><td class="num">${fmtHrs(tot('overtime_min'))}</td><td class="num">${fmtMin(tot('late_min'))}</td><td class="num">${fmtMin(tot('undertime_min'))}</td><td></td></tr></tfoot>` : ''}`;
    $('#pay-note').textContent = 'Hours count only verified and approved shifts. Shifts awaiting review are excluded until a manager approves them. Late time is already excluded from regular hours, and the unpaid break of each shift is deducted.';
  }

  // ================================================================ EMPLOYEES
  let employees = [];
  $('#emp-search').addEventListener('input', renderEmployees);
  $('#emp-add').addEventListener('click', () => employeeForm());

  async function loadEmployees() {
    ({ employees } = await api('/employees'));
    renderEmployees();
  }

  const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const SHIFT_PRESETS = [
    { label: 'Morning', start: '07:00', end: '12:00', break_min: 0 },
    { label: 'Afternoon', start: '13:00', end: '17:00', break_min: 0 },
    { label: 'Whole day', start: '08:00', end: '17:00', break_min: 60 },
    { label: 'Evening', start: '17:00', end: '21:00', break_min: 0 },
    { label: 'Night', start: '22:00', end: '06:00', break_min: 60 },
  ];

  // '12345' -> 'Mon–Fri', '135' -> 'Mon, Wed, Fri'
  function fmtDays(days) {
    const d = [...String(days)].map(Number).sort();
    if (d.length === 7) return 'Daily';
    const runs = [];
    for (const n of d) {
      const last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
    }
    return runs.map(([a, b]) => (a === b ? DAY_SHORT[a - 1] : b === a + 1 ? `${DAY_SHORT[a - 1]}, ${DAY_SHORT[b - 1]}` : `${DAY_SHORT[a - 1]}–${DAY_SHORT[b - 1]}`)).join(', ');
  }

  function shiftMinutes(sh) {
    const [sh1, sm1] = sh.start.split(':').map(Number);
    const [sh2, sm2] = sh.end.split(':').map(Number);
    let m = (sh2 * 60 + sm2) - (sh1 * 60 + sm1);
    if (m <= 0) m += 1440;
    return m - (Number(sh.break_min) || 0);
  }

  function renderEmployees() {
    const q = $('#emp-search').value.trim().toLowerCase();
    const list = employees.filter((e) => !q || [e.name, e.employee_no, e.position, e.email].some((v) => String(v || '').toLowerCase().includes(q)));
    const admin = state.me.role === 'admin';
    $('#emp-table').className = `table${admin ? ' clickable' : ''}`;
    $('#emp-table').innerHTML = `
      <thead><tr><th>Name</th><th>Role</th><th>Site</th><th>Mode</th><th>Shifts</th><th>Status</th></tr></thead>
      <tbody>${list.length ? list.map((e) => `
        <tr data-id="${e.id}">
          <td><div class="cell-main">${esc(e.name)}</div><div class="cell-sub">${esc(e.employee_no || '')}${e.position ? ` · ${esc(e.position)}` : ''}</div></td>
          <td style="text-transform:capitalize">${esc(e.role)}</td>
          <td>${esc(e.site_name || '—')}</td>
          <td>${badge(e.work_type, WORK_LABEL[e.work_type])}</td>
          <td class="shift-cell">${e.shifts.length ? e.shifts.map((sh) => `<div><span class="shift-days">${esc(fmtDays(sh.days))}</span> <span class="num">${esc(shiftLabel(sh.start, sh.end))}</span>${ruleLabel(sh) ? ` <span class="shift-site-name">· ${esc(ruleLabel(sh))}</span>` : ''}</div>`).join('') : '<span class="muted">None</span>'}</td>
          <td>${e.active ? badge('ok', 'Active') : badge('off', 'Inactive')}</td>
        </tr>`).join('') : '<tr class="empty"><td colspan="6">No employees found.</td></tr>'}</tbody>`;
    if (admin) $$('#emp-table tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', () => employeeForm(employees.find((x) => x.id === Number(tr.dataset.id)))));
  }

  async function employeeForm(e = null) {
    if (!state.sites.length) ({ sites: state.sites } = await api('/sites'));
    const v = e || { role: 'employee', work_type: 'site', grace_min: 5, early_min: 10, active: 1, shifts: [] };
    let shifts = (v.shifts.length ? v.shifts : [{ days: '12345', start: '08:00', end: '17:00', break_min: 60 }])
      .map((sh) => ({ id: sh.id, days: sh.days, start: sh.start, end: sh.end, break_min: sh.break_min, early_min: sh.early_min ?? null, work_type: sh.work_type ?? (sh.site_id ? 'site' : null), site_id: sh.site_id ?? null }));
    const opt = (val, label, cur) => `<option value="${val}"${String(cur) === String(val) ? ' selected' : ''}>${esc(label)}</option>`;

    openModal(e ? 'Edit employee' : 'Add employee', `
      <form id="emp-form" class="form-grid" novalidate>
        <div class="field"><label for="f-name">Full name</label><input id="f-name" name="name" required value="${esc(v.name)}"></div>
        <div class="field"><label for="f-email">Email (sign-in)</label><input id="f-email" name="email" type="email" required value="${esc(v.email)}"></div>
        <div class="field"><label for="f-no">Employee no.</label><input id="f-no" name="employee_no" value="${esc(v.employee_no)}"></div>
        <div class="field"><label for="f-pos">Position</label><input id="f-pos" name="position" value="${esc(v.position)}"></div>

        <div class="form-section">Default location rules</div>
        <p class="full muted small section-note">Used by shifts set to "Employee default" and by unscheduled check-ins. Each shift below can override them.</p>
        <div class="field"><label for="f-site">Assigned site</label><select id="f-site" name="site_id"><option value="">— None —</option>${state.sites.map((s) => opt(s.id, s.name, v.site_id)).join('')}</select><span class="hint">Default for shifts without their own site. Managers oversee people assigned here.</span></div>
        <div class="field"><label for="f-wt">Check-in mode</label><select id="f-wt" name="work_type">
          ${opt('site', 'Site-bound — only at assigned site', v.work_type)}${opt('multi', 'Multi-site — at any active site', v.work_type)}${opt('field', 'Field — anywhere, location logged', v.work_type)}
        </select></div>
        <div class="field"><label for="f-role">Role</label><select id="f-role" name="role">${opt('employee', 'Employee', v.role)}${opt('manager', 'Manager (oversees assigned site)', v.role)}${opt('admin', 'Administrator', v.role)}</select></div>
        <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active account</label>

        <div class="form-section section-row">
          <span>Shifts</span>
          <button type="button" class="btn btn-ghost btn-sm" id="shift-add">+ Add shift</button>
        </div>
        <div class="full shift-presets" role="group" aria-label="Quick add a shift">
          <span class="muted small">Quick add:</span>
          ${SHIFT_PRESETS.map((p, i) => `<button type="button" class="chip" data-preset="${i}">${p.label} <span class="num">${hmToLabel(p.start)}–${hmToLabel(p.end)}</span></button>`).join('')}
        </div>
        <div class="full shift-list" id="shift-list"></div>

        <div class="form-section">Rules &amp; access</div>
        <div class="field"><label for="f-gr">Late grace (min)</label><input id="f-gr" name="grace_min" type="number" min="0" value="${esc(v.grace_min)}"><span class="hint">Arrivals within this many minutes aren't marked late.</span></div>
        <div class="field">
          <label for="f-early">Default early check-in (min)</label>
          <div class="input-row">
            <input id="f-early" name="early_min" type="number" min="0" max="240" value="${esc(v.early_min ?? 10)}">
            <button type="button" class="btn btn-ghost btn-sm" id="early-apply">Apply to all shifts</button>
          </div>
          <span class="hint">Check-in opens this many minutes before a shift starts. Used by shifts with a blank early check-in.</span>
        </div>

        <p class="form-error full" id="emp-err"></p>
        <div class="form-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">${e ? 'Save changes' : 'Add employee'}</button></div>
      </form>`, true);

    const homeSite = () => state.sites.find((x) => String(x.id) === $('#f-site').value);
    const defaultEarly = () => Number($('#f-early').value || 0);
    // "7:50 AM" — start minus this shift's early check-in (or the employee default).
    const opensLabel = (sh) => {
      const [h, m] = sh.start.split(':').map(Number);
      const t = ((h * 60 + m - (sh.early_min ?? defaultEarly())) % 1440 + 1440) % 1440;
      return hmToLabel(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    };
    // What "Employee default" means right now, from the Default location rules fields.
    const defaultRule = () => {
      const wt = $('#f-wt').value;
      if (wt === 'field') return 'anywhere';
      if (wt === 'multi') return 'any active site';
      return homeSite() ? `at ${homeSite().name}` : 'at assigned site (none set)';
    };
    const renderShifts = () => {
      $('#shift-list').innerHTML = shifts.map((sh, i) => `
        <fieldset class="shift-card" data-i="${i}">
          <legend class="sr-only">Shift ${i + 1}</legend>
          <div class="shift-head">
            <span class="shift-title">Shift ${i + 1}</span>
            <span class="muted small num">${fmtMin(shiftMinutes(sh))} paid${sh.end <= sh.start ? ' · overnight' : ''} · check-in opens ${esc(opensLabel(sh))}</span>
            <button type="button" class="btn btn-danger btn-sm shift-remove" data-remove="${i}" ${shifts.length === 1 ? 'disabled title="An employee needs at least one shift"' : ''}>Remove</button>
          </div>
          <div class="day-toggles" role="group" aria-label="Days for shift ${i + 1}">
            ${DAY_SHORT.map((d, n) => `<button type="button" class="day${sh.days.includes(String(n + 1)) ? ' on' : ''}" data-day="${n + 1}" aria-pressed="${sh.days.includes(String(n + 1))}">${d}</button>`).join('')}
          </div>
          <div class="field shift-site">
            <label>Location rule</label>
            <select data-k="rule">
              <option value="">Employee default — ${esc(defaultRule())}</option>
              <optgroup label="Check in at a specific site">
                ${state.sites.filter((x) => x.active || x.id === sh.site_id).map((x) => `<option value="site:${x.id}"${sh.work_type === 'site' && x.id === sh.site_id ? ' selected' : ''}>At ${esc(x.name)}</option>`).join('')}
              </optgroup>
              <optgroup label="Other rules">
                <option value="multi"${sh.work_type === 'multi' ? ' selected' : ''}>Any active site (multi-site)</option>
                <option value="field"${sh.work_type === 'field' ? ' selected' : ''}>Anywhere — field work, location logged</option>
              </optgroup>
            </select>
          </div>
          <div class="shift-times">
            <div class="field"><label>Start</label><input type="time" data-k="start" value="${esc(sh.start)}" required></div>
            <div class="field"><label>End</label><input type="time" data-k="end" value="${esc(sh.end)}" required></div>
            <div class="field"><label>Unpaid break (min)</label><input type="number" min="0" data-k="break_min" value="${esc(sh.break_min)}"></div>
            <div class="field"><label>Early check-in (min)</label><input type="number" min="0" max="240" data-k="early_min" value="${sh.early_min ?? ''}" placeholder="Default (${esc(defaultEarly())})"></div>
          </div>
        </fieldset>`).join('');
    };
    renderShifts();
    $('#f-site').addEventListener('change', renderShifts);
    $('#f-wt').addEventListener('change', renderShifts);
    $('#f-early').addEventListener('input', renderShifts); // placeholders + "opens at" follow the default
    $('#early-apply').addEventListener('click', () => {
      const val = defaultEarly();
      shifts.forEach((sh) => { sh.early_min = val; });
      renderShifts();
      toast(`Early check-in set to ${val} min on all ${shifts.length} shift${shifts.length > 1 ? 's' : ''}. Save to keep it.`);
    });

    const addShift = (base) => {
      // Default new shifts to the days the last shift used, so split shifts are one click.
      const days = shifts.length ? shifts[shifts.length - 1].days : '12345';
      const prev = shifts[shifts.length - 1];
      shifts.push({ days, start: base.start, end: base.end, break_min: base.break_min, early_min: prev?.early_min ?? null, work_type: prev?.work_type ?? null, site_id: prev?.site_id ?? null });
      renderShifts();
    };
    // "+ Add shift" proposes a 4-hour block starting an hour after the last shift ends.
    const toHm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    $('#shift-add').addEventListener('click', () => {
      const last = shifts[shifts.length - 1];
      if (!last) return addShift(SHIFT_PRESETS[2]);
      const [h, m] = last.end.split(':').map(Number);
      const start = h * 60 + m + 60;
      addShift({ start: toHm(start), end: toHm(start + 240), break_min: 0 });
    });
    $$('#modal-body [data-preset]').forEach((b) => b.addEventListener('click', () => addShift(SHIFT_PRESETS[Number(b.dataset.preset)])));

    $('#shift-list').addEventListener('click', (ev) => {
      const card = ev.target.closest('.shift-card');
      if (!card) return;
      const i = Number(card.dataset.i);
      const day = ev.target.closest('[data-day]');
      if (day) {
        const d = day.dataset.day;
        const set = new Set(shifts[i].days);
        if (set.has(d)) set.delete(d); else set.add(d);
        shifts[i].days = [...set].sort().join('');
        renderShifts();
      }
      const rm = ev.target.closest('[data-remove]');
      if (rm && shifts.length > 1) { shifts.splice(i, 1); renderShifts(); }
    });
    $('#shift-list').addEventListener('change', (ev) => {
      const k = ev.target.dataset.k;
      if (!k) return;
      const i = Number(ev.target.closest('.shift-card').dataset.i);
      if (k === 'rule') {
        // '' = employee default · 'site:<id>' = at that site · 'multi' = any site · 'field' = anywhere
        const [mode, id] = ev.target.value.split(':');
        shifts[i].work_type = mode || null;
        shifts[i].site_id = mode === 'site' ? Number(id) : null;
      } else {
        shifts[i][k] = k === 'break_min' ? Number(ev.target.value || 0)
          : k === 'early_min' ? (ev.target.value === '' ? null : Number(ev.target.value))
          : ev.target.value;
      }
      renderShifts();
    });

    $('#emp-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const body = Object.fromEntries(fd);
      body.active = fd.has('active');
      body.shifts = shifts;
      try {
        if (e) await api(`/employees/${e.id}`, { method: 'PUT', body });
        else await api('/employees', { method: 'POST', body });
        closeModal(); toast(e ? 'Employee updated' : 'Employee added');
        loadEmployees();
      } catch (err) { $('#emp-err').textContent = err.message; }
    });
  }

  // ================================================================ SITES
  $('#site-add').addEventListener('click', () => siteForm());

  async function loadSites() {
    ({ sites: state.sites } = await api('/sites'));
    const admin = state.me.role === 'admin';
    $('#site-list').innerHTML = state.sites.length ? state.sites.map((s) => `
      <li data-id="${s.id}">
        <div class="avatar" aria-hidden="true"><svg class="avatar-icon" viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg></div>
        <div class="who" style="flex:1;min-width:0">
          <div class="cell-main">${esc(s.name)}</div>
          <div class="cell-sub">${esc(SITE_KINDS[s.kind] || s.kind)} · ${esc(s.address || `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`)}</div>
        </div>
        <div class="when" style="text-align:right;font-size:12px;color:var(--text-2)">
          <div>${s.qr_required ? `${badge('out', 'QR')} ` : ''}${s.active ? badge('ok', `${s.radius_m} m`) : badge('off', 'Inactive')}</div>
          <div style="margin-top:4px">${s.staff_count} staff</div>
        </div>
      </li>`).join('') : '<li class="empty-list">No sites yet.</li>';

    const map = getMap('sites-map');
    map._layer.clearLayers();
    const layers = state.sites.filter((s) => s.active).map((s) => fence(s).bindTooltip(`${s.name} · ${s.radius_m} m`).addTo(map._layer));
    fit(map, layers);
    $$('#site-list li[data-id]').forEach((li) => li.addEventListener('click', () => {
      const s = state.sites.find((x) => x.id === Number(li.dataset.id));
      if (admin) siteForm(s); else map.setView([s.lat, s.lng], 17);
    }));
  }

  function siteForm(s = null) {
    const v = s || { kind: 'branch', radius_m: 100, active: 1 };
    const opt = (val, label) => `<option value="${val}"${v.kind === val ? ' selected' : ''}>${label}</option>`;
    openModal(s ? 'Edit site' : 'Add site', `
      <form id="site-form" class="form-grid" novalidate>
        <div class="field"><label for="s-name">Site name</label><input id="s-name" name="name" required value="${esc(v.name)}"></div>
        <div class="field"><label for="s-kind">Type</label><select id="s-kind" name="kind">${Object.entries(SITE_KINDS).map(([k, label]) => opt(k, label)).join('')}</select></div>
        <div class="field full"><label for="s-addr">Address</label><input id="s-addr" name="address" value="${esc(v.address)}"></div>
        <div class="field full">
          <label>Geofence — click the map to place the centre</label>
          <div class="map map-md" id="modal-site-map"></div>
        </div>
        <div class="field"><label for="s-lat">Latitude</label><input id="s-lat" name="lat" type="number" step="any" value="${v.lat ?? ''}"></div>
        <div class="field"><label for="s-lng">Longitude</label><input id="s-lng" name="lng" type="number" step="any" value="${v.lng ?? ''}"></div>
        <div class="field"><label for="s-rad">Radius (m)</label><input id="s-rad" name="radius_m" type="number" min="10" max="5000" value="${v.radius_m}"><span class="hint">15–30 m for a single room, 50–150 m for a building, wider for grounds. Phone GPS is often only accurate to ±10–30 m indoors.</span></div>
        <div class="field" style="justify-content:flex-end;gap:8px">
          <button type="button" class="btn btn-ghost btn-sm" id="s-here">Use my current location</button>
          <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active</label>
        </div>
        <div class="field full qr-setting">
          <label class="check"><input type="checkbox" name="qr_required" ${v.qr_required ? 'checked' : ''}> Require the class QR to check in and out here</label>
          <span class="hint">Put a screen in the room showing this site's QR display. Every class scheduled here gets its own random code, shown from the class's early check-in until it ends. A code only works for that teacher's class, at this site, on that day. Anyone checking in or out inside this geofence must scan their class's code first. Field (anywhere) shifts don't need it.</span>
          ${s ? `<div class="qr-actions">
            <button type="button" class="btn btn-ghost btn-sm" id="s-kiosk-open">Open QR display</button>
            <button type="button" class="btn btn-ghost btn-sm" id="s-kiosk-copy">Copy display link</button>
            <button type="button" class="btn btn-danger btn-sm" id="s-kiosk-reset">Reset link</button>
          </div>
          <span class="hint">Keep the display link private: anyone with it can see the codes. <strong>Reset link</strong> stops the old link and replaces today's codes, so open the new one on the room's screen afterwards.</span>` : ''}
        </div>
        <p class="form-error full" id="site-err"></p>
        <div class="form-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">${s ? 'Save site' : 'Add site'}</button></div>
      </form>`, true);

    if (s) {
      const link = async (reset = false) => {
        const { path } = await api(`/sites/${s.id}/kiosk${reset ? '/reset' : ''}`, reset ? { method: 'POST' } : {});
        return GEO_CONFIG.apiUrl + path;
      };
      $('#s-kiosk-open').addEventListener('click', async () => {
        // Open the tab synchronously, so the popup blocker allows it, then point it at the link.
        const w = window.open('', '_blank');
        try { const url = await link(); if (w) w.location = url; else location.assign(url); } catch (err) { w?.close(); toast(err.message, true); }
      });
      $('#s-kiosk-copy').addEventListener('click', async () => {
        try { if (await geoCopy(await link())) toast('Display link copied'); } catch (err) { toast(err.message || 'Could not copy the link', true); }
      });
      $('#s-kiosk-reset').addEventListener('click', async () => {
        if (!confirm(`Reset the QR display link for ${s.name}? The current display stops working until you open the new link on it.`)) return;
        try { await link(true); toast('Display link reset. Open the new link on the room\'s screen.'); } catch (err) { toast(err.message, true); }
      });
    }

    const center = v.lat != null ? [v.lat, v.lng] : state.sites[0] ? [state.sites[0].lat, state.sites[0].lng] : [13.9621, 121.1633];
    const map = getMap('modal-site-map', center, 16);
    let circle = null;
    const draw = () => {
      const lat = Number($('#s-lat').value); const lng = Number($('#s-lng').value); const r = Number($('#s-rad').value) || 100;
      if (!$('#s-lat').value || !$('#s-lng').value || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (circle) circle.remove();
      circle = fence({ lat, lng, radius_m: r }).addTo(map._layer);
    };
    const place = (lat, lng, pan) => {
      $('#s-lat').value = lat.toFixed(6); $('#s-lng').value = lng.toFixed(6); draw();
      if (pan) map.setView([lat, lng], 17);
    };
    map.on('click', (e) => place(e.latlng.lat, e.latlng.lng, false));
    ['#s-lat', '#s-lng', '#s-rad'].forEach((sel) => $(sel).addEventListener('input', draw));
    setTimeout(() => { map.invalidateSize(); draw(); if (circle) map.fitBounds(circle.getBounds(), { padding: [20, 20] }); }, 50);

    $('#s-here').addEventListener('click', () => {
      if (!navigator.geolocation) return toast('Location not supported', true);
      navigator.geolocation.getCurrentPosition(
        (p) => place(p.coords.latitude, p.coords.longitude, true),
        () => toast('Could not read your location', true),
        { enableHighAccuracy: true, timeout: 15000 },
      );
    });

    $('#site-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const body = Object.fromEntries(fd);
      body.active = fd.has('active');
      body.qr_required = fd.has('qr_required');
      try {
        if (s) await api(`/sites/${s.id}`, { method: 'PUT', body });
        else await api('/sites', { method: 'POST', body });
        closeModal(); toast(s ? 'Site updated' : 'Site added');
        loadSites();
      } catch (err) { $('#site-err').textContent = err.message; }
    });
  }

  boot();
})();
