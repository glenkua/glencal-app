// GlenCal app. Entries live only in the encrypted vault on this device (see vault.js).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  var MONTH_FULL = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  var DOW = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  var LOCK_AFTER_MS = 30000;   // lock when the app has been in the background this long

  var items = [];
  var unlocked = false;
  var econMode = false;                 // ECON view: economic calendar only
  var hiddenCats = {};                  // categories switched off in the main feed
  try { (localStorage.getItem('glencal.hiddenCats') || '').split(',').forEach(function (c) { if (c) hiddenCats[c] = 1; }); } catch (e) {}
  function saveHidden() { prefs('hiddenCats', Object.keys(hiddenCats).join(',')); }
  function allOn() { return !econMode && !Object.keys(hiddenCats).length; }
  var todayISO = GC.iso(new Date());

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function catOf(i) { return (i.cat && GC.CAT_BY_ID[i.cat]) ? i.cat : GC.inferCat([i.title, i.place, i.note].join(' ')); }
  function dLabel(s) { var d = GC.fromISO(s); return { day: d.getDate(), mon: MON[d.getMonth()], dow: DOW[d.getDay()] }; }
  function longLabel(s) { var l = dLabel(s); return l.day + ' ' + l.mon + ' ' + l.dow; }
  function promptToday() {
    var d = new Date();
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' (' + GC.iso(d) + ')';
  }
  function prefs(k, v) {
    try { if (v === undefined) return localStorage.getItem('glencal.' + k); localStorage.setItem('glencal.' + k, v); } catch (e) { return null; }
  }

  // ---------- saving ----------
  var saving = Promise.resolve();
  var rules = [], paid = {}, calcTape = [], notes = [];
  function persist() {
    var snap = { v: 2, items: items.slice(), rules: rules.slice(), paid: Object.assign({}, paid), calc: calcTape.slice(0, 30), notes: notes.filter(function (n) { return n.title || n.body; }) };
    saving = saving.then(function () { return Vault.save(snap); }).catch(function (e) { notice('Saving failed: ' + e.message); });
  }
  function notice(msg) { var n = $('notice'); n.textContent = msg || ''; n.hidden = !msg; syncHead(); }

  // =====================================================================
  // Lock screen
  // =====================================================================
  function lockScreen(html) { $('lockbox').innerHTML = '<h1>GLENCAL</h1>' + html; $('lock').hidden = false; document.body.classList.add('covered'); }
  function friendlyError(e) {
    var m = (e && (e.name || '') + ' ' + (e.message || '')) || '';
    if (/NotAllowed|Abort/.test(m)) return 'Cancelled. Tap the button to try again.';
    if (/NO_PRF/.test(m)) return 'This iPhone browser can\'t use Face ID to encrypt data. Use a passphrase instead.';
    if (/WRONG/.test(m)) return 'That didn\'t unlock it. Check and try again.';
    return 'Something went wrong: ' + (e && e.message ? e.message : e);
  }

  function showSetup(msg) {
    var pk = Vault.passkeySupported();
    lockScreen('<p>Your calendar is stored only on this iPhone, encrypted. ' + (pk ? 'Face ID unlocks it.' : '') + '</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      (pk ? '<button class="btn primary" id="lk-passkey" type="button">SET UP FACE ID</button>' : '') +
      '<button class="btn link" id="lk-pw" type="button">Use a passphrase instead</button>');
    if (pk) $('lk-passkey').onclick = function () { doCreate('passkey'); };
    $('lk-pw').onclick = function () { showPassphraseSetup(); };
  }
  function showPassphraseSetup(msg, rekey) {
    lockScreen('<p>Choose a passphrase. Use at least 4 random words; it can\'t be reset.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<input class="pw" id="lk-p1" type="password" autocomplete="new-password" placeholder="passphrase">' +
      '<input class="pw" id="lk-p2" type="password" autocomplete="new-password" placeholder="type it again">' +
      '<button class="btn primary" id="lk-go" type="button">SET PASSPHRASE</button>');
    $('lk-go').onclick = function () {
      var a = $('lk-p1').value, b = $('lk-p2').value;
      if (a.length < 12) return showPassphraseSetup('Use at least 12 characters.', rekey);
      if (a !== b) return showPassphraseSetup('The two passphrases don\'t match.', rekey);
      doCreate('passphrase', a, rekey);
    };
  }
  async function doCreate(method, pass, rekey) {
    lockScreen('<p>Setting up…</p>');
    try {
      var code = rekey ? await Vault.rekey(method, pass) : await Vault.create(method, pass);
      var list = await Vault.read();
      showRecovery(code, list);
    } catch (e) {
      if (method === 'passkey') showSetup(friendlyError(e)); else showPassphraseSetup(friendlyError(e), rekey);
    }
  }
  function showRecovery(code, list) {
    lockScreen('<p><b style="color:var(--fg)">Your recovery code.</b> Save it in the Passwords app or somewhere safe. ' +
      'It\'s the only way back in if Face ID or your passphrase stops working. You\'ll only see it this once.</p>' +
      '<div class="code" id="lk-code">' + esc(code) + '</div>' +
      '<button class="btn" id="lk-copy" type="button">COPY CODE</button>' +
      '<label><input type="checkbox" id="lk-saved"> I\'ve saved my recovery code</label>' +
      '<button class="btn primary" id="lk-done" type="button" disabled>OPEN GLENCAL</button>');
    $('lk-copy').onclick = function () {
      navigator.clipboard.writeText(code).then(function () { $('lk-copy').textContent = 'COPIED'; }, function () { $('lk-copy').textContent = 'SELECT THE CODE ABOVE AND COPY'; });
    };
    $('lk-saved').onchange = function () { $('lk-done').disabled = !this.checked; };
    $('lk-done').onclick = function () { enterApp(list); };
  }

  function showUnlock(msg) {
    var pw = Vault.method() === 'passphrase';
    lockScreen((msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      (pw ? '<input class="pw" id="lk-p" type="password" autocomplete="current-password" placeholder="passphrase">' : '') +
      '<button class="btn primary" id="lk-unlock" type="button">' + (pw ? 'UNLOCK' : 'UNLOCK WITH FACE ID') + '</button>' +
      '<button class="btn link" id="lk-rec" type="button">Use recovery code</button>');
    $('lk-unlock').onclick = async function () {
      try {
        var list = await Vault.unlock(pw ? $('lk-p').value : undefined);
        if (prefs('lock') !== 'on') await Vault.rekey('device');   // Face ID lock is off: stop asking from now on
        enterApp(list);
      }
      catch (e) { showUnlock(friendlyError(e)); }
    };
    if (pw) $('lk-p').onkeydown = function (e) { if (e.key === 'Enter') $('lk-unlock').click(); };
    $('lk-rec').onclick = function () { showRecoveryEntry(); };
  }
  function showRecoveryEntry(msg) {
    lockScreen('<p>Enter your recovery code. You\'ll then set up Face ID (or a passphrase) again.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<input class="pw" id="lk-c" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX">' +
      '<button class="btn primary" id="lk-go" type="button">UNLOCK</button>' +
      '<button class="btn link" id="lk-back" type="button">Back</button>');
    $('lk-go').onclick = async function () {
      try {
        await Vault.unlockWithRecovery($('lk-c').value);
        lockScreen('<p>Unlocked. Now set up a new way to unlock. This also gives you a new recovery code.</p>' +
          (Vault.passkeySupported() ? '<button class="btn primary" id="lk-passkey" type="button">SET UP FACE ID</button>' : '') +
          '<button class="btn link" id="lk-pw" type="button">Use a passphrase instead</button>');
        if ($('lk-passkey')) $('lk-passkey').onclick = function () { doCreate('passkey', null, true); };
        $('lk-pw').onclick = function () { showPassphraseSetup('', true); };
      } catch (e) { showRecoveryEntry(friendlyError(e)); }
    };
    $('lk-back').onclick = function () { showUnlock(); };
  }

  function showLockOn(msg) {
    lockScreen('<p>Turn on the lock: GlenCal will ask for Face ID (or a passphrase) when it opens and after 30 seconds in the background.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      (Vault.passkeySupported() ? '<button class="btn primary" id="lk-passkey" type="button">USE FACE ID</button>' : '') +
      '<button class="btn link" id="lk-pw" type="button">Use a passphrase instead</button>' +
      '<button class="btn link" id="lk-cancel" type="button">Cancel</button>');
    if ($('lk-passkey')) $('lk-passkey').onclick = function () { doCreate('passkey', null, true); };
    $('lk-pw').onclick = function () { showPassphraseSetup('', true); };
    $('lk-cancel').onclick = function () { prefs('lock', 'off'); $('lock').hidden = true; document.body.classList.remove('covered'); };
  }

  function enterApp(list) {
    var data = Array.isArray(list) ? { items: list } : (list || {});
    items = data.items || [];
    rules = data.rules || [];
    paid = data.paid || {};
    calcTape = data.calc || [];
    notes = data.notes || [];
    Tools.setTape(calcTape);
    unlocked = true;
    todayISO = GC.iso(new Date());
    $('lock').hidden = true;
    document.body.classList.remove('covered');
    setClock();
    refresh();
    setTimeout(function () { setTab('brief'); }, 0);
  }

  function lockNow() {
    Vault.lock();
    unlocked = false;
    items = [];
    closeSheet();
    $('list').innerHTML = '';
    askHistory = []; pending = null;
    calcTape = []; Tools.setTape([]); notes = [];
    showUnlock();
  }

  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    var locking = Vault.method() !== 'device';
    if (document.hidden) {
      hiddenAt = Date.now();
      if (locking) document.body.classList.add('covered');          // hide content from the app switcher
    } else {
      if (locking && unlocked && Date.now() - hiddenAt > LOCK_AFTER_MS) lockNow();
      else if (unlocked) document.body.classList.remove('covered');
      if (unlocked && GC.iso(new Date()) !== todayISO) { todayISO = GC.iso(new Date()); setClock(); refresh(); }
    }
  });

  // =====================================================================
  // World clocks. Amber = that city's main stock exchange is in its trading session
  // (weekdays, local time, lunch breaks excluded; exchange holidays are not accounted for).
  // =====================================================================
  var CLOCKS = [
    { c: 'WELLINGTON', tz: 'Pacific/Auckland', s: [[600, 1005]], x: 'NZX 10:00-16:45' },
    { c: 'SYDNEY', tz: 'Australia/Sydney', s: [[600, 960]], x: 'ASX 10:00-16:00' },
    { c: 'TOKYO', tz: 'Asia/Tokyo', s: [[540, 690], [750, 930]], x: 'TSE 9:00-11:30, 12:30-15:30' },
    { c: 'SINGAPORE', home: true, tz: 'Asia/Singapore', s: [[540, 720], [780, 1020]], x: 'SGX 9:00-12:00, 13:00-17:00' },
    { c: 'LONDON', tz: 'Europe/London', s: [[480, 990]], x: 'LSE 8:00-16:30' },
    { c: 'NEW YORK', tz: 'America/New_York', s: [[570, 960]], x: 'NYSE 9:30-16:00' }
  ];
  var tzFmt = {};
  function zoned(tz, now) {
    var f = tzFmt[tz] || (tzFmt[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    var p = {};
    f.formatToParts(now).forEach(function (x) { p[x.type] = x.value; });
    return { ymd: p.year + '-' + p.month + '-' + p.day, h: +p.hour, m: +p.minute, wd: p.weekday };
  }
  function renderClocks() {
    var now = new Date(), here = GC.iso(now), html = '';
    CLOCKS.forEach(function (k) {
      var z = zoned(k.tz, now), mins = z.h * 60 + z.m;
      var weekday = z.wd !== 'Sat' && z.wd !== 'Sun';
      var open = weekday && k.s.some(function (r) { return mins >= r[0] && mins < r[1]; });
      var diff = Math.round((GC.fromISO(z.ymd) - GC.fromISO(here)) / 86400000);
      html += '<div class="ck' + (open ? ' open' : '') + (k.home ? ' home' : '') + '" title="' + k.x + (open ? ' (open)' : ' (closed)') + '">' +
        '<span class="c">' + k.c + '</span><span class="h">' + ('0' + z.h).slice(-2) + ':' + ('0' + z.m).slice(-2) +
        (diff ? '<span class="o">' + (diff > 0 ? '+' : '−') + Math.abs(diff) + '</span>' : '') + '</span></div>';
    });
    $('clocks').innerHTML = html;
  }
  // ---- market ticker: quotes saved by a GitHub job every ~10 min (delayed), read every 2 min ----
  var MKT = null, mktKey = '';
  try { MKT = JSON.parse(localStorage.getItem('glencal.mkt') || 'null'); } catch (e) {}
  var DP = { USDJPY: 2, SPX: 2, NDX: 2, DOW: 2 };
  function mktURL() {
    var h = location.hostname, m = /^([^.]+)\.github\.io$/.exec(h);
    if (!m) return null;
    var repo = location.pathname.split('/')[1] || (m[1] + '.github.io');
    return 'https://raw.githubusercontent.com/' + m[1] + '/' + repo + '/markets/markets.json';
  }
  function fmtQ(q) {
    var dp = q.kind === 'yield' ? 3 : (DP[q.k] != null ? DP[q.k] : 4);
    var v = Number(q.price).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    var ch = '', cls = 'fl';
    if (q.prev) {
      var d = q.price - q.prev;
      if (q.kind === 'yield') { var bp = d * 100; ch = (bp > 0 ? '+' : bp < 0 ? '−' : '') + Math.abs(bp).toFixed(1) + 'bp'; cls = bp > 0.05 ? 'up' : bp < -0.05 ? 'dn' : 'fl'; }
      else { var pc = d / q.prev * 100; ch = (pc > 0 ? '+' : pc < 0 ? '−' : '') + Math.abs(pc).toFixed(2) + '%'; cls = pc > 0.005 ? 'up' : pc < -0.005 ? 'dn' : 'fl'; }
    }
    return { v: v, ch: ch, cls: cls };
  }
  function renderTicker() {
    if (!MKT || !MKT.items || !MKT.items.length) return;
    var TK = MKT.items.filter(function (q) { return q.tk !== false; });
    var key = TK.map(function (q) { return q.k; }).join(',');
    if (key !== mktKey) {   // build once; later refreshes update numbers in place so the scroll doesn't restart
      var set = TK.map(function (q) {
        return '<span class="tq" data-k="' + esc(q.k) + '"><b>' + esc(q.k) + '</b><span class="v"></span><span class="fl"></span></span>';
      }).join('') + '<span class="tksep" aria-hidden="true">◆</span>';
      $('tktrack').innerHTML = '<span class="tk-set">' + set + '</span><span class="tk-set" aria-hidden="true">' + set + '</span>';
      mktKey = key;
      $('tick').hidden = false;
      if (unlocked) syncHead();
    }
    TK.forEach(function (q) {
      var f = fmtQ(q);
      $('tktrack').querySelectorAll('[data-k="' + q.k + '"]').forEach(function (el) {   // both copies
        el.children[1].textContent = f.v;
        el.children[2].textContent = f.ch;
        el.children[2].className = f.cls;
      });
    });
  }
  function loadMarkets() {
    var url = mktURL(); if (!url || document.hidden) return Promise.resolve();
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.items) { MKT = d; renderTicker(); if (tab === 'brief') renderBrief(); try { localStorage.setItem('glencal.mkt', JSON.stringify(d)); } catch (e) {} if (tab === 'tools') Tools.draw(); } }).catch(function () {});
  }
  function showMarkets() {
    if (!MKT) return;
    openSheet('<h2>Markets</h2><table class="mt">' + MKT.items.filter(function (q) { return q.tk !== false; }).map(function (q) {
      var f = fmtQ(q);
      return '<tr><td>' + esc(q.k) + '</td><td>' + f.v + '</td><td class="' + f.cls + '" style="color:var(--' + (f.cls === 'up' ? 'up' : f.cls === 'dn' ? 'red' : 'muted') + ')">' + f.ch + '</td></tr>';
    }).join('') + '</table>' +
      '<p class="small">Delayed quotes from ' + esc(MKT.source || 'Yahoo Finance') + ', fetched ' + esc(MKT.updated) + ' Singapore time; refreshed about every 10 minutes. ' +
      'Change is against the previous close (yields in basis points). UST 2Y uses the CBOT 2-Year Yield futures as a stand-in for the cash yield. Not for trading.</p>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="close">OK</button></div>');
  }
  $('tick').addEventListener('click', showMarkets);
  loadMarkets();
  setInterval(loadMarkets, 2 * 60000);

  renderClocks();
  setInterval(renderClocks, 15000);
  loadFinance();
  setInterval(loadFinance, 30 * 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { renderClocks(); loadFinance(); loadMarkets(); if (tab === 'news') loadNews(); if (tab === 'fan') loadFantasy(); if (tab === 'brief') { loadNews(); renderBrief(); } } });

  // =====================================================================
  // News: headlines collected by a GitHub job every ~10 min (same branch as the ticker)
  // =====================================================================
  var tab = 'brief', NEWS = null;
  var newsHidden = {};
  (prefs('newsHidden') || '').split(',').forEach(function (k) { if (k) newsHidden[k] = 1; });
  function newsTags(n) {
    var t = [];
    if (n.cb) t.push('cb');
    if (n.sg) t.push('sg');
    (n.ccy || []).forEach(function (c) { if (t.indexOf(c) < 0) t.push(c); });
    return t.length ? t : ['other'];
  }
  var lastSeen = prefs('newsSeen') || '';
  function newsURL() { var u = mktURL(); return u ? u.replace('/markets.json', '/news.json') : null; }
  function loadNews() {
    var url = newsURL(); if (!url || document.hidden) return Promise.resolve();
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.items) { NEWS = d; if (tab === 'news') renderNews(); if (tab === 'brief') renderBrief(); } }).catch(function () {});
  }
  var NEWS_CHIPS = [['all', 'All'], ['cb', '★ Central banks'], ['sg', '🇸🇬 SG'], ['other', 'General'], ['USD', 'USD'], ['EUR', 'EUR'], ['JPY', 'JPY'], ['GBP', 'GBP'], ['AUD', 'AUD'], ['NZD', 'NZD'], ['SGD', 'SGD']];
  function renderNewsChips() {
    $('nchips').innerHTML = NEWS_CHIPS.map(function (c) {
      var on = c[0] === 'all' ? !Object.keys(newsHidden).length : !newsHidden[c[0]];
      return '<button class="chip' + (on ? '' : ' off') + '" type="button" data-n="' + c[0] + '" aria-pressed="' + on + '">' + esc(c[1]) + '</button>';
    }).join('');
  }
  function renderNews() {
    if (!NEWS) { $('news').innerHTML = '<p class="empty">Loading headlines…</p>'; return; }
    var q = $('q').value.trim().toLowerCase();
    var list = NEWS.items.filter(function (n) {
      if (!newsTags(n).some(function (t) { return !newsHidden[t]; })) return false;   // shown if any of its tags is switched on
      return !q || (n.title + ' ' + n.src).toLowerCase().indexOf(q) >= 0;
    });
    var html = '<div class="nmeta">Updated ' + esc(NEWS.updated.slice(11)) + ' Singapore · ' + list.length + ' headlines · tap to open</div>', lastDay = '';
    list.forEach(function (n) {
      var day = n.t.slice(0, 10);
      if (day !== lastDay) {
        var l = dLabel(day), rel = day === todayISO ? 'TODAY · ' : day === GC.iso(GC.addDays(new Date(), -1)) ? 'YESTERDAY · ' : '';
        html += '<h2 class="mbar"><span>' + rel + l.dow + ' ' + l.day + ' ' + l.mon + '</span></h2>';
        lastDay = day;
      }
      html += '<a class="nrow' + (n.cb ? ' cb' : '') + (lastSeen && n.t > lastSeen ? ' new' : '') + '" href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="nt">' + esc(n.t.slice(11)) + '</span><span class="ns">' + esc(n.src) + '</span>' +
        '<span class="nh">' + (n.cb ? '<span class="star">★</span> ' : '') + esc(n.title) +
        ((n.ccy || []).length ? '<span class="cc">' + esc(n.ccy.slice(0, 3).join(' ')) + '</span>' : '') + '</span></a>';
    });
    if (!list.length) html += '<p class="empty">NO MATCHES</p>';
    $('news').innerHTML = html;
  }
  // =====================================================================
  // Morning brief: today, the next 24h of ECON, markets, top headlines
  // =====================================================================
  function stamp(d) { return GC.iso(d) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function briefRows(list, econ) {
    return list.map(function (e) {
      var c = GC.CAT_BY_ID[catOf(e)];
      var days = Math.round((GC.fromISO(e.date) - GC.fromISO(todayISO)) / 86400000);
      var title = e.finance ? (e.kind === 'cb' ? '<span class="star">★</span> ' : '') + '<b class="ccy">' + esc(e.ccy) + '</b> ' + esc(e.raw)
        : esc(e.title) + (e.age ? ' (' + e.age + ')' : '') + (e.isDue ? '<span class="due">' + (e.paid ? 'PAID' : 'DUE') + '</span>' : '');
      return '<button type="button" class="brow' + (e.finance && e.kind === 'cb' ? ' cb' : '') + '" data-bid="' + esc(e.id) + '">' +
        '<span class="tm">' + (e.time ? esc(GC.fmtTime(e.time)) : '') + '</span><span class="emo" aria-hidden="true">' + (e.emoji || c.emoji) + '</span>' +
        '<span class="t">' + title + (e.place ? '<span class="pl"> @ ' + esc(e.place) + '</span>' : '') +
        (e.noteHTML ? '<span class="note">' + e.noteHTML + '</span>' : e.note && !e.bill ? '<span class="note">' + esc(e.note) + '</span>' : '') + '</span>' +
        '<span class="cd">' + (econ && days === 1 ? 'TMR' : '') + '</span></button>';
    }).join('');
  }
  function renderBrief() {
    if (!unlocked) return;
    var now = new Date(), h = now.getHours(), l = dLabel(todayISO), tmr = GC.iso(GC.addDays(now, 1));
    var byTime = function (a, b) { return (a.time || '') < (b.time || '') ? -1 : 1; };
    var mineOf = function (d) { return allEntries().filter(function (e) { return e.date === d && !(e.bill && !e.isDue); }).sort(byTime); };
    var html = '<div class="bhead">' + (h < 12 ? 'GOOD MORNING' : h < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING') + ' · ' + l.dow + ' ' + l.day + ' ' + l.mon + '</div>';

    // today / tomorrow
    var today = mineOf(todayISO), tom = mineOf(tmr);
    html += '<section class="bsec"><h2 class="mbar"><span>TODAY</span><span class="n">' + today.length + '</span></h2>' +
      (today.length ? briefRows(today) : '<p class="bnone">Nothing scheduled today.</p>');
    if (tom.length) html += '<div class="bsub">TOMORROW</div>' + briefRows(tom.slice(0, 4)) + (tom.length > 4 ? '<p class="bnone">+' + (tom.length - 4) + ' more</p>' : '');
    html += '</section>';

    // ECON: released in the last 3 hours, or due in the next 24
    var lo = stamp(new Date(now - 3 * 3600e3)), hi = stamp(new Date(now.getTime() + 24 * 3600e3));
    var econ = financeItems().filter(function (e) { var k = e.date + ' ' + (e.time || '12:00'); return k >= lo && k <= hi; })
      .sort(function (a, b) { return (a.date + (a.time || '12:00')) < (b.date + (b.time || '12:00')) ? -1 : 1; });
    html += '<section class="bsec"><h2 class="mbar"><span>ECON · NEXT 24H</span><span class="n">' + econ.length + '</span></h2>' +
      (econ.length ? briefRows(econ, true) : '<p class="bnone">No tier-1 releases in the next 24 hours.</p>') + '</section>';

    // markets
    var tk = MKT && MKT.items ? MKT.items.filter(function (q) { return q.tk !== false; }) : [];
    html += '<section class="bsec"><h2 class="mbar"><span>MARKETS · VS PREVIOUS CLOSE</span></h2>' + (tk.length ? '<div class="bgrid">' + tk.map(function (q) {
      var f = fmtQ(q);
      return '<div class="bq"><b>' + esc(q.k) + '</b><span class="v">' + f.v + ' <span style="color:var(--' + (f.cls === 'up' ? 'up' : f.cls === 'dn' ? 'red' : 'muted') + ')">' + f.ch + '</span></span></div>';
    }).join('') + '</div>' : '<p class="bnone">Loading prices…</p>') + '</section>';

    // headlines: central banks, then FX/rates/macro, then Singapore
    var picks = [];
    if (NEWS && NEWS.items) {
      var since = stamp(new Date(now - 14 * 3600e3)), seen = {};
      var take = function (pred, n) {
        NEWS.items.filter(function (x) { return x.t >= since && !seen[x.url] && pred(x); }).slice(0, n).forEach(function (x) { seen[x.url] = 1; picks.push(x); });
      };
      // US first; other regions only when it's front-page, market-moving news
      var US = /\b(u\.s\.|us|usa|america|fed|fomc|powell|treasur(y|ies)|wall street|white house|congress|nonfarm|payrolls?|dollar)\b/i;
      var BIG = /\b(crash(es|ed)?|plunge[sd]?|tumble[sd]?|rout|sell-?off|turmoil|panic|crisis|contagion|default(s|ed)?|bailout|collapse[sd]?|bank run|insolven|emergency|surprise (rate )?(cut|hike)|intervene[sd]?|intervention|war|invasion|attack|sanctions?|downgrade[sd]?|halt(s|ed)?|record (low|high)|resign(s|ed|ation)?)\b/i;
      var isUS = function (x) { return (x.ccy || []).indexOf('USD') >= 0 || US.test(x.title); };
      take(function (x) { return x.cb && x.src === 'FED'; }, 2);
      take(function (x) { return !x.sg && !x.cb && x.kind === 'macro' && isUS(x); }, 5);
      take(function (x) { return !x.sg && BIG.test(x.title); }, 3);
      take(function (x) { return x.sg; }, 3);
      picks.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
    }
    html += '<section class="bsec"><h2 class="mbar"><span>HEADLINES · US · SG · MAJOR</span></h2>' + (picks.length ? picks.map(function (n) {
      return '<a class="nrow' + (n.cb ? ' cb' : '') + '" href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="nt">' + esc(n.t.slice(11)) + '</span><span class="ns">' + esc(n.src) + '</span>' +
        '<span class="nh">' + (n.cb ? '<span class="star">★</span> ' : '') + (n.sg ? '🇸🇬 ' : '') + esc(n.title) + '</span></a>';
    }).join('') : '<p class="bnone">' + (NEWS ? 'Nothing major in the last 14 hours.' : 'Loading headlines…') + '</p>') + '</section>';

    html += '<div class="bfoot">Prices and headlines are delayed (about 10–30 minutes). Pull down to refresh.' +
      (MKT && MKT.updated ? ' Prices ' + esc(MKT.updated.slice(11)) + '.' : '') + (NEWS && NEWS.updated ? ' Headlines ' + esc(NEWS.updated.slice(11)) + '.' : '') + '</div>';
    $('brief').innerHTML = html;
  }
  $('brief').addEventListener('click', function (e) {
    var b = e.target.closest('[data-bid]'); if (!b) return;
    var id = b.getAttribute('data-bid');
    if (id.indexOf('hol-') === 0) showHoliday(id);
    else if (id.indexOf('fin-') === 0) showFinance(id);
    else if (id.indexOf('bill-') === 0) showBill(id);
    else showEdit(id);
  });

  // =====================================================================
  // Notes
  // =====================================================================
  function noteTitle(n) { return n.title || (n.body || '').split('\n')[0].replace(/^[•\-\s]+/, '').slice(0, 80) || 'Untitled'; }
  function noteWhen(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var l = dLabel(GC.iso(d));
    return l.day + ' ' + l.mon + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function renderNotes() {
    var q = $('q').value.trim().toLowerCase();
    var list = notes.filter(function (n) { return (n.title || n.body) && (!q || (n.title + ' ' + n.body).toLowerCase().indexOf(q) >= 0); })
      .sort(function (a, b) { return a.updated < b.updated ? 1 : -1; });
    var row = function (n) {
      var body = n.title ? n.body : (n.body || '').split('\n').slice(1).join('\n');
      return '<div class="nwrap"><div class="swipe-del"><button type="button" data-ndel="' + esc(n.id) + '">DELETE</button></div>' +
        '<button type="button" class="nnote" data-note="' + esc(n.id) + '"><span class="nt1">' + esc(noteTitle(n)) + '</span><span class="nd">' +
        (function () { var t = (n.body.match(/^\s*[☐☑] /gm) || []).length, d = (n.body.match(/^\s*☑ /gm) || []).length; return t ? '<span class="nck' + (d === t ? ' all' : '') + '">' + d + '/' + t + ' ✓</span> ' : ''; })() +
        esc(noteWhen(n.updated)) + '</span>' +
        '<span class="np">' + esc((body || '').trim().slice(0, 240)) + '</span></button></div>';
    };
    var pinned = list.filter(function (n) { return n.pinned; }), rest = list.filter(function (n) { return !n.pinned; });
    $('notes').innerHTML = (pinned.length ? '<h2 class="mbar"><span>📌 PINNED</span><span class="n">' + pinned.length + '</span></h2>' + pinned.map(row).join('') : '') +
      '<h2 class="mbar"><span>NOTES</span><span class="n">' + rest.length + '</span></h2>' +
      (rest.length ? rest.map(row).join('') : '<p class="empty">' + (q ? 'NO MATCHES' : pinned.length ? 'No other notes.' : 'No notes yet. Tap + ADD to write one.') + '</p>');
  }
  var noteEd = null, noteTimer = null, noteDelArmed = false;
  function openNote(id) {
    var now = new Date().toISOString();
    noteEd = notes.filter(function (n) { return n.id === id; })[0] || { id: 'n' + uid(), title: '', body: '', pinned: false, created: now, updated: now };
    noteDelArmed = false;
    openSheet('<div class="ned f"><input id="n-title" placeholder="Title (optional)" value="' + esc(noteEd.title) + '">' +
      '<div class="ntool" id="ntool">' +
        [['bullet', '•', 'Bullet list'], ['num', '1.', 'Numbered list'], ['check', '☐', 'Checklist'], ['tick', '☑', 'Tick or untick this line'],
         ['time', '🕐', 'Insert date and time'], ['line', '—', 'Divider'], ['share', 'Share', 'Share this note']].map(function (t) {
          return '<button type="button" class="key" data-fmt="' + t[0] + '" aria-label="' + t[2] + '">' + t[1] + '</button>';
        }).join('') + '</div>' +
      '<textarea id="n-body" placeholder="Write anything: call notes, levels to watch, ideas…">' + esc(noteEd.body) + '</textarea></div>' +
      '<div id="n-msg" class="small" hidden></div>' +
      '<div class="actions"><button class="btn" type="button" data-act="n-pin">' + (noteEd.pinned ? 'Unpin' : '📌 Pin') + '</button>' +

      '<button class="btn" type="button" data-act="n-events">Make events</button>' +
      '<button class="btn danger" type="button" data-act="n-del">Delete</button>' +
      '<button class="btn primary" type="button" data-act="n-done">Done</button></div>');
    if (!id) setTimeout(function () { $('n-body').focus(); }, 60);
  }
  function noteChanged() {
    if (!noteEd) return;
    noteEd.title = $('n-title').value; noteEd.body = $('n-body').value; noteEd.updated = new Date().toISOString();
    if ((noteEd.title || noteEd.body) && notes.indexOf(noteEd) < 0) notes.push(noteEd);
    clearTimeout(noteTimer); noteTimer = setTimeout(persist, 600);
  }
  function noteMsg(html) { var m = $('n-msg'); if (m) { m.innerHTML = html; m.hidden = !html; } }
  async function noteTidy() {
    var text = $('n-body').value.trim();
    if (!text) return noteMsg('Write something first.');
    var st = aiStatus();
    if (st === 'unsupported') return noteMsg('AI needs WebGPU, which this browser doesn\'t offer.');
    if (st === 'none') return noteMsg('Set up the on-device AI first: ··· → AI on this iPhone.');
    noteMsg('Tidying on this iPhone…');
    try {
      var m = await ensureAI(function (p, t) { noteMsg('Loading AI… ' + Math.round(p * 100) + '%'); });
      var out = await m.tidy(text);
      if (!out || !out.bullets || !out.bullets.length) return noteMsg('AI couldn\'t tidy that. Your note is unchanged.');
      noteEd.prevBody = noteEd.body; noteEd.prevTitle = noteEd.title;
      $('n-body').value = out.bullets.map(function (b) { return '• ' + b.replace(/^[•\-\s]+/, ''); }).join('\n');
      if (!$('n-title').value.trim() && out.title) $('n-title').value = out.title;
      noteChanged();
      noteMsg('Tidied. <button class="btn link" type="button" data-act="n-undo">Undo</button>');
    } catch (e) { noteMsg('AI couldn\'t tidy that (' + esc(e.message || e) + '). Your note is unchanged.'); }
  }
  $('sheet').addEventListener('input', function (e) { if (noteEd && (e.target.id === 'n-title' || e.target.id === 'n-body')) noteChanged(); });

  // ---- note formatting: plain text with list markers, so it stays readable anywhere you share it ----
  var LIST_RE = /^(\s*)(• |(\d+)\. |☐ |☑ )?(.*)$/;
  function lineBounds(v, a, b) {
    var s = v.lastIndexOf('\n', a - 1) + 1, e = v.indexOf('\n', b); if (e < 0) e = v.length;
    return [s, e];
  }
  function setBody(ta, v, caret) { ta.value = v; ta.focus(); try { ta.setSelectionRange(caret, caret); } catch (x) {} noteChanged(); }
  function fmtLines(kind) {
    var ta = $('n-body'), v = ta.value, r = lineBounds(v, ta.selectionStart, ta.selectionEnd);
    var lines = v.slice(r[0], r[1]).split('\n');
    var prev = v.slice(0, Math.max(0, r[0] - 1)).split('\n').pop(), pm = LIST_RE.exec(prev), n = pm && pm[3] ? +pm[3] + 1 : 1;
    var allSame = lines.every(function (l) { var m = LIST_RE.exec(l); return kind === 'bullet' ? m[2] === '• ' : kind === 'num' ? !!m[3] : (m[2] === '☐ ' || m[2] === '☑ '); });
    var out = lines.map(function (l) {
      var m = LIST_RE.exec(l), ind = m[1], txt = m[4];
      if (allSame) return ind + txt;                                   // tapping again removes the markers
      if (kind === 'bullet') return ind + '• ' + txt;
      if (kind === 'num') return ind + (n++) + '. ' + txt;
      return ind + (m[2] === '☑ ' ? '☑ ' : '☐ ') + txt;
    }).join('\n');
    setBody(ta, v.slice(0, r[0]) + out + v.slice(r[1]), r[0] + out.length);
  }
  function tickLines() {
    var ta = $('n-body'), v = ta.value, r = lineBounds(v, ta.selectionStart, ta.selectionEnd), pos = ta.selectionStart;
    var out = v.slice(r[0], r[1]).split('\n').map(function (l) {
      var m = LIST_RE.exec(l);
      return m[2] === '☐ ' ? m[1] + '☑ ' + m[4] : m[2] === '☑ ' ? m[1] + '☐ ' + m[4] : m[1] + '☐ ' + (m[2] || '') + m[4];
    }).join('\n');
    setBody(ta, v.slice(0, r[0]) + out + v.slice(r[1]), Math.min(pos + (out.length - (r[1] - r[0])), r[0] + out.length));
  }
  function insertText(t) {
    var ta = $('n-body'), v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
    if (a > 0 && v[a - 1] !== '\n' && t.charAt(0) === '\n') t = t; else if (a === 0 || v[a - 1] === '\n') t = t.replace(/^\n/, '');
    setBody(ta, v.slice(0, a) + t + v.slice(b), a + t.length);
  }
  function shareNote() {
    noteChanged();
    var text = (noteEd.title ? noteEd.title + '\n\n' : '') + noteEd.body;
    if (navigator.share) navigator.share({ title: noteEd.title || 'Note', text: text }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { noteMsg('Copied to clipboard.'); });
  }
  // keep the keyboard up while tapping the formatting bar
  $('sheet').addEventListener('pointerdown', function (e) { if (e.target.closest('#ntool')) e.preventDefault(); });
  $('sheet').addEventListener('click', function (e) {
    var b = e.target.closest('[data-fmt]'); if (!b || !noteEd) return;
    var f = b.getAttribute('data-fmt'), now = new Date(), l = dLabel(GC.iso(now));
    if (f === 'bullet' || f === 'num' || f === 'check') fmtLines(f);
    else if (f === 'tick') tickLines();
    else if (f === 'time') insertText('\n[' + l.day + ' ' + l.mon.charAt(0) + l.mon.slice(1).toLowerCase() + ' ' + ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) + '] ');
    else if (f === 'line') insertText('\n———————————\n');
    else if (f === 'share') shareNote();
  });
  // return on a list line starts the next item; return on an empty item ends the list
  $('sheet').addEventListener('keydown', function (e) {
    if (e.target.id !== 'n-body' || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    var ta = e.target, v = ta.value, a = ta.selectionStart;
    if (a !== ta.selectionEnd) return;
    var s = v.lastIndexOf('\n', a - 1) + 1, line = v.slice(s, a), m = LIST_RE.exec(line);
    if (!m[2]) return;
    e.preventDefault();
    if (!m[4].trim() && v.slice(a, (v.indexOf('\n', a) + 1 || v.length + 1) - 1).trim() === '') { setBody(ta, v.slice(0, s) + m[1] + v.slice(a), s + m[1].length); return; }
    var next = m[3] ? (+m[3] + 1) + '. ' : m[2] === '☑ ' ? '☐ ' : m[2];
    var ins = '\n' + m[1] + next;
    setBody(ta, v.slice(0, a) + ins + v.slice(a), a + ins.length);
  });

  function setTab(t) {
    if (tab === 'news' && t !== 'news' && NEWS) { lastSeen = NEWS.items.length ? NEWS.items[0].t : lastSeen; prefs('newsSeen', lastSeen); }
    if (tab === 'fan' && t !== 'fan' && FAN) { fanSeen = FAN.items.length ? FAN.items[0].t : fanSeen; prefs('fanSeen', fanSeen); }
    tab = t;
    var cal = t === 'cal', news = t === 'news', fan = t === 'fan', tl = t === 'tools', br = t === 'brief', nt = t === 'notes';
    $('tab-notes').setAttribute('aria-pressed', nt); $('notes').hidden = !nt;
    $('tab-brief').setAttribute('aria-pressed', br); $('brief').hidden = !br;
    $('tab-cal').setAttribute('aria-pressed', cal); $('tab-news').setAttribute('aria-pressed', news); $('tab-fan').setAttribute('aria-pressed', fan); $('tab-tools').setAttribute('aria-pressed', tl);
    $('list').hidden = !cal; $('news').hidden = !news; $('fan').hidden = !fan; $('tools').hidden = !tl;
    $('chips').hidden = !cal; $('nchips').hidden = !news; $('fchips').hidden = !fan; $('tchips').hidden = !tl; $('openx').hidden = cal || tl || br || nt; $('cmdrow').hidden = tl || br;
    $('ask').hidden = true;   // assistant switched off for now $('jump').hidden = !cal; $('add').hidden = !(cal || br || nt);
    $('q').value = '';
    if (news) { renderNewsChips(); renderNews(); loadNews(); SC().scrollTop = 0; }
    else if (fan) { renderFantasyChips(); renderFantasy(); loadFantasy(); SC().scrollTop = 0; }
    else if (tl) { $('tchips').innerHTML = Tools.chips(); Tools.draw(); SC().scrollTop = 0; }
    else if (br) { renderBrief(); loadNews(); SC().scrollTop = 0; }
    else if (nt) { renderNotes(); SC().scrollTop = 0; }
    else { showPast = false; render(); jumpToday(false); }
    syncHead();
  }
  $('tab-brief').addEventListener('click', function () { setTab('brief'); });
  $('tab-notes').addEventListener('click', function () { setTab('notes'); });
  // short swipe shows DELETE; a long swipe (past 60% of the width) deletes straight away. Undo for 6 seconds.
  var nsw = null, nOpen = null, nJust = false, noteUndo = null;
  function nSet(el, x, anim) { el.style.transition = anim ? 'transform 180ms ease' : 'none'; el.style.transform = x ? 'translateX(' + x + 'px)' : ''; }
  function nClose() { if (nOpen) { nSet(nOpen, 0, true); nOpen = null; } }
  function deleteNote(id) {
    var n = notes.filter(function (x) { return x.id === id; })[0]; if (!n) return;
    notes = notes.filter(function (x) { return x.id !== id; }); persist(); renderNotes();
    noteUndo = n; lastDeleted = null;
    $('toastMsg').textContent = 'Deleted note: ' + noteTitle(n); $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $('toast').hidden = true; noteUndo = null; }, 6000);
  }
  $('notes').addEventListener('pointerdown', function (e) {
    var el = e.target.closest('.nnote'); if (!el) return;
    if (nOpen && nOpen !== el) nClose();
    nsw = { el: el, x0: e.clientX, y0: e.clientY, base: el === nOpen ? -el.parentNode.querySelector('.swipe-del').offsetWidth : 0, dx: 0, horiz: null };
  });
  $('notes').addEventListener('pointermove', function (e) {
    if (!nsw) return;
    var dx = e.clientX - nsw.x0, dy = e.clientY - nsw.y0;
    if (nsw.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) nsw.horiz = Math.abs(dx) > Math.abs(dy);
    if (!nsw.horiz) return;
    nsw.dx = dx; nSet(nsw.el, Math.min(0, nsw.base + dx), false);
  });
  function nEnd() {
    if (!nsw) return;
    var s2 = nsw; nsw = null;
    if (!s2.horiz) return;
    nJust = true; setTimeout(function () { nJust = false; }, 350);
    var w = s2.el.offsetWidth, act = s2.el.parentNode.querySelector('.swipe-del').offsetWidth, pos = s2.base + s2.dx;
    if (pos < -0.6 * w) { nSet(s2.el, -w, true); setTimeout(function () { deleteNote(s2.el.getAttribute('data-note')); }, 170); nOpen = null; }
    else if (pos < -act / 2) { nSet(s2.el, -act, true); nOpen = s2.el; }
    else { nSet(s2.el, 0, true); if (nOpen === s2.el) nOpen = null; }
  }
  $('notes').addEventListener('pointerup', nEnd);
  $('notes').addEventListener('pointercancel', nEnd);
  $('notes').addEventListener('click', function (e) {
    var d = e.target.closest('[data-ndel]'); if (d) { nOpen = null; deleteNote(d.getAttribute('data-ndel')); return; }
    var b = e.target.closest('[data-note]'); if (!b || nJust) return;
    if (nOpen) { nClose(); return; }
    openNote(b.getAttribute('data-note'));
  });
  $('tab-cal').addEventListener('click', function () { setTab('cal'); });
  $('tab-news').addEventListener('click', function () { setTab('news'); });
  $('tab-fan').addEventListener('click', function () { setTab('fan'); });
  $('tab-tools').addEventListener('click', function () { setTab('tools'); });
  var tapeTimer = null;
  Tools.init($('tools'), function () { return MKT; }, function (t) { calcTape = t; clearTimeout(tapeTimer); tapeTimer = setTimeout(persist, 800); });
  $('tchips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tool]'); if (!b) return;
    Tools.select(b.getAttribute('data-tool')); $('tchips').innerHTML = Tools.chips(); SC().scrollTop = 0;
  });
  $('nchips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-n]'); if (!b) return;
    var k = b.getAttribute('data-n');
    if (k === 'all') {
      if (Object.keys(newsHidden).length) newsHidden = {};
      else NEWS_CHIPS.forEach(function (c) { if (c[0] !== 'all') newsHidden[c[0]] = 1; });
    } else if (newsHidden[k]) delete newsHidden[k]; else newsHidden[k] = 1;
    prefs('newsHidden', Object.keys(newsHidden).join(','));
    renderNewsChips(); renderNews(); SC().scrollTop = 0;
  });
  setInterval(function () { if (tab === 'news') loadNews(); if (tab === 'fan') loadFantasy(); }, 2 * 60000);

  // ---- Fantasy: RotoWire player alerts, Yahoo/ESPN/PFF headlines, Sleeper most-added ----
  var FAN = null, fanFilter = 'all', fanSeen = prefs('fanSeen') || '';
  var FAN_CHIPS = [['all', 'All'], ['alert', '🚨 Alerts'], ['NBA', '🏀 NBA'], ['NFL', '🏈 NFL'], ['trend', '📈 Most added']];
  var ST_LABEL = { out: 'OUT', doubt: 'Q', in: 'IN' };
  function loadFantasy() {
    var u = mktURL(); if (!u || document.hidden) return Promise.resolve();
    return fetch(u.replace('/markets.json', '/fantasy.json'), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.items) { FAN = d; if (tab === 'fan') renderFantasy(); } }).catch(function () {});
  }
  function renderFantasyChips() {
    $('fchips').innerHTML = FAN_CHIPS.map(function (c) {
      return '<button class="chip" type="button" data-f="' + c[0] + '" aria-pressed="' + (fanFilter === c[0]) + '">' + esc(c[1]) + '</button>';
    }).join('');
  }
  function renderFantasy() {
    if (!FAN) { $('fan').innerHTML = '<p class="empty">Loading…</p>'; return; }
    var head = '<div class="nmeta">Updated ' + esc(FAN.updated.slice(11)) + ' Singapore · tap to open</div>';
    if (fanFilter === 'trend') {
      $('fan').innerHTML = head + '<div class="trend">' + ['NBA', 'NFL'].map(function (sp) {
        var list = (FAN.trending || {})[sp] || [];
        return '<h3>' + (sp === 'NBA' ? '🏀' : '🏈') + ' ' + sp + ' · MOST ADDED ON SLEEPER, LAST 24H</h3>' + (list.length ? list.map(function (p, n) {
          return '<div class="tr"><span class="k">' + (n + 1) + '</span><span>' + esc(p.n) + ' <span class="pl">' + esc([p.pos, p.team].filter(Boolean).join(' · ')) + '</span></span>' +
            '<span class="a">+' + Number(p.adds || 0).toLocaleString('en-US') + '</span></div>';
        }).join('') : '<p class="small">No data.</p>');
      }).join('') + '</div>';
      return;
    }
    var q = $('q').value.trim().toLowerCase();
    var list = FAN.items.filter(function (x) {
      if (fanFilter === 'alert' && x.kind !== 'alert') return false;
      if ((fanFilter === 'NBA' || fanFilter === 'NFL') && x.sport !== fanFilter) return false;
      return !q || (x.title + ' ' + (x.blurb || '')).toLowerCase().indexOf(q) >= 0;
    });
    var html = head, lastDay = '';
    list.forEach(function (x) {
      var day = x.t.slice(0, 10);
      if (day !== lastDay) {
        var l = dLabel(day), rel = day === todayISO ? 'TODAY · ' : day === GC.iso(GC.addDays(new Date(), -1)) ? 'YESTERDAY · ' : '';
        html += '<h2 class="mbar"><span>' + rel + l.dow + ' ' + l.day + ' ' + l.mon + '</span></h2>';
        lastDay = day;
      }
      html += '<a class="nrow' + (x.kind === 'alert' ? ' alert' : '') + (fanSeen && x.t > fanSeen ? ' new' : '') + '" href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="nt">' + esc(x.t.slice(11)) + '</span><span class="ns"><span class="sp ' + x.sport + '">' + x.sport + '</span><br>' + esc(x.src) + '</span>' +
        '<span class="nh">' + (x.status ? '<span class="st ' + x.status + '">' + ST_LABEL[x.status] + '</span>' : '') + esc(x.title) +
        (x.blurb ? '<span class="fblurb">' + esc(x.blurb) + '</span>' : '') + '</span></a>';
    });
    if (!list.length) html += '<p class="empty">NO MATCHES</p>';
    $('fan').innerHTML = html;
  }
  $('fchips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-f]'); if (!b) return;
    fanFilter = b.getAttribute('data-f'); renderFantasyChips(); renderFantasy(); SC().scrollTop = 0;
  });

  // =====================================================================
  // Feed
  // =====================================================================
  function setClock() { var l = dLabel(todayISO); $('clock').textContent = l.dow + ' ' + l.day + ' ' + l.mon + ' ' + todayISO.slice(0, 4); }
  var headH = 0, mbarH = 0;
  function syncHead() {
    headH = $('bar').offsetHeight;
    document.documentElement.style.setProperty('--headH', headH + 'px');
    var mb = document.querySelector('.mbar'); mbarH = mb ? mb.offsetHeight : 0;
  }
  // Singapore public holidays from holidays.js: 3 months back to 2 years ahead, rolling.
  function holidaysOn() { return prefs('holidays') !== 'off'; }
  function holidayItems() {
    if (!holidaysOn() || typeof SG_HOLIDAYS === 'undefined') return [];
    var lo = GC.iso(GC.addDays(new Date(), -90)), hi = GC.iso(GC.addDays(new Date(), 730));
    return SG_HOLIDAYS.filter(function (h) { return h.date >= lo && h.date <= hi; }).map(function (h) {
      return { id: 'hol-' + h.date + '-' + h.title.replace(/\W+/g, ''), date: h.date, title: h.title, time: '', place: '', note: '', cat: 'holiday', est: h.est, holiday: true, src: '' };
    });
  }
  // ---- Bills & recurring payments: generated from rules, 3 months back to 12 months ahead ----
  var KIND_LABEL = { statement: 'statement', bill: 'bill', debit: 'auto-debit', check: 'check' };
  function dayIn(y, m, day) {   // m 0-11; 'last' or a number clamped to the month's length
    var last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, day === 'last' ? last : Math.min(+day, last));
  }
  var holidaySet = null;
  function isBizDay(d) {
    if (!holidaySet) { holidaySet = {}; (typeof SG_HOLIDAYS === 'undefined' ? [] : SG_HOLIDAYS).forEach(function (h) { holidaySet[h.date] = 1; }); }
    return d.getDay() !== 0 && d.getDay() !== 6 && !holidaySet[GC.iso(d)];
  }
  function shiftBiz(d, mode) {
    if (mode !== 'earlier' && mode !== 'later') return d;
    var step = mode === 'later' ? 1 : -1, x = new Date(d);
    while (!isBizDay(x)) x = GC.addDays(x, step);
    return x;
  }
  function short(d) { var l = dLabel(GC.iso(d)); return l.dow.charAt(0) + l.dow.slice(1).toLowerCase() + ' ' + l.day + ' ' + l.mon.charAt(0) + l.mon.slice(1).toLowerCase(); }
  function billItems() {
    var now = new Date(), lo = GC.iso(GC.addDays(now, -90)), hi = GC.iso(GC.addDays(now, 365)), out = [];
    rules.forEach(function (r) {
      for (var k = -4; k <= 13; k++) {
        var base = new Date(now.getFullYear(), now.getMonth() + k, 1), y = base.getFullYear(), m = base.getMonth();
        var ym = y + '-' + ('0' + (m + 1)).slice(-2);
        var main = dayIn(y, m, r.day), due = null, orig = null;
        if (r.dueWhen === 'same' || r.dueWhen === 'next') {
          orig = dayIn(y, m + (r.dueWhen === 'next' ? 1 : 0), r.dueDay);
          due = shiftBiz(orig, r.shift);
        }
        var mainISO = GC.iso(main);
        if (mainISO >= lo && mainISO <= hi) {
          out.push({ id: 'bill-' + r.id + '-' + ym + '-m', date: mainISO, time: '', place: '', cat: 'bills', bill: true, ruleId: r.id,
            title: r.name + ' ' + KIND_LABEL[r.kind || 'statement'],
            note: [due ? 'Pay by ' + short(due) : '', r.note || ''].filter(Boolean).join(' · ') });
        }
        if (due) {
          var dueISO = GC.iso(due), id = 'bill-' + r.id + '-' + ym + '-d';
          if (dueISO >= lo && dueISO <= hi) {
            out.push({ id: id, date: dueISO, time: '', place: '', cat: 'bills', bill: true, isDue: true, ruleId: r.id, paid: !!paid[id],
              title: r.name + ' payment',
              note: [ (r.kind === 'bill' ? 'Bill ' : 'Statement ') + short(main), GC.iso(orig) !== dueISO ? 'moved from ' + short(orig) : ''].filter(Boolean).join(' · ') });
          }
        }
      }
    });
    return out;
  }
  var REPEAT_NAMES = { none: 'Does not repeat', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };
  function occurrences(it) {
    if (!it.repeat || it.repeat === 'none' || !GC.fromISOok(it.date)) return [it];
    var start = GC.fromISO(it.date), now = new Date();
    var lo = GC.addDays(now, -90), hi = GC.addDays(now, it.repeat === 'yearly' ? 730 : 365), out = [];
    for (var n = 0; n < 5000; n++) {
      var d = it.repeat === 'weekly' ? GC.addDays(start, 7 * n)
        : it.repeat === 'monthly' ? dayIn(start.getFullYear(), start.getMonth() + n, start.getDate())
        : dayIn(start.getFullYear() + n, start.getMonth(), start.getDate());   // 29 Feb -> 28 Feb in other years
      if (d > hi) break;
      if (d < lo) continue;
      var iso = GC.iso(d);
      var o = Object.assign({}, it, { id: it.id + '@' + iso, date: iso, seriesId: it.id, recurring: true });
      // birthdays/anniversaries entered with the real original date (5+ years back) show the count
      if (it.repeat === 'yearly' && n > 0 && now.getFullYear() - start.getFullYear() >= 5 && /birthday|bday|anniversary/i.test(it.title)) o.age = n;
      out.push(o);
    }
    return out;
  }
  function expandAll(list) { var out = []; list.forEach(function (it) { out = out.concat(occurrences(it)); }); return out; }
  function allEntries() { return expandAll(items).concat(holidayItems(), billItems()); }

  // ---- Finance tab: official schedules (finance.js) + live high-impact feed (data/finance-live.json) ----
  var finLive = { items: [], updated: '' };
  function loadFinance() {
    return fetch('data/finance-live.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.items) return;
      finLive = d;
      if (unlocked) { renderChips(); if (econMode) render(); if (tab === 'brief') renderBrief(); }
    }).catch(function () {});
  }
  var CB_RE = /rate|monetary policy|policy statement|press conference|statement/i;
  // actual vs consensus: above / below / in line (tolerance depends on the units)
  function num(v) { var m = /(-?\d+(?:\.\d+)?)\s*([%KMBT])?/i.exec(String(v || '').replace(/,/g, '')); return m ? { n: +m[1], u: (m[2] || '').toUpperCase() } : null; }
  function surprise(a, f) {
    var x = num(a), y = num(f);
    if (!x || !y) return null;
    var tol = x.u === 'K' ? 5 : x.u === '%' ? 0.05 : Math.max(0.005 * Math.abs(y.n), 0.01);
    var d = x.n - y.n;
    if (d > tol) return { mark: '▲', cls: 'sup', word: 'above consensus' };
    if (d < -tol) return { mark: '▼', cls: 'sdn', word: 'below consensus' };
    return { mark: '=', cls: 'sin', word: 'in line with consensus' };
  }
  function financeItems() {
    var live = finLive.items || [], st = (typeof FIN_STATIC === 'undefined') ? [] : FIN_STATIC;
    var liveDates = live.map(function (x) { return x.date; }).sort();
    var lo = liveDates[0] || '', hi = liveDates[liveDates.length - 1] || '';
    var liveByKey = {};
    live.forEach(function (x) { var k = x.ccy + '|' + x.date; (liveByKey[k] = liveByKey[k] || []).push(x); });
    var dropLive = {}, out = [];
    st.forEach(function (x, n) {
      var same = liveByKey[x.ccy + '|' + x.date] || [];
      var inLive = lo && x.date >= lo && x.date <= hi;
      if (x.kind === 'data' && inLive && same.some(function (l) { return l.kind === 'data'; })) return;   // live feed has the detail
      var e = { id: 'fin-s' + n, date: x.date, time: x.time, ccy: x.ccy, kind: x.kind, raw: x.title, info: x.note, check: x.check, src: 'official' };
      if (x.kind === 'cb') {
        same.forEach(function (l) {
          if (l.kind === 'cb' || CB_RE.test(l.title)) {
            dropLive[l.id] = 1;
            if (l.forecast && !e.forecast) { e.forecast = l.forecast; e.previous = l.previous; e.liveTitle = l.title; }
            if (l.actual && !e.actual) { e.actual = l.actual; e.actualSrc = l.actualSrc; }
          }
        });
      }
      out.push(e);
    });
    live.forEach(function (l) {
      if (dropLive[l.id]) return;
      out.push({ id: 'fin-' + l.id, date: l.date, time: l.time, ccy: l.ccy, kind: l.kind, raw: l.title, forecast: l.forecast, previous: l.previous, actual: l.actual, actualSrc: l.actualSrc, src: 'live' });
    });
    return out.map(function (e) {
      var sp = e.actual ? surprise(e.actual, e.forecast) : null;
      var fp = [e.actual ? 'A ' + e.actual + (sp ? ' ' + sp.mark : '') : '', e.forecast ? 'F ' + e.forecast : '', e.previous ? 'P ' + e.previous : ''].filter(Boolean).join(' · ');
      e.noteHTML = [e.actual ? '<span class="' + (sp ? sp.cls : '') + '">A ' + esc(e.actual) + (sp ? ' ' + sp.mark : '') + '</span>' : '',
        e.forecast ? 'F ' + esc(e.forecast) : '', e.previous ? 'P ' + esc(e.previous) : ''].filter(Boolean).join(' · ');
      e.surprise = sp ? sp.word : '';
      e.title = e.ccy + ' ' + e.raw + (e.check ? ' (check)' : '');
      e.note = fp; e.place = ''; e.cat = 'finance'; e.finance = true; e.emoji = e.kind === 'cb' ? '🏦' : '📊';
      return e;
    });
  }
  function visible() {
    var q = $('q').value.trim().toLowerCase();
    return (econMode ? financeItems() : allEntries()).filter(function (i) {
      if (!econMode && hiddenCats[catOf(i)]) return false;
      return !q || [i.title, i.place, i.note, i.src].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  var ALWAYS = { bills: 1, finance: 1 };   // shown even when empty
  function chipOrder() {
    var ids = GC.CATS.map(function (c) { return c.id; });
    var def = ['bills', 'finance'].concat(ids.filter(function (id) { return !ALWAYS[id]; }));
    var saved = (prefs('chipOrder') || '').split(',').filter(function (id) { return GC.CAT_BY_ID[id]; });
    def.forEach(function (id) { if (saved.indexOf(id) < 0) saved.push(id); });
    return saved;
  }
  function chipLabel(id) { var c = GC.CAT_BY_ID[id]; return c.emoji + ' ' + c.name; }
  function renderChips() {
    var counts = {};
    var all = allEntries();
    all.forEach(function (i) { var c = catOf(i); counts[c] = (counts[c] || 0) + 1; });
    counts.finance = financeItems().filter(function (x) { return x.date >= todayISO; }).length;
    var html = '<button class="chip" type="button" data-cat="all" aria-pressed="' + allOn() + '">All<span class="n">' + all.length + '</span></button>';
    chipOrder().forEach(function (id) {
      if (!counts[id] && !ALWAYS[id]) return;
      var on = id === 'finance' ? econMode : (!econMode && !hiddenCats[id]);
      html += '<button class="chip' + (id === 'finance' ? ' fin' : '') + (on ? '' : ' off') + '" type="button" data-cat="' + id + '" aria-pressed="' + on + '">' +
        esc(chipLabel(id)) + '<span class="n">' + (counts[id] || 0) + '</span></button>';
    });
    $('chips').innerHTML = html;
  }

  // ---- hold any category to rearrange the order ----
  function showArrange() {
    var order = chipOrder();
    openSheet('<h2>Arrange categories</h2><p>All always comes first. Categories with nothing in them stay hidden until they have entries.</p>' +
      order.map(function (id, n) {
        return '<div class="arr"><span class="lbl">' + esc(chipLabel(id)) + '</span>' +
          '<button class="btn" type="button" data-act="arr-move" data-id="' + id + '" data-dir="-1"' + (n === 0 ? ' disabled' : '') + ' aria-label="Move up">▲</button>' +
          '<button class="btn" type="button" data-act="arr-move" data-id="' + id + '" data-dir="1"' + (n === order.length - 1 ? ' disabled' : '') + ' aria-label="Move down">▼</button></div>';
      }).join('') +
      '<div class="actions"><button class="btn grow" type="button" data-act="arr-reset">Reset order</button><button class="btn primary" type="button" data-act="close">Done</button></div>');
  }
  function moveChip(id, dir) {
    var order = chipOrder(), i = order.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    order.splice(i, 1); order.splice(j, 0, id);
    prefs('chipOrder', order.join(','));
    renderChips(); showArrange();
  }

  var shownDates = [];
  function render() {
    var q = $('q').value.trim();
    var byDate = {};
    visible().forEach(function (i) { (byDate[i.date] = byDate[i.date] || []).push(i); });
    var dates = Object.keys(byDate);
    if (dates.length && !q && !byDate[todayISO]) dates.push(todayISO);
    dates.sort();
    var pastCount = dates.filter(function (d) { return d < todayISO; }).length;
    if (!showPast && !q) dates = dates.filter(function (d) { return d >= todayISO; });
    shownDates = dates;
    if (!dates.length) {
      $('list').innerHTML = (!q && !econMode && Object.keys(hiddenCats).length && !visible().length && allEntries().length) ? '<p class="empty">All categories are switched off. Tap a category to show it, or ALL for everything.</p>'
        : (q || econMode || Object.keys(hiddenCats).length) ? '<p class="empty">NO MATCHES</p>'
        : '<p class="empty">Nothing here yet. Tap + ADD and paste any text that has a date in it.</p>';
      return;
    }
    var byMonth = {};
    dates.forEach(function (d) { (byMonth[d.slice(0, 7)] = byMonth[d.slice(0, 7)] || []).push(d); });
    var html = '';
    Object.keys(byMonth).sort().forEach(function (mk) {
      var md = GC.fromISO(mk + '-01');
      var count = byMonth[mk].reduce(function (n, d) { return n + (byDate[d] ? byDate[d].length : 0); }, 0);
      var body = '';
      byMonth[mk].forEach(function (d) {
        var l = dLabel(d);
        if (!byDate[d]) { body += '<div class="nowline" id="d-' + d + '">TODAY ' + l.day + ' ' + l.mon + ' ' + l.dow + ' · NOTHING ON</div>'; return; }
        var list = byDate[d].slice().sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
        body += '<ul class="dgrp' + (d < todayISO ? ' past' : '') + (d === todayISO ? ' today' : '') + '" id="d-' + d + '">' +
          list.map(function (i, k) {
            var c = GC.CAT_BY_ID[catOf(i)];
            var days = Math.round((GC.fromISO(d) - GC.fromISO(todayISO)) / 86400000);
            return '<li' + (i.holiday ? ' class="hol"' : i.finance ? ' class="fin' + (i.kind === 'cb' ? ' cb' : '') + '"' : i.bill ? ' class="bill' + (i.paid ? ' paid' : '') + '"' : '') + '>' +
              (i.holiday || i.finance || i.bill ? '' : '<div class="swipe-del"><button type="button" data-del="' + esc(i.id) + '">DELETE</button></div>') +
              '<button class="item" type="button" data-id="' + esc(i.id) + '">' +
              '<span class="dc">' + (k === 0 ? l.day + ' <span class="w">' + l.dow + '</span>' : '') + '</span>' +
              '<span class="tm">' + (i.time ? esc(GC.fmtTime(i.time)) : '') + '</span>' +
              '<span class="emo" aria-hidden="true">' + (i.emoji || c.emoji) + '</span>' +
              '<span class="t">' + (i.finance ? (i.kind === 'cb' ? '<span class="star">★</span> ' : '') + '<b>' + esc(i.ccy) + '</b> ' + esc(i.raw) + (i.check ? '<span class="pl"> (check)</span>' : '') : esc(i.title) + (i.age ? ' (' + i.age + ')' : '') + (i.recurring ? '<span class="pl"> ↻</span>' : '')) + (i.est ? '<span class="pl"> (est.)</span>' : '') + (i.isDue ? '<span class="due">' + (i.paid ? 'PAID' : 'DUE') + '</span>' : '') + (i.place ? '<span class="pl"> @ ' + esc(i.place) + '</span>' : '') +
              (i.noteHTML ? '<span class="note">' + i.noteHTML + '</span>' : i.note ? '<span class="note">' + esc(i.note) + '</span>' : '') + '</span>' +
              '<span class="cd">' + (k === 0 && days > 0 ? days + 'D' : '') + '</span></button></li>';
          }).join('') + '</ul>';
      });
      html += '<section class="mon"><h2 class="mbar" data-m="' + mk + '"><span>' + MONTH_FULL[md.getMonth()] + ' ' + md.getFullYear() + '</span><span class="n">' + count + '</span></h2>' + body + '</section>';
    });
    if (!showPast && !q && pastCount) html = '<div class="pasthint">↓ PULL DOWN FOR ' + pastCount + ' PAST DAY' + (pastCount === 1 ? '' : 'S') + '</div>' + html;
    $('list').innerHTML = html;
    syncHead();
  }
  var digestTimer = null;
  // ---- pull down at the top: calendar shows past days; news and fantasy refresh ----
  function SC() { return $('scroll'); }
  var showPast = false, PULL_AT = 70, pull = { y0: null, d: 0, on: false, busy: false };
  function pullText(d) {
    if (tab === 'cal') return showPast ? '' : d >= PULL_AT ? 'Release to show past events' : '↓ Pull to show past events';
    return pull.busy ? 'Refreshing…' : d >= PULL_AT ? 'Release to refresh' : '↓ Pull to refresh';   // news, fantasy, brief
  }
  function setPull(d, anim) {
    var pw = $('pw');
    pw.style.transition = anim ? 'transform 200ms ease' : 'none';
    pw.style.transform = d ? 'translateY(' + d + 'px)' : '';
    $('pull').textContent = d ? pullText(d) : '';
    $('pull').classList.toggle('ready', d >= PULL_AT);
  }
  SC().addEventListener('touchstart', function (e) {
    pull.y0 = (SC().scrollTop <= 0 && e.touches.length === 1 && !pull.busy) ? e.touches[0].clientY : null; pull.d = 0;
  }, { passive: true });
  SC().addEventListener('touchmove', function (e) {
    if (pull.y0 === null) return;
    var dy = e.touches[0].clientY - pull.y0;
    if (dy <= 0 || SC().scrollTop > 0) { if (pull.on) setPull(0); pull.on = false; return; }
    if ((tab === 'cal' && showPast) || tab === 'tools' || tab === 'notes') return;
    pull.on = true; e.preventDefault();
    pull.d = Math.min(130, dy * 0.45); setPull(pull.d);
  }, { passive: false });
  SC().addEventListener('touchend', function () {
    if (!pull.on) { pull.y0 = null; return; }
    var go = pull.d >= PULL_AT; pull.on = false; pull.y0 = null;
    if (!go) { setPull(0, true); return; }
    if (tab === 'cal') {
      showPast = true; setPull(0, true); render();
      var t = $('d-' + todayISO) || document.querySelector('#list .dgrp, #list .nowline');
      if (t) scrollToEl(t, false);
      setTimeout(function () { SC().scrollBy({ top: -120, behavior: 'smooth' }); }, 60);   // reveal the last few past days
      return;
    }
    pull.busy = true; setPull(48, true);
    (tab === 'news' ? loadNews() : tab === 'fan' ? loadFantasy() : Promise.all([loadNews(), loadMarkets(), loadFinance()])).then(function () { pull.busy = false; setPull(0, true); }, function () { pull.busy = false; setPull(0, true); });
  });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });   // no pinch zoom

  function refresh() { renderChips(); syncHead(); render(); clearTimeout(digestTimer); digestTimer = setTimeout(writeDigest, 1500); }
  function writeDigest() {
    if (!unlocked) return;
    var lo = GC.iso(new Date()), hi = GC.iso(GC.addDays(new Date(), 60)), days = {};
    expandAll(items).concat(holidayItems(), billItems().filter(function (b) { return b.isDue && !b.paid; }))
      .filter(function (e) { return e.date >= lo && e.date <= hi; })
      .sort(function (a, b) { return (a.time || '') < (b.time || '') ? -1 : 1; })
      .forEach(function (e) {
        var line = (e.time ? GC.fmtTime(e.time) + ' ' : '') + e.title + (e.isDue ? ' (payment due)' : '');
        (days[e.date] = days[e.date] || []).push(line);
      });
    Vault.writeDigest({ made: new Date().toISOString(), days: days }).catch(function () {});
  }

  // ---------- jump panel: tap a month bar ----------
  function showJump(curMonth) {
    var byDate = {};
    visible().forEach(function (i) { (byDate[i.date] = byDate[i.date] || []).push(i); });
    var dates = Object.keys(byDate).sort(), byMonth = {};
    dates.forEach(function (d) { (byMonth[d.slice(0, 7)] = byMonth[d.slice(0, 7)] || []).push(d); });
    var html = '<h2>Jump to</h2><div class="actions"><button class="btn primary grow" type="button" data-act="jump-today">Today</button>' +
      '<button class="btn" type="button" data-act="close">Close</button></div>';
    Object.keys(byMonth).sort().forEach(function (mk) {
      var md = GC.fromISO(mk + '-01');
      html += '<div class="jm" id="jm-' + mk + '"><div class="jmh">' + MONTH_FULL[md.getMonth()] + ' ' + md.getFullYear() + '</div><div class="jd">' +
        byMonth[mk].map(function (d) {
          var l = dLabel(d), seen = {}, emo = '';
          byDate[d].forEach(function (i) { var e = GC.CAT_BY_ID[catOf(i)].emoji; if (!seen[e] && Object.keys(seen).length < 3) { seen[e] = 1; emo += e; } });
          return '<button class="jday' + (d < todayISO ? ' past' : '') + (d === todayISO ? ' today' : '') + '" type="button" data-act="jump" data-day="' + d + '">' +
            '<b>' + l.day + '</b><span class="w">' + l.dow + '</span><span class="e">' + emo + '</span></button>';
        }).join('') + '</div></div>';
    });
    if (!dates.length) html += '<p>Nothing to jump to yet.</p>';
    openSheet(html);
    var cur = $('jm-' + (curMonth || todayISO.slice(0, 7)));
    if (cur) $('sheet').scrollTop = cur.offsetTop - $('sheet').offsetTop - 8;
  }
  function scrollToEl(el, smooth) {
    if (!el) return;
    var y = el.getBoundingClientRect().top - SC().getBoundingClientRect().top + SC().scrollTop - mbarH;
    SC().scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
  }
  function jumpToday(smooth) {
    var el = $('d-' + todayISO);
    if (!el) { var after = shownDates.filter(function (d) { return d >= todayISO; })[0] || shownDates[shownDates.length - 1]; el = after ? $('d-' + after) : null; }
    scrollToEl(el, smooth);
  }

  // =====================================================================
  // Sheets: add, check, edit
  // =====================================================================
  function openSheet(html) { $('sheet').innerHTML = html; $('scrim').hidden = false; }
  function closeSheet() { $('scrim').hidden = true; $('sheet').innerHTML = ''; }
  function catOptions(sel) {
    return GC.CATS.filter(function (c) { return c.id !== 'holiday' && c.id !== 'finance' && c.id !== 'bills'; }).map(function (c) { return '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' + c.emoji + ' ' + esc(c.name) + '</option>'; }).join('');
  }
  function fieldsHTML(i, n) {
    return '<div class="f">' +
      '<label>What<input id="title-' + n + '" value="' + esc(i.title) + '" placeholder="e.g. Meet Sarah"></label>' +
      '<label>Date<input id="date-' + n + '" type="date" value="' + esc(i.date) + '"></label>' +
      '<label>Time (optional)<input id="time-' + n + '" value="' + esc(GC.fmtTime(i.time)) + '" placeholder="3pm"></label>' +
      '<label>Place (optional)<input id="place-' + n + '" value="' + esc(i.place) + '"></label>' +
      '<label>Note (optional)<input id="note-' + n + '" value="' + esc(i.note) + '" placeholder="e.g. bring passport"></label>' +
      '<label>Category<select id="cat-' + n + '">' + catOptions(catOf(i)) + '</select></label>' +
      '<label>Repeats<select id="rep-' + n + '">' + opts(REPEAT_NAMES, i.repeat || 'none') + '</select></label></div>';
  }
  function readFields(n) {
    return { title: $('title-' + n).value.trim(), date: $('date-' + n).value, time: GC.normTime($('time-' + n).value),
      place: $('place-' + n).value.trim(), note: $('note-' + n).value.trim(), cat: $('cat-' + n).value, repeat: $('rep-' + n).value };
  }

  var lastPaste = '';
  function showPaste(prefill, msg) {
    var st = aiStatus();
    openSheet('<h2>Add</h2><p>Type or paste anything: a message, an email, or your own rough notes.</p>' +
      '<textarea id="paste" placeholder="dinner w mum n dad sat 730 at jumbo&#10;&#10;23 Nov&#10;- Meet xxx&#10;- Submit xxx"></textarea>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<div id="aiprog" hidden><div class="small" id="aiprogtxt">Starting AI…</div><div class="prog"><div id="aiprogbar"></div></div></div>' +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button>' +
      '<button class="btn primary" type="button" data-act="parse">Read dates</button></div>');
    if (prefill) $('paste').value = prefill;
    setTimeout(function () { $('paste').focus(); }, 50);
  }

  var drafts = [];
  function showConfirm(list, msg) {
    drafts = list.map(function (d) {
      var x = { id: uid(), title: d.title || '', date: d.date || '', time: d.time || '', place: d.place || '', note: d.note || '', src: d.src || '', flag: d.flag || '' };
      x.cat = (d.cat && GC.CAT_BY_ID[d.cat]) ? d.cat : GC.inferCat([x.title, x.place, x.note].join(' '));
      // suggest "every year" for birthdays and anniversaries (not for one-off drinks or dinners)
      x.repeat = d.repeat || (/birthday|bday|anniversary/i.test(x.title) && !/drinks|dinner|lunch|party|celebrat/i.test(x.title) ? 'yearly' : 'none');
      return x;
    });
    if (!drafts.length) {
      openSheet('<h2>No entries found</h2><p>Each entry needs some words describing it. Try one entry per line.</p>' +
        '<div class="actions"><button class="btn primary" type="button" data-act="back">Back</button></div>');
      return;
    }
    var html = '<h2>Check ' + drafts.length + (drafts.length === 1 ? ' entry' : ' entries') + '</h2><p>Fix anything that looks wrong, then save.</p>' +
      (msg ? '<div class="flag">' + esc(msg) + '</div>' : '');
    drafts.forEach(function (d, n) {
      var warn = !d.date ? 'No date found. Pick one.' : d.flag;
      html += '<div class="row" id="row-' + n + '"><div class="rowtop"><span>' + (n + 1) + '/' + drafts.length + '</span>' +
        '<button class="btn link" type="button" data-act="drop" data-n="' + n + '">Remove</button></div>' +
        (warn ? '<div class="flag">! ' + esc(warn) + '</div>' : '') + fieldsHTML(d, n) +
        (d.src ? '<div class="src">You wrote: ' + esc(d.src) + '</div>' : '') + '</div>';
    });
    html += '<div id="cerr" class="err" hidden></div><div class="actions"><button class="btn grow" type="button" data-act="back">Back</button>' +
      '<button class="btn primary" type="button" data-act="save-all">Save</button></div>';
    openSheet(html);
  }
  function saveAll() {
    var out = [], bad = 0, now = new Date().toISOString();
    drafts.forEach(function (d, n) {
      if (d.dropped) return;
      var f = readFields(n), ok = f.title && f.date;
      $('row-' + n).classList.toggle('bad', !ok);
      if (!ok) { bad++; return; }
      out.push({ id: d.id, title: f.title, date: f.date, time: f.time, place: f.place, note: f.note, cat: f.cat, repeat: f.repeat, src: d.src, added: now });
    });
    if (bad) { $('cerr').hidden = false; $('cerr').textContent = bad + (bad === 1 ? ' entry needs' : ' entries need') + ' a description and a date.'; return; }
    if (!out.length) { closeSheet(); return; }
    items = items.concat(out); persist();
    closeSheet(); econMode = false; refresh();
    if (out[0].date < todayISO && !showPast) { showPast = true; render(); }
    scrollToEl($('d-' + out[0].date), true);
  }

  var editing = null, delArmed = false;
  function showEdit(id) {
    var sid = String(id).split('@')[0];
    editing = items.filter(function (i) { return i.id === sid; })[0];
    if (!editing) return;
    delArmed = false;
    openSheet('<h2>Edit</h2>' + (editing.repeat && editing.repeat !== 'none' ? '<p class="small">Repeats ' + REPEAT_NAMES[editing.repeat].toLowerCase() + '. Changes and delete apply to every occurrence; Date is the first one.</p>' : '') + fieldsHTML(editing, 'e') +
      (editing.src ? '<div><p>Original text</p><div class="src">' + esc(editing.src) + '</div></div>' : '') +
      '<div id="eerr" class="err" hidden></div>' +
      '<div class="actions"><button class="btn danger grow" type="button" data-act="del">Delete</button>' +
      '<button class="btn" type="button" data-act="close">Cancel</button>' +
      '<button class="btn primary" type="button" data-act="save-one">Save</button></div>');
  }
  function showHoliday(id) {
    var h = holidayItems().filter(function (x) { return x.id === id; })[0];
    if (!h) return;
    openSheet('<h2>🇸🇬 ' + esc(h.title) + '</h2><p>' + longLabel(h.date) + ' ' + h.date.slice(0, 4) + '. Singapore public holiday.</p>' +
      '<p class="small">' + (h.est
        ? 'Estimated. MOM has not published the ' + h.date.slice(0, 4) + ' dates yet; holidays that follow the lunar or Islamic calendar may move by a day. The official date will replace this once it is announced.'
        : 'Official date from the Ministry of Manpower.') + '</p>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="close">OK</button></div>');
  }
  var KIND_NAMES = { statement: 'Card statement', bill: 'Bill', debit: 'Auto-debit (no action needed)', check: 'Check / reminder' };
  var SHIFT_NAMES = { earlier: 'Move to the business day before', later: 'Move to the business day after', none: 'Keep the date' };
  function dayOptions(sel) {
    var h = '';
    for (var n = 1; n <= 31; n++) h += '<option value="' + n + '"' + (String(sel) === String(n) ? ' selected' : '') + '>' + n + '</option>';
    return h + '<option value="last"' + (sel === 'last' ? ' selected' : '') + '>Last day</option>';
  }
  function opts(map, sel) { return Object.keys(map).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + map[k] + '</option>'; }).join(''); }

  function showBill(id) {
    var b = billItems().filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    var r = rules.filter(function (x) { return x.id === b.ruleId; })[0] || {};
    openSheet('<h2>💳 ' + esc(b.title) + '</h2><p>' + longLabel(b.date) + ' ' + b.date.slice(0, 4) + '</p>' +
      (b.note ? '<p class="small">' + esc(b.note) + '</p>' : '') +
      '<div class="actions">' + '<button class="btn grow" type="button" data-act="rule-edit" data-rule="' + esc(r.id || '') + '">Edit recurring</button>' +
      '<button class="btn" type="button" data-act="close">Close</button>' +
      (b.isDue ? '<button class="btn primary" type="button" data-act="bill-paid" data-bill="' + esc(b.id) + '">' + (b.paid ? 'Mark unpaid' : 'Mark paid') + '</button>' : '') +
      '</div>');
  }
  function showRules() {
    var h = '<h2>Bills &amp; recurring</h2><p>Monthly statements, payment due dates, auto-debits and checks. They show in All and under 💳 Bills, 3 months back to 12 months ahead.</p>';
    h += rules.length ? rules.map(function (r) {
      var due = r.dueWhen === 'same' || r.dueWhen === 'next' ? 'due ' + (r.dueDay === 'last' ? 'last day' : r.dueDay) + (r.dueWhen === 'next' ? ' next mth' : '') : '';
      return '<button class="rule" type="button" data-act="rule-edit" data-rule="' + esc(r.id) + '"><span>' + esc(r.name) + '</span><span class="small">' +
        esc(KIND_LABEL[r.kind] || '') + ' ' + (r.day === 'last' ? 'last day' : r.day) + (due ? ' · ' + due : '') + '</span></button>';
    }).join('') : '<p class="small">Nothing yet.</p>';
    h += '<div class="actions"><button class="btn grow" type="button" data-act="close">Close</button><button class="btn" type="button" data-act="paste-import">Paste list</button><button class="btn primary" type="button" data-act="rule-edit" data-rule="">Add</button></div>';
    openSheet(h);
  }
  function showRuleForm(id, msg) {
    var r = rules.filter(function (x) { return x.id === id; })[0] || { id: '', name: '', kind: 'statement', day: 1, dueWhen: 'none', dueDay: 1, shift: 'earlier', note: '' };
    openSheet('<h2>' + (r.id ? 'Edit recurring' : 'Add recurring') + '</h2>' + (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<div class="f"><label>Name<input id="r-name" value="' + esc(r.name) + '" placeholder="e.g. Visa card"></label>' +
      '<div class="two"><label>Type<select id="r-kind">' + opts(KIND_NAMES, r.kind) + '</select></label>' +
      '<label>Day each month<select id="r-day">' + dayOptions(r.day) + '</select></label></div>' +
      '<div class="two"><label>Payment due<select id="r-duewhen">' + opts({ none: 'No due date', same: 'Same month', next: 'Next month' }, r.dueWhen) + '</select></label>' +
      '<label>Due day<select id="r-dueday">' + dayOptions(r.dueDay) + '</select></label></div>' +
      '<label>If due date is a weekend or SG public holiday<select id="r-shift">' + opts(SHIFT_NAMES, r.shift) + '</select></label>' +
      '<label>Note (optional)<input id="r-note" value="' + esc(r.note || '') + '" placeholder="e.g. Pay full amount"></label></div>' +
      '<div class="actions">' + (r.id ? '<button class="btn danger grow" type="button" data-act="rule-del" data-rule="' + esc(r.id) + '">Delete</button>' : '<span class="grow"></span>') +
      '<button class="btn" type="button" data-act="rules">Back</button><button class="btn primary" type="button" data-act="rule-save" data-rule="' + esc(r.id) + '">Save</button></div>');
  }
  function saveRule(id) {
    var r = { id: id || 'r' + uid(), name: $('r-name').value.trim(), kind: $('r-kind').value, day: $('r-day').value === 'last' ? 'last' : +$('r-day').value,
      dueWhen: $('r-duewhen').value, dueDay: $('r-dueday').value === 'last' ? 'last' : +$('r-dueday').value, shift: $('r-shift').value, note: $('r-note').value.trim() };
    if (!r.name) return showRuleForm(id, 'Give it a name, e.g. "Visa card".');
    rules = rules.filter(function (x) { return x.id !== r.id; }).concat([r]);
    persist(); refresh(); showRules();
  }
  // ---- evening notification (push) ----
  function b64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function showNotify(msg, subJSON) {
    var ready = typeof PUSH_PUBLIC_KEY === 'string' && PUSH_PUBLIC_KEY.length > 20;
    var perm = ('Notification' in window) ? Notification.permission : 'unsupported';
    openSheet('<h2>Evening notification</h2><p>Each evening at about 8pm Singapore time, GlenCal shows tomorrow\'s events and payments due. ' +
      'The signal from the server carries no calendar data: this iPhone builds the message from its own encrypted copy.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      (!ready ? '<p class="small">Not set up yet: the sending key hasn\'t been created. Ask Claude to finish the setup.</p>'
        : perm === 'unsupported' ? '<p class="small">Notifications need GlenCal opened from its Home Screen icon (iOS 16.4 or later).</p>'
        : '<p class="small">Permission: ' + perm + '.</p>' +
          (subJSON ? '<p>Last step: copy this and send it to Claude in your chat. It lets the evening job reach this iPhone (it contains no calendar data).</p><textarea id="subjson" readonly style="min-height:6rem">' + esc(subJSON) + '</textarea>' : '')) +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Close</button>' +
      (ready && perm !== 'unsupported' ? '<button class="btn" type="button" data-act="notify-test">Test</button>' : '') +
      (subJSON ? '<button class="btn primary" type="button" data-act="notify-copy">Copy</button>' : ready && perm !== 'unsupported' ? '<button class="btn primary" type="button" data-act="notify-on">Turn on</button>' : '') +
      '</div>');
  }
  function turnOnNotify() {
    Notification.requestPermission().then(function (p) {
      if (p !== 'granted') return showNotify('Notifications are blocked. Allow them in Settings → Notifications → GlenCal.');
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (s) { return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(PUSH_PUBLIC_KEY) }); });
      }).then(function (sub) { writeDigest(); showNotify('', JSON.stringify(sub)); });
    }).catch(function (e) { showNotify('Could not turn on: ' + (e.message || e)); });
  }
  function showFinance(id) {
    var f = financeItems().filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    var rows = [['When', longLabel(f.date) + ' ' + f.date.slice(0, 4) + (f.time ? ', ' + GC.fmtTime(f.time) + ' Singapore' : ', time not fixed')],
      ['Currency', f.ccy]];
    if (f.actual) rows.push(['Actual', f.actual + (f.surprise ? ' (' + f.surprise + ')' : '')]);
    if (f.forecast) rows.push(['Forecast', f.forecast]);
    if (f.previous) rows.push(['Previous', f.previous]);
    openSheet('<h2>' + f.emoji + ' ' + esc(f.ccy + ' ' + f.raw) + '</h2><div class="kv">' +
      rows.map(function (r) { return '<span>' + r[0] + '</span><span>' + esc(r[1]) + '</span>'; }).join('') + '</div>' +
      (f.info ? '<p class="small">' + esc(f.info) + '</p>' : '') +
      (f.actual ? '<p class="small">' + (f.actualSrc === 'bls' ? 'Actual: official figure from the US Bureau of Labor Statistics (calculated from the published index, so the last decimal can differ from the headline).'
        : 'Actual: taken from the next release\'s "previous" figure, so it may include revisions.') + '</p>' : '') +
      '<p class="small">' + (f.src === 'official' ? 'Date from the official published schedule.' + (f.liveTitle ? ' Forecast from the live calendar (' + esc(f.liveTitle) + ').' : '')
        : 'From the live high-impact calendar' + (finLive.updated ? ', updated ' + esc(finLive.updated) + ' Singapore time' : '') + '. Forecasts are market consensus and can change.') + '</p>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="close">OK</button></div>');
  }
  function saveOne() {
    var f = readFields('e');
    if (!f.title || !f.date) { $('eerr').hidden = false; $('eerr').textContent = 'Add a description and a date before saving.'; return; }
    Object.assign(editing, f); persist();
    closeSheet(); refresh();
  }

  // ---------- delete with undo ----------
  var toastTimer = null, lastDeleted = null;
  function removeItem(id) {
    id = String(id).split('@')[0];
    var it = items.filter(function (i) { return i.id === id; })[0];
    if (!it) return;
    var y = SC().scrollTop;
    items = items.filter(function (i) { return i.id !== id; }); persist();
    lastDeleted = it;
    refresh(); SC().scrollTop = y;
    $('toastMsg').textContent = 'Deleted: ' + it.title;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').hidden = true; lastDeleted = null; }, 6000);
  }
  $('undo').addEventListener('click', function () {
    if (typeof noteUndo !== 'undefined' && noteUndo) { notes.push(noteUndo); noteUndo = null; persist(); $('toast').hidden = true; clearTimeout(toastTimer); if (tab === 'notes') renderNotes(); return; }
    if (!lastDeleted) return;
    var y = SC().scrollTop;
    items.push(lastDeleted); persist();
    lastDeleted = null; $('toast').hidden = true; clearTimeout(toastTimer);
    refresh(); SC().scrollTop = y;
  });

  // ---------- swipe left to show Delete ----------
  var sw = null, openRow = null, justSwiped = false;
  function actW(el) { return el.parentNode.querySelector('.swipe-del').offsetWidth; }
  function setX(el, x, anim) { el.classList.toggle('anim', !!anim); el.style.transform = x ? 'translateX(' + x + 'px)' : ''; }
  function closeOpen() { if (openRow) { setX(openRow, 0, true); openRow = null; } }
  $('list').addEventListener('pointerdown', function (e) {
    var el = e.target.closest('.item'); if (!el || !el.parentNode.querySelector('.swipe-del')) return;
    if (openRow && openRow !== el) closeOpen();
    sw = { el: el, x0: e.clientX, y0: e.clientY, base: el === openRow ? -actW(el) : 0, dx: 0, horiz: null };
  });
  $('list').addEventListener('pointermove', function (e) {
    if (!sw) return;
    var dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
    if (sw.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) sw.horiz = Math.abs(dx) > Math.abs(dy);
    if (!sw.horiz) return;
    sw.dx = dx;
    setX(sw.el, Math.max(-actW(sw.el) * 1.25, Math.min(0, sw.base + dx)), false);
  });
  function endSwipe() {
    if (!sw) return;
    if (sw.horiz) {
      var w = actW(sw.el), pos = sw.base + sw.dx;
      justSwiped = true; setTimeout(function () { justSwiped = false; }, 350);
      if (pos < -w / 2) { setX(sw.el, -w, true); openRow = sw.el; } else { setX(sw.el, 0, true); if (openRow === sw.el) openRow = null; }
    }
    sw = null;
  }
  $('list').addEventListener('pointerup', endSwipe);
  $('list').addEventListener('pointercancel', endSwipe);
  document.addEventListener('pointerdown', function (e) { if (openRow && !e.target.closest('li')) closeOpen(); });

  // =====================================================================
  // AI (on-device, see ai.js)
  // =====================================================================
  var AI = null, aiState = navigator.gpu ? 'unknown' : 'unsupported';
  function aiSize() { return prefs('model') === 'large' ? 'large' : 'small'; }
  function aiStatus() { return aiState === 'unknown' ? (prefs('aiReady') === aiSize() ? 'cached' : 'none') : aiState; }
  async function aiModule() { return AI || (AI = await import('./ai.js')); }
  async function ensureAI(onProgress) {
    var m = await aiModule();
    if (m.loaded(aiSize())) return m;
    aiState = 'loading';
    await m.load(aiSize(), onProgress);
    aiState = 'ready'; prefs('aiReady', aiSize());
    return m;
  }
  function progressTo(barId, txtId) {
    return function (p, text) {
      var bar = $(barId), t = $(txtId);
      if (bar) bar.style.width = Math.round(p * 100) + '%';
      if (t) t.textContent = text.replace(/\[.*?\]\s*/g, '').slice(0, 140) || 'Loading…';
    };
  }

  async function aiRead() {
    var text = $('paste').value;
    if (!text.trim()) return;
    lastPaste = text;
    $('aiprog').hidden = false;
    $('sheet').querySelectorAll('.actions .btn').forEach(function (b) { b.disabled = true; });
    try {
      var m = await ensureAI(progressTo('aiprogbar', 'aiprogtxt'));
      $('aiprogtxt').textContent = 'Reading…'; $('aiprogbar').style.width = '100%';
      var out = await m.extract(text, promptToday());
      showConfirm(out.map(function (a) {
        var t = (a.time || '').replace('-', '–');
        return { title: a.title, date: GC.fromISOok(a.date) ? a.date : '', time: t ? GC.normTime(t) : '', place: a.place, note: a.note, cat: a.category, src: text,
          flag: GC.fromISOok(a.date) ? '' : 'No clear date in the text. Pick one.' };
      }));
    } catch (e) {
      showConfirm(GC.parseText(text, new Date()), 'AI couldn\'t read that (' + (e.message || e) + '), so this is the quick read.');
    }
  }

  function showAISetup(msg) {
    var st = aiStatus();
    var sizes = { small: 'Standard (about 1 GB)', large: 'Larger and smarter (about 2 GB, slower)' };
    openSheet('<h2>AI on this iPhone</h2>' +
      (st === 'unsupported'
        ? '<p>This browser doesn\'t offer WebGPU, which the AI needs. Everything else works without it.</p>'
        : '<p>The AI runs entirely on this iPhone, offline once downloaded. Your text is never sent anywhere. The model downloads once (over Wi-Fi is best) and stays on the phone.</p>' +
          '<div class="f"><label>Model<select id="ai-size">' + Object.keys(sizes).map(function (k) { return '<option value="' + k + '"' + (k === aiSize() ? ' selected' : '') + '>' + sizes[k] + '</option>'; }).join('') + '</select></label></div>' +
          '<div class="small">Status: ' + ({ none: 'not downloaded', cached: 'downloaded', loading: 'loading', ready: 'ready' }[st] || st) + '</div>' +
          (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
          '<div id="aiprog" hidden><div class="small" id="aiprogtxt">Starting…</div><div class="prog"><div id="aiprogbar"></div></div></div>' +
          '<div class="actions">' + (st !== 'none' ? '<button class="btn danger grow" type="button" data-act="ai-remove">Remove model</button>' : '<span class="grow"></span>') +
          '<button class="btn" type="button" data-act="close">Close</button>' +
          '<button class="btn primary" type="button" data-act="ai-download">' + (st === 'none' ? 'Download' : 'Load') + '</button></div>'));
    if ($('ai-size')) $('ai-size').onchange = function () { prefs('model', this.value); aiState = navigator.gpu ? 'unknown' : 'unsupported'; showAISetup(); };
  }
  async function aiDownload() {
    $('aiprog').hidden = false;
    $('sheet').querySelectorAll('.actions .btn').forEach(function (b) { b.disabled = true; });
    try {
      await ensureAI(progressTo('aiprogbar', 'aiprogtxt'));
      openSheet('<h2>AI ready</h2><p>Use <b>Read with AI</b> when adding, and <b>ASK</b> to ask questions or make changes.</p>' +
        '<div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
    } catch (e) {
      aiState = navigator.gpu ? 'unknown' : 'unsupported'; prefs('aiReady', '');
      showAISetup('Download or loading failed: ' + (e.message || e) + '. If the phone ran out of memory, try the Standard model.');
    }
  }
  async function aiRemove() {
    try { var m = await aiModule(); await m.remove(aiSize()); } catch (e) {}
    prefs('aiReady', ''); aiState = navigator.gpu ? 'unknown' : 'unsupported';
    showAISetup();
  }

  // ---------- ASK: questions and proposed changes ----------
  var askHistory = [], pending = null, askBusy = false;
  var STOP = { the: 1, and: 1, for: 1, with: 1, what: 1, when: 1, did: 1, last: 1, next: 1, this: 1, week: 1, month: 1, have: 1, any: 1, add: 1, move: 1, delete: 1, remove: 1, change: 1, show: 1, all: 1, my: 1, on: 1, to: 1, is: 1, are: 1, was: 1, from: 1, into: 1 };
  function contextFor(q) {
    var words = q.toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2 && !STOP[w]; });
    var lo = GC.iso(GC.addDays(new Date(), -14)), hi = GC.iso(GC.addDays(new Date(), 45));
    var scored = allEntries().concat(financeItems()).map(function (e) {
      var hay = [e.title, e.place, e.note, GC.CAT_BY_ID[catOf(e)].name].join(' ').toLowerCase();
      var hit = words.some(function (w) { return hay.indexOf(w) >= 0; });
      return { e: e, keep: hit || (e.date >= lo && e.date <= hi), hit: hit };
    }).filter(function (x) { return x.keep; });
    scored.sort(function (a, b) { return (b.hit - a.hit) || (a.e.date < b.e.date ? -1 : 1); });
    return scored.slice(0, 45).map(function (x) { return x.e; }).sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; })
      .map(function (e) {
        return (e.seriesId || e.id) + ' | ' + e.date + ' ' + dLabel(e.date).dow + (e.time ? ' ' + e.time : '') + ' | ' + e.title + (e.place ? ' @ ' + e.place : '') + (e.note ? ' | ' + e.note : '');
      }).join('\n');
  }
  function summary(e) {
    return longLabel(e.date) + (e.time ? ' ' + GC.fmtTime(e.time) : '') + ' ' + GC.CAT_BY_ID[catOf(e)].emoji + ' ' + e.title + (e.place ? ' @ ' + e.place : '');
  }
  function showAsk() {
    var st = aiStatus();
    var log = askHistory.map(function (h) { return '<div class="u">' + esc(h.q) + '</div><div class="a">' + esc(h.a) + '</div>'; }).join('');
    var chg = '';
    if (pending && (pending.adds.length || pending.updates.length || pending.deletes.length)) {
      chg = '<div class="chg"><div class="small">PROPOSED CHANGES</div>' +
        pending.adds.map(function (e) { return '<div class="add">+ ' + esc(summary(e)) + '</div>'; }).join('') +
        pending.updates.map(function (u) { return '<div class="upd">~ ' + esc(summary(u.before)) + '<br>&nbsp;&nbsp;→ ' + esc(summary(u.after)) + '</div>'; }).join('') +
        pending.deletes.map(function (e) { return '<div class="del">− ' + esc(summary(e)) + '</div>'; }).join('') +
        '<div class="actions"><button class="btn grow" type="button" data-act="ask-discard">Discard</button><button class="btn primary" type="button" data-act="ask-apply">Apply</button></div></div>';
    }
    openSheet('<h2>Ask</h2>' +
      (st === 'unsupported' ? '<p>AI needs WebGPU, which this browser doesn\'t offer.</p>' :
       st === 'none' ? '<p>Set up the on-device AI first.</p><div class="actions"><button class="btn primary" type="button" data-act="ai-setup">Set up AI</button></div>' :
       (askHistory.length ? '' : '<p>Ask about your calendar or tell it what to change, e.g. "What\'s on next week?", "When did I last see the dentist?", "Move haircut to Sat 11am". Changes wait for your OK. Runs on this iPhone.</p>') +
       '<div class="chat">' + log + '</div>' + chg +
       '<div id="aiprog" hidden><div class="small" id="aiprogtxt">Thinking…</div><div class="prog"><div id="aiprogbar"></div></div></div>' +
       '<textarea id="askq" style="min-height:4.5rem" placeholder="ask or tell"></textarea>' +
       '<div class="actions"><button class="btn grow" type="button" data-act="ask-new">New</button><button class="btn" type="button" data-act="close">Close</button>' +
       '<button class="btn primary" type="button" data-act="ask-send">Send</button></div>'));
    var s = $('sheet'); s.scrollTop = s.scrollHeight;
  }
  async function askSend() {
    var q = ($('askq').value || '').trim();
    if (!q || askBusy) return;
    askBusy = true;
    $('aiprog').hidden = false;
    $('sheet').querySelectorAll('.actions .btn').forEach(function (b) { b.disabled = true; });
    try {
      var m = await ensureAI(progressTo('aiprogbar', 'aiprogtxt'));
      $('aiprogtxt').textContent = 'Thinking…'; $('aiprogbar').style.width = '100%';
      var r = await m.ask(q, promptToday(), contextFor(q), askHistory);
      var p = { adds: [], updates: [], deletes: [] };
      (r.add || []).forEach(function (a) {
        if (!GC.fromISOok(a.date) || !a.title) return;
        var t = (a.time || '').replace('-', '–');
        p.adds.push({ id: uid(), date: a.date, title: a.title, time: t ? GC.normTime(t) : '', place: a.place || '', note: a.note || '', cat: GC.CAT_BY_ID[a.category] ? a.category : '', src: 'Added by assistant: ' + q, added: new Date().toISOString() });
      });
      (r.update || []).forEach(function (u) {
        var before = items.filter(function (i) { return i.id === (u.id || '').trim(); })[0];
        if (!before) return;
        var after = Object.assign({}, before);
        if (u.date && GC.fromISOok(u.date)) after.date = u.date;
        if (u.time) after.time = /^none$/i.test(u.time) ? '' : GC.normTime(u.time.replace('-', '–'));
        if (u.title) after.title = u.title;
        if (u.place) after.place = u.place;
        if (u.note) after.note = u.note;
        if (JSON.stringify(after) !== JSON.stringify(before)) p.updates.push({ before: before, after: after });
      });
      (r['delete'] || []).forEach(function (id) {
        var e = items.filter(function (i) { return i.id === String(id).trim(); })[0];
        if (e) p.deletes.push(e);
      });
      pending = p;
      askHistory.push({ q: q, a: r.reply || '(no reply)' });
    } catch (e) {
      askHistory.push({ q: q, a: 'That didn\'t work (' + (e.message || e) + '). Try again, maybe more simply.' });
    }
    askBusy = false;
    showAsk();
  }
  function askApply() {
    if (!pending) return;
    var byId = {};
    pending.updates.forEach(function (u) { byId[u.after.id] = u.after; });
    var del = {};
    pending.deletes.forEach(function (e) { del[e.id] = 1; });
    items = items.filter(function (i) { return !del[i.id]; }).map(function (i) { return byId[i.id] || i; }).concat(pending.adds);
    persist();
    askHistory.push({ q: '(apply)', a: 'Done. Your calendar is updated.' });
    pending = null;
    refresh(); showAsk();
  }

  // =====================================================================
  // Menu: AI, backup, lock, update
  // =====================================================================
  function showMenu() {
    openSheet('<h2>Menu</h2><div class="menu">' +
      (prefs('aiReady') ? '<button class="btn" type="button" data-act="ai-free">Remove AI model (frees about 1 GB)</button>' : '') +
      '<button class="btn" type="button" data-act="rules">Bills &amp; recurring</button>' +
      '<button class="btn" type="button" data-act="notify">Evening notification</button>' +
      '<button class="btn" type="button" data-act="hol-toggle">' + (holidaysOn() ? 'Hide' : 'Show') + ' Singapore holidays</button>' +
      '<button class="btn" type="button" data-act="import">Import entries</button>' +
      '<button class="btn" type="button" data-act="export">Export backup</button>' +
      (Vault.method() === 'device'
        ? '<button class="btn" type="button" data-act="lock-on">Turn on Face ID lock</button>'
        : '<button class="btn" type="button" data-act="lock">Lock now</button><button class="btn" type="button" data-act="lock-off">Turn off Face ID lock</button>') +
      (updateReady ? '<button class="btn primary" type="button" data-act="update">Install update</button>' : '') +
      '</div><p class="small">Entries are encrypted on this iPhone. ' + (Vault.method() === 'device' ? 'Opens without Face ID.' : 'Unlocked with ' + (Vault.method() === 'passkey' ? 'Face ID' : 'a passphrase') + '. Locks after 30 seconds in the background.') + '<br>Version 9983f16b95ef</p>' +
      '<div class="actions"><button class="btn" type="button" data-act="close">Close</button></div>');
  }
  function showImport(msg) {
    openSheet('<h2>Import entries</h2><p>Paste a GlenCal backup, or the data copied from the Scriptable version. Entries with the same id are replaced, others are added.</p>' +
      '<textarea id="imp" placeholder="[ { &quot;date&quot;: ... } ]"></textarea>' + (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button><button class="btn" type="button" data-act="paste-import">Paste from clipboard</button><button class="btn primary" type="button" data-act="do-import">Import</button></div>');
  }
  function doImport(text) {
    var list;
    var newRules = [];
    try { var d = JSON.parse(text != null ? text : $('imp').value); list = Array.isArray(d) ? d : (d && (d.items || [])); newRules = (d && d.rules) || []; if (d && d.paid) Object.assign(paid, d.paid); } catch (e) {}
    newRules = newRules.filter(function (r) { return r && r.name && r.day; }).map(function (r) {
      return { id: r.id || 'r' + uid(), name: String(r.name), kind: KIND_LABEL[r.kind] ? r.kind : 'statement', day: r.day === 'last' ? 'last' : +r.day,
        dueWhen: r.dueWhen === 'same' || r.dueWhen === 'next' ? r.dueWhen : 'none', dueDay: r.dueDay === 'last' ? 'last' : +(r.dueDay || 1),
        shift: SHIFT_NAMES[r.shift] ? r.shift : 'earlier', note: r.note || '' };
    });
    try { var dn = JSON.parse(text != null ? text : $('imp').value); if (dn && Array.isArray(dn.notes)) { var nid = {}; dn.notes.forEach(function (n) { if (n && n.id) nid[n.id] = 1; }); notes = notes.filter(function (n) { return !nid[n.id]; }).concat(dn.notes.filter(function (n) { return n && n.id; })); } } catch (e) {}
    if (newRules.length) { var rid = {}; newRules.forEach(function (r) { rid[r.id] = 1; }); rules = rules.filter(function (r) { return !rid[r.id]; }).concat(newRules); }
    if (!Array.isArray(list) || (!list.length && !newRules.length)) return showImport('That isn\'t a GlenCal backup. Paste the whole text, starting with [ or {.');
    var clean = list.filter(function (x) { return x && x.title && GC.fromISOok(x.date); }).map(function (x) {
      return { id: x.id || uid(), date: x.date, title: String(x.title), time: x.time || '', place: x.place || '', note: x.note || '', cat: x.cat || '', repeat: REPEAT_NAMES[x.repeat] ? x.repeat : 'none', src: x.src || '', added: x.added || '' };
    });
    var byId = {}; clean.forEach(function (x) { byId[x.id] = x; });
    items = items.filter(function (i) { return !byId[i.id]; }).concat(clean);
    persist(); refresh();
    openSheet('<h2>Imported</h2><p>' + clean.length + ' entries' + (newRules.length ? ' and ' + newRules.length + ' recurring items' : '') + ' imported.</p><div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
  }
  function doExport() {
    var json = JSON.stringify({ v: 2, items: items, rules: rules, paid: paid, notes: notes }, null, 1);
    var file = null;
    try { file = new File([json], 'glencal-backup-' + todayISO + '.json', { type: 'application/json' }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(function () {});
    } else {
      openSheet('<h2>Export backup</h2><p>Copy this text and keep it somewhere safe. It is not encrypted.</p><textarea readonly>' + esc(json) + '</textarea>' +
        '<div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
    }
  }

  // ---------- updates (service worker) ----------
  var updateReady = false, swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      swReg = reg;
      function check() { if (reg.waiting && navigator.serviceWorker.controller) { updateReady = true; $('more').textContent = '··· ●'; } }
      check();
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (w) w.addEventListener('statechange', function () { if (w.state === 'installed') check(); });
      });
    }).catch(function () {});
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (!reloading) { reloading = true; location.reload(); } });
  }
  function installUpdate() { if (swReg && swReg.waiting) swReg.waiting.postMessage('skip-waiting'); }

  // =====================================================================
  // Events
  // =====================================================================
  $('q').addEventListener('input', function () { if (tab === 'notes') { renderNotes(); return; } if (tab === 'news') { renderNews(); return; } if (tab === 'fan') { renderFantasy(); return; } render(); if (!$('q').value) jumpToday(false); });
  $('jump').addEventListener('click', function () { $('q').value = ''; render(); jumpToday(true); });
  var holdTimer = null, held = false, hold0 = null;
  $('chips').addEventListener('pointerdown', function (e) {
    if (!e.target.closest('[data-cat]')) return;
    held = false; hold0 = { x: e.clientX, y: e.clientY };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () { held = true; if (navigator.vibrate) navigator.vibrate(10); showArrange(); }, 550);
  });
  $('chips').addEventListener('pointermove', function (e) {
    if (hold0 && (Math.abs(e.clientX - hold0.x) > 8 || Math.abs(e.clientY - hold0.y) > 8)) { clearTimeout(holdTimer); hold0 = null; }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { $('chips').addEventListener(ev, function () { clearTimeout(holdTimer); hold0 = null; }); });
  $('chips').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cat]'); if (!b) return;
    if (held) { held = false; return; }
    var cat = b.getAttribute('data-cat');
    if (cat === 'all') {                                                // ALL: everything on; tap again: everything off
      if (allOn()) { hiddenCats = {}; GC.CATS.forEach(function (c) { if (c.id !== 'finance') hiddenCats[c.id] = 1; }); }
      else hiddenCats = {};
      econMode = false;
    }
    else if (cat === 'finance') econMode = !econMode;                   // ECON: its own view, on/off
    else if (econMode) econMode = false;                                // leaving ECON returns to your filter
    else { if (hiddenCats[cat]) delete hiddenCats[cat]; else hiddenCats[cat] = 1; }   // switch one category off/on
    saveHidden(); refresh(); jumpToday(false);
  });
  $('add').addEventListener('click', function () { if (tab === 'notes') openNote(null); else showPaste(''); });
  $('ask').addEventListener('click', showAsk);
  $('more').addEventListener('click', showMenu);
  $('list').addEventListener('click', function (e) {
    if (e.target.closest('[data-open="rules"]')) { showRules(); return; }
    var mb = e.target.closest('.mbar');
    if (mb) { showJump(mb.getAttribute('data-m')); return; }
    var d = e.target.closest('[data-del]');
    if (d) { openRow = null; removeItem(d.getAttribute('data-del')); return; }
    var b = e.target.closest('button[data-id]'); if (!b) return;
    if (justSwiped) return;
    if (openRow) { closeOpen(); return; }
    var id = b.getAttribute('data-id');
    if (id.indexOf('hol-') === 0) { showHoliday(id); return; }
    if (id.indexOf('fin-') === 0) { showFinance(id); return; }
    if (id.indexOf('bill-') === 0) { showBill(id); return; }
    showEdit(id);
  });
  $('scrim').addEventListener('click', function (e) { if (e.target === $('scrim') && !askBusy) { if (noteEd) { noteChanged(); noteEd = null; persist(); } closeSheet(); if (tab === 'notes') renderNotes(); } });
  $('sheet').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    if (act === 'close') closeSheet();
    else if (act === 'parse') { lastPaste = $('paste').value; showConfirm(GC.parseText(lastPaste, new Date()).map(function (d) { d.src = d.src; return d; })); }
    else if (act === 'ai-read') aiRead();
    else if (act === 'back') showPaste(lastPaste);
    else if (act === 'drop') { var n = +b.getAttribute('data-n'); drafts[n].dropped = true; $('row-' + n).hidden = true; }
    else if (act === 'save-all') saveAll();
    else if (act === 'save-one') saveOne();
    else if (act === 'del') { if (!delArmed) { delArmed = true; b.textContent = 'Tap again to delete'; } else { closeSheet(); removeItem(editing.id); } }
    else if (act === 'ai-setup') showAISetup();
    else if (act === 'ai-free') { b.disabled = true; b.textContent = 'Removing…'; aiRemove().then(function () { prefs('aiReady', ''); showMenu(); }, function () { prefs('aiReady', ''); showMenu(); }); }
    else if (act === 'ai-download') aiDownload();
    else if (act === 'ai-remove') aiRemove();
    else if (act === 'ask-send') askSend();
    else if (act === 'ask-new') { askHistory = []; pending = null; showAsk(); }
    else if (act === 'ask-apply') askApply();
    else if (act === 'ask-discard') { pending = null; askHistory.push({ q: '(discard)', a: 'Discarded.' }); showAsk(); }
    else if (act === 'import') showImport();
    else if (act === 'rules') showRules();
    else if (act === 'n-done') { noteChanged(); noteEd = null; persist(); closeSheet(); if (tab === 'notes') renderNotes(); }
    else if (act === 'n-pin') { noteEd.pinned = !noteEd.pinned; b.textContent = noteEd.pinned ? 'Unpin' : '📌 Pin'; noteChanged(); }
    else if (act === 'n-ai') noteTidy();
    else if (act === 'n-undo') { if (noteEd && noteEd.prevBody != null) { $('n-body').value = noteEd.prevBody; $('n-title').value = noteEd.prevTitle || ''; noteChanged(); noteMsg('Restored the original.'); } }
    else if (act === 'n-events') { noteChanged(); var txt = $('n-body').value; noteEd = null; persist(); closeSheet(); showPaste(txt); }
    else if (act === 'n-del') {
      if (!noteDelArmed) { noteDelArmed = true; b.textContent = 'Tap again to delete'; }
      else { var did = noteEd.id; notes = notes.filter(function (n) { return n.id !== did; }); noteEd = null; persist(); closeSheet(); if (tab === 'notes') renderNotes(); }
    }
    else if (act === 'notify') showNotify();
    else if (act === 'notify-on') turnOnNotify();
    else if (act === 'notify-copy') { var t = $('subjson').value; navigator.clipboard.writeText(t).then(function () { b.textContent = 'Copied'; }, function () { $('subjson').select(); }); }
    else if (act === 'notify-test') { writeDigest(); navigator.serviceWorker.ready.then(function (r) { return r.showNotification('GlenCal', { body: 'Test: notifications are working.', icon: 'icon-192.png' }); }).catch(function (e) { showNotify('Test failed: ' + (e.message || e)); }); }
    else if (act === 'arr-move') moveChip(b.getAttribute('data-id'), +b.getAttribute('data-dir'));
    else if (act === 'arr-reset') { prefs('chipOrder', ''); renderChips(); showArrange(); }
    else if (act === 'rule-edit') showRuleForm(b.getAttribute('data-rule'));
    else if (act === 'rule-save') saveRule(b.getAttribute('data-rule'));
    else if (act === 'rule-del') { if (b.textContent !== 'Tap again to delete') { b.textContent = 'Tap again to delete'; } else { var rd = b.getAttribute('data-rule'); rules = rules.filter(function (r) { return r.id !== rd; }); persist(); refresh(); showRules(); } }
    else if (act === 'bill-paid') { var bid = b.getAttribute('data-bill'); if (paid[bid]) delete paid[bid]; else paid[bid] = 1; persist(); refresh(); showBill(bid); }
    else if (act === 'hol-toggle') { prefs('holidays', holidaysOn() ? 'off' : 'on'); refresh(); showMenu(); }
    else if (act === 'do-import') doImport();
    else if (act === 'paste-import') {
      if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { doImport(t); }, function () { showImport('Couldn\'t read the clipboard. Paste into the box instead.'); });
      else showImport('Paste into the box instead.');
    }
    else if (act === 'export') doExport();
    else if (act === 'lock') lockNow();
    else if (act === 'lock-off') { prefs('lock', 'off'); Vault.rekey('device').then(showMenu, function (e) { notice('Could not turn off the lock: ' + e.message); }); }
    else if (act === 'lock-on') { closeSheet(); prefs('lock', 'on'); showLockOn(); }
    else if (act === 'update') installUpdate();
    else if (act === 'jump') { var day = b.getAttribute('data-day'); closeSheet(); if (day < todayISO && !showPast) { showPast = true; render(); } scrollToEl($('d-' + day), true); }
    else if (act === 'jump-today') { closeSheet(); $('q').value = ''; render(); jumpToday(true); }
  });
  window.addEventListener('resize', function () { if (unlocked) syncHead(); });

  // =====================================================================
  // Start
  // =====================================================================
  Vault.status().then(async function (st) {
    if (st === 'new' && prefs('lock') !== 'on') { await Vault.create('device'); return enterApp(await Vault.read()); }
    if (st === 'new') return showSetup();
    if (Vault.method() === 'device') return enterApp(await Vault.unlock());
    showUnlock();
  })
    .catch(function (e) { lockScreen('<div class="err">GlenCal couldn\'t open its storage: ' + esc(e.message || e) + '</div>'); });
})();
