// Gmail (read-only) for GlenCal. Sign-in happens on Google's own page; the short-lived access token
// stays in this window's session storage and is only used to call Google directly from the phone.
var Gmail = (function () {
  var CLIENT_ID = '763528613489-9comi47olvj2chti87hk4tet9a4ei6bd.apps.googleusercontent.com';
  var SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  var REDIRECT = location.origin + location.pathname.replace(/[^/]*$/, '') + 'oauth.html';
  function rnd() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function get(k) { try { return sessionStorage.getItem('glencal.g.' + k); } catch (e) { return null; } }
  function set(k, v) { try { if (v == null) sessionStorage.removeItem('glencal.g.' + k); else sessionStorage.setItem('glencal.g.' + k, v); } catch (e) {} }
  return {
    redirect: REDIRECT,
    start: function () {
      var state = rnd(); set('state', state);
      location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + [
        'client_id=' + encodeURIComponent(CLIENT_ID), 'redirect_uri=' + encodeURIComponent(REDIRECT),
        'response_type=token', 'scope=' + encodeURIComponent(SCOPE), 'include_granted_scopes=true', 'state=' + state
      ].join('&');
    },
    token: function () {
      var t = get('token'), exp = +get('exp');
      return t && exp > Date.now() + 30000 ? t : null;
    },
    forget: function () { set('token', null); set('exp', null); },
    api: function (path) {
      var t = this.token(); if (!t) return Promise.reject(new Error('Not signed in'));
      return fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + t } })
        .then(function (r) { if (r.status === 401) { Gmail.forget(); throw new Error('Sign-in expired'); } if (!r.ok) throw new Error('Gmail error ' + r.status); return r.json(); });
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
