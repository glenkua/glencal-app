// Landing page for Google sign-in. Saves the token for GlenCal if we came back inside the app window.
(function () {
  var p = {}; location.hash.slice(1).split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
  history.replaceState(null, '', location.pathname);   // don't keep the token in the address bar
  var msg = document.getElementById('msg'), expected = null;
  try { expected = sessionStorage.getItem('glencal.g.state'); } catch (e) {}
  var standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (p.error) { msg.textContent = 'Google sign-in was cancelled or failed (' + p.error + '). Go back to GlenCal and try again.'; return; }
  if (!p.access_token) { msg.textContent = 'No sign-in details found. Go back to GlenCal and tap Connect Gmail again.'; return; }
  if (!expected || expected !== p.state) {
    msg.innerHTML = '<b>Signed in, but iPhone finished it in a separate browser window</b>, so GlenCal can\'t receive it.<br><br>' +
      'Close this window (Done, top left) and tell Claude: "<b>separate window</b>" (standalone: ' + standalone + ').';
    return;
  }
  try {
    sessionStorage.setItem('glencal.g.token', p.access_token);
    sessionStorage.setItem('glencal.g.exp', String(Date.now() + (+p.expires_in || 3600) * 1000));
    sessionStorage.removeItem('glencal.g.state');
  } catch (e) {}
  location.replace('./#mail');
})();
