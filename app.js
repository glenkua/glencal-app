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
  var bkPass = '', lastBackup = 0;
  var NOTE_CATS = ['Impt', 'Work', 'Finance', 'Housing', 'Fitness', 'Car', 'Travel', 'Personal'], noteCats = NOTE_CATS.slice(), noteFilter = 'all';
  var rules = [], paid = {}, calcTape = [], notes = [], mailPins = [], mailSeen = [], seenSet = {};
  var loaded = false, lastCounts = null, restoreList = [];
  function counts(d) { return { items: (d.items || []).length, notes: (d.notes || []).filter(function (n) { return n && (n.title || n.body); }).length, pins: (d.mailPins || []).length }; }
  function persist() {
    if (!loaded) return;   // nothing is saved until your data has finished loading
    var snap = { v: 2, items: items.slice(), rules: rules.slice(), paid: Object.assign({}, paid), calc: calcTape.slice(0, 30), notes: notes.filter(function (n) { return n.title || n.body; }), mailPins: mailPins, mailSeen: mailSeen.slice(-1500), watch: WL, noteCats: noteCats, bkPass: bkPass, lastBackup: lastBackup };
    var c = counts(snap), p = lastCounts;
    // Safety net: a save that would empty a section that had 3 or more entries in one go is held back.
    if (p && ['items', 'notes', 'pins'].some(function (k) { return p[k] >= 3 && c[k] === 0; }) && !persist.allowWipe) {
      notice('Saving paused: it would have cleared a whole section. Reopen the app; if anything is missing, use ··· → Restore an earlier copy.');
      return;
    }
    persist.allowWipe = false; lastCounts = c;
    var keep = persist.keep; persist.keep = false;
    saving = saving.then(function () { return Vault.save(snap, keep); }).catch(function (e) { notice('Saving failed: ' + e.message); });
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
    mailPins = data.mailPins || [];
    mailSeen = data.mailSeen || []; seenSet = {}; mailSeen.forEach(function (id) { seenSet[id] = 1; });
    noteCats = Array.isArray(data.noteCats) ? data.noteCats : NOTE_CATS.slice();
    bkPass = data.bkPass || ''; lastBackup = data.lastBackup || 0;
    WL = data.watch && data.watch.list ? data.watch : JSON.parse(JSON.stringify(WL_DEFAULT)); normWL();
    Tools.setTape(calcTape);
    lastCounts = counts(data); loaded = true; prefs('vaultSeen', '1');
    unlocked = true;
    todayISO = GC.iso(new Date());
    $('lock').hidden = true;
    document.body.classList.remove('covered');
    setClock();
    refresh();
    setTimeout(function () {
      setTab('brief');
      if (location.hash === '#gmail' || location.hash === '#mail') { history.replaceState(null, '', location.pathname); setTab('mail'); }
    }, 0);
  }

  function lockNow() {
    Vault.lock();
    unlocked = false; loaded = false;
    items = [];
    closeSheet();
    $('list').innerHTML = '';
    calcTape = []; Tools.setTape([]); notes = []; mailPins = []; MAIL.list = null; mailCache = {}; mailCacheOrder = []; BMAIL.list = null;
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
      .then(function (d) { if (d && d.items) { MKT = d; renderTicker(); if (tab === 'brief') renderBrief(); try { localStorage.setItem('glencal.mkt', JSON.stringify(d)); } catch (e) {} if (tab === 'tools') Tools.draw(); if (tab === 'watch') renderWatch(); } }).catch(function () {});
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
  // =====================================================================
  // Watchlist: a Bloomberg-style worksheet with four charts on top
  // =====================================================================
  var WL_DEFAULT = { list: ['USDSGD', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'SPX', 'NDX', 'DOW', 'UST 2Y', 'UST 5Y', 'UST 10Y', 'UST 30Y'], views: [['USDSGD', 'USDJPY', 'SPX', 'UST 10Y'], [], []], view: 0, range: '1M', dma: false };
  function normWL() {   // older saves: one chart set and a 1W range
    if (!WL.views) { WL.views = [WL.charts || [], [], []]; WL.view = 0; }
    delete WL.charts;
    while (WL.views.length < 3) WL.views.push([]);
    if (!(WL.view >= 0 && WL.view < 3)) WL.view = 0;
    if (!WRANGES.some(function (r) { return r[0] === WL.range; })) WL.range = '1M';
    if (!WL.vranges) WL.vranges = [WL.range, WL.range, WL.range];
    WL.vranges = WL.vranges.map(function (r) { return WRANGES.some(function (x) { return x[0] === r; }) ? r : '1M'; });
    if (!WL.vnames) WL.vnames = ['', '', ''];
    WL.range = WL.vranges[WL.view];
  }
  function vch() { return WL.views[WL.view]; }
  function vname(i) { return (WL.vnames && WL.vnames[i]) || 'View ' + (i + 1); }
  var WL = JSON.parse(JSON.stringify(WL_DEFAULT));
  var WRANGES = [['1D', 'hist-1d'], ['1M', 'hist-2y', 31], ['3M', 'hist-2y', 92], ['6M', 'hist-2y', 183], ['1Y', 'hist-2y', 366], ['5Y', 'hist-5y', 1827, 5]];   // last: weekly points (5 trading days each)
  var MAS = [[50, '#5fd0e8'], [100, '#c792ff'], [200, '#ff6b6b']];   // 50 / 100 / 200-day moving averages
  var LINE = '#f2f2f2';                                               // price line: white, so it stands apart from the amber UI
  var HIST = {};   // file -> { at, data, loading }
  function quote(k) { return MKT && MKT.items ? MKT.items.filter(function (q) { return q.k === k; })[0] : null; }
  function dpFor(q, v) {
    if (!q) return 2;
    if (q.kind === 'yield') return 3;
    if (q.kind === 'fx') { var a = Math.abs(v != null ? v : q.price); return a >= 5000 ? 0 : a >= 20 ? 2 : 4; }
    return 2;
  }
  function wnum(v, dp) { return Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  function loadHist(file) {
    var h = HIST[file] || (HIST[file] = {});
    var url = mktURL();
    var maxAge = file === 'hist-1d' ? 5 * 60000 : file === 'hist-2y' ? 30 * 60000 : 60 * 60000;   // daily and weekly history change only every few hours
    if (!url || h.loading || (h.data && Date.now() - h.at < maxAge)) return Promise.resolve();
    h.loading = true;
    return fetch(url.replace('/markets.json', '/' + file + '.json'), { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; })   // no-cache: unchanged files come back as a tiny "not modified"
      .then(function (d) { if (d && d.s) { h.data = d; h.at = Date.now(); } }, function () {})
      .then(function () { h.loading = false; if (tab === 'watch') drawCharts(); });
  }
  function renderWatchChips() {
    $('wchips').innerHTML = '<div class="wvrow">' + [0, 1, 2].map(function (i) {
      return '<button class="chip" type="button" data-wv="' + i + '" aria-pressed="' + (WL.view === i) + '">' + esc(vname(i)) + '</button>';
    }).join('') + '</div><div class="wrrow">' + WRANGES.map(function (r) {
      return '<button class="chip" type="button" data-wr="' + r[0] + '" aria-pressed="' + (WL.range === r[0]) + '">' + r[0] + '</button>';
    }).join('') + '<button class="chip" type="button" data-wdma="1" aria-pressed="' + !!WL.dma + '">DMA</button></div>';
  }
  function unpack(s) { return s ? s.m.map(function (m, i) { return { t: (s.t0 + m * 60) * 1000, c: s.c[i] }; }) : null; }
  function dailyWithMA(k, file, per) {   // closes with 50/100/200-day averages; weekly points use 10/20/40 weeks
    var h = HIST[file || 'hist-2y'], d = unpack(h && h.data && h.data.s[k]);
    if (!d) return null;
    MAS.forEach(function (ma) {
      var n = Math.round(ma[0] / (per || 1)), sum = 0;
      d.forEach(function (p, i) { sum += p.c; if (i >= n) sum -= d[i - n].c; p['ma' + ma[0]] = i >= n - 1 ? sum / n : null; });
    });
    return d;
  }
  function series(k) {
    var r = WRANGES.filter(function (x) { return x[0] === WL.range; })[0];
    if (r[2]) {
      var d = dailyWithMA(k, r[1], r[3]); if (!d) return null;
      var from = d.length ? d[d.length - 1].t - r[2] * 864e5 : 0;
      return { pts: d.filter(function (p) { return p.t >= from; }), daily: true };
    }
    var h = HIST[r[1]], pts = unpack(h && h.data && h.data.s[k]);
    if (!pts) return null;
    var lvl = {}, d2 = WL.dma ? dailyWithMA(k) : null;   // intraday: today's DMA levels as flat lines
    if (d2 && d2.length) MAS.forEach(function (ma) { lvl[ma[0]] = d2[d2.length - 1]['ma' + ma[0]]; });
    return { pts: pts, daily: false, lvl: lvl };
  }
  var chartGeo = {};
  function chartSVG(k, w, tall) {
    var q = quote(k), sr = series(k);
    var H = tall || 140, padR = 46, padB = 14, padT = 6, W = Math.max(120, w);
    if (!sr || sr.pts.length < 2) return '<svg viewBox="0 0 ' + W + ' ' + H + '"><text x="' + (W / 2) + '" y="' + (H / 2) + '" fill="#555" font-size="10" text-anchor="middle">' + (sr ? 'No data for this range' : 'Loading…') + '</text></svg>';
    var p = sr.pts, lo = Infinity, hi = -Infinity;
    p.forEach(function (x) {
      lo = Math.min(lo, x.c); hi = Math.max(hi, x.c);
      if (WL.dma && sr.daily) MAS.forEach(function (ma) { var v = x['ma' + ma[0]]; if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    });
    if (hi === lo) { hi += Math.abs(hi) * 0.001 || 1; lo -= Math.abs(lo) * 0.001 || 1; }
    var pad = (hi - lo) * 0.15; hi += pad; lo -= pad;   // breathing room above and below the line
    var t0 = p[0].t, t1 = p[p.length - 1].t, pw = W - padR, ph = H - padB - padT;
    var useIdx = !sr.daily;   // intraday: space points evenly so closed hours don't leave gaps
    function X(x, i) { return useIdx ? i / (p.length - 1) * pw : (x.t - t0) / (t1 - t0 || 1) * pw; }
    function Y(v) { return padT + (hi - v) / (hi - lo) * ph; }
    var dp = dpFor(q, p[p.length - 1].c), o = '';
    for (var g = 0; g <= 4; g++) {   // grid and right-hand price axis
      var v = lo + (hi - lo) * (g + 0.5) / 5, y = Y(v).toFixed(1);
      o += '<line x1="0" x2="' + pw + '" y1="' + y + '" y2="' + y + '" stroke="#242424" stroke-dasharray="2 3"/>' +
        '<text x="' + (pw + 3) + '" y="' + (+y + 3) + '" fill="#8a8a8a" font-size="9" font-family="Menlo,monospace">' + wnum(v, dp) + '</text>';
    }
    function lbl(x) {
      var d = new Date(x.t);
      if (WL.range === '1D') return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + (WL.range === '1Y' || WL.range === '5Y' ? " '" + String(d.getFullYear()).slice(2) : '');
    }
    [0, Math.floor((p.length - 1) / 2), p.length - 1].forEach(function (i, j) {
      o += '<text x="' + X(p[i], i).toFixed(1) + '" y="' + (H - 2) + '" fill="#777" font-size="9" font-family="Menlo,monospace" text-anchor="' + ['start', 'middle', 'end'][j] + '">' + lbl(p[i]) + '</text>';
    });
    if (WL.dma) MAS.forEach(function (ma) {
      var key = 'ma' + ma[0];
      if (sr.daily) {
        var md = '';
        p.forEach(function (x, i) { if (x[key] != null) md += (md ? 'L' : 'M') + X(x, i).toFixed(1) + ' ' + Y(x[key]).toFixed(1); });
        if (md) o += '<path d="' + md + '" fill="none" stroke="' + ma[1] + '" stroke-width="0.8"/>';
      } else {
        var lv = sr.lvl[ma[0]];
        if (lv != null && lv >= lo && lv <= hi) o += '<line x1="0" x2="' + pw + '" y1="' + Y(lv).toFixed(1) + '" y2="' + Y(lv).toFixed(1) + '" stroke="' + ma[1] + '" stroke-width="1" stroke-dasharray="4 3"/>';
      }
    });
    var d = p.map(function (x, i) { return (i ? 'L' : 'M') + X(x, i).toFixed(1) + ' ' + Y(x.c).toFixed(1); }).join('');
    var last = p[p.length - 1], ly = Y(last.c);
    o += '<path d="' + d + '" fill="none" stroke="' + LINE + '" stroke-width="1" stroke-linejoin="round"/>' +
      '<rect x="' + pw + '" y="' + (ly - 6.5).toFixed(1) + '" width="' + padR + '" height="13" fill="' + LINE + '"/>' +
      '<text x="' + (pw + 3) + '" y="' + (ly + 3).toFixed(1) + '" fill="#000" font-size="9" font-weight="700" font-family="Menlo,monospace">' + wnum(last.c, dp) + '</text>';
    chartGeo[k] = { W: W, H: H, pw: pw, padT: padT, ph: ph, dp: dp, pts: p, xs: p.map(function (x, i) { return X(x, i); }), ys: p.map(function (x) { return Y(x.c); }) };
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px">' + o + '<g class="xh"></g></svg>';
  }
  function maLegend(k) {   // latest 50/100/200-day values under the chart title
    if (!WL.dma) return '';
    var d = dailyWithMA(k); if (!d || !d.length) return '';
    var q = quote(k), lastD = d[d.length - 1];
    return '<div class="wma">' + MAS.map(function (ma) {
      var v = lastD['ma' + ma[0]];
      return '<span style="color:' + ma[1] + '">' + ma[0] + 'D ' + (v != null ? wnum(v, dpFor(q, v)) : '—') + '</span>';
    }).join('') + '</div>';
  }
  function chgHTML(q, from, to) {
    if (from == null || to == null) return '';
    if (q && q.kind === 'yield') { var bp = (to - from) * 100; return '<span class="c ' + (bp > 0.05 ? 'up' : bp < -0.05 ? 'dn' : 'fl') + '" style="color:var(--' + (bp > 0.05 ? 'up' : bp < -0.05 ? 'red' : 'muted') + ')">' + (bp > 0 ? '+' : bp < 0 ? '−' : '') + Math.abs(bp).toFixed(1) + 'bp</span>'; }
    var pc = (to - from) / from * 100;
    return '<span class="c" style="color:var(--' + (pc > 0.005 ? 'up' : pc < -0.005 ? 'red' : 'muted') + ')">' + (pc > 0 ? '+' : pc < 0 ? '−' : '') + Math.abs(pc).toFixed(2) + '%</span>';
  }
  function drawCharts() {
    var grid = $('wgrid'); if (!grid) return;
    var keys = WL.list.filter(function (k) { return vch().indexOf(k) >= 0; }).slice(0, 4);
    var r = WRANGES.filter(function (x) { return x[0] === WL.range; })[0];
    loadHist(r[1]); if (WL.dma) loadHist('hist-2y');
    var cells = '';
    for (var i = 0; i < 4; i++) {
      var k = keys[i];
      if (!k) { cells += '<div class="wc empty">Tap ◉ beside a<br>security to chart it</div>'; continue; }
      var q = quote(k), sr = series(k), p = sr && sr.pts;
      var from = WL.range === '1D' && q && q.prev ? q.prev : p && p.length ? p[0].c : null;
      var to = q && q.price != null ? q.price : p && p.length ? p[p.length - 1].c : null;
      cells += '<div class="wc"><div class="wh"><b>' + esc(k) + '</b><span class="p">' + (to != null ? wnum(to, dpFor(q, to)) : '') + '</span>' + chgHTML(q, from, to) + '</div>' + maLegend(k) + '<div data-wsvg="' + esc(k) + '"></div></div>';
    }
    grid.innerHTML = cells;
    grid.querySelectorAll('[data-wsvg]').forEach(function (el) { el.innerHTML = chartSVG(el.getAttribute('data-wsvg'), el.clientWidth); });
  }
  function renderWatch() {
    var rows = WL.list.map(function (k) {
      var q = quote(k), f = q ? fmtQ(q) : null, on = vch().indexOf(k) >= 0;
      return '<tr><td class="s" data-wrow="' + esc(k) + '">' + esc(k) + (q ? '<span>' + esc(q.name || '') + '</span>' : '') + '</td>' +
        '<td class="px">' + (q && q.price != null ? wnum(q.price, dpFor(q)) : '—') + '</td>' +
        '<td class="' + (f ? f.cls : 'fl') + '">' + (f ? f.ch : '') + '</td>' +
        '<td class="ct"><button class="wtog' + (on ? ' on' : '') + '" type="button" data-wchart="' + esc(k) + '" aria-pressed="' + on + '" aria-label="Chart ' + esc(k) + '"></button></td></tr>';
    }).join('');
    $('watch').innerHTML = '<div id="wgrid" class="wgrid"></div>' +
      '<table class="wl"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup><thead><tr><th>SECURITY</th><th>LAST PX</th><th>1D %CHG</th><th>CHT</th></tr></thead><tbody>' + rows +
      '<tr class="wadd"><td colspan="4"><button type="button" data-wadd="1">+ Add security</button></td></tr></tbody></table>' +
      '<p class="wfoot">Delayed prices from ' + esc((MKT && MKT.source) || 'Yahoo Finance') + (MKT && MKT.updated ? ', ' + esc(MKT.updated.slice(11)) + ' SGT' : '') + '. Yields show the change in basis points. ' +
      (WL.dma ? 'DMA: 50-day (blue), 100-day (purple) and 200-day (red) moving averages of daily closes; on 1D they show as dashed levels; on 5Y (weekly points) they use 10, 20 and 40 weeks. ' : '') + 'Tap a chart to enlarge it; swipe the charts to change view. Tap a security to move or remove it. Pull down to refresh.</p>';
    drawCharts();
  }
  function toggleChart(k) {
    var c = vch(), i = c.indexOf(k);
    if (i >= 0) c.splice(i, 1);
    else { c.push(k); if (c.length > 4) { var out = c.shift(); flashToast('Up to 4 charts per view: ' + out + ' swapped out'); } }
    persist(); renderWatchChips(); renderWatch();
  }
  function wRowSheet(k) {
    var q = quote(k), i = WL.list.indexOf(k);
    openSheet('<h2 style="text-transform:none;letter-spacing:0">' + esc(k) + '</h2><p class="small">' + esc(q ? q.name + ' · ' + q.group : '') + '</p>' +
      '<div class="actions"><button class="btn" type="button" data-wmove="-1" data-wk="' + esc(k) + '"' + (i <= 0 ? ' disabled' : '') + '>↑ Move up</button>' +
      '<button class="btn" type="button" data-wmove="1" data-wk="' + esc(k) + '"' + (i >= WL.list.length - 1 ? ' disabled' : '') + '>↓ Move down</button>' +
      '<button class="btn" type="button" data-wdel="' + esc(k) + '">Remove</button><button class="btn primary" type="button" data-act="close">Done</button></div>');
  }
  function wPickList(qs) {
    qs = (qs || '').trim().toLowerCase();
    var avail = (MKT && MKT.items || []).filter(function (q) { return WL.list.indexOf(q.k) < 0 && (!qs || (q.k + ' ' + (q.name || '') + ' ' + (q.group || '')).toLowerCase().indexOf(qs) >= 0); });
    if (!avail.length) return '<p class="small">' + (MKT ? 'Nothing else matches.' : 'Prices are still loading.') + '</p>';
    var html = '', g = null;
    avail.forEach(function (q) {
      if (q.group !== g) { g = q.group; html += '<h3>' + esc((g || 'Other').toUpperCase()) + '</h3>'; }
      html += '<button type="button" data-wpick="' + esc(q.k) + '"><b>' + esc(q.k) + '</b><span>' + esc(q.name || '') + '</span></button>';
    });
    return html;
  }
  function wAddSheet() {
    openSheet('<h2>Add security</h2><input id="wsearch" class="search" type="search" placeholder="search, e.g. gold, SGD, DBS" autocomplete="off" style="width:100%;box-sizing:border-box">' +
      '<div class="wpick" id="wpick">' + wPickList('') + '</div>' +
      '<p class="small">This list is fixed by the price job. Ask for anything missing and it can be added.</p>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
  }
  $('sheet').addEventListener('input', function (e) { if (e.target.id === 'wsearch') $('wpick').innerHTML = wPickList(e.target.value); });
  $('sheet').addEventListener('click', function (e) {
    var b = e.target.closest('[data-wpick]');
    if (b) { WL.list.push(b.getAttribute('data-wpick')); persist(); renderWatch(); $('wpick').innerHTML = wPickList($('wsearch').value); flashToast(b.getAttribute('data-wpick') + ' added'); return; }
    b = e.target.closest('[data-wmove]');
    if (b) {
      var k = b.getAttribute('data-wk'), i = WL.list.indexOf(k), j = i + Number(b.getAttribute('data-wmove'));
      if (i < 0 || j < 0 || j >= WL.list.length) return;
      WL.list.splice(i, 1); WL.list.splice(j, 0, k); persist(); renderWatch(); wRowSheet(k); return;
    }
    b = e.target.closest('[data-wdel]');
    if (b) {
      var d = b.getAttribute('data-wdel');
      WL.list = WL.list.filter(function (x) { return x !== d; }); WL.views = WL.views.map(function (v) { return v.filter(function (x) { return x !== d; }); });
      persist(); renderWatch(); closeSheet(); flashToast(d + ' removed');
    }
  });
  function bigChart(k) {
    var q = quote(k), w = Math.min(window.innerWidth, 672) - 28;
    var sr = series(k), p = sr && sr.pts;
    var from = WL.range === '1D' && q && q.prev ? q.prev : p && p.length ? p[0].c : null, to = q && q.price != null ? q.price : p && p.length ? p[p.length - 1].c : null;
    openSheet('<div class="wbig"><div class="wh"><b>' + esc(k) + '</b><span class="p">' + (to != null ? wnum(to, dpFor(q, to)) : '') + '</span>' + chgHTML(q, from, to) +
      '<span class="r">' + esc(WL.range) + '</span></div>' + maLegend(k) +
      '<div id="bigc" class="bigc">' + chartSVG(k, w, Math.round(Math.min(window.innerHeight * 0.45, 340))) + '</div>' +
      '<div id="bigx" class="bigx">Touch and drag across the chart to read prices.</div></div>' +
      '<p class="small">' + esc(q ? q.name : '') + '</p><div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
    var box = $('bigc'), g = chartGeo[k];
    if (!g) return;
    function at(e) {
      var r = box.getBoundingClientRect(), x = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width * g.W, best = 0;
      for (var i = 1; i < g.xs.length; i++) if (Math.abs(g.xs[i] - x) < Math.abs(g.xs[best] - x)) best = i;
      var pt = g.pts[best], d = new Date(pt.t), xs = g.xs[best].toFixed(1), ys = g.ys[best].toFixed(1);
      box.querySelector('.xh').innerHTML = '<line x1="' + xs + '" x2="' + xs + '" y1="' + g.padT + '" y2="' + (g.padT + g.ph) + '" stroke="#ffa21f" stroke-width="0.8"/>' +
        '<line x1="0" x2="' + g.pw + '" y1="' + ys + '" y2="' + ys + '" stroke="#ffa21f" stroke-width="0.6" stroke-dasharray="2 2"/><circle cx="' + xs + '" cy="' + ys + '" r="3" fill="#ffa21f"/>';
      var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var when = d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear() + (WL.range === '1D' ? ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) : '');
      var first = g.pts[0].c, ch = q && q.kind === 'yield' ? ((pt.c - first) * 100 >= 0 ? '+' : '−') + Math.abs((pt.c - first) * 100).toFixed(1) + 'bp' : ((pt.c - first) / first * 100 >= 0 ? '+' : '−') + Math.abs((pt.c - first) / first * 100).toFixed(2) + '%';
      $('bigx').innerHTML = '<b>' + wnum(pt.c, g.dp) + '</b> · ' + when + ' · <span class="small">' + ch + ' from the start of the chart</span>';
      if (e.cancelable) e.preventDefault();
    }
    box.addEventListener('touchstart', at, { passive: false });
    box.addEventListener('touchmove', at, { passive: false });
    box.addEventListener('mousemove', at);
  }
  var wsw = null, wSwiped = false;
  $('watch').addEventListener('touchstart', function (e) { wsw = e.target.closest('#wgrid') && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  $('watch').addEventListener('touchend', function (e) {
    if (!wsw) return;
    var t = e.changedTouches[0], dx = t.clientX - wsw.x, dy = t.clientY - wsw.y; wsw = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    var nv = WL.view + (dx < 0 ? 1 : -1); if (nv < 0 || nv > 2) return;
    wSwiped = true; setTimeout(function () { wSwiped = false; }, 400);
    WL.view = nv; WL.range = WL.vranges[nv]; persist(); renderWatchChips(); renderWatch(); flashToast(vname(nv));
  }, { passive: true });
  $('watch').addEventListener('click', function (e) {
    if (wSwiped) return;
    var b = e.target.closest('[data-wchart]'); if (b) { toggleChart(b.getAttribute('data-wchart')); return; }
    var cg = e.target.closest('[data-wsvg]'); if (cg) { bigChart(cg.getAttribute('data-wsvg')); return; }
    if (e.target.closest('[data-wadd]')) { wAddSheet(); return; }
    b = e.target.closest('[data-wrow]'); if (b) wRowSheet(b.getAttribute('data-wrow'));
  });
  $('wchips').addEventListener('click', function (e) {
    var v = e.target.closest('[data-wv]');
    if (v) { WL.view = Number(v.getAttribute('data-wv')); WL.range = WL.vranges[WL.view]; persist(); renderWatchChips(); renderWatch(); return; }
    var b = e.target.closest('[data-wr]');
    if (b) { WL.range = WL.vranges[WL.view] = b.getAttribute('data-wr'); persist(); renderWatchChips(); drawCharts(); return; }
    if (e.target.closest('[data-wdma]')) { WL.dma = !WL.dma; persist(); renderWatchChips(); renderWatch(); }
  });
  window.addEventListener('resize', function () { if (tab === 'watch') drawCharts(); });
  $('wren').addEventListener('click', function () {
    var n = window.prompt('Name for ' + vname(WL.view), WL.vnames[WL.view] || '');
    if (n === null) return;
    WL.vnames[WL.view] = n.trim().slice(0, 14); persist(); renderWatchChips();
  });
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
  (prefs('newsHidden2') || '').split(',').forEach(function (k) { if (k) newsHidden[k] = 1; });   // new categories: start with everything on
  var NEWS_RX = {
    sg: /\b(singapore|singaporean|mas|sgd|s\$|sti|straits times index|dbs|ocbc|uob|singtel|temasek|gic|changi|hdb|cpf)\b/i,
    fx: /\b(fx|forex|currenc(y|ies)|exchange rates?|dollar|greenback|dxy|euro|yen|sterling|pound|franc|yuan|renminbi|cnh|rupee|won|ringgit|rupiah|baht|peso|aussie|kiwi|loonie|intervention|devalu\w*|carry trade|[A-Z]{3}\/[A-Z]{3})\b/i,
    eq: /\b(stocks?|shares?|equit(y|ies)|s&p|nasdaq|dow|nikkei|hang seng|ftse|dax|stoxx|kospi|index futures|earnings|profit|revenue|ipo|listing|buyback|dividend|bear market|bull market|market cap|valuation|wall street|chipmakers?|nvidia|apple|microsoft|tesla|alphabet|amazon|meta)\b/i,
    fi: /\b(bonds?|yields?|treasur(y|ies)|gilts?|bunds?|jgbs?|notes? auction|auction|debt|credit|spreads?|coupon|duration|sovereign|issuance|rating|downgrade|upgrade|default|rates? (cut|hike|decision)|cuts? rates|hikes? rates|basis points?|bps?|sofr|sora|repo|qt|qe|balance sheet|curve)\b/i,
    ec: /\b(inflation|cpi|pce|ppi|gdp|growth|recession|jobs?|payrolls?|unemployment|jobless|wages?|pmi|retail sales|industrial production|exports?|imports?|trade (deficit|surplus|balance)|tariffs?|consumer (confidence|sentiment|spending)|housing starts|home sales|house prices|home prices|holiday spending|cost of living|prices|economy|economic|economists?|fed|fomc|powell|ecb|lagarde|boj|ueda|boe|bailey|rba|rbnz|pboc|central banks?|policy rate|monetary|fiscal|budget|deficit)\b/i
  };
  function newsTags(n) {   // a headline can sit in more than one category
    var t = [], h = n.title || '';
    if (n.sg || NEWS_RX.sg.test(h)) t.push('sg');
    if (NEWS_RX.fx.test(h)) t.push('fx');
    if (n.kind === 'equity' || NEWS_RX.eq.test(h)) t.push('eq');
    if (n.cb || NEWS_RX.fi.test(h)) t.push('fi');
    if (n.cb || NEWS_RX.ec.test(h)) t.push('ec');
    return t.length ? t : ['gen'];
  }
  var lastSeen = prefs('newsSeen') || '';
  function newsURL() { var u = mktURL(); return u ? u.replace('/markets.json', '/news.json') : null; }
  var BRIEF = null, briefAt = 0;
  try { BRIEF = JSON.parse(localStorage.getItem('glencal.brief') || 'null'); } catch (e) {}
  function loadBrief() {
    var u = mktURL(); if (!u || Date.now() - briefAt < 15 * 60000) return;
    briefAt = Date.now();
    fetch(u.replace('/markets.json', '/brief.json'), { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.items && (!BRIEF || d.made !== BRIEF.made)) { BRIEF = d; try { localStorage.setItem('glencal.brief', JSON.stringify(d)); } catch (e) {} if (tab === 'brief') renderBrief(); }
    }, function () {});
  }
  function aheadLine() {   // key releases and meetings in the next 7 days (first 4), from the ECON calendar
    var lo = todayISO, hi = GC.iso(GC.addDays(new Date(), 7));
    var KEY = /(cpi|pce|payroll|non-?farm|nfp|gdp|fomc|rate decision|interest rate|cash rate|monetary policy|unemployment|employment change|retail sales|ism|pmi)/i;
    var pick = function (until) { return financeItems().filter(function (e) { return e.date >= lo && e.date <= until && (e.kind === 'cb' || KEY.test(e.raw || '')); })
      .sort(function (a, b) { return (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1; }); };
    var list = pick(hi).slice(0, 4);
    if (list.length < 2) list = pick(GC.iso(GC.addDays(new Date(), 21))).slice(0, 2);   // quiet week: still show the next two key events
    return list.map(function (e) { var l = dLabel(e.date); return (e.date === todayISO ? 'Today' : l.dow + ' ' + l.day) + (e.time ? ' ' + GC.fmtTime(e.time) : '') + ' <b>' + esc(e.ccy) + '</b> ' + esc((e.raw || '').replace(/\s*\(.*?\)\s*/g, ' ').trim()); }).join(' · ');
  }
  function loadNews() {
    var url = newsURL(); if (!url || document.hidden) return Promise.resolve();
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.items) { NEWS = d; if (tab === 'news') renderNews(); if (tab === 'brief') renderBrief(); } }).catch(function () {});
  }
  var NEWS_CHIPS = [['all', 'All'], ['sg', 'SG'], ['fx', 'FX'], ['eq', 'Equities'], ['fi', 'Fixed Income'], ['ec', 'Economics'], ['gen', 'General']];
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
  function briefRows(list, econ, dayLab) {   // dayLab: label for a left-hand day column (shown on the first row only)
    return list.map(function (e, idx) {
      var c = GC.CAT_BY_ID[catOf(e)];
      var days = Math.round((GC.fromISO(e.date) - GC.fromISO(todayISO)) / 86400000);
      var title = e.finance ? (e.kind === 'cb' ? '<span class="star">★</span> ' : '') + '<b class="ccy">' + esc(e.ccy) + '</b> ' + esc(e.raw)
        : '<span class="tt">' + esc(e.title) + (e.age ? ' (' + e.age + ')' : '') + (e.isDue ? '<span class="due">' + (e.paid ? 'PAID' : 'DUE') + '</span>' : '') + '</span>';
      return '<button type="button" class="brow' + (e.finance && e.kind === 'cb' ? ' cb' : '') + (dayLab != null && idx === 0 ? ' dfirst' : '') + '" data-bid="' + esc(e.id) + '">' +
        (dayLab != null ? '<span class="dl">' + (idx === 0 ? dayLab : '') + '</span>' : '') +
        '<span class="tm">' + (e.time ? esc(GC.fmtTime(e.time)) : '') + '</span><span class="emo" aria-hidden="true">' + (e.emoji || c.emoji) + '</span>' +
        '<span class="t">' + title + (e.place ? (e.finance ? '<span class="pl"> @ ' + esc(e.place) + '</span>' : '<span class="pl2">@ ' + esc(e.place) + '</span>') : '') +
        (e.noteHTML ? '<span class="note">' + e.noteHTML + '</span>' : e.note && !e.bill ? '<span class="note">' + esc(e.note) + '</span>' : '') + '</span>' +
        '<span class="cd">' + (econ && days === 1 ? 'TMR' : '') + '</span></button>';
    }).join('');
  }
  function renderBrief() {
    if (!unlocked) return;
    var now = new Date(), h = now.getHours(), l = dLabel(todayISO), tmr = GC.iso(GC.addDays(now, 1));
    var byTime = function (a, b) { return (a.time || '') < (b.time || '') ? -1 : 1; };
    var mineOf = function (d) { return allEntries().filter(function (e) { return e.date === d && !(e.bill && !e.isDue); }).sort(byTime); };
    var html = '<div class="bhead"><span>' + (h < 12 ? 'GOOD MORNING' : h < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING') + ' · ' + l.dow + ' ' + l.day + ' ' + l.mon + '</span>' +
      '<button class="key" type="button" data-bmenu="1" aria-label="Menu">···' + (updateReady ? ' ●' : '') + '</button></div>';
    if (typeof DAILY !== 'undefined' && DAILY.length) {   // one item a day, the same all day
      var dayNo = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(2026, 0, 1)) / 864e5);
      var it = DAILY[((dayNo * 37) % DAILY.length + DAILY.length) % DAILY.length];   // stepping by 37 mixes the topics
      var KIND = { m: 'MONEY', h: 'HABIT', t: 'DID YOU KNOW', q: 'QUOTE' };
      html += '<div class="bdaily' + (it[0] === 'q' ? ' q' : '') + '"><span class="dk">' + KIND[it[0]] + '</span>' +
        (it[0] === 'q' ? '“' + esc(it[1]) + '” <span class="ds">— ' + esc(it[2]) + '</span>' : esc(it[1])) + '</div>';
    }

    // today / tomorrow
    // weekly backup reminder: shows when the last backup is over 7 days old (or never), unless snoozed today
    var bkAge = lastBackup ? Math.floor((Date.now() - lastBackup) / 864e5) : null, snooze = +(prefs('bkSnooze') || 0);
    if ((bkAge === null || bkAge >= 7) && Date.now() - snooze > 20 * 3600e3) {
      html += '<div class="bkcard"><div><b>🔒 Weekly backup</b><span class="small">' + (bkAge === null ? 'No backup saved yet.' : 'Last backup ' + bkAge + ' days ago.') + ' Save an encrypted copy to iCloud Drive.</span></div>' +
        '<div class="bkbtns"><button class="btn" type="button" data-act="bk-later">Later</button><button class="btn primary" type="button" data-act="export">Back up</button></div></div>';
    }
    // events: today and the next 6 days, grouped by day; days with nothing are skipped (today always shows)
    var wk = '', wkCount = 0;
    for (var di = 0; di < 7; di++) {
      var dd = GC.iso(GC.addDays(now, di)), list = mineOf(dd);
      if (!list.length && di > 0) continue;
      var dl = dLabel(dd);
      var lab = di === 0 ? 'TODAY' : di === 1 ? 'TMR' : dl.dow + ' ' + dl.day;
      wk += list.length ? briefRows(list, false, lab) : '<div class="brow dfirst bempty"><span class="dl">' + lab + '</span></div>';
      wkCount += list.length;
    }
    html += '<section class="bsec"><h2 class="mbar"><span>EVENTS · NEXT 7 DAYS</span><span class="n">' + wkCount + '</span></h2>' +
      '<div class="bscroll bweek">' + wk + '</div>' + (wkCount > 3 ? '<div class="bmore">↓ scroll for more</div>' : '');

    html += '</section>';

    // mail: latest Primary emails (only while signed in)
    if (Gmail.token()) {
      if ((!BMAIL.list || Date.now() - BMAIL.at > 5 * 60000) && !BMAIL.loading) loadBriefMail();
      var ml2 = BMAIL.list || [];
      html += '<section class="bsec"><h2 class="mbar"><span>MAIL · PAST 7 DAYS</span><span class="n">' + (BMAIL.list ? BMAIL.list.filter(isUnread).length + ' unread' : '') + '</span></h2>' +
        (ml2.length ? '<div class="bmail' + (ml2.length > 3 ? ' bscroll' : '') + '">' + ml2.map(function (m) {
          return '<button type="button" class="mrow' + (isUnread(m) ? '' : ' read') + '" data-bmid="' + esc(m.id) + '"><span class="mt2">' + esc(mailWhen(m.date)) + '</span>' +
            '<span><span class="mf' + (isUnread(m) ? ' unread' : '') + '">' + esc(m.from) + '</span><span class="ms">' + esc(m.subject) + '</span></span></button>';
        }).join('') + '</div>' + (ml2.length > 3 ? '<div class="bmore">↓ scroll for ' + (ml2.length - 3) + ' more</div>' : '')
          : '<p class="bnone">' + (BMAIL.loading || !BMAIL.list ? 'Loading…' : 'No mail in the past 7 days.') + '</p>') + '</section>';
    } else {
      html += '<section class="bsec"><h2 class="mbar"><span>MAIL</span></h2><p class="bnone"><button class="btn" type="button" data-bgo="1">Sign in to Gmail</button></p></section>';
    }

    // ECON: only what's still to come in the next 24 hours (released data stays in the ECON calendar)
    var lo = stamp(now), hi = stamp(new Date(now.getTime() + 24 * 3600e3));
    var econ = financeItems().filter(function (e) { var k = e.date + ' ' + (e.time || '12:00'); return k >= lo && k <= hi; })
      .sort(function (a, b) { return (a.date + (a.time || '12:00')) < (b.date + (b.time || '12:00')) ? -1 : 1; });
    html += '<section class="bsec"><h2 class="mbar"><span>ECON · NEXT 24H</span><span class="n">' + econ.length + '</span></h2>' +
      (econ.length ? (econ.length > 3
        ? '<div class="bscroll" id="becon">' + briefRows(econ, true) + '</div><div class="bmore">↓ scroll for ' + (econ.length - 3) + ' more</div>'
        : briefRows(econ, true)) : '<p class="bnone">No tier-1 releases in the next 24 hours.</p>') + '</section>';

    // markets
    var tk = MKT && MKT.items ? MKT.items.filter(function (q) { return q.tk !== false; }) : [];
    html += '<section class="bsec"><h2 class="mbar"><span>MARKETS · VS PREVIOUS CLOSE</span></h2>' + (tk.length ? '<div class="bgrid">' + tk.map(function (q) {
      var f = fmtQ(q);
      return '<div class="bq"><b>' + esc(q.k) + '</b><span class="v">' + f.v + ' <span style="color:var(--' + (f.cls === 'up' ? 'up' : f.cls === 'dn' ? 'red' : 'muted') + ')">' + f.ch + '</span></span></div>';
    }).join('') + '</div>' : '<p class="bnone">Loading prices…</p>') + '</section>';

    // market brief: made once a day at 7am SGT from the NY session headlines
    loadBrief();
    if (BRIEF && BRIEF.items) {
      html += '<section class="bsec"><h2 class="mbar"><span>MARKET BRIEF · ' + esc((BRIEF.label || '').toUpperCase()) + '</span></h2>' +
        (BRIEF.tone ? '<div class="bbul"><span class="bdot">•</span><span class="bt"><b>Overall:</b> ' + esc(BRIEF.tone.replace(/^([^:]+): /, '$1 — ')) + '</span></div>' : '') +
        BRIEF.items.filter(function (b) { return b.k !== 'macro'; }).map(function (b) {
          return '<a class="bbul" href="' + esc(b.url) + '" target="_blank" rel="noopener noreferrer"><span class="bdot">•</span><span class="bt"><b>' + esc(b.label) + ':</b> ' + esc(b.t) + ' <span class="bs">(' + esc(b.src) + ')</span></span></a>';
        }).join('') + '</section>';
    }

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
    html += '<section class="bsec"><h2 class="mbar"><span>HEADLINES</span></h2>' + (picks.length ? picks.map(function (n) {
      return '<a class="nrow' + (n.cb ? ' cb' : '') + '" href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="nt">' + esc(n.t.slice(11)) + '</span><span class="ns">' + esc(n.src) + '</span>' +
        '<span class="nh">' + (n.cb ? '<span class="star">★</span> ' : '') + (n.sg ? '🇸🇬 ' : '') + esc(n.title) + '</span></a>';
    }).join('') : '<p class="bnone">' + (NEWS ? 'Nothing major in the last 14 hours.' : 'Loading headlines…') + '</p>') + '</section>';

    html += '<div class="bfoot">Prices and headlines are delayed (about 10–30 minutes). Pull down to refresh.' +
      (MKT && MKT.updated ? ' Prices ' + esc(MKT.updated.slice(11)) + '.' : '') + (NEWS && NEWS.updated ? ' Headlines ' + esc(NEWS.updated.slice(11)) + '.' : '') + '</div>';
    $('brief').innerHTML = html;
  }
  $('brief').addEventListener('click', function (e) {
    if (e.target.closest('[data-bmenu]')) { showMenu(); return; }
    var bk = e.target.closest('.bkcard [data-act]');
    if (bk) { if (bk.getAttribute('data-act') === 'export') showExport(); else { prefs('bkSnooze', String(Date.now())); renderBrief(); } return; }
    var bm = e.target.closest('[data-bmid]'); if (bm) { if (!lpJust) openMail(bm.getAttribute('data-bmid')); return; }
    if (e.target.closest('[data-bgo]')) { Gmail.start(); return; }
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
    renderNoteChips();
    var list = notes.filter(function (n) { return (n.title || n.body) && (noteFilter === 'all' || n.cat === noteFilter) && (!q || (n.title + ' ' + n.body + ' ' + (n.cat || '')).toLowerCase().indexOf(q) >= 0); })
      .sort(function (a, b) { return a.updated < b.updated ? 1 : -1; });
    var row = function (n) {
      var body = n.title ? n.body : (n.body || '').split('\n').slice(1).join('\n');
      return '<div class="nwrap"><div class="swipe-pin" aria-hidden="true">' + (n.pinned ? 'UNPIN' : '📌 PIN') + '</div>' +
        '<div class="swipe-del"><button type="button" data-ndel="' + esc(n.id) + '">DELETE</button></div>' +
        '<button type="button" class="nnote" data-note="' + esc(n.id) + '"><span class="nt1">' + esc(noteTitle(n)) + '</span><span class="nd">' + (n.cat && noteFilter === 'all' ? '<span class="ncat">' + esc(n.cat.toUpperCase()) + '</span>' : '') +
        (function () { var t = (n.body.match(/^\s*[☐☑] /gm) || []).length, d = (n.body.match(/^\s*☑ /gm) || []).length; return t ? '<span class="nck' + (d === t ? ' all' : '') + '">' + d + '/' + t + ' ✓</span> ' : ''; })() +
        esc(noteWhen(n.updated)) + '</span>' +
        '<span class="np">' + esc((body || '').trim().slice(0, 240)) + '</span></button></div>';
    };
    var pinned = list.filter(function (n) { return n.pinned; }), rest = list.filter(function (n) { return !n.pinned; });
    $('notes').innerHTML = '<div class="actions" style="margin-top:0.5rem"><button class="btn primary" type="button" data-newnote="1">+ New note</button></div>' + (pinned.length ? '<h2 class="mbar"><span>📌 PINNED</span><span class="n">' + pinned.length + '</span></h2>' + pinned.map(row).join('') : '') +
      '<h2 class="mbar"><span>NOTES</span><span class="n">' + rest.length + '</span></h2>' +
      (rest.length ? rest.map(row).join('') : '<p class="empty">' + (q ? 'NO MATCHES' + (noteFilter !== 'all' ? ' IN ' + esc(noteFilter.toUpperCase()) : '') : pinned.length ? 'No other notes.' : noteFilter !== 'all' ? 'No ' + esc(noteFilter) + ' notes yet.' : 'No notes yet. Tap + New note to write one.') + '</p>');
    if (q && noteFilter !== 'all') {   // matches in other categories
      var elsewhere = notes.filter(function (n) { return (n.title || n.body) && n.cat !== noteFilter && (n.title + ' ' + n.body + ' ' + (n.cat || '')).toLowerCase().indexOf(q) >= 0; }).length;
      if (elsewhere) $('notes').innerHTML += '<div class="actions"><button class="btn" type="button" data-nall="1">' + elsewhere + ' more in other categories · search all</button></div>';
    }
    $('q').placeholder = noteFilter === 'all' ? 'search notes' : 'search ' + noteFilter + ' notes';
  }
  function renderNoteChips() {
    var count = function (c) { return notes.filter(function (n) { return (n.title || n.body) && (c === 'all' || n.cat === c); }).length; };
    $('ntchips').innerHTML = [['all', 'All']].concat(noteCats.map(function (c) { return [c, c]; })).map(function (c) {
      return '<button class="chip" type="button" data-ncat="' + esc(c[0]) + '" aria-pressed="' + (noteFilter === c[0]) + '">' + esc(c[1]) + '<span class="n">' + count(c[0]) + '</span></button>';
    }).join('') + '<button class="chip" type="button" data-ncatedit="1" aria-label="Add or remove categories">+</button>';
  }
  function addNoteCat(name) {
    name = String(name || '').trim().slice(0, 20);
    if (!name) return null;
    var hit = noteCats.filter(function (c) { return c.toLowerCase() === name.toLowerCase(); })[0];
    if (hit) return hit;
    noteCats.push(name); persist(); return name;
  }
  function catSheet() {
    openSheet('<h2>Note categories</h2><div class="f"><input id="nc-new" placeholder="New category, e.g. Kids" maxlength="20"></div>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="nc-add">Add</button></div>' +
      '<div class="catlist">' + noteCats.map(function (c) {
        return '<div><span>' + esc(c) + '</span><button class="btn" type="button" data-ncdel="' + esc(c) + '">Remove</button></div>';
      }).join('') + '</div><p class="small">Removing a category keeps its notes; they just show under All.</p>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
  }
  function catPickHTML(sel) {
    return '<div class="catpick" id="catpick">' + [''].concat(noteCats).map(function (c) {
      return '<button class="chip" type="button" data-pickcat="' + esc(c) + '" aria-pressed="' + ((sel || '') === c) + '">' + (c ? esc(c) : 'None') + '</button>';
    }).join('') + '<button class="chip" type="button" data-pickcat-new="1">+ New</button></div>' +
      '<div class="f" id="catnewrow" hidden><input id="cat-new" placeholder="New category name" maxlength="20"></div>';
  }
  function pickedCat() {
    var v = $('cat-new') && !$('catnewrow').hidden ? $('cat-new').value.trim() : '';
    if (v) return addNoteCat(v);
    var b = $('catpick') && $('catpick').querySelector('[aria-pressed="true"]');
    return b ? b.getAttribute('data-pickcat') : '';
  }
  // ---- save an email to Notes: choose the title and category first ----
  var pendingMailNote = null;
  function mailToNoteSheet(m) {
    pendingMailNote = m;
    openSheet('<h2>Save to Notes</h2><div class="f"><label class="small" for="mn-title">Title</label><input id="mn-title" value="' + esc(m.subject || '') + '"></div>' +
      '<span class="small">CATEGORY</span>' + catPickHTML(noteFilter !== 'all' ? noteFilter : '') +
      '<div class="actions"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary grow" type="button" data-act="mn-save">Save note</button></div>');
  }
  function saveMailNote() {
    var m = pendingMailNote; if (!m) return;
    var title = $('mn-title').value.trim() || m.subject || 'Email', cat = pickedCat();
    pendingMailNote = null; closeSheet(); flashToast('Saving…');
    (m.text ? Promise.resolve(m) : fetchMail(m.id)).then(function (full) { return full; }, function () { return m; }).then(function (full) {
      var nowIso = new Date().toISOString();
      notes.push({ id: 'n' + uid(), title: title, body: mailNoteText(full), cat: cat || '', pinned: false, created: nowIso, updated: nowIso });
      persist(); if (tab === 'notes') renderNotes(); flashToast('Saved to Notes' + (cat ? ' · ' + cat : ''));
    });
  }
  // ---- long-press an email: quick actions ----
  function mailActions(id) {
    var m = (MAIL.list || []).concat(mailPins, BMAIL.list || []).filter(function (x) { return x.id === id; })[0]; if (!m) return;
    var pinned = mailPins.some(function (x) { return x.id === id; });
    openSheet('<h2 style="text-transform:none;letter-spacing:0">' + esc(m.subject) + '</h2><p class="small">' + esc(m.from) + '</p>' +
      '<div class="actions" style="flex-direction:column;align-items:stretch">' +
      '<button class="btn primary" type="button" data-mact="note" data-id="' + esc(id) + '">📝 Save to Notes</button>' +
      '<button class="btn" type="button" data-mact="pin" data-id="' + esc(id) + '">' + (pinned ? 'Unpin' : '📌 Pin') + '</button>' +
      '<a class="btn" href="https://mail.google.com/mail/u/0/#all/' + esc(m.threadId || m.id) + '" target="_blank" rel="noopener noreferrer">Open in Gmail</a>' +
      '<button class="btn" type="button" data-act="close">Cancel</button></div>');
  }
  var lp = null, lpJust = false;
  function lpStart(e) {
    var el = e.target.closest('[data-mid],[data-bmid]'); if (!el) return;
    var id = el.getAttribute('data-mid') || el.getAttribute('data-bmid');
    lp = { x: e.clientX, y: e.clientY, t: setTimeout(function () {
      lp = null; lpJust = true; mJust = true; setTimeout(function () { lpJust = false; mJust = false; }, 450);
      if (navigator.vibrate) navigator.vibrate(10);
      mailActions(id);
    }, 550) };
  }
  function lpMove(e) { if (lp && (Math.abs(e.clientX - lp.x) > 8 || Math.abs(e.clientY - lp.y) > 8)) { clearTimeout(lp.t); lp = null; } }
  function lpEnd() { if (lp) { clearTimeout(lp.t); lp = null; } }
  ['mail', 'brief'].forEach(function (id) {
    $(id).addEventListener('pointerdown', lpStart);
    $(id).addEventListener('pointermove', lpMove);
    $(id).addEventListener('pointerup', lpEnd);
    $(id).addEventListener('pointercancel', lpEnd);
    $(id).addEventListener('contextmenu', function (e) { if (e.target.closest('[data-mid],[data-bmid]')) e.preventDefault(); });
  });
  $('ntchips').addEventListener('click', function (e) {
    if (e.target.closest('[data-ncatedit]')) { catSheet(); return; }
    var b = e.target.closest('[data-ncat]'); if (!b) return;
    noteFilter = b.getAttribute('data-ncat'); renderNotes(); SC().scrollTop = 0;
  });
  $('sheet').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pickcat]');
    if (b) { $('catpick').querySelectorAll('[data-pickcat]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); $('catnewrow').hidden = true; return; }
    if (e.target.closest('[data-pickcat-new]')) { $('catpick').querySelectorAll('[data-pickcat]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); $('catnewrow').hidden = false; $('cat-new').focus(); return; }
    b = e.target.closest('[data-ncdel]');
    if (b) {
      var c = b.getAttribute('data-ncdel');
      noteCats = noteCats.filter(function (x) { return x !== c; });
      notes.forEach(function (n) { if (n.cat === c) n.cat = ''; });
      if (noteFilter === c) noteFilter = 'all';
      persist(); catSheet(); if (tab === 'notes') renderNotes(); return;
    }
    b = e.target.closest('[data-restore]');
    if (b) {
      var pick = restoreList[Number(b.getAttribute('data-restore'))]; if (!pick) return;
      var full = b.getAttribute('data-full') === '1';
      if (full && !window.confirm('Replace everything (calendar, notes, pinned mail, watchlist) with this copy? Your current data is saved to this list first, so you can undo.')) return;
      persist.keep = true; persist.allowWipe = true; persist();   // current copy always goes into the history first
      saving.then(function () {
        closeSheet();
        if (full) { enterApp(pick.data); persist.allowWipe = true; persist(); flashToast('Restored'); return; }
        // add back: calendar entries and bills from the copy that you don't have now; everything else stays as it is
        var d = pick.data, have = {}, haveR = {}, addI = 0, addR = 0;
        items.forEach(function (i) { have[i.id] = 1; }); rules.forEach(function (r) { haveR[r.id] = 1; });
        (d.items || []).forEach(function (i) { if (i && i.id && !have[i.id]) { items.push(i); addI++; } });
        (d.rules || []).forEach(function (r) { if (r && r.id && !haveR[r.id]) { rules.push(r); addR++; } });
        Object.keys(d.paid || {}).forEach(function (k) { if (!(k in paid)) paid[k] = d.paid[k]; });
        persist(); refresh(); if (tab === 'brief') renderBrief();
        flashToast(addI || addR ? 'Added back ' + addI + ' entries' + (addR ? ' and ' + addR + ' bills/recurring' : '') : 'Nothing missing: you already have everything in that copy');
      });
      return;
    }
    b = e.target.closest('[data-mact]');
    if (b) {
      var mid = b.getAttribute('data-id'), m = (MAIL.list || []).concat(mailPins, BMAIL.list || []).filter(function (x) { return x.id === mid; })[0];
      if (b.getAttribute('data-mact') === 'note' && m) mailToNoteSheet(mailCache[mid] || m);
      else if (b.getAttribute('data-mact') === 'pin') { closeSheet(); toggleMailPin(mid); }
    }
  });
  $('sheet').addEventListener('change', function (e) {
    if (e.target.id !== 'n-cat' || !noteEd) return;
    var v = e.target.value;
    if (v === '__new') {
      var name = addNoteCat(window.prompt('New category name') || '');
      if (!name) { e.target.value = noteEd.cat || ''; return; }
      v = name;
      e.target.innerHTML = noteCatOptions(v);
    }
    noteEd.cat = v; noteChanged();
  });
  function noteCatOptions(sel) {
    return [''].concat(noteCats).map(function (c) { return '<option value="' + esc(c) + '"' + ((sel || '') === c ? ' selected' : '') + '>' + (c ? esc(c) : 'No category') + '</option>'; }).join('') + '<option value="__new">+ New category…</option>';
  }
  var noteEd = null, noteTimer = null, noteDelArmed = false;
  function openNote(id) {
    var now = new Date().toISOString();
    noteEd = notes.filter(function (n) { return n.id === id; })[0] || { id: 'n' + uid(), title: '', body: '', cat: noteFilter !== 'all' ? noteFilter : '', pinned: false, created: now, updated: now };
    noteDelArmed = false;
    openSheet('<div class="ned f"><input id="n-title" placeholder="Title (optional)" value="' + esc(noteEd.title) + '">' +
      '<select id="n-cat" aria-label="Category">' + noteCatOptions(noteEd.cat) + '</select>' +
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
    if (!id) setTimeout(function () { if ($('n-body')) $('n-body').focus(); }, 60);
  }
  function noteChanged() {
    if (!noteEd) return;
    noteEd.title = $('n-title').value; noteEd.body = $('n-body').value; noteEd.updated = new Date().toISOString();
    if ((noteEd.title || noteEd.body) && notes.indexOf(noteEd) < 0) notes.push(noteEd);
    clearTimeout(noteTimer); noteTimer = setTimeout(persist, 600);
  }
  function noteMsg(html) { var m = $('n-msg'); if (m) { m.innerHTML = html; m.hidden = !html; } }
  // swipe left/right inside an open email
  var msx = null;
  $('sheet').addEventListener('touchstart', function (e) { msx = $('sheet').querySelector('.mbody') && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null; }, { passive: true });
  $('sheet').addEventListener('touchend', function (e) {
    if (!msx) return;
    var t = e.changedTouches[0], dx = t.clientX - msx.x, dy = t.clientY - msx.y; msx = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) mailStep(dx < 0 ? 1 : -1);
  }, { passive: true });
  $('sheet').addEventListener('change', function (e) {
    if (e.target.id !== 'impfile' || !e.target.files || !e.target.files[0]) return;
    var r = new FileReader();
    r.onload = function () { restoreText(String(r.result)); };
    r.readAsText(e.target.files[0]);
  });
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

  // =====================================================================
  // Mail (Gmail, read-only). Emails are fetched to the phone and shown; they are not stored.
  // =====================================================================
  var MAIL = { list: null, filter: 'all', q: '', loading: false, err: '', next: '', more: false };
  function isUnread(m) { return m.unread && !seenSet[m.id]; }
  // the Brief keeps its own list: inbox, past 7 days
  var BMAIL = { list: null, loading: false, at: 0 };
  function loadBriefMail() {
    if (!Gmail.token() || BMAIL.loading) return Promise.resolve();
    BMAIL.loading = true;
    return Gmail.page('in:inbox newer_than:7d', 30, '').then(function (r) { BMAIL.list = r.list; BMAIL.at = Date.now(); }, function () {})
      .then(function () { BMAIL.loading = false; if (tab === 'brief') renderBrief(); });
  }
  function markSeen(id) { if (!seenSet[id]) { seenSet[id] = 1; mailSeen.push(id); persist(); } }
  var MAIL_CHIPS = [['all', 'All mail'], ['inbox', 'Inbox'], ['unread', 'Unread'], ['banks', '🏦 Banks & bills']];
  var BANK_Q = '(from:dbs.com OR from:posb.com.sg OR from:uob.com.sg OR from:citibank.com OR from:citi.com OR from:hsbc.com.sg OR from:trustbank.sg OR from:ocbc.com OR from:sc.com OR from:spgroup.com.sg OR subject:(statement OR bill OR "payment due" OR transaction))';
  function mailQuery() {
    var base = { all: '', inbox: 'in:inbox', unread: 'is:unread', banks: BANK_Q, primary: 'in:inbox category:primary' }[MAIL.filter];
    return (base + (MAIL.q ? ' ' + MAIL.q : '')).trim();
  }
  function mailWhen(ms) {
    var d = new Date(ms), iso = GC.iso(d), hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return iso === todayISO ? hm : (function () { var l = dLabel(iso); return l.day + ' ' + l.mon; })();
  }
  function loadMail() {
    if (!Gmail.token()) { MAIL.err = 'signin'; renderMail(); if (tab === 'brief') renderBrief(); return Promise.resolve(); }
    MAIL.loading = true; MAIL.err = ''; if (tab === 'mail') renderMail();
    return Gmail.page(mailQuery(), 40, '').then(function (r) { MAIL.list = r.list; MAIL.next = r.next; }, function (e) { MAIL.err = e.message || String(e); })
      .then(function () { MAIL.loading = false; if (tab === 'mail') renderMail(); if (tab === 'brief') renderBrief(); });
  }
  function loadOlder() {   // next 40, all the way back
    if (!MAIL.next || MAIL.more || !Gmail.token()) return;
    MAIL.more = true; if (tab === 'mail') renderMail();
    Gmail.page(mailQuery(), 40, MAIL.next).then(function (r) {
      var seen = {}; (MAIL.list || []).forEach(function (m) { seen[m.id] = 1; });
      MAIL.list = (MAIL.list || []).concat(r.list.filter(function (m) { return !seen[m.id]; }));
      MAIL.next = r.next;
    }, function (e) { MAIL.err = e.message || String(e); }).then(function () { MAIL.more = false; if (tab === 'mail') renderMail(); });
  }
  function signinCard(why) {
    return '<div class="mcard"><b>Connect Gmail</b><p class="small">' + esc(why) + ' You sign in on Google\'s own page; access is read-only and your emails go straight between this iPhone and Google. Google keeps you signed in for about an hour at a time.</p>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="gmail-go">Sign in with Google</button></div></div>';
  }
  function renderMailChips() {
    $('mchips').innerHTML = MAIL_CHIPS.map(function (c) { return '<button class="chip" type="button" data-m="' + c[0] + '" aria-pressed="' + (MAIL.filter === c[0]) + '">' + esc(c[1]) + '</button>'; }).join('');
  }
  function renderMail() {
    try { renderMail2(); } catch (e) { $('mail').innerHTML = '<p class="err" style="margin-top:1rem">Mail could not be shown: ' + esc(e.message || e) + '</p><p class="small">Gmail: ' + esc(Gmail.status()) + '</p>'; }
  }
  function renderMail2() {
    if (!Gmail.token()) { $('mail').innerHTML = signinCard('Read your Gmail here (and your Hotmail, if you forward it to Gmail).'); return; }
    var h = (MAIL.loading || MAIL.err) ? '<div class="nmeta">' + (MAIL.loading ? 'Loading…' : '<span class="err">' + esc(MAIL.err) + '</span>') + '</div>' : '';
    var pinned = {}; mailPins.forEach(function (p) { pinned[p.id] = 1; });
    var row = function (m) {
      return '<div class="mwrap"><div class="swipe-pin" aria-hidden="true">' + (pinned[m.id] ? 'UNPIN' : '📌 PIN') + '</div>' +
        '<button type="button" class="mrow' + (isUnread(m) ? '' : ' read') + '" data-mid="' + esc(m.id) + '"><span class="mt2">' + esc(mailWhen(m.date)) + '</span>' +
        '<span><span class="mf' + (isUnread(m) ? ' unread' : '') + '">' + (pinned[m.id] ? '📌 ' : '') + esc(m.from) + '</span><span class="ms">' + esc(m.subject) + '</span>' +
        (m.snippet ? '<span class="mp">' + esc(m.snippet) + '</span>' : '') + '</span></button></div>';
    };
    if (mailPins.length) h += '<h2 class="mbar"><span>📌 PINNED</span><span class="n">' + mailPins.length + '</span></h2>' +
      mailPins.slice().sort(function (a, b) { return b.date - a.date; }).map(row).join('');
    var lastDay = '';
    (MAIL.list || []).forEach(function (m) {
      var day = GC.iso(new Date(m.date));
      if (day !== lastDay) { var l = dLabel(day); h += '<h2 class="mbar"><span>' + (day === todayISO ? 'TODAY · ' : '') + l.dow + ' ' + l.day + ' ' + l.mon + '</span></h2>'; lastDay = day; }
      h += row(m);
    });
    if (MAIL.list && !MAIL.list.length) h += '<p class="empty">No emails here.</p>';
    if (MAIL.list && MAIL.list.length) h += MAIL.next
      ? '<div class="actions" style="justify-content:center;margin:0.8rem 0"><button class="btn" type="button" data-older="1"' + (MAIL.more ? ' disabled' : '') + '>' + (MAIL.more ? 'Loading older…' : 'Load older') + '</button></div>'
      : '<p class="empty">End of your mail.</p>';
    var y = SC().scrollTop;
    $('mail').innerHTML = h;
    SC().scrollTop = y;
  }
  // ---- quick summary: the most informative sentences plus key facts, worked out on the phone (no AI, nothing sent) ----
  var SUM_NOISE = /(unsubscribe|view (?:this|it) in (?:your )?browser|privacy (?:policy|notice)|all rights reserved|©|copyright|do not reply|no-?reply|this (?:e-?mail|message) (?:was|is) (?:sent|intended)|manage (?:your )?(?:preferences|subscription)|terms (?:and|&) conditions|click here|download (?:the|our) app|follow us|sent from my|confidential)/i;
  var SUM_GREET = /^(dear|hi|hello|hey|good (?:morning|afternoon|evening)|greetings|thank you for|thanks for|we hope|hope you|regards|best|cheers|warm regards|kind regards|sincerely|yours)\b/i;
  var SUM_USEFUL = /(due|deadline|by \d|confirm|confirmed|please|required|action|reminder|booked|booking|reservation|cancel|approved|declined|payment|paid|amount|invoice|statement|delivered|delivery|shipped|ready|reference|meeting|call|schedule|reschedul|interview|offer|update|change|expire|renew|password|verify|ticket|flight|check-in|order)/i;
  function mailSummary(m) {
    var raw = (m.text || m.snippet || '');
    // drop quoted replies and anything after a signature line
    var cut = raw.search(/\n\s*(?:on .{5,80} wrote:|-----\s*original message|from:\s.+\nsent:|--\s*\n|sent from my )/i);
    if (cut > 0) raw = raw.slice(0, cut);
    var lines = raw.split(/\n+/).map(function (l) { return l.replace(/^[>\s]+/, '').trim(); }).filter(function (l) { return l && !SUM_NOISE.test(l) && !(SUM_GREET.test(l) && l.length < 45); });
    var sents = [];
    lines.join(' ').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).forEach(function (x, i) {
      x = x.trim(); if (x.length < 25 || x.length > 260 || SUM_GREET.test(x)) return;
      var sc = (SUM_USEFUL.test(x) ? 3 : 0) + (/(SGD|S\$|USD|\$)\s?[\d,]+/.test(x) ? 2 : 0) + (/\b\d{1,2}\s?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}\/\d{1,2}|\d{1,2}(?::|\.)\d{2}\s?(?:am|pm)?/i.test(x) ? 2 : 0) + Math.max(0, 2 - i * 0.3);
      sents.push({ t: x, s: sc, i: i });
    });
    var top = sents.slice().sort(function (a, b) { return b.s - a.s; }).slice(0, 2).sort(function (a, b) { return a.i - b.i; })
      .map(function (x) { return x.t.length > 170 ? x.t.slice(0, 167).replace(/\s+\S*$/, '') + '…' : x.t; });
    if (!top.length && m.snippet) top = [m.snippet.slice(0, 170)];
    // key facts
    var body = raw.replace(/\s+/g, ' '), facts = [], seen = {};
    var add = function (f) { var k = f.toLowerCase(); if (!seen[k] && facts.length < 5) { seen[k] = 1; facts.push(f); } };
    (body.match(/(?:SGD|S\$|USD|US\$|EUR|GBP|JPY|AUD|MYR|HKD)\s?[\d,]+(?:\.\d{2})?|\$\s?[\d,]+\.\d{2}/gi) || []).slice(0, 2).forEach(function (a) { add(a.replace(/\s+/, ' ')); });
    (body.match(/\b\d{1,2}\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:\s\d{4})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s\d{1,2}(?:,?\s\d{4})?\b/gi) || []).slice(0, 2).forEach(add);
    (body.match(/\b\d{1,2}(?::|\.)\d{2}\s?(?:am|pm)\b|\b\d{1,2}\s?(?:am|pm)\b/gi) || []).slice(0, 1).forEach(add);
    var ref = /\b(?:ref(?:erence)?|booking|order|confirmation|reservation|ticket|case|invoice)\s*(?:no\.?|number|#|code|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})\b/i.exec(body);
    if (ref && /\d/.test(ref[1])) add('Ref ' + ref[1]);
    return { lines: top, facts: facts };
  }
  var openMailMsg = null, mailNavId = null;
  function mailOrder() {   // same order as on screen: pinned first, then the list
    var seen = {}, out = [];
    (tab === 'brief' ? (BMAIL.list || []) : mailPins.slice().sort(function (a, b) { return b.date - a.date; }).concat(MAIL.list || [])).forEach(function (m) { if (!seen[m.id]) { seen[m.id] = 1; out.push(m.id); } });
    return out;
  }
  function mailStep(dir) {   // dir +1 = older (next), -1 = newer (previous)
    var order = mailOrder(), i = order.indexOf(mailNavId);
    if (i < 0) return;
    var j = i + dir;
    if (j >= 0 && j < order.length) { openMail(order[j]); return; }
    if (dir > 0 && MAIL.next) { openSheet('<h2>Mail</h2><p>Loading older…</p>'); loadOlder(); var tries = 0, wait = setInterval(function () { tries++; var o2 = mailOrder(); if (o2.length > order.length || tries > 40) { clearInterval(wait); if (o2[j]) openMail(o2[j]); else closeSheet(); } }, 250); }
  }
  // ---- email text: short links, no image placeholders or invisible spacers ----
  function mailBodyHTML(text) {
    var t = String(text || '').slice(0, 15000)
      .replace(/[\u034F\u00AD\u200B-\u200F\u2028\u2029\u202F\u2060-\u2064\uFEFF]/g, '')   // invisible spacers newsletters use
      .replace(/\[(?:image|cid|img)[^\]]*\]/gi, '')                                      // image placeholders
      .replace(/<(https?:\/\/[^>\s]+)>/g, ' $1 ')
      .replace(/\[\s*(https?:\/\/[^\]\s]+)\s*\]/g, ' $1 ')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    var out = '', last = 0, re = /https?:\/\/[^\s<>"')\]]+/g, mm;
    while ((mm = re.exec(t))) {
      out += esc(t.slice(last, mm.index));
      var url = mm[0].replace(/[.,;:!?]+$/, ''), host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { host = 'link'; }
      out += '<a class="mlink" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">🔗 ' + esc(host) + '</a>';
      last = mm.index + url.length;
    }
    return out + esc(t.slice(last));
  }
  // plain text for Notes: same clean-up, web addresses shortened to their site name
  function mailNoteText(m) {
    var t = String(m.text || m.snippet || '').slice(0, 15000)
      .replace(/[͏­​-‏\u2028\u2029 ⁠-⁤﻿]/g, '')
      .replace(/\[(?:image|cid|img)[^\]]*\]/gi, '')
      .replace(/<(https?:\/\/[^>\s]+)>/g, ' $1 ')
      .replace(/\[\s*(https?:\/\/[^\]\s]+)\s*\]/g, ' $1 ')
      .replace(/https?:\/\/[^\s<>"')\]]+/g, function (u) {
        u = u.replace(/[.,;:!?]+$/, '');
        var h = (/^https?:\/\/([^\/?#:]+)/i.exec(u) || [])[1] || 'link';
        return '🔗 ' + h.replace(/^www\./i, '');
      })
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    return 'From: ' + m.from + '\n\n' + t.slice(0, 6000) + '\n\nOriginal in Gmail: https://mail.google.com/mail/u/0/#all/' + (m.threadId || m.id);
  }
  var mailCache = {}, mailCacheOrder = [];
  function cacheMail(m) { if (!mailCache[m.id]) { mailCacheOrder.push(m.id); if (mailCacheOrder.length > 30) delete mailCache[mailCacheOrder.shift()]; } mailCache[m.id] = m; }
  function fetchMail(id) { return mailCache[id] ? Promise.resolve(mailCache[id]) : Gmail.full(id).then(function (m) { cacheMail(m); return m; }); }
  function mailSheet(m, full, order, pos) {
    var d = new Date(m.date), l = dLabel(GC.iso(d));
    var sum = '';
    if (full) {
      var sm = mailSummary(m), line = sm.lines[0] || '';
      if (line.length > 120) line = line.slice(0, 117).replace(/\s+\S*$/, '') + '…';
      if (line || sm.facts.length) sum = '<div class="msum">' + (line ? '<p>' + esc(line) + '</p>' : '') + (sm.facts.length ? '<p class="mfacts">' + sm.facts.slice(0, 3).map(esc).join(' · ') + '</p>' : '') + '</div>';
    }
    openSheet('<div class="mtitle">' + esc(m.subject) + '</div>' +
      '<p class="mfrom">' + esc(m.from) + ' · ' + l.dow + ' ' + l.day + ' ' + l.mon + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + '</p>' + sum +
      '<div class="mbody">' + (full ? mailBodyHTML(m.text || m.snippet) : esc(m.snippet || '') + '<p class="small">Loading the full email…</p>') + '</div>' +
      '<div class="mnav"><button class="btn" type="button" data-act="m-prev"' + (pos <= 0 ? ' disabled' : '') + '>‹ Newer</button>' +
        '<span class="small">' + (pos >= 0 ? (pos + 1) + ' / ' + order.length + (MAIL.next ? '+' : '') : '') + '</span>' +
        '<button class="btn" type="button" data-act="m-next"' + (pos < 0 || (pos >= order.length - 1 && !MAIL.next) ? ' disabled' : '') + '>Older ›</button></div>' +
      '<div class="actions"><a class="btn grow" href="https://mail.google.com/mail/u/0/#all/' + esc(m.threadId || m.id) + '" target="_blank" rel="noopener noreferrer">Open in Gmail</a>' +
      '<button class="btn" type="button" data-act="m-note">Save to Notes</button><button class="btn" type="button" data-act="m-events">Make events</button>' +
      '<button class="btn primary" type="button" data-act="close">Done</button></div>');
    $('sheet').classList.add('mailsheet');
  }
  function openMail(id) {
    mailNavId = id; markSeen(id);
    if (tab === 'mail') renderMail(); else if (tab === 'brief') renderBrief();
    var order = mailOrder(), pos = order.indexOf(id);
    var meta = (MAIL.list || []).concat(mailPins, BMAIL.list || []).filter(function (x) { return x.id === id; })[0];
    if (mailCache[id]) { openMailMsg = mailCache[id]; mailSheet(mailCache[id], true, order, pos); }
    else if (meta) { openMailMsg = meta; mailSheet(meta, false, order, pos); }   // header and preview straight away
    else openSheet('<h2>Mail</h2><p>Loading…</p>');
    fetchMail(id).then(function (m) {
      if (mailNavId !== id) return;   // already swiped on
      openMailMsg = m;
      var sc = $('sheet').scrollTop;
      mailSheet(m, true, mailOrder(), mailOrder().indexOf(id));
      $('sheet').scrollTop = sc;
      [order[pos + 1], order[pos - 1]].forEach(function (nid) { if (nid && !mailCache[nid]) fetchMail(nid).catch(function () {}); });   // ready for the next swipe
    }, function (e) { if (mailNavId === id) openSheet('<h2>Mail</h2><div class="err">' + esc(e.message || e) + '</div><div class="actions"><button class="btn primary" type="button" data-act="gmail-go">Sign in again</button></div>'); });
  }


  function setTab(t) {
    if (tab === 'news' && t !== 'news' && NEWS) { lastSeen = NEWS.items.length ? NEWS.items[0].t : lastSeen; prefs('newsSeen', lastSeen); }
    if (tab === 'fan' && t !== 'fan' && FAN) { fanSeen = FAN.items.length ? FAN.items[0].t : fanSeen; prefs('fanSeen', fanSeen); }
    tab = t;
    var cal = t === 'cal', news = t === 'news', fan = t === 'fan', tl = t === 'tools', br = t === 'brief', nt = t === 'notes', ml = t === 'mail', wt = t === 'watch';
    $('tab-mail').setAttribute('aria-pressed', ml); $('mail').hidden = !ml; $('mchips').hidden = !ml;
    $('tab-notes').setAttribute('aria-pressed', nt); $('notes').hidden = !nt; $('ntchips').hidden = !nt;
    $('tab-watch').setAttribute('aria-pressed', wt); $('watch').hidden = !wt; $('wchips').hidden = !wt; $('wren').hidden = !wt;
    $('tab-brief').setAttribute('aria-pressed', br); $('brief').hidden = !br;
    $('tab-cal').setAttribute('aria-pressed', cal); $('tab-news').setAttribute('aria-pressed', news); $('tab-fan').setAttribute('aria-pressed', fan); $('tab-tools').setAttribute('aria-pressed', tl);
    $('list').hidden = !cal; $('news').hidden = !news; $('fan').hidden = !fan; $('tools').hidden = !tl;
    $('chips').hidden = !cal; $('nchips').hidden = !news; $('fchips').hidden = !fan; $('tchips').hidden = !tl; $('openx').hidden = cal || tl || br || nt || ml || wt; $('cmdrow').hidden = tl || br || wt;
    $('brandtxt').hidden = !br; $('jump').hidden = true;   // TODAY button removed
    $('add').hidden = !cal;                                   // + ADD only on the Calendar
    $('r1').hidden = br;                                      // the Brief has no top row; its menu sits by the greeting
    $('q').value = ''; $('qclear').hidden = true; $('q').placeholder = 'search';
    if (news) { renderNewsChips(); renderNews(); loadNews(); SC().scrollTop = 0; }
    else if (fan) { renderFantasyChips(); renderFantasy(); loadFantasy(); SC().scrollTop = 0; }
    else if (tl) { $('tchips').innerHTML = Tools.chips(); Tools.draw(); SC().scrollTop = 0; }
    else if (br) { renderBrief(); loadNews(); SC().scrollTop = 0; }
    else if (nt) { renderNotes(); SC().scrollTop = 0; }
    else if (wt) { renderWatchChips(); renderWatch(); loadMarkets(); SC().scrollTop = 0; }
    else if (ml) {
      if (!Gmail.token() && Gmail.canRenew()) { Gmail.renew(); return; }   // quick hop to Google and back, no typing
      renderMailChips(); renderMail(); if (!MAIL.list) loadMail();
      SC().scrollTop = 0;
    }
    else { showPast = false; render(); jumpToday(false); }
    syncHead();
  }
  $('tab-brief').addEventListener('click', function () { setTab('brief'); });
  $('tab-notes').addEventListener('click', function () { setTab('notes'); });
  $('tab-watch').addEventListener('click', function () { setTab('watch'); });
  $('tab-mail').addEventListener('click', function () { setTab('mail'); });
  // older mail loads by itself when you scroll near the bottom
  SC().addEventListener('scroll', function () { if (tab === 'mail' && MAIL.next && !MAIL.more && SC().scrollTop + SC().clientHeight > SC().scrollHeight - 600) loadOlder(); }, { passive: true });
  var msw = null, mJust = false;
  function mSet(el, x, anim) { el.style.transition = anim ? 'transform 180ms ease' : 'none'; el.style.transform = x ? 'translateX(' + x + 'px)' : ''; }
  function toggleMailPin(id) {
    var i = mailPins.findIndex(function (p) { return p.id === id; });
    if (i >= 0) { mailPins.splice(i, 1); flashToast('Unpinned'); }
    else {
      var m = (MAIL.list || []).filter(function (x) { return x.id === id; })[0]; if (!m) return;
      mailPins.push({ id: m.id, threadId: m.threadId, subject: m.subject, from: m.from, date: m.date, unread: false, snippet: '' });
      flashToast('Pinned');
    }
    persist(); renderMail();
  }
  $('mail').addEventListener('pointerdown', function (e) {
    var el = e.target.closest('.mrow'); if (!el || !el.parentNode.classList.contains('mwrap')) return;
    msw = { el: el, x0: e.clientX, y0: e.clientY, dx: 0, horiz: null };
  });
  $('mail').addEventListener('pointermove', function (e) {
    if (!msw) return;
    var dx = e.clientX - msw.x0, dy = e.clientY - msw.y0;
    if (msw.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) msw.horiz = dx > 0 && Math.abs(dx) > Math.abs(dy);
    if (!msw.horiz) return;
    msw.dx = dx; mSet(msw.el, Math.max(0, Math.min(msw.el.offsetWidth * 0.5, dx)), false);
    var pinEl = msw.el.parentNode.querySelector('.swipe-pin'); if (pinEl) pinEl.classList.toggle('ready', dx > msw.el.offsetWidth * 0.33);
  });
  function mEnd() {
    if (!msw) return;
    var s2 = msw; msw = null;
    if (!s2.horiz) return;
    mJust = true; setTimeout(function () { mJust = false; }, 350);
    mSet(s2.el, 0, true);
    if (s2.dx > s2.el.offsetWidth * 0.33) { var id = s2.el.getAttribute('data-mid'); setTimeout(function () { toggleMailPin(id); }, 190); }
  }
  $('mail').addEventListener('pointerup', mEnd);
  $('mail').addEventListener('pointercancel', mEnd);
  $('mail').addEventListener('click', function (e) { if (mJust) return; if (e.target.closest('[data-older]')) { loadOlder(); return; } var b = e.target.closest('[data-mid]'); if (b) openMail(b.getAttribute('data-mid')); var g = e.target.closest('[data-act="gmail-go"]'); if (g) Gmail.start(); });
  $('mchips').addEventListener('click', function (e) { var b = e.target.closest('[data-m]'); if (!b) return; MAIL.filter = b.getAttribute('data-m'); renderMailChips(); loadMail(); SC().scrollTop = 0; });
  function syncClear() { $('qclear').hidden = !$('q').value; }
  $('q').addEventListener('input', syncClear);
  $('qclear').addEventListener('click', function (e) {
    e.preventDefault();
    $('q').value = ''; syncClear();
    if (tab === 'mail') { if (MAIL.q) { MAIL.q = ''; loadMail(); } }
    else $('q').dispatchEvent(new Event('input'));
  });
  $('q').addEventListener('keydown', function (e) { if (tab === 'mail' && e.key === 'Enter') { MAIL.q = $('q').value.trim(); loadMail(); $('q').blur(); } });
  // short swipe shows DELETE; a long swipe (past 60% of the width) deletes straight away. Undo for 6 seconds.
  var nsw = null, nOpen = null, nJust = false, noteUndo = null;
  function nSet(el, x, anim) { el.style.transition = anim ? 'transform 180ms ease' : 'none'; el.style.transform = x ? 'translateX(' + x + 'px)' : ''; }
  function nClose() { if (nOpen) { nSet(nOpen, 0, true); nOpen = null; } }
  function deleteNote(id) {
    var n = notes.filter(function (x) { return x.id === id; })[0]; if (!n) return;
    notes = notes.filter(function (x) { return x.id !== id; }); persist(); renderNotes();
    noteUndo = n; lastDeleted = null;
    $('undo').hidden = false; $('toastMsg').textContent = 'Deleted note: ' + noteTitle(n); $('toast').hidden = false;
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
    nsw.dx = dx;
    var maxRight = nsw.base === 0 ? nsw.el.offsetWidth * 0.5 : 0;
    nSet(nsw.el, Math.max(-nsw.el.offsetWidth, Math.min(maxRight, nsw.base + dx)), false);
    var pinEl = nsw.el.parentNode.querySelector('.swipe-pin');
    if (pinEl) pinEl.classList.toggle('ready', nsw.base + dx > nsw.el.offsetWidth * 0.33);
  });
  function nEnd() {
    if (!nsw) return;
    var s2 = nsw; nsw = null;
    if (!s2.horiz) return;
    nJust = true; setTimeout(function () { nJust = false; }, 350);
    var w = s2.el.offsetWidth, act = s2.el.parentNode.querySelector('.swipe-del').offsetWidth, pos = s2.base + s2.dx;
    if (pos > 0.33 * w) {   // swipe right: pin / unpin
      var pid = s2.el.getAttribute('data-note'), pn = notes.filter(function (x) { return x.id === pid; })[0];
      nSet(s2.el, 0, true); nOpen = null;
      if (pn) { pn.pinned = !pn.pinned; persist(); setTimeout(function () { renderNotes(); flashToast(pn.pinned ? 'Pinned' : 'Unpinned'); }, 190); }
      return;
    }
    if (pos > 0) { nSet(s2.el, 0, true); return; }
    if (pos < -0.6 * w) { nSet(s2.el, -w, true); setTimeout(function () { deleteNote(s2.el.getAttribute('data-note')); }, 170); nOpen = null; }
    else if (pos < -act / 2) { nSet(s2.el, -act, true); nOpen = s2.el; }
    else { nSet(s2.el, 0, true); if (nOpen === s2.el) nOpen = null; }
  }
  $('notes').addEventListener('pointerup', nEnd);
  $('notes').addEventListener('pointercancel', nEnd);
  $('notes').addEventListener('click', function (e) {
    if (e.target.closest('[data-newnote]')) { openNote(null); return; }
    if (e.target.closest('[data-nall]')) { noteFilter = 'all'; renderNotes(); return; }
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
  Tools.init($('tools'), function () { return MKT; }, function (t) { calcTape = t; clearTimeout(tapeTimer); tapeTimer = setTimeout(persist, 800); }, showSaveToNote);
  var pendingSum = null;
  function showSaveToNote(sum) {
    pendingSum = sum;
    openSheet('<h2>Save to Notes</h2><div class="f"><label>Name<input id="sv-name" value="' + esc(sum.title) + '"></label>' +
      '<label>Description (optional)<textarea id="sv-desc" style="min-height:4.5rem" placeholder="e.g. dealer quote for the new car"></textarea></label></div>' +
      '<div class="src">' + esc(sum.body) + '</div>' +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button><button class="btn primary" type="button" data-act="sv-save">Save</button></div>');
  }
  function flashToast(msg) {
    $('undo').hidden = true; $('toastMsg').textContent = msg; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $('toast').hidden = true; $('undo').hidden = false; }, 2500);
  }
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
    prefs('newsHidden2', Object.keys(newsHidden).join(','));
    renderNewsChips(); renderNews(); SC().scrollTop = 0;
  });
  setInterval(function () { if (tab === 'news') loadNews(); if (tab === 'fan') loadFantasy(); }, 2 * 60000);

  // ---- Fantasy: RotoWire player alerts, Yahoo/ESPN/PFF headlines, Sleeper most-added ----
  var FAN = null, fanFilter = 'all', fanSeen = prefs('fanSeen') || '';
  // All = everything on; tap a category to switch it off. "Most added" is its own view, like ECON.
  var FAN_CHIPS = [['all', 'All'], ['alert', '🚨 Alerts'], ['news', '📰 Headlines'], ['NBA', '🏀 NBA'], ['NFL', '🏈 NFL'], ['trend', '📈 Most added']];
  var FAN_CATS = ['alert', 'news', 'NBA', 'NFL'];
  var fanHidden = {}, fanTrend = false;
  (prefs('fanHidden') || '').split(',').forEach(function (k) { if (k) fanHidden[k] = 1; });
  var ST_LABEL = { out: 'OUT', doubt: 'Q', in: 'IN' };
  function loadFantasy() {
    var u = mktURL(); if (!u || document.hidden) return Promise.resolve();
    return fetch(u.replace('/markets.json', '/fantasy.json'), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.items) { FAN = d; if (tab === 'fan') renderFantasy(); } }).catch(function () {});
  }
  function renderFantasyChips() {
    $('fchips').innerHTML = FAN_CHIPS.map(function (c) {
      var on = c[0] === 'trend' ? fanTrend : fanTrend ? false : c[0] === 'all' ? !Object.keys(fanHidden).length : !fanHidden[c[0]];
      var off = c[0] !== 'trend' && c[0] !== 'all' && !fanTrend && fanHidden[c[0]];
      return '<button class="chip' + (off ? ' off' : '') + '" type="button" data-f="' + c[0] + '" aria-pressed="' + on + '">' + esc(c[1]) + '</button>';
    }).join('');
  }
  function renderFantasy() {
    if (!FAN) { $('fan').innerHTML = '<p class="empty">Loading…</p>'; return; }
    var head = '<div class="nmeta">Updated ' + esc(FAN.updated.slice(11)) + ' Singapore · tap to open</div>';
    if (fanTrend) {
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
      if (fanHidden[x.sport]) return false;                              // sport switched off
      if (fanHidden[x.kind === 'alert' ? 'alert' : 'news']) return false;   // alerts or headlines switched off
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
    var k = b.getAttribute('data-f');
    if (k === 'trend') fanTrend = !fanTrend;
    else if (fanTrend) fanTrend = false;                                       // leaving Most added returns to your filter
    else if (k === 'all') { if (Object.keys(fanHidden).length) fanHidden = {}; else FAN_CATS.forEach(function (c) { fanHidden[c] = 1; }); }
    else if (fanHidden[k]) delete fanHidden[k]; else fanHidden[k] = 1;
    prefs('fanHidden', Object.keys(fanHidden).join(','));
    renderFantasyChips(); renderFantasy(); SC().scrollTop = 0;
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
              '<span class="t">' + (i.finance ? (i.kind === 'cb' ? '<span class="star">★</span> ' : '') + '<b>' + esc(i.ccy) + '</b> ' + esc(i.raw) + (i.check ? '<span class="pl"> (check)</span>' : '') : '<span class="tt">' + esc(i.title) + (i.age ? ' (' + i.age + ')' : '') + (i.recurring ? '<span class="pl"> ↻</span>' : '') + (i.est ? '<span class="pl"> (est.)</span>' : '') + (i.isDue ? '<span class="due">' + (i.paid ? 'PAID' : 'DUE') + '</span>' : '') + '</span>' + (i.place ? '<span class="pl2">@ ' + esc(i.place) + '</span>' : '')) +
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
  // true if the finger is on a scrollable box inside the page (e.g. ECON in the brief) that can still scroll up
  function innerCanScrollUp(el) {
    for (; el && el !== SC(); el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      var oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) return true;
    }
    return false;
  }
  SC().addEventListener('touchstart', function (e) {
    var ok = SC().scrollTop <= 0 && e.touches.length === 1 && !pull.busy && !innerCanScrollUp(e.target);
    pull.y0 = ok ? e.touches[0].clientY : null; pull.d = 0;
  }, { passive: true });
  SC().addEventListener('touchmove', function (e) {
    if (pull.y0 === null) return;
    var dy = e.touches[0].clientY - pull.y0;
    if (dy <= 0 || SC().scrollTop > 0) { if (pull.on) setPull(0); pull.on = false; return; }
    if ((tab === 'cal' && showPast) || tab === 'tools' || tab === 'notes') return;   // mail and insights refresh on pull
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
    (tab === 'news' ? loadNews() : tab === 'fan' ? loadFantasy() : tab === 'watch' ? (HIST = {}, loadMarkets()) : tab === 'mail' ? loadMail() : Promise.all([loadNews(), loadMarkets(), loadFinance(), (BMAIL.at = 0, loadBriefMail())])).then(function () { pull.busy = false; setPull(0, true); }, function () { pull.busy = false; setPull(0, true); });
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
  function openSheet(html) { $('sheet').classList.remove('mailsheet'); $('sheet').innerHTML = html; $('scrim').hidden = false; }
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
    openSheet('<h2>Add</h2><p>Type or paste anything: a message, an email, or your own rough notes.</p>' +
      '<textarea id="paste" placeholder="dinner w mum n dad sat 730 at jumbo&#10;&#10;23 Nov&#10;- Meet xxx&#10;- Submit xxx"></textarea>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button>' +
      '<button class="btn primary" type="button" data-act="parse">Read dates</button></div>');
    if (prefill) $('paste').value = prefill;
    setTimeout(function () { if ($('paste')) $('paste').focus(); }, 50);
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
  // ---- Gmail test: sign in and list the latest subjects ----
  function showGmail() {
    if (!Gmail.token()) {
      openSheet('<h2>Gmail (test)</h2><p>Sign in with Google to let GlenCal read your Gmail (read-only). Your emails go straight between this iPhone and Google.</p>' +
        '<p class="small">This is a test: it lists your 10 latest emails to check that sign-in comes back into the app. Google will warn that the app is unverified, because it\'s your own app in testing. Tap <b>Continue</b>.</p>' +
        '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button><button class="btn primary" type="button" data-act="gmail-go">Connect Gmail</button></div>');
      return;
    }
    openSheet('<h2>Gmail (test)</h2><p>Loading your latest emails…</p>');
    Gmail.latest(10).then(function (list) {
      openSheet('<h2>Gmail ✓ connected</h2><p class="small">Sign-in worked inside the app. Your 10 latest emails:</p>' +
        list.map(function (m) { return '<div class="row"><b>' + esc(m.subject) + '</b><span class="small">' + esc(m.from) + ' · ' + esc(m.date.replace(/\s\(.*\)$/, '').slice(0, 25)) + '</span></div>'; }).join('') +
        '<div class="actions"><button class="btn grow" type="button" data-act="gmail-off">Disconnect</button><button class="btn primary" type="button" data-act="close">Done</button></div>');
    }, function (e) {
      openSheet('<h2>Gmail (test)</h2><div class="err">' + esc(e.message || e) + '</div><div class="actions"><button class="btn grow" type="button" data-act="close">Close</button><button class="btn primary" type="button" data-act="gmail-go">Sign in again</button></div>');
    });
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
    $('undo').hidden = false; $('toastMsg').textContent = 'Deleted: ' + it.title;
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
  // Menu: backup, lock, update
  // =====================================================================
  function showMenu() {
    openSheet('<h2>Menu</h2><div class="menu">' +
      '<button class="btn" type="button" data-act="rules">Bills &amp; recurring</button>' +
      '<button class="btn" type="button" data-act="gmail">Gmail: ' + (Gmail.token() ? 'connected (sign out)' : 'sign in') + '</button>' +
      '<button class="btn" type="button" data-act="notify">Evening notification</button>' +
      '<button class="btn" type="button" data-act="hol-toggle">' + (holidaysOn() ? 'Hide' : 'Show') + ' Singapore holidays</button>' +
      '<button class="btn" type="button" data-act="import">Import entries</button>' +
      '<button class="btn" type="button" data-act="export">Export backup</button>' +
      '<button class="btn" type="button" data-act="restore">Restore an earlier copy</button>' +
      (Vault.method() === 'device'
        ? '<button class="btn" type="button" data-act="lock-on">Turn on Face ID lock</button>'
        : '<button class="btn" type="button" data-act="lock">Lock now</button><button class="btn" type="button" data-act="lock-off">Turn off Face ID lock</button>') +
      (updateReady ? '<button class="btn primary" type="button" data-act="update">Install update</button>' : '') +
      '</div><p class="small">Entries are encrypted on this iPhone. ' + (Vault.method() === 'device' ? 'Opens without Face ID.' : 'Unlocked with ' + (Vault.method() === 'passkey' ? 'Face ID' : 'a passphrase') + '. Locks after 30 seconds in the background.') + '<br>Version 5620b07c6813</p>' +
      '<div class="actions"><button class="btn" type="button" data-act="close">Close</button></div>');
  }
  function showImport(msg) {
    openSheet('<h2>Import entries</h2><p>Paste a GlenCal backup, or the data copied from the Scriptable version. Entries with the same id are replaced, others are added.</p>' +
      '<label class="btn" style="text-align:center">Choose backup file<input id="impfile" type="file" accept=".json,application/json,text/plain" hidden></label>' +
      '<p class="small">or paste the text:</p>' +
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
    try { var dc = JSON.parse(text != null ? text : $('imp').value); if (dc && Array.isArray(dc.calc) && !calcTape.length) { calcTape = dc.calc.slice(0, 30); Tools.setTape(calcTape); } } catch (e) {}
    if (newRules.length) { var rid = {}; newRules.forEach(function (r) { rid[r.id] = 1; }); rules = rules.filter(function (r) { return !rid[r.id]; }).concat(newRules); }
    try {   // v3 backups: pinned mail, watchlist and note categories
      var dx = JSON.parse(text != null ? text : $('imp').value);
      if (dx && Array.isArray(dx.mailPins)) { var pid = {}; mailPins.forEach(function (m) { pid[m.id] = 1; }); dx.mailPins.forEach(function (m) { if (m && m.id && !pid[m.id]) mailPins.push(m); }); }
      if (dx && Array.isArray(dx.noteCats)) dx.noteCats.forEach(function (c) { if (noteCats.indexOf(c) < 0) noteCats.push(c); });
      if (dx && dx.watch && dx.watch.list) { WL = dx.watch; normWL(); }
    } catch (e) {}
    if (!Array.isArray(list) || (!list.length && !newRules.length)) return showImport('That isn\'t a GlenCal backup. Paste the whole text, starting with [ or {.');
    var clean = list.filter(function (x) { return x && x.title && GC.fromISOok(x.date); }).map(function (x) {
      return { id: x.id || uid(), date: x.date, title: String(x.title), time: x.time || '', place: x.place || '', note: x.note || '', cat: x.cat || '', repeat: REPEAT_NAMES[x.repeat] ? x.repeat : 'none', src: x.src || '', added: x.added || '' };
    });
    var byId = {}; clean.forEach(function (x) { byId[x.id] = x; });
    items = items.filter(function (i) { return !byId[i.id]; }).concat(clean);
    persist(); refresh();
    openSheet('<h2>Imported</h2><p>' + clean.length + ' entries' + (newRules.length ? ' and ' + newRules.length + ' recurring items' : '') + ' imported.</p><div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
  }
  // Backup: AES-GCM with a key from your password (PBKDF2, 600,000 rounds). Without the password the file can't be read.
  function bkKey(pass, salt) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: 600000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  function b64(u8) { var s2 = ''; for (var i = 0; i < u8.length; i += 0x8000) s2 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s2); }
  function unb64(t) { return Uint8Array.from(atob(t), function (c) { return c.charCodeAt(0); }); }
  function backupJSON() { return JSON.stringify({ v: 3, made: new Date().toISOString(), items: items, rules: rules, paid: paid, notes: notes, calc: calcTape, mailPins: mailPins, watch: WL, noteCats: noteCats }); }
  async function makeBackup(pass) {
    var plain = backupJSON();
    if (!pass) return plain;
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, await bkKey(pass, salt), new TextEncoder().encode(plain)));
    return JSON.stringify({ glencalBackup: 1, enc: 'AES-GCM, PBKDF2-SHA256 600000', made: new Date().toISOString(), salt: b64(salt), iv: b64(iv), data: b64(ct) });
  }
  async function openBackup(text, pass) {
    var o = JSON.parse(text);
    if (!o || !o.glencalBackup) return text;
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, await bkKey(pass, unb64(o.salt)), unb64(o.data));
    return new TextDecoder().decode(pt);
  }
  function showExport(msg) {
    if (bkPass && !msg) {   // password already chosen: one tap
      openSheet('<h2>Back up to iCloud Drive</h2><p>Tap <b>Save backup</b>, then choose <b>Save to Files</b> → <b>iCloud Drive</b> in the share sheet. The file is encrypted with your backup password.</p>' +
        '<div class="actions"><button class="btn link grow" type="button" data-act="bk-change">Change password</button><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="button" data-act="bk-saved">Save backup</button></div>');
      return;
    }
    openSheet('<h2>Export backup</h2><p>Choose a password for the backup file. You\'ll need it to restore. It can\'t be recovered if you forget it.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<div class="f"><input class="pw" id="bk-p1" type="password" autocomplete="new-password" placeholder="backup password (8+ characters)">' +
      '<input class="pw" id="bk-p2" type="password" autocomplete="new-password" placeholder="type it again"></div>' +
      '<label class="small" style="display:flex;gap:0.4rem;align-items:center"><input type="checkbox" id="bk-rem" checked> Remember on this iPhone, so weekly backups are one tap (kept inside the encrypted app data)</label>' +
      '<div class="actions"><button class="btn link grow" type="button" data-act="bk-plain">Export without a password (readable)</button>' +
      '<button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="button" data-act="bk-enc">Export</button></div>');
  }
  function markBackedUp() { lastBackup = Date.now(); persist(); if (tab === 'brief') renderBrief(); }
  async function exportBackup(pass) {
    var text = await makeBackup(pass), name = 'glencal-backup-' + todayISO + (pass ? '' : '-readable') + '.json', file = null;
    try { file = new File([text], name, { type: 'application/json' }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      closeSheet();
      navigator.share({ files: [file] }).then(function () { markBackedUp(); flashToast('Backup saved'); }, function () {});
    } else {
      markBackedUp();
      openSheet('<h2>Export backup</h2><p>Copy this text and save it somewhere safe.</p><textarea readonly>' + esc(text) + '</textarea>' +
        '<div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
    }
  }
  var pendingBackup = null;
  function askBackupPassword(msg) {
    openSheet('<h2>Restore backup</h2><p>This backup is password-protected. Enter the password you chose when you exported it.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<input class="pw" id="bk-in" type="password" autocomplete="current-password" placeholder="backup password">' +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button><button class="btn primary" type="button" data-act="bk-open">Restore</button></div>');
  }
  function restoreText(text) {
    var o = null; try { o = JSON.parse(text); } catch (e) {}
    if (o && o.glencalBackup) { pendingBackup = text; askBackupPassword(); return; }
    doImport(text);
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
      function check() { if (reg.waiting && navigator.serviceWorker.controller) { updateReady = true; $('more').textContent = '··· ●'; if (tab === 'brief') renderBrief(); } }
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
  $('q').addEventListener('input', function () { if (tab === 'mail') { if (!$('q').value && MAIL.q) { MAIL.q = ''; loadMail(); } return; } if (tab === 'notes') { renderNotes(); return; } if (tab === 'news') { renderNews(); return; } if (tab === 'fan') { renderFantasy(); return; } render(); if (!$('q').value) jumpToday(false); });
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
  $('scrim').addEventListener('click', function (e) { if (e.target === $('scrim')) { if (noteEd) { noteChanged(); noteEd = null; persist(); } closeSheet(); if (tab === 'notes') renderNotes(); } });
  $('sheet').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    if (act === 'close') closeSheet();
    else if (act === 'parse') { lastPaste = $('paste').value; showConfirm(GC.parseText(lastPaste, new Date()).map(function (d) { d.src = d.src; return d; })); }
    else if (act === 'back') showPaste(lastPaste);
    else if (act === 'drop') { var n = +b.getAttribute('data-n'); drafts[n].dropped = true; $('row-' + n).hidden = true; }
    else if (act === 'save-all') saveAll();
    else if (act === 'save-one') saveOne();
    else if (act === 'del') { if (!delArmed) { delArmed = true; b.textContent = 'Tap again to delete'; } else { closeSheet(); removeItem(editing.id); } }
    else if (act === 'import') showImport();
    else if (act === 'rules') showRules();
    else if (act === 'gmail') showGmail();
    else if (act === 'm-prev') mailStep(-1);
    else if (act === 'm-next') mailStep(1);
    else if (act === 'm-note' && openMailMsg) mailToNoteSheet(openMailMsg);
    else if (act === 'mn-save') saveMailNote();
    else if (act === 'restore') {
      openSheet('<h2>Restore an earlier copy</h2><p>Loading…</p>');
      Vault.history().then(function (h) {
        restoreList = h;
        openSheet('<h2>Restore an earlier copy</h2><p class="small">The app keeps up to 20 earlier copies on this iPhone, at least 30 minutes apart. <b>Add back</b> returns calendar entries and bills from that copy that you no longer have, and changes nothing else. <b>Replace all</b> swaps everything for that copy. Either way your current data is saved to this list first.</p>' +
          (h.length ? '<div class="catlist">' + h.map(function (x, i) {
            var c = counts(x.data), d = new Date(x.at);
            return '<div><span>' + d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) +
              '<br><span class="small">' + c.items + ' entries · ' + (x.data.rules || []).length + ' bills/recurring · ' + c.notes + ' notes · ' + c.pins + ' pinned mail</span></span>' +
              '<span style="display:flex;flex-direction:column;gap:0.25rem"><button class="btn primary" type="button" data-restore="' + i + '">Add back</button><button class="btn" type="button" data-restore="' + i + '" data-full="1">Replace all</button></span></div>';
          }).join('') + '</div>' : '<p>No earlier copies yet. They build up as you use the app.</p>') +
          '<div class="actions"><button class="btn primary" type="button" data-act="close">Close</button></div>');
      }, function (e) { openSheet('<h2>Restore</h2><div class="err">' + esc(e.message || e) + '</div><div class="actions"><button class="btn primary" type="button" data-act="close">Close</button></div>'); });
    }
    else if (act === 'nc-add') { var nn = addNoteCat($('nc-new').value); if (nn) { catSheet(); if (tab === 'notes') renderNotes(); } }
    else if (act === 'm-events' && openMailMsg) { var mt = openMailMsg.subject + '\n' + (openMailMsg.text || '').slice(0, 1500); closeSheet(); showPaste(mt); }
    else if (act === 'gmail-go') Gmail.start();
    else if (act === 'gmail-off') { Gmail.forget(); Gmail.markOK(false); MAIL.list = null; showGmail(); }
    else if (act === 'sv-save') {
      if (!pendingSum) return;
      var nm = $('sv-name').value.trim() || pendingSum.title, ds = $('sv-desc').value.trim(), nowIso = new Date().toISOString();
      notes.push({ id: 'n' + uid(), title: nm, body: (ds ? ds + '\n\n' : '') + pendingSum.body, pinned: false, created: nowIso, updated: nowIso });
      pendingSum = null; persist(); closeSheet(); flashToast('Saved to Notes');
    }
    else if (act === 'n-done') { noteChanged(); noteEd = null; persist(); closeSheet(); if (tab === 'notes') renderNotes(); }
    else if (act === 'n-pin') { noteEd.pinned = !noteEd.pinned; b.textContent = noteEd.pinned ? 'Unpin' : '📌 Pin'; noteChanged(); }
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
    else if (act === 'do-import') restoreText($('imp').value);
    else if (act === 'paste-import') {
      if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { restoreText(t); }, function () { showImport('Couldn\'t read the clipboard. Paste into the box instead.'); });
      else showImport('Paste into the box instead.');
    }
    else if (act === 'export') showExport();
    else if (act === 'bk-plain') exportBackup('');
    else if (act === 'bk-enc') { var p1 = $('bk-p1').value, p2 = $('bk-p2').value; if (p1.length < 8) showExport('Use at least 8 characters.'); else if (p1 !== p2) showExport('The two passwords don\'t match.'); else { if ($('bk-rem').checked) { bkPass = p1; persist(); } exportBackup(p1); } }
    else if (act === 'bk-saved') exportBackup(bkPass);
    else if (act === 'bk-change') { bkPass = ''; persist(); showExport(); }
    else if (act === 'bk-later') { prefs('bkSnooze', String(Date.now())); renderBrief(); }
    else if (act === 'bk-open') { var pw = $('bk-in').value; openBackup(pendingBackup, pw).then(function (t) { pendingBackup = null; doImport(t); }, function () { askBackupPassword('Wrong password, or the file is damaged.'); }); }
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
  // Ask the browser to keep this app's storage (reduces the chance iOS clears it when space runs low).
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  Vault.status().then(async function (st) {
    if (st === 'new' && prefs('vaultSeen') === '1') {   // storage was used before but is now empty: never start over silently
      lockScreen('<div class="err">Your saved GlenCal data wasn\'t found on this iPhone.</div>' +
        '<p>This can happen if iOS cleared website data, or the app was removed and added again. Nothing has been changed yet.</p>' +
        '<p>If you have a backup file (··· → Export backup), restore it now. Otherwise you can start with an empty calendar.</p>' +
        '<div class="actions" style="flex-direction:column;align-items:stretch"><button class="btn primary" type="button" id="lk-restore">Restore from a backup file</button>' +
        '<button class="btn" type="button" id="lk-fresh">Start with an empty calendar</button></div>');
      $('lk-restore').onclick = async function () { await Vault.create('device'); enterApp(await Vault.read()); setTimeout(function () { showImport(); }, 300); };
      $('lk-fresh').onclick = async function () { if (!window.confirm('Start with an empty calendar? Your old entries can only come back from a backup file.')) return; await Vault.create('device'); enterApp(await Vault.read()); };
      return;
    }
    if (st === 'new' && prefs('lock') !== 'on') { await Vault.create('device'); return enterApp(await Vault.read()); }
    if (st === 'new') return showSetup();
    if (Vault.method() === 'device') return enterApp(await Vault.unlock());
    showUnlock();
  })
    .catch(function (e) { lockScreen('<div class="err">GlenCal couldn\'t open its storage: ' + esc(e.message || e) + '</div>'); });
})();
