/* Geo Attendance web page <-> Apps Script API (Web.gs#doPost), plus Google sign-in.
 * The page lives outside Google's Apps Script frame so the camera works in the photo box. */
(function () {
  'use strict';
  var KEY = 'geo.session';
  var cfg = window.GEO_CONFIG || {};

  function session() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setSession(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ } }

  // Same contract as the Node build's api(): resolves with the body, throws Error(body.error),
  // and calls onUnauthorized on a 401. text/plain keeps it a "simple" CORS request.
  window.geoRpc = function (path, opts, onUnauthorized) {
    opts = opts || {};
    if (path === '/auth/logout') { window.geoSignOut(); return Promise.resolve({}); }
    return fetch(cfg.apiUrl, {
      method: 'POST',
      body: JSON.stringify({ method: opts.method || 'GET', path: '/api' + path, body: opts.body || null, session: session() }),
    }).then(function (r) {
      if (!r.ok) throw new Error('The server had a problem (' + r.status + '). Try again.');
      return r.json();
    }, function () {
      throw new Error('Could not reach the server. Check your connection.');
    }).then(function (res) {
      if (!res || typeof res.status !== 'number') throw new Error('Unexpected response from the server');
      var body = res.body || {};
      if (res.status >= 200 && res.status < 300) return res.body;
      if (res.status === 401) { setSession(null); if (path !== '/auth/me' && onUnauthorized) onUnauthorized(body.error); }
      throw new Error(body.error || ('Request failed (' + res.status + ')'));
    });
  };

  window.geoSignOut = function () {
    setSession(null);
    try { google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
  };

  // Renders "Sign in with Google" into #login-google; done() runs once a session is issued.
  window.geoSignIn = function (done) {
    var box = document.getElementById('login-google');
    var err = document.getElementById('login-error');
    if (!cfg.clientId) { err.textContent = 'Google sign-in is not configured yet. Ask the administrator.'; return; }
    var tries = 0;
    (function start() {
      if (!(window.google && google.accounts && google.accounts.id)) {
        if (++tries > 100) { err.textContent = 'Could not load Google sign-in. Check your connection and reload.'; return; }
        setTimeout(start, 100);
        return;
      }
      google.accounts.id.initialize({
        client_id: cfg.clientId,
        hd: 'dlsl.edu.ph',
        auto_select: true,
        cancel_on_tap_outside: false,
        callback: function (resp) {
          err.textContent = '';
          box.setAttribute('aria-busy', 'true');
          window.geoRpc('/auth/google', { method: 'POST', body: { credential: resp.credential } }).then(function (r) {
            setSession(r.session);
            box.removeAttribute('aria-busy');
            done();
          }).catch(function (e) {
            box.removeAttribute('aria-busy');
            err.textContent = e.message;
          });
        },
      });
      box.innerHTML = '';
      google.accounts.id.renderButton(box, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
      google.accounts.id.prompt();
    })();
  };

  // CSV reports come back as { filename, text }; save them as a file.
  window.geoDownload = function (path) {
    window.geoRpc(path, {}, function () {}).then(function (r) {
      var url = URL.createObjectURL(new Blob([r.text], { type: 'text/csv;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url; a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }).catch(function (e) { window.alert(e.message); });
  };

  window.geoCopy = function (text) {
    return navigator.clipboard.writeText(text).then(function () { return true; })
      .catch(function () { window.prompt('Copy this link:', text); return false; });
  };

  // Attendance photos: <img data-photo="<id>/<in|out>"> gets its picture through the API;
  // <a data-photo-open> opens it full size in a new tab.
  var photos = {};
  function photo(key) {
    if (!photos[key]) {
      var p = key.split('/');
      photos[key] = window.geoRpc('/attendance/' + p[0] + '/photo/' + p[1], {}, function () {}).then(function (r) { return r.dataUrl; });
      photos[key].catch(function () { delete photos[key]; });
    }
    return photos[key];
  }
  function fill(root) {
    (root.querySelectorAll ? root.querySelectorAll('img[data-photo]:not([src])') : []).forEach(function (img) {
      photo(img.getAttribute('data-photo')).then(function (url) { img.src = url; }).catch(function () { img.alt = 'Photo unavailable'; });
    });
  }
  new MutationObserver(function () { fill(document); }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-photo-open]');
    if (!a) return;
    e.preventDefault();
    var w = window.open('', '_blank');
    photo(a.getAttribute('data-photo-open')).then(function (url) {
      if (!w) return;
      w.document.title = 'Attendance photo';
      w.document.body.style.cssText = 'margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh';
      var img = w.document.createElement('img');
      img.src = url; img.style.cssText = 'max-width:100%;max-height:100vh';
      w.document.body.appendChild(img);
    }).catch(function () { if (w) w.close(); });
  });
})();
