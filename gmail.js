// Gmail (read-only) for GlenCal. Sign-in happens on Google's own page; the short-lived access token
// stays in this window's session storage and is only used to call Google directly from the phone.
var Gmail = (function () {
  var CLIENT_ID = '763528613489-9comi47olvj2chti87hk4tet9a4ei6bd.apps.googleusercontent.com';
  var SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  var REDIRECT = location.origin + location.pathname.replace(/[^/]*$/, '') + 'oauth.html';
  function rnd() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function get(k) { try { return localStorage.getItem('glencal.g.' + k); } catch (e) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem('glencal.g.' + k); else localStorage.setItem('glencal.g.' + k, v); } catch (e) {} }
  function dec(d) {   // base64url -> UTF-8 text
    var bin = atob(d.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(u);
  }
  function htmlToText(h) {   // parsed without running anything, then read as text
    if (!h) return '';
    h = h.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)[^>]*>/gi, '\n$&');
    var doc = new DOMParser().parseFromString(h, 'text/html');
    doc.querySelectorAll('script,style,head,title').forEach(function (n) { n.remove(); });
    return (doc.body ? doc.body.textContent : '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  }
  return {
    redirect: REDIRECT,
    start: function (opts) {
      var state = rnd(); set('state', state); set('silent', opts && opts.silent ? '1' : null);
      location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + [
        'client_id=' + encodeURIComponent(CLIENT_ID), 'redirect_uri=' + encodeURIComponent(REDIRECT),
        'response_type=token', 'scope=' + encodeURIComponent(SCOPE), 'include_granted_scopes=true', 'state=' + state
      ].join('&') + (opts && opts.silent ? '&prompt=none' : '');
    },
    token: function () {
      var t = get('token'), exp = +get('exp');
      return t && exp > Date.now() + 30000 ? t : null;
    },
    forget: function () { set('token', null); set('exp', null); },
    status: function () { var t = get('token'), exp = +get('exp'); if (!t) return 'not signed in'; var m = Math.round((exp - Date.now()) / 60000); return m > 0 ? 'signed in, ' + m + ' min left' : 'sign-in expired'; },
    // renew without asking, if Google still remembers this phone; at most once every 10 minutes
    canRenew: function () { return get('ok') === '1' && Date.now() - (+get('triedAt') || 0) > 600000; },
    renew: function () { set('triedAt', String(Date.now())); this.start({ silent: true }); },
    markOK: function (on) { set('ok', on ? '1' : null); },
    api: function (path) {
      var t = this.token(); if (!t) return Promise.reject(new Error('Not signed in'));
      return fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + t } })
        .then(function (r) { if (r.status === 401) { Gmail.forget(); throw new Error('Sign-in expired'); } if (!r.ok) throw new Error('Gmail error ' + r.status); return r.json(); });
    },
    // run fn over items, at most n at a time
    pool: function (items, n, fn) {
      return new Promise(function (res) {
        var out = new Array(items.length), i = 0, active = 0, done = 0;
        if (!items.length) return res(out);
        function next() {
          while (active < n && i < items.length) (function (k) {
            active++;
            fn(items[k]).then(function (v) { out[k] = v; }, function () { out[k] = null; }).then(function () { active--; done++; if (done === items.length) res(out); else next(); });
          })(i++);
        }
        next();
      });
    },
    ids: function (q, max) {   // message ids matching a Gmail search, following pages up to max
      var self = this, all = [];
      function page(tok) {
        return self.api('messages?maxResults=' + Math.min(100, max - all.length) + (q ? '&q=' + encodeURIComponent(q) : '') + (tok ? '&pageToken=' + tok : '')).then(function (d) {
          (d.messages || []).forEach(function (m) { all.push(m.id); });
          return d.nextPageToken && all.length < max ? page(d.nextPageToken) : all;
        });
      }
      return page('');
    },
    // one page of a search: { list: [...messages with sender/subject], next: token for the next page or '' }
    page: function (q, n, tok) {
      var self = this;
      return self.api('messages?maxResults=' + (n || 40) + (q ? '&q=' + encodeURIComponent(q) : '') + (tok ? '&pageToken=' + tok : '')).then(function (d) {
        var ids = (d.messages || []).map(function (m) { return m.id; });
        return self.pool(ids, 8, function (id) { return self.meta(id); }).then(function (l) {
          return { list: l.filter(Boolean).sort(function (a, b) { return b.date - a.date; }), next: d.nextPageToken || '' };
        });
      });
    },
    meta: function (id) {
      return this.api('messages/' + id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date').then(function (x) {
        var h = {}; (x.payload && x.payload.headers || []).forEach(function (y) { h[y.name] = y.value; });
        var from = h.From || '', m = /<([^>]+)>/.exec(from);
        return { id: x.id, threadId: x.threadId, subject: h.Subject || '(no subject)', from: from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || from,
                 fromEmail: (m ? m[1] : from).toLowerCase(), date: +x.internalDate, snippet: x.snippet || '', unread: (x.labelIds || []).indexOf('UNREAD') >= 0 };
      });
    },
    list: function (q, max) {
      var self = this;
      return self.ids(q, max || 40).then(function (ids) { return self.pool(ids, 8, function (id) { return self.meta(id); }); })
        .then(function (l) { return l.filter(Boolean).sort(function (a, b) { return b.date - a.date; }); });
    },
    full: function (id) {   // subject, sender and the body as plain text
      return this.api('messages/' + id + '?format=full').then(function (x) {
        var h = {}; (x.payload && x.payload.headers || []).forEach(function (y) { h[y.name] = y.value; });
        var acc = { plain: [], html: [] };
        (function walk(p) {
          if (!p) return;
          if (p.body && p.body.data) { if (p.mimeType === 'text/plain') acc.plain.push(dec(p.body.data)); else if (p.mimeType === 'text/html') acc.html.push(dec(p.body.data)); }
          (p.parts || []).forEach(walk);
        })(x.payload);
        var from = h.From || '', m = /<([^>]+)>/.exec(from);
        return { id: x.id, threadId: x.threadId, subject: h.Subject || '(no subject)', from: from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || from,
                 fromEmail: (m ? m[1] : from).toLowerCase(), date: +x.internalDate, snippet: x.snippet || '',
                 text: acc.plain.length ? acc.plain.join('\n') : htmlToText(acc.html.join('\n')) };
      });
    },
    latest: function (n) {
      var self = this;
      return self.api('messages?maxResults=' + (n || 10)).then(function (d) {
        return Promise.all((d.messages || []).map(function (m) {
          return self.api('messages/' + m.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date').then(function (x) {
            var h = {}; (x.payload && x.payload.headers || []).forEach(function (y) { h[y.name] = y.value; });
            return { id: m.id, subject: h.Subject || '(no subject)', from: (h.From || '').replace(/<[^>]+>/, '').trim(), date: h.Date || '', snippet: x.snippet || '' };
          });
        }));
      });
    }
  };
})();
