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
  var activeCat = 'all';
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
  function persist() {
    var snap = items.slice();
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
    items = list || [];
    unlocked = true;
    todayISO = GC.iso(new Date());
    $('lock').hidden = true;
    document.body.classList.remove('covered');
    setClock();
    refresh();
    setTimeout(function () { syncHead(); jumpToday(false); }, 0);
  }

  function lockNow() {
    Vault.lock();
    unlocked = false;
    items = [];
    closeSheet();
    $('list').innerHTML = '';
    askHistory = []; pending = null;
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
    { c: 'WLG', tz: 'Pacific/Auckland', s: [[600, 1005]], x: 'NZX 10:00-16:45' },
    { c: 'SYD', tz: 'Australia/Sydney', s: [[600, 960]], x: 'ASX 10:00-16:00' },
    { c: 'TYO', tz: 'Asia/Tokyo', s: [[540, 690], [750, 930]], x: 'TSE 9:00-11:30, 12:30-15:30' },
    { c: 'SG/HK', tz: 'Asia/Singapore', s: [[540, 720], [780, 1020]], x: 'SGX 9:00-12:00, 13:00-17:00' },
    { c: 'LON', tz: 'Europe/London', s: [[480, 990]], x: 'LSE 8:00-16:30' },
    { c: 'NYC', tz: 'America/New_York', s: [[570, 960]], x: 'NYSE 9:30-16:00' }
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
      html += '<div class="ck' + (open ? ' open' : '') + '" title="' + k.x + (open ? ' (open)' : ' (closed)') + '">' +
        '<span class="c">' + k.c + '</span><span class="h">' + ('0' + z.h).slice(-2) + ':' + ('0' + z.m).slice(-2) +
        (diff ? '<span class="o">' + (diff > 0 ? '+' : '−') + Math.abs(diff) + '</span>' : '') + '</span></div>';
    });
    $('clocks').innerHTML = html;
  }
  renderClocks();
  setInterval(renderClocks, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) renderClocks(); });

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
  function allEntries() { return items.concat(holidayItems()); }
  function visible() {
    var q = $('q').value.trim().toLowerCase();
    return allEntries().filter(function (i) {
      if (activeCat !== 'all' && catOf(i) !== activeCat) return false;
      return !q || [i.title, i.place, i.note, i.src].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderChips() {
    var counts = {};
    var all = allEntries();
    all.forEach(function (i) { var c = catOf(i); counts[c] = (counts[c] || 0) + 1; });
    if (activeCat !== 'all' && !counts[activeCat]) activeCat = 'all';
    var html = '<button class="chip" type="button" data-cat="all" aria-pressed="' + (activeCat === 'all') + '">All<span class="n">' + all.length + '</span></button>';
    GC.CATS.forEach(function (c) {
      if (!counts[c.id]) return;
      html += '<button class="chip" type="button" data-cat="' + c.id + '" aria-pressed="' + (activeCat === c.id) + '">' + c.emoji + ' ' + esc(c.name) + '<span class="n">' + counts[c.id] + '</span></button>';
    });
    $('chips').innerHTML = html;
  }

  var shownDates = [];
  function render() {
    var q = $('q').value.trim();
    var byDate = {};
    visible().forEach(function (i) { (byDate[i.date] = byDate[i.date] || []).push(i); });
    var dates = Object.keys(byDate);
    if (dates.length && !q && !byDate[todayISO]) dates.push(todayISO);
    dates.sort();
    shownDates = dates;
    if (!dates.length) {
      $('list').innerHTML = (q || activeCat !== 'all') ? '<p class="empty">NO MATCHES</p>'
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
            return '<li' + (i.holiday ? ' class="hol"' : '') + '>' +
              (i.holiday ? '' : '<div class="swipe-del"><button type="button" data-del="' + esc(i.id) + '">DELETE</button></div>') +
              '<button class="item" type="button" data-id="' + esc(i.id) + '">' +
              '<span class="dc">' + (k === 0 ? l.day + ' <span class="w">' + l.dow + '</span>' : '') + '</span>' +
              '<span class="tm">' + (i.time ? esc(GC.fmtTime(i.time)) : '') + '</span>' +
              '<span class="emo" aria-hidden="true">' + c.emoji + '</span>' +
              '<span class="t">' + esc(i.title) + (i.est ? '<span class="pl"> (est.)</span>' : '') + (i.place ? '<span class="pl"> @ ' + esc(i.place) + '</span>' : '') +
              (i.note ? '<span class="note">' + esc(i.note) + '</span>' : '') + '</span>' +
              '<span class="cd">' + (k === 0 && days > 0 ? days + 'D' : '') + '</span></button></li>';
          }).join('') + '</ul>';
      });
      html += '<section class="mon"><h2 class="mbar" data-m="' + mk + '"><span>' + MONTH_FULL[md.getMonth()] + ' ' + md.getFullYear() + '</span><span class="n">' + count + '</span></h2>' + body + '</section>';
    });
    $('list').innerHTML = html;
    syncHead();
  }
  function refresh() { renderChips(); syncHead(); render(); }

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
    var y = el.getBoundingClientRect().top + window.pageYOffset - $('bar').getBoundingClientRect().bottom - mbarH;
    window.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
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
    return GC.CATS.filter(function (c) { return c.id !== 'holiday'; }).map(function (c) { return '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' + c.emoji + ' ' + esc(c.name) + '</option>'; }).join('');
  }
  function fieldsHTML(i, n) {
    return '<div class="f">' +
      '<label>What<input id="title-' + n + '" value="' + esc(i.title) + '" placeholder="e.g. Meet Sarah"></label>' +
      '<label>Date<input id="date-' + n + '" type="date" value="' + esc(i.date) + '"></label>' +
      '<label>Time (optional)<input id="time-' + n + '" value="' + esc(GC.fmtTime(i.time)) + '" placeholder="3pm"></label>' +
      '<label>Place (optional)<input id="place-' + n + '" value="' + esc(i.place) + '"></label>' +
      '<label>Note (optional)<input id="note-' + n + '" value="' + esc(i.note) + '" placeholder="e.g. bring passport"></label>' +
      '<label>Category<select id="cat-' + n + '">' + catOptions(catOf(i)) + '</select></label></div>';
  }
  function readFields(n) {
    return { title: $('title-' + n).value.trim(), date: $('date-' + n).value, time: GC.normTime($('time-' + n).value),
      place: $('place-' + n).value.trim(), note: $('note-' + n).value.trim(), cat: $('cat-' + n).value };
  }

  var lastPaste = '';
  function showPaste(prefill, msg) {
    var st = aiStatus();
    openSheet('<h2>Add</h2><p>Type or paste anything: a message, an email, or your own rough notes.</p>' +
      '<textarea id="paste" placeholder="dinner w mum n dad sat 730 at jumbo&#10;&#10;23 Nov&#10;- Meet xxx&#10;- Submit xxx"></textarea>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<div id="aiprog" hidden><div class="small" id="aiprogtxt">Starting AI…</div><div class="prog"><div id="aiprogbar"></div></div></div>' +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button>' +
      '<button class="btn" type="button" data-act="parse">Quick read</button>' +
      (st === 'unsupported' ? '' : st === 'none'
        ? '<button class="btn primary" type="button" data-act="ai-setup">Set up AI</button>'
        : '<button class="btn primary" type="button" data-act="ai-read">Read with AI</button>') + '</div>' +
      (st === 'unsupported' ? '<p class="small">AI needs WebGPU, which this browser doesn\'t offer. Quick read still works.</p>' : ''));
    if (prefill) $('paste').value = prefill;
    setTimeout(function () { $('paste').focus(); }, 50);
  }

  var drafts = [];
  function showConfirm(list, msg) {
    drafts = list.map(function (d) {
      var x = { id: uid(), title: d.title || '', date: d.date || '', time: d.time || '', place: d.place || '', note: d.note || '', src: d.src || '', flag: d.flag || '' };
      x.cat = (d.cat && GC.CAT_BY_ID[d.cat]) ? d.cat : GC.inferCat([x.title, x.place, x.note].join(' '));
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
      out.push({ id: d.id, title: f.title, date: f.date, time: f.time, place: f.place, note: f.note, cat: f.cat, src: d.src, added: now });
    });
    if (bad) { $('cerr').hidden = false; $('cerr').textContent = bad + (bad === 1 ? ' entry needs' : ' entries need') + ' a description and a date.'; return; }
    if (!out.length) { closeSheet(); return; }
    items = items.concat(out); persist();
    closeSheet(); activeCat = 'all'; refresh();
    scrollToEl($('d-' + out[0].date), true);
  }

  var editing = null, delArmed = false;
  function showEdit(id) {
    editing = items.filter(function (i) { return i.id === id; })[0];
    if (!editing) return;
    delArmed = false;
    openSheet('<h2>Edit</h2>' + fieldsHTML(editing, 'e') +
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
  function saveOne() {
    var f = readFields('e');
    if (!f.title || !f.date) { $('eerr').hidden = false; $('eerr').textContent = 'Add a description and a date before saving.'; return; }
    Object.assign(editing, f); persist();
    closeSheet(); refresh();
  }

  // ---------- delete with undo ----------
  var toastTimer = null, lastDeleted = null;
  function removeItem(id) {
    var it = items.filter(function (i) { return i.id === id; })[0];
    if (!it) return;
    var y = window.pageYOffset;
    items = items.filter(function (i) { return i.id !== id; }); persist();
    lastDeleted = it;
    refresh(); window.scrollTo({ top: y });
    $('toastMsg').textContent = 'Deleted: ' + it.title;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').hidden = true; lastDeleted = null; }, 6000);
  }
  $('undo').addEventListener('click', function () {
    if (!lastDeleted) return;
    var y = window.pageYOffset;
    items.push(lastDeleted); persist();
    lastDeleted = null; $('toast').hidden = true; clearTimeout(toastTimer);
    refresh(); window.scrollTo({ top: y });
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
    var scored = allEntries().map(function (e) {
      var hay = [e.title, e.place, e.note, GC.CAT_BY_ID[catOf(e)].name].join(' ').toLowerCase();
      var hit = words.some(function (w) { return hay.indexOf(w) >= 0; });
      return { e: e, keep: hit || (e.date >= lo && e.date <= hi), hit: hit };
    }).filter(function (x) { return x.keep; });
    scored.sort(function (a, b) { return (b.hit - a.hit) || (a.e.date < b.e.date ? -1 : 1); });
    return scored.slice(0, 45).map(function (x) { return x.e; }).sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; })
      .map(function (e) {
        return e.id + ' | ' + e.date + ' ' + dLabel(e.date).dow + (e.time ? ' ' + e.time : '') + ' | ' + e.title + (e.place ? ' @ ' + e.place : '') + (e.note ? ' | ' + e.note : '');
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
      '<button class="btn" type="button" data-act="ai-setup">AI on this iPhone</button>' +
      '<button class="btn" type="button" data-act="hol-toggle">' + (holidaysOn() ? 'Hide' : 'Show') + ' Singapore holidays</button>' +
      '<button class="btn" type="button" data-act="import">Import entries</button>' +
      '<button class="btn" type="button" data-act="export">Export backup</button>' +
      (Vault.method() === 'device'
        ? '<button class="btn" type="button" data-act="lock-on">Turn on Face ID lock</button>'
        : '<button class="btn" type="button" data-act="lock">Lock now</button><button class="btn" type="button" data-act="lock-off">Turn off Face ID lock</button>') +
      (updateReady ? '<button class="btn primary" type="button" data-act="update">Install update</button>' : '') +
      '</div><p class="small">Entries are encrypted on this iPhone. ' + (Vault.method() === 'device' ? 'Opens without Face ID.' : 'Unlocked with ' + (Vault.method() === 'passkey' ? 'Face ID' : 'a passphrase') + '. Locks after 30 seconds in the background.') + '<br>Version 7c143d36cee3</p>' +
      '<div class="actions"><button class="btn" type="button" data-act="close">Close</button></div>');
  }
  function showImport(msg) {
    openSheet('<h2>Import entries</h2><p>Paste a GlenCal backup, or the data copied from the Scriptable version. Entries with the same id are replaced, others are added.</p>' +
      '<textarea id="imp" placeholder="[ { &quot;date&quot;: ... } ]"></textarea>' + (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<div class="actions"><button class="btn grow" type="button" data-act="close">Cancel</button><button class="btn primary" type="button" data-act="do-import">Import</button></div>');
  }
  function doImport() {
    var list;
    try { var d = JSON.parse($('imp').value); list = Array.isArray(d) ? d : (d && d.items); } catch (e) {}
    if (!Array.isArray(list)) return showImport('That isn\'t a GlenCal backup. Paste the whole text, starting with [ or {.');
    var clean = list.filter(function (x) { return x && x.title && GC.fromISOok(x.date); }).map(function (x) {
      return { id: x.id || uid(), date: x.date, title: String(x.title), time: x.time || '', place: x.place || '', note: x.note || '', cat: x.cat || '', src: x.src || '', added: x.added || '' };
    });
    var byId = {}; clean.forEach(function (x) { byId[x.id] = x; });
    items = items.filter(function (i) { return !byId[i.id]; }).concat(clean);
    persist(); refresh();
    openSheet('<h2>Imported</h2><p>' + clean.length + ' entries imported.</p><div class="actions"><button class="btn primary" type="button" data-act="close">Done</button></div>');
  }
  function doExport() {
    var json = JSON.stringify(items, null, 1);
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
  $('q').addEventListener('input', function () { render(); if (!$('q').value) jumpToday(false); });
  $('jump').addEventListener('click', function () { $('q').value = ''; render(); jumpToday(true); });
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cat]'); if (!b) return;
    activeCat = b.getAttribute('data-cat'); refresh(); jumpToday(false);
  });
  $('add').addEventListener('click', function () { showPaste(''); });
  $('ask').addEventListener('click', showAsk);
  $('more').addEventListener('click', showMenu);
  $('list').addEventListener('click', function (e) {
    var mb = e.target.closest('.mbar');
    if (mb) { showJump(mb.getAttribute('data-m')); return; }
    var d = e.target.closest('[data-del]');
    if (d) { openRow = null; removeItem(d.getAttribute('data-del')); return; }
    var b = e.target.closest('button[data-id]'); if (!b) return;
    if (justSwiped) return;
    if (openRow) { closeOpen(); return; }
    var id = b.getAttribute('data-id');
    if (id.indexOf('hol-') === 0) { showHoliday(id); return; }
    showEdit(id);
  });
  $('scrim').addEventListener('click', function (e) { if (e.target === $('scrim') && !askBusy) closeSheet(); });
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
    else if (act === 'ai-download') aiDownload();
    else if (act === 'ai-remove') aiRemove();
    else if (act === 'ask-send') askSend();
    else if (act === 'ask-new') { askHistory = []; pending = null; showAsk(); }
    else if (act === 'ask-apply') askApply();
    else if (act === 'ask-discard') { pending = null; askHistory.push({ q: '(discard)', a: 'Discarded.' }); showAsk(); }
    else if (act === 'import') showImport();
    else if (act === 'hol-toggle') { prefs('holidays', holidaysOn() ? 'off' : 'on'); refresh(); showMenu(); }
    else if (act === 'do-import') doImport();
    else if (act === 'export') doExport();
    else if (act === 'lock') lockNow();
    else if (act === 'lock-off') { prefs('lock', 'off'); Vault.rekey('device').then(showMenu, function (e) { notice('Could not turn off the lock: ' + e.message); }); }
    else if (act === 'lock-on') { closeSheet(); prefs('lock', 'on'); showLockOn(); }
    else if (act === 'update') installUpdate();
    else if (act === 'jump') { var day = b.getAttribute('data-day'); closeSheet(); scrollToEl($('d-' + day), true); }
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
