// GlenCal TOOLS: calculator with tape, FX converter, TVM, rates, % change. Works offline; nothing is stored or sent.
var Tools = (function () {
  'use strict';
  var root = null, tool = 'calc', getMkt = function () { return null; }, onTape = function () {};
  var TAPE_MAX = 30;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---------- numbers ----------
  // "10m" -> 10,000,000; "2.5k", "1bn", "1,250.5" all work
  function parseNum(s) {
    s = String(s == null ? '' : s).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
    if (!s) return NaN;
    var m = /^(-?\d*\.?\d+(?:e-?\d+)?)(k|m|mm|mn|b|bn)?$/.exec(s);
    if (!m) return NaN;
    var mult = { k: 1e3, m: 1e6, mm: 1e6, mn: 1e6, b: 1e9, bn: 1e9 }[m[2]] || 1;
    return parseFloat(m[1]) * mult;
  }
  function fmt(v, dp) {
    if (!isFinite(v)) return '—';
    if (dp == null) {
      var a = Math.abs(v);
      dp = a === 0 ? 0 : a >= 1e6 ? 2 : a >= 1 ? 6 : 8;
      var s = v.toLocaleString('en-US', { maximumFractionDigits: dp });
      return s;
    }
    return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  // ---------- thousands separators ----------
  function groupInt(d) { return d.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function groupStr(v) {   // "1234567.5" -> "1,234,567.5"; leaves shorthand like "10m" and anything else alone
    var m = /^(-?)([\d,]*)(\.\d*)?([a-z]*)$/i.exec(String(v == null ? '' : v).replace(/\s/g, ''));
    return m ? m[1] + groupInt(m[2].replace(/,/g, '')) + (m[3] || '') + (m[4] || '') : String(v);
  }
  function groupExpr(e) { return String(e).replace(/\d+(\.\d*)?/g, function (n) { var i = n.indexOf('.'); return i < 0 ? groupInt(n) : groupInt(n.slice(0, i)) + n.slice(i); }); }
  function liveFormat(el) {   // regroup while typing and keep the caret after the same digit
    var v = el.value, pos = el.selectionStart == null ? v.length : el.selectionStart, out = groupStr(v);
    if (out === v) return;
    var before = v.slice(0, pos).replace(/,/g, '').length, cnt = 0, np = 0;
    while (np < out.length && cnt < before) { if (out[np] !== ',') cnt++; np++; }
    el.value = out;
    try { el.setSelectionRange(np, np); } catch (e) {}
  }

  // ---------- CALC: safe expression evaluator (no eval) ----------
  var OPS = { '+': [1, 'L'], '-': [1, 'L'], '*': [2, 'L'], '/': [2, 'L'], '^': [3, 'R'], 'neg': [4, 'R'] };
  function tokenize(src) {
    var s = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/,/g, ''), out = [], i = 0;
    s = s.replace(/(^|[^\d.)])(\d*\.?\d+)\s*([+-])\s*(\d*\.?\d+)%/g, function (_, pre, x, op, y) { return pre + x + op + '(' + x + '*' + y + '/100)'; });
    while (i < s.length) {
      var c = s[i];
      if (c === ' ') { i++; continue; }
      var m = /^(\d*\.?\d+(?:e-?\d+)?)(k|mm|mn|m|bn|b)?/i.exec(s.slice(i));
      if (m && m[0]) { out.push({ t: 'n', v: parseNum(m[0]) }); i += m[0].length; continue; }
      if ('+-*/^()%'.indexOf(c) >= 0) { out.push({ t: c }); i++; continue; }
      if (s.slice(i, i + 3).toLowerCase() === 'ans') { out.push({ t: 'ans' }); i += 3; continue; }
      throw new Error('bad');
    }
    return out;
  }
  function evaluate(src, ans) {
    var toks = tokenize(src), outq = [], st = [], prev = null;
    toks.forEach(function (k) {
      if (k.t === 'n' || k.t === 'ans') { outq.push(k.t === 'ans' ? ans : k.v); prev = 'n'; return; }
      if (k.t === '%') { outq.push(-100); outq.push('%'); prev = 'n'; return; }   // postfix percent
      if (k.t === '(') { st.push('('); prev = '('; return; }
      if (k.t === ')') { while (st.length && st[st.length - 1] !== '(') outq.push(st.pop()); if (!st.length) throw new Error('bad'); st.pop(); prev = 'n'; return; }
      var op = k.t;
      if (op === '-' && (prev === null || prev === 'op' || prev === '(')) op = 'neg';
      else if (op === '+' && (prev === null || prev === 'op' || prev === '(')) { prev = 'op'; return; }
      while (st.length) {
        var top = st[st.length - 1]; if (top === '(') break;
        var a = OPS[op], b = OPS[top];
        if ((a[1] === 'L' && a[0] <= b[0]) || (a[1] === 'R' && a[0] < b[0])) outq.push(st.pop()); else break;
      }
      st.push(op); prev = 'op';
    });
    while (st.length) { var x = st.pop(); if (x === '(') throw new Error('bad'); outq.push(x); }
    var s = [];
    for (var i = 0; i < outq.length; i++) {
      var t = outq[i];
      if (typeof t === 'number') { s.push(t); continue; }
      if (t === '%') { s.pop(); s.push(s.pop() / 100); continue; }
      if (t === 'neg') { s.push(-s.pop()); continue; }
      var r = s.pop(), l = s.pop();
      if (l === undefined || r === undefined) throw new Error('bad');
      s.push(t === '+' ? l + r : t === '-' ? l - r : t === '*' ? l * r : t === '/' ? l / r : Math.pow(l, r));
    }
    if (s.length !== 1 || !isFinite(s[0])) throw new Error('bad');
    return s[0];
  }
  var expr = '', ans = 0, tape = [];
  var KEYS = ['C', '(', ')', '⌫', '7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '±', '0', '.', '+', '%', '^', 'ANS', '='];
  function calcHTML() {
    var preview = '';
    if (expr) { try { preview = fmt(evaluate(expr, ans)); } catch (e) { preview = ''; } }
    var hist = tape.slice(0, 30).reverse();   // oldest at the top, newest just above the current line
    return '<div class="calc">' +
      '<div class="cdisp">' +
        (tape.length ? '<button type="button" class="cclear" data-act2="tape-clear">CLEAR</button>' : '') +
        '<div class="chist" id="chist">' + (hist.length ? hist.map(function (t) {
          var n = tape.indexOf(t);
          return '<button type="button" class="tl" data-tape="' + n + '"><span class="te">' + esc(groupExpr(t.e)) + '</span><span class="tr2">= ' + esc(fmt(t.r)) + '</span></button>';
        }).join('') : '<p class="chint">Workings show here. Tap a line to reuse its result. Shorthand: 10m, 2.5k, 1bn.</p>') + '</div>' +
        '<div class="cexpr">' + esc(expr ? groupExpr(expr) : ' ') + '</div>' +
        '<button type="button" class="cres" data-copy="' + esc(preview) + '" aria-label="Copy result">' + esc(preview || (expr ? '…' : '0')) + '</button>' +
      '</div>' +
      '<div class="ckeys">' + KEYS.map(function (k) {
        var cls = k === '=' ? ' eq' : k === '⌫' ? ' del' : /[÷×−+^%()]/.test(k) ? ' op' : (k === 'C' || k === '±' || k === 'ANS') ? ' fn' : '';
        return '<button type="button" class="ck2' + cls + '" data-k="' + esc(k) + '"' + (k === '⌫' ? ' aria-label="Delete"' : '') + '>' + esc(k) + '</button>';
      }).join('') + '</div></div>';
  }
  function press(k) {
    if (k === 'C') expr = '';
    else if (k === '⌫') expr = expr.slice(0, -1);
    else if (k === '±') expr = expr ? '−(' + expr + ')' : '−';
    else if (k === 'ANS') expr += 'ans';
    else if (k === '=') {
      if (!expr) return;
      try { var r = evaluate(expr, ans); tape.unshift({ e: expr.replace(/ans/g, fmt(ans)), r: r }); tape = tape.slice(0, TAPE_MAX); ans = r; onTape(tape.slice()); expr = String(+r.toPrecision(12)); }
      catch (e) { flash('Check the expression'); return; }
    } else {
      // start fresh after a result if a digit is typed
      if (/^[0-9.(]$/.test(k) && tape.length && expr === String(+tape[0].r.toPrecision(12))) expr = '';
      expr += k;
    }
    draw();
  }

  // ---------- FX converter ----------
  // USD value of one unit of each currency, from the ticker's pairs
  var PAIRS = { USDSGD: ['SGD', 'inv'], EURUSD: ['EUR', 'dir'], GBPUSD: ['GBP', 'dir'], USDJPY: ['JPY', 'inv'], AUDUSD: ['AUD', 'dir'],
    NZDUSD: ['NZD', 'dir'], USDCNH: ['CNH', 'inv'], USDHKD: ['HKD', 'inv'], USDCHF: ['CHF', 'inv'], USDCAD: ['CAD', 'inv'],
    USDKRW: ['KRW', 'inv'], USDINR: ['INR', 'inv'], USDMYR: ['MYR', 'inv'], USDIDR: ['IDR', 'inv'], USDTHB: ['THB', 'inv'] };
  var ORDER = ['SGD', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CNH', 'HKD', 'CHF', 'CAD', 'KRW', 'INR', 'MYR', 'IDR', 'THB'];
  var NODEC = { JPY: 1, KRW: 1, IDR: 1 };
  var fxAmt = '1,000,000', fxFrom = 'SGD';
  function usdValues() {
    var m = getMkt(), u = { USD: 1 };
    ((m && m.items) || []).forEach(function (q) { var p = PAIRS[q.k]; if (p && q.price) u[p[0]] = p[1] === 'dir' ? q.price : 1 / q.price; });
    return { u: u, when: m && m.updated };
  }
  function fxHTML() {
    var v = usdValues(), amt = parseNum(fxAmt), list = ORDER.filter(function (c) { return v.u[c]; });
    if (list.length < 2) return '<p class="empty">No rates yet. Open the app online once so the latest rates can load.</p>';
    if (list.indexOf(fxFrom) < 0) fxFrom = list.indexOf('SGD') >= 0 ? 'SGD' : 'USD';
    var usd = amt * v.u[fxFrom];
    return '<div class="f"><div class="two"><label>Amount<input id="fx-amt" inputmode="decimal" value="' + esc(fxAmt) + '"></label>' +
      '<label>Currency<select id="fx-from">' + list.map(function (c) { return '<option' + (c === fxFrom ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label></div></div>' +
      '<table class="mt fxt">' + list.filter(function (c) { return c !== fxFrom; }).map(function (c) {
        var out = usd / v.u[c], rate = v.u[fxFrom] / v.u[c];
        return '<tr><td>' + c + '</td><td>' + (isFinite(out) ? fmt(out, NODEC[c] ? 0 : 2) : '—') + '</td><td class="small">1 ' + fxFrom + ' = ' + fmt(rate, rate >= 100 ? 2 : 4) + '</td></tr>';
      }).join('') + '</table>' +
      '<p class="small">Mid rates from the ticker (Yahoo Finance, delayed)' + (v.when ? ', fetched ' + esc(v.when) + ' Singapore' : '') + '. Crosses are via USD. Indicative only.</p>';
  }

  // ---------- TVM ----------
  var tvm = { N: '120', IY: '3.5', PV: '500,000', PMT: '', FV: '0', PY: '12', BEGIN: false };
  function tvmSolve(which) {
    var N = parseNum(tvm.N), iy = parseNum(tvm.IY), PV = parseNum(tvm.PV), PMT = parseNum(tvm.PMT), FV = parseNum(tvm.FV), py = +tvm.PY, t = tvm.BEGIN ? 1 : 0;
    var r = iy / 100 / py;
    function f(N, r, PV, PMT, FV) {   // = 0 when the cash flows balance (cash paid out is negative)
      if (Math.abs(r) < 1e-12) return PV + PMT * N + FV;
      var g = Math.pow(1 + r, N);
      return PV * g + PMT * (1 + r * t) * (g - 1) / r + FV;
    }
    var res;
    if (which === 'FV') res = -(f(N, r, PV, PMT, 0));
    else if (which === 'PV') { var g = Math.pow(1 + r, N); res = Math.abs(r) < 1e-12 ? -(PMT * N + FV) : -(PMT * (1 + r * t) * (g - 1) / r + FV) / g; }
    else if (which === 'PMT') { var g2 = Math.pow(1 + r, N); res = Math.abs(r) < 1e-12 ? -(PV + FV) / N : -(PV * g2 + FV) * r / ((1 + r * t) * (g2 - 1)); }
    else if (which === 'N') {
      if (Math.abs(r) < 1e-12) res = -(PV + FV) / PMT;
      else { var a = PMT * (1 + r * t) / r; res = Math.log((a - FV) / (a + PV)) / Math.log(1 + r); }
    } else if (which === 'IY') {   // bisection on the periodic rate
      var lo = -0.99, hi = 1, flo = f(N, lo, PV, PMT, FV), ok = false;
      for (var i = 0; i < 300; i++) {
        var mid = (lo + hi) / 2, fm = f(N, mid, PV, PMT, FV);
        if (Math.abs(fm) < 1e-9) { ok = true; lo = hi = mid; break; }
        if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
      }
      res = ((lo + hi) / 2) * py * 100;
      if (!ok && Math.abs(f(N, res / py / 100, PV, PMT, FV)) > 1e-4 * (Math.abs(PV) + Math.abs(FV) + Math.abs(PMT) * N + 1)) res = NaN;
    }
    if (!isFinite(res)) { flash('No solution with these inputs. Check signs: money paid out is negative.'); return; }
    tvm[which] = groupStr(String(+res.toPrecision(10)));
    draw();
  }
  function tvmHTML() {
    var F = [['N', 'N  (number of payments)'], ['IY', 'I/Y  (% per year)'], ['PV', 'PV  (present value)'], ['PMT', 'PMT  (payment each period)'], ['FV', 'FV  (future value)']];
    return '<div class="f">' + F.map(function (x) {
      return '<label>' + x[1] + '<span class="solve"><input id="tvm-' + x[0] + '" inputmode="decimal" value="' + esc(tvm[x[0]]) + '"><button type="button" class="btn" data-solve="' + x[0] + '">Solve</button></span></label>';
    }).join('') +
      '<div class="two"><label>Payments per year<select id="tvm-PY">' + [1, 2, 4, 12, 52, 365].map(function (n) { return '<option' + (String(n) === tvm.PY ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label>Payments at<select id="tvm-BG"><option value="0"' + (!tvm.BEGIN ? ' selected' : '') + '>End of period</option><option value="1"' + (tvm.BEGIN ? ' selected' : '') + '>Start of period</option></select></label></div></div>' +
      '<p class="small">Fill four values and tap Solve on the fifth. Money you pay out is negative, money you receive is positive (e.g. loan: PV +500,000, PMT negative). Example loaded: 10-year, 3.5% loan of 500k: tap Solve on PMT.</p>';
  }

  // ---------- RATES ----------
  var FREQ = [['1', 'Annual'], ['2', 'Semi-annual'], ['4', 'Quarterly'], ['12', 'Monthly'], ['365', 'Daily'], ['c', 'Continuous']];
  var rt = { rate: '4.00', from: '2', tenor: '5', tunit: 'y', amt: '1m', notional: '10m', dur: '4.5', move: '10', cpn: '4.25', yrs: '10', bfreq: '2', yld: '4.40', px: '' };
  function toCont(r, f) { return f === 'c' ? r : +f * Math.log(1 + r / +f); }
  function fromCont(rc, f) { return f === 'c' ? rc : +f * (Math.exp(rc / +f) - 1); }
  function bond(cpn, yrs, fq, y) {   // price per 100 and modified duration, on a coupon date
    var n = Math.round(yrs * fq), c = cpn * 100 / fq, r = y / fq, pv = 0, dur = 0;
    for (var k = 1; k <= n; k++) { var cf = c + (k === n ? 100 : 0), df = Math.pow(1 + r, -k); pv += cf * df; dur += (k / fq) * cf * df; }
    return { price: pv, mod: (dur / pv) / (1 + r) };
  }
  function ratesHTML() {
    var r = parseNum(rt.rate) / 100, rc = toCont(r, rt.from);
    var dv01 = parseNum(rt.notional) * parseNum(rt.dur) * 0.0001, mv = parseNum(rt.move);
    var cpn = parseNum(rt.cpn) / 100, yrs = parseNum(rt.yrs), fq = +rt.bfreq, y = parseNum(rt.yld) / 100, b = bond(cpn, yrs, fq, y);
    return '<h3 class="th">COMPOUNDING</h3><div class="f"><div class="two"><label>Rate %<input id="rt-rate" inputmode="decimal" value="' + esc(rt.rate) + '"></label>' +
      '<label>Compounded<select id="rt-from">' + FREQ.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === rt.from ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label></div></div>' +
      '<table class="mt">' + FREQ.map(function (x) { return '<tr><td>' + x[1] + '</td><td>' + (isFinite(rc) ? fmt(fromCont(rc, x[0]) * 100, 4) + '%' : '—') + '</td></tr>'; }).join('') + '</table>' +
      '<div class="f"><div class="two"><label>Tenor<span class="solve"><input id="rt-tenor" inputmode="decimal" value="' + esc(rt.tenor) + '"><select id="rt-tunit" style="max-width:6.5rem">' +
        [['d', 'days'], ['m', 'months'], ['y', 'years']].map(function (u) { return '<option value="' + u[0] + '"' + (u[0] === rt.tunit ? ' selected' : '') + '>' + u[1] + '</option>'; }).join('') + '</select></span></label>' +
      '<label>Amount (optional)<input id="rt-amt" inputmode="decimal" value="' + esc(rt.amt) + '"></label></div></div>' +
      (function () {
        var T = parseNum(rt.tenor) / (rt.tunit === 'd' ? 365 : rt.tunit === 'm' ? 12 : 1), A = parseNum(rt.amt);
        if (!(T > 0) || !isFinite(rc)) return '';
        var tot = Math.exp(rc * T) - 1, simple = r * T;
        return '<table class="mt"><tr><td>Total compounded over ' + esc(rt.tenor) + ' ' + ({ d: 'days', m: 'months', y: 'years' })[rt.tunit] + '</td><td>' + fmt(tot * 100, 4) + '%</td></tr>' +
          '<tr><td>Simple interest, same tenor</td><td>' + fmt(simple * 100, 4) + '%</td></tr>' +
          '<tr><td>Compounding effect</td><td>' + fmt((tot - simple) * 100, 4) + '%</td></tr>' +
          (isFinite(A) && A ? '<tr><td>' + fmt(A, 0) + ' grows to</td><td>' + fmt(A * (1 + tot), 2) + '</td></tr><tr><td>Interest earned</td><td>' + fmt(A * tot, 2) + '</td></tr>' : '') + '</table>';
      })() +
      '<p class="small">Days use a 365-day year. Every rate in the table above gives the same total over the tenor.</p>' +
      '<h3 class="th">DV01 / BASIS-POINT VALUE</h3><div class="f"><div class="two"><label>Notional<input id="rt-notional" inputmode="decimal" value="' + esc(rt.notional) + '"></label>' +
      '<label>Modified duration<input id="rt-dur" inputmode="decimal" value="' + esc(rt.dur) + '"></label></div>' +
      '<label>Move (bp)<input id="rt-move" inputmode="decimal" value="' + esc(rt.move) + '"></label></div>' +
      '<table class="mt"><tr><td>Value of 1bp</td><td>' + fmt(dv01, 2) + '</td></tr><tr><td>P&amp;L for ' + esc(rt.move) + 'bp</td><td>' + fmt(dv01 * mv, 2) + '</td></tr></table>' +
      '<h3 class="th">BOND PRICE ↔ YIELD</h3><div class="f"><div class="two"><label>Coupon %<input id="rt-cpn" inputmode="decimal" value="' + esc(rt.cpn) + '"></label>' +
      '<label>Years to maturity<input id="rt-yrs" inputmode="decimal" value="' + esc(rt.yrs) + '"></label></div>' +
      '<div class="two"><label>Coupons per year<select id="rt-bfreq"><option value="1"' + (rt.bfreq === '1' ? ' selected' : '') + '>1</option><option value="2"' + (rt.bfreq === '2' ? ' selected' : '') + '>2</option><option value="4"' + (rt.bfreq === '4' ? ' selected' : '') + '>4</option></select></label>' +
      '<label>Yield %<input id="rt-yld" inputmode="decimal" value="' + esc(rt.yld) + '"></label></div>' +
      '<label>Or price (per 100) → yield<span class="solve"><input id="rt-px" inputmode="decimal" value="' + esc(rt.px) + '" placeholder="e.g. 98.75"><button type="button" class="btn" data-act2="px2y">Yield</button></span></label></div>' +
      '<table class="mt"><tr><td>Price (per 100)</td><td>' + fmt(b.price, 4) + '</td></tr><tr><td>Modified duration</td><td>' + fmt(b.mod, 3) + '</td></tr>' +
      '<tr><td>Value of 1bp per 1m face</td><td>' + fmt(b.price / 100 * 1e6 * b.mod * 0.0001, 2) + '</td></tr></table>' +
      '<p class="small">Bond figures assume settlement on a coupon date (no accrued interest).</p>';
  }
  function priceToYield() {
    var px = parseNum(rt.px), cpn = parseNum(rt.cpn) / 100, yrs = parseNum(rt.yrs), fq = +rt.bfreq;
    if (!isFinite(px)) { flash('Enter a price first.'); return; }
    var lo = -0.05, hi = 1;
    for (var i = 0; i < 200; i++) { var mid = (lo + hi) / 2; if (bond(cpn, yrs, fq, mid).price > px) lo = mid; else hi = mid; }
    rt.yld = (((lo + hi) / 2) * 100).toFixed(4); draw();
  }

  // ---------- % CHANGE ----------
  var pc = { a: '1.2850', b: '1.2915', yrs: '', jpy: false };
  function pcHTML() {
    var a = parseNum(pc.a), b = parseNum(pc.b), d = b - a, yrs = parseNum(pc.yrs);
    var rows = [['Change', fmt(d)], ['% change', fmt(d / a * 100, 4) + '%'],
      ['In bp (if these are rates in %)', fmt(d * 100, 2) + 'bp'],
      ['In pips (FX)', fmt(d * (pc.jpy ? 100 : 10000), 1) + ' pips']];
    if (isFinite(yrs) && yrs > 0) rows.push(['Annualised (CAGR) over ' + esc(pc.yrs) + 'y', fmt((Math.pow(b / a, 1 / yrs) - 1) * 100, 4) + '%']);
    return '<div class="f"><div class="two"><label>From<input id="pc-a" inputmode="decimal" value="' + esc(pc.a) + '"></label>' +
      '<label>To<input id="pc-b" inputmode="decimal" value="' + esc(pc.b) + '"></label></div>' +
      '<div class="two"><label>Years (for CAGR, optional)<input id="pc-yrs" inputmode="decimal" value="' + esc(pc.yrs) + '"></label>' +
      '<label>Pip size<select id="pc-jpy"><option value="0"' + (!pc.jpy ? ' selected' : '') + '>0.0001 (most pairs)</option><option value="1"' + (pc.jpy ? ' selected' : '') + '>0.01 (JPY pairs)</option></select></label></div></div>' +
      '<table class="mt">' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + (isFinite(a) && isFinite(b) ? r[1] : '—') + '</td></tr>'; }).join('') + '</table>';
  }

  // ---------- PACE (running) ----------
  var MI = 1.609344;
  var pace = { unit: 'km', dist: '2.4', time: '', pace: '3:00', speed: '', src: 'pace' };
  function toSec(v) {   // "h:mm:ss", "mm:ss" or plain minutes ("7.5")
    v = String(v || '').trim(); if (!v) return NaN;
    if (v.indexOf(':') < 0) return parseFloat(v) * 60;
    var p = v.split(':').map(Number), sec = 0;
    if (p.some(isNaN)) return NaN;
    p.forEach(function (x) { sec = sec * 60 + x; });
    return sec;
  }
  function hms(sec, withH) {
    if (!isFinite(sec) || sec < 0) return '';
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60;
    return (h || withH ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
  }
  function paceSec() {   // seconds per unit, from pace or speed (whichever was typed last)
    if (pace.src === 'speed') { var sp = parseFloat(pace.speed); return sp > 0 ? 3600 / sp : NaN; }
    return toSec(pace.pace);
  }
  function paceSolve(which) {
    var d = parseFloat(pace.dist), t = toSec(pace.time), ps = paceSec();
    if (which === 'time') { if (!(d > 0 && ps > 0)) return flash('Enter distance and pace (or speed).'); pace.time = hms(d * ps, d * ps >= 3600); }
    else if (which === 'dist') { if (!(t > 0 && ps > 0)) return flash('Enter time and pace (or speed).'); pace.dist = String(+(t / ps).toFixed(3)); }
    else { if (!(d > 0 && t > 0)) return flash('Enter distance and time.'); ps = t / d; }
    pace.pace = hms(ps); pace.speed = String(+(3600 / ps).toFixed(2)); pace.src = 'pace';
    draw();
  }
  function setUnit(u) {   // convert what's there when switching km <-> miles
    if (u === pace.unit) return;
    var f = u === 'mi' ? 1 / MI : MI, d = parseFloat(pace.dist), ps = paceSec();
    if (d > 0) pace.dist = String(+(d * f).toFixed(3));
    if (ps > 0) { ps = ps / f; pace.pace = hms(ps); pace.speed = String(+(3600 / ps).toFixed(2)); pace.src = 'pace'; }
    pace.unit = u; draw();
  }
  function paceHTML() {
    var U = pace.unit, other = U === 'km' ? 'mi' : 'km', f = U === 'km' ? 1 / MI : MI;
    var d = parseFloat(pace.dist), t = toSec(pace.time), ps = paceSec();
    var PRESETS = [['2.4 km', 2.4], ['5K', 5], ['10K', 10], ['Half', 21.0975], ['Full', 42.195]];
    var rows = [];
    if (d > 0) rows.push(['Distance', fmt(d, 3) + ' ' + U + '  ·  ' + fmt(d * f, 3) + ' ' + other]);
    if (t > 0) rows.push(['Time', hms(t, t >= 3600)]);
    if (ps > 0) {
      rows.push(['Pace', hms(ps) + ' /' + U + '  ·  ' + hms(U === 'km' ? ps * MI : ps / MI) + ' /' + other]);
      rows.push(['Speed', fmt(3600 / ps, 2) + (U === 'km' ? ' km/h' : ' mph') + '  ·  ' + fmt(U === 'km' ? 3600 / ps / MI : 3600 / ps * MI, 2) + (U === 'km' ? ' mph' : ' km/h')]);
    }
    return '<div class="f"><label>Units<select id="pc2-unit"><option value="km"' + (U === 'km' ? ' selected' : '') + '>Metric (km)</option><option value="mi"' + (U === 'mi' ? ' selected' : '') + '>Imperial (miles)</option></select></label>' +
      '<div class="presets">' + PRESETS.map(function (x) { return '<button type="button" class="chip" data-preset="' + x[1] + '">' + x[0] + '</button>'; }).join('') + '</div>' +
      '<label>Distance (' + U + ')<span class="solve"><input id="pc2-dist" inputmode="decimal" value="' + esc(pace.dist) + '"><button type="button" class="btn" data-pace="dist">Solve</button></span></label>' +
      '<label>Time (h:mm:ss or mm:ss)<span class="solve"><input id="pc2-time" inputmode="numbers-and-punctuation" value="' + esc(pace.time) + '" placeholder="e.g. 7:12 or 1:45:00"><button type="button" class="btn" data-pace="time">Solve</button></span></label>' +
      '<label>Pace (min:sec per ' + U + ')<span class="solve"><input id="pc2-pace" inputmode="numbers-and-punctuation" value="' + esc(pace.pace) + '" placeholder="e.g. 4:30"><button type="button" class="btn" data-pace="pace">Solve</button></span></label>' +
      '<label>or Speed (' + (U === 'km' ? 'km/h' : 'mph') + ')<input id="pc2-speed" inputmode="decimal" value="' + esc(pace.speed) + '" placeholder="e.g. 12"></label></div>' +
      (rows.length ? '<table class="mt">' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' : '') +
      '<p class="small">Fill in any two of distance, time and pace (or speed), then tap Solve on the one you want. Pace and speed are the same thing in different units; whichever you typed last is used.</p>';
  }

  // ---------- SG TAX & CPF (employee, age 55 and below, Singapore Citizen / 3rd-year+ PR) ----------
  // CPF Board 2026: employee 20%, employer 17%; Ordinary Wage ceiling $8,000/month; annual limit $102,000 (OW + AW).
  // IRAS resident rates from YA2024 onwards. Earned Income Relief $1,000 (under 55). Reliefs capped at $80,000.
  var CPF = { emp: 0.20, er: 0.17, owCap: 8000, annual: 102000 };
  var BANDS = [[20000, 0], [30000, 2], [40000, 3.5], [80000, 7], [120000, 11.5], [160000, 15], [200000, 18], [240000, 19],
               [280000, 19.5], [320000, 20], [500000, 22], [1000000, 23], [Infinity, 24]];
  var sg = { salary: '10,000', months: '12', bonus: '30,000', other: '0', rebate: '0', rebateCap: '0' };
  function sgTax(ci) {
    var tax = 0, lo = 0, marg = 0;
    for (var i = 0; i < BANDS.length; i++) {
      var hi = BANDS[i][0], r = BANDS[i][1] / 100;
      if (ci > lo) { tax += (Math.min(ci, hi) - lo) * r; marg = BANDS[i][1]; }
      lo = hi;
    }
    return { tax: tax, marginal: ci > 0 ? marg : 0 };
  }
  function sgCalc(over) {
    var S = parseNum(sg.salary) || 0, M = parseNum(sg.months) || 12, B = parseNum(sg.bonus) || 0, other = parseNum(sg.other) || 0;
    if (over && over.bonus != null) B = over.bonus;
    var owSub = Math.min(S, CPF.owCap) * M, awSub = Math.max(0, Math.min(B, CPF.annual - owSub));
    var empCPF = CPF.emp * (owSub + awSub), erCPF = CPF.er * (owSub + awSub);
    var gross = S * M + B;
    var reliefs = Math.min(80000, 1000 + empCPF + other), ci = Math.max(0, gross - reliefs);
    var t = sgTax(ci), reb = Math.min(t.tax * (parseNum(sg.rebate) || 0) / 100, parseNum(sg.rebateCap) || 0), tax = Math.max(0, t.tax - reb);
    return { S: S, M: M, B: B, owSub: owSub, awSub: awSub, empCPF: empCPF, erCPF: erCPF, gross: gross, reliefs: reliefs, ci: ci,
             taxBefore: t.tax, rebate: reb, tax: tax, marginal: t.marginal, net: gross - empCPF - tax,
             monthlyCPF: CPF.emp * Math.min(S, CPF.owCap) };
  }
  function sgHTML() {
    var r = sgCalc(), $$ = function (v) { return '$' + fmt(v, 0); };
    var row = function (k, v, b) { return '<tr><td>' + (b ? '<b>' + k + '</b>' : k) + '</td><td>' + (b ? '<b>' + v + '</b>' : v) + '</td></tr>'; };
    var h = '<div class="f"><div class="two"><label>Monthly salary<input id="sg-salary" inputmode="decimal" value="' + esc(sg.salary) + '"></label>' +
      '<label>Bonus for the year<input id="sg-bonus" inputmode="decimal" value="' + esc(sg.bonus) + '"></label></div></div>';

    // headline figures
    h += '<div class="sgsum"><div><span>Take-home / yr</span><b>' + $$(r.net) + '</b><i>' + $$(r.net / (r.M || 12)) + ' a month</i></div>' +
      '<div><span>Income tax</span><b>' + $$(r.tax) + '</b><i>' + fmt(r.gross ? r.tax / r.gross * 100 : 0, 1) + '% of income</i></div>' +
      '<div><span>Your CPF</span><b>' + $$(r.empCPF) + '</b><i>+ ' + $$(r.erCPF) + ' employer</i></div></div>';

    // what if the bonus (or other variable pay) changes
    var base = r, deltas = [-20000, -10000, 0, 10000, 25000, 50000, 100000];
    h += '<h3 class="th">WHAT IF YOUR BONUS CHANGES</h3><div class="tblwrap"><table class="mt sgt"><tr><td>Bonus</td><td>Income</td><td>Tax</td><td>Eff.</td><td>Top</td><td>Take-home</td><td>Keep of extra</td></tr>' +
      deltas.map(function (d) {
        var nb = base.B + d; if (nb < 0) return '';
        var x = d ? sgCalc({ bonus: nb }) : base, dg = x.gross - base.gross;
        var keep = d ? fmt((x.net - base.net) / dg * 100, 0) + '%' : '—';
        return '<tr' + (d ? '' : ' class="hl"') + '><td>' + (d ? (d > 0 ? '+' : '−') + '$' + fmt(Math.abs(d) / 1000, 0) + 'k' : 'Now') + '</td><td>' + $$(x.gross) + '</td><td>' + $$(x.tax) + '</td>' +
          '<td>' + fmt(x.gross ? x.tax / x.gross * 100 : 0, 1) + '%</td><td>' + fmt(x.marginal, 1) + '%</td><td>' + $$(x.net) + '</td><td>' + keep + '</td></tr>';
      }).join('') + '</table></div>' +
      '<p class="small">"Keep of extra" = how much of the extra (or lost) income stays with you after tax and CPF. Bonus above the yearly CPF limit attracts no CPF, so you keep more of it in cash.</p>';

    // the bands, with yours highlighted
    var lo = 0, cum = 0;
    h += '<h3 class="th">TAX BANDS (YOU: ' + $$(r.ci) + ' CHARGEABLE)</h3><table class="mt sgt"><tr><td>Chargeable income</td><td>Rate</td><td>Tax at top of band</td></tr>' +
      BANDS.map(function (bd) {
        var hi = bd[0], mine = r.ci > lo && r.ci <= hi || (r.ci === 0 && lo === 0);
        if (isFinite(hi)) cum += (hi - lo) * bd[1] / 100;
        var label = isFinite(hi) ? '$' + fmt(lo / 1000, 0) + 'k – $' + fmt(hi / 1000, 0) + 'k' : 'Above $1m';
        var out = '<tr' + (mine ? ' class="hl"' : '') + '><td>' + label + (mine ? ' ◀' : '') + '</td><td>' + bd[1] + '%</td><td>' + (isFinite(hi) ? $$(cum) : '—') + '</td></tr>';
        lo = hi; return out;
      }).join('') + '</table>';

    // details, folded away
    h += '<details class="sched"><summary>Full breakdown and settings</summary>' +
      '<div class="f"><div class="two"><label>Months paid<input id="sg-months" inputmode="decimal" value="' + esc(sg.months) + '"></label>' +
      '<label>Other reliefs<input id="sg-other" inputmode="decimal" value="' + esc(sg.other) + '"></label></div>' +
      '<div class="two"><label>Tax rebate % (if announced)<input id="sg-rebate" inputmode="decimal" value="' + esc(sg.rebate) + '"></label>' +
      '<label>Rebate cap $<input id="sg-rebateCap" inputmode="decimal" value="' + esc(sg.rebateCap) + '"></label></div></div>' +
      '<table class="mt">' + row('Your CPF each month', $$(r.monthlyCPF)) + row('Take-home each month before tax', $$(r.S - r.monthlyCPF)) +
      row('Bonus subject to CPF', $$(r.awSub) + (r.awSub < r.B ? ' (of ' + $$(r.B) + ')' : '')) +
      row('Employment income', $$(r.gross)) + row('Reliefs ($1,000 earned income + your CPF' + (parseNum(sg.other) ? ' + other' : '') + ')', '−' + $$(r.reliefs)) +
      row('Chargeable income', $$(r.ci)) + (r.rebate ? row('Tax before rebate', $$(r.taxBefore)) + row('Rebate', '−' + $$(r.rebate)) : '') +
      row('Estimated tax', $$(r.tax), true) + '</table>' +
      '<p class="small">Estimate for a Singapore tax resident aged 55 or below (citizen or 3rd-year+ PR). CPF 2026: 20% you, 17% employer, on salary up to $8,000 a month and total wages up to $102,000 a year. ' +
      'Tax: IRAS resident rates from YA2024 onwards (income in 2026 is taxed in YA2027); reliefs capped at $80,000. No personal tax rebate has been announced for YA2026 or YA2027.</p></details>';
    return h;
  }

  // ---------- INTEREST: loans and deposits ----------
  var ln = { amt: '1,000,000', rate: '3.5', tenor: '5', unit: 'y', freq: '12', type: 'annuity', basis: '365' };
  var LN_TYPES = [['annuity', 'Amortising, equal instalments (like a mortgage)'], ['linear', 'Amortising, equal principal'],
                  ['bullet', 'Non-amortising (interest only, principal at end)'], ['simple', 'Simple interest, paid at maturity']];
  function lnCalc() {
    var A = parseNum(ln.amt), R = parseNum(ln.rate) / 100, n0 = parseNum(ln.tenor), f = +ln.freq;
    if (!(A > 0) || !isFinite(R) || !(n0 > 0)) return null;
    var years = ln.unit === 'd' ? n0 / 365 : ln.unit === 'm' ? n0 / 12 : n0;
    if (ln.type === 'simple') {
      var days = ln.unit === 'd' ? n0 : Math.round(years * 365), interest = A * R * days / +ln.basis;
      return { simple: true, days: days, interest: interest, total: A + interest, rows: [] };
    }
    var N = Math.round(years * f);
    if (N < 1) return { err: 'The tenor is shorter than one payment period. Pick a shorter frequency or use simple interest.' };
    var r = R / f, bal = A, rows = [], pay = 0;
    if (ln.type === 'annuity') pay = Math.abs(r) < 1e-12 ? A / N : A * r / (1 - Math.pow(1 + r, -N));
    for (var k = 1; k <= N; k++) {
      var int = bal * r, prin = ln.type === 'annuity' ? pay - int : ln.type === 'linear' ? A / N : (k === N ? bal : 0);
      if (k === N) prin = bal;   // clear any rounding left on the last payment
      bal -= prin;
      rows.push([k, int + prin, int, prin, Math.max(0, bal)]);
    }
    var ti = rows.reduce(function (t, x) { return t + x[2]; }, 0);
    return { N: N, rows: rows, interest: ti, total: A + ti, first: rows[0][1], last: rows[rows.length - 1][1], periodInt: A * r };
  }
  function lnHTML() {
    var c = lnCalc(), PER = { '12': 'month', '4': 'quarter', '2': 'half-year', '1': 'year' }, per = PER[ln.freq];
    var sel = function (id, opts, v) { return '<select id="' + id + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === v ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'; };
    var h = '<div class="f"><label>Type' + sel('ln-type', LN_TYPES, ln.type) + '</label>' +
      '<div class="two"><label>Amount<input id="ln-amt" inputmode="decimal" value="' + esc(ln.amt) + '"></label>' +
      '<label>Rate % per year<input id="ln-rate" inputmode="decimal" value="' + esc(ln.rate) + '"></label></div>' +
      '<div class="two"><label>Tenor<span class="solve"><input id="ln-tenor" inputmode="decimal" value="' + esc(ln.tenor) + '">' +
        sel('ln-unit', [['d', 'days'], ['m', 'months'], ['y', 'years']], ln.unit) + '</span></label>' +
      (ln.type === 'simple'
        ? '<label>Day count' + sel('ln-basis', [['365', 'ACT/365 (SGD, GBP, HKD)'], ['360', 'ACT/360 (USD, EUR, most others)']], ln.basis) + '</label>'
        : '<label>Payments' + sel('ln-freq', [['12', 'Monthly'], ['4', 'Quarterly'], ['2', 'Semi-annual'], ['1', 'Annual']], ln.freq) + '</label>') +
      '</div></div>';
    if (!c) return h + '<p class="small">Enter an amount, rate and tenor.</p>';
    if (c.err) return h + '<p class="err">' + esc(c.err) + '</p>';
    var $$ = function (v) { return fmt(v, 2); };
    var row = function (k, v, b) { return '<tr><td>' + (b ? '<b>' + k + '</b>' : k) + '</td><td>' + (b ? '<b>' + v + '</b>' : v) + '</td></tr>'; };
    if (c.simple) return h + '<table class="mt">' + row('Days', fmt(c.days, 0)) + row('Interest at maturity', $$(c.interest), true) +
      row('Total repaid', $$(c.total)) + '</table><p class="small">Interest = amount × rate × days / ' + ln.basis + '. Months and years are converted at 365 days a year.</p>';
    h += '<table class="mt">' +
      (ln.type === 'annuity' ? row('Payment each ' + per, $$(c.first), true)
        : ln.type === 'linear' ? row('First payment', $$(c.first), true) + row('Last payment', $$(c.last))
        : row('Interest each ' + per, $$(c.periodInt), true) + row('Final payment (interest + principal)', $$(c.last))) +
      row('Number of payments', fmt(c.N, 0)) + row('Total interest', $$(c.interest), true) + row('Total paid', $$(c.total)) + '</table>';
    h += '<details class="sched"><summary>Payment schedule (' + c.N + ' payments)</summary><table class="mt sch"><tr><td>#</td><td>Payment</td><td>Interest</td><td>Principal</td><td>Balance</td></tr>' +
      c.rows.map(function (x) { return '<tr><td>' + x[0] + '</td><td>' + $$(x[1]) + '</td><td>' + $$(x[2]) + '</td><td>' + $$(x[3]) + '</td><td>' + $$(x[4]) + '</td></tr>'; }).join('') + '</table></details>' +
      '<p class="small">Interest each period = balance × rate ÷ payments per year. Figures are unrounded estimates; your bank may round each payment.</p>';
    return h;
  }

  // ---------- shell ----------
  var TOOLS = [['calc', 'Calc'], ['fx', 'FX'], ['tvm', 'TVM'], ['rates', 'Rates'], ['pct', '% Chg'], ['loan', 'Interest'], ['sgtax', 'Tax'], ['pace', 'Pace']];
  function chipsHTML() {
    return TOOLS.map(function (t) { return '<button class="chip" type="button" data-tool="' + t[0] + '" aria-pressed="' + (tool === t[0]) + '">' + t[1] + '</button>'; }).join('');
  }
  function draw() {
    if (!root) return;
    var focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
    var pos = focused && document.activeElement.selectionStart;
    root.innerHTML = '<div class="toolsbox">' + (tool === 'calc' ? calcHTML() : tool === 'fx' ? fxHTML() : tool === 'tvm' ? tvmHTML() : tool === 'rates' ? ratesHTML() : tool === 'pace' ? paceHTML() : tool === 'sgtax' ? sgHTML() : tool === 'loan' ? lnHTML() : pcHTML()) + '<div id="tmsg" class="err" hidden></div></div>';
    var ch = document.getElementById('chist'); if (ch) ch.scrollTop = ch.scrollHeight;
    if (focused && document.getElementById(focused)) {   // keep typing position while results update
      var el = document.getElementById(focused); el.focus();
      try { if (pos != null) el.setSelectionRange(pos, pos); } catch (e) {}
    }
  }
  function flash(m) { var e = document.getElementById('tmsg'); if (e) { e.textContent = m; e.hidden = false; } }
  function onInput(e) {
    var id = e.target.id; if (!id) return;
    if (e.target.tagName === 'INPUT' && e.target.getAttribute('inputmode') === 'decimal') liveFormat(e.target);
    var v = e.target.value;
    if (id === 'fx-amt') fxAmt = v; else if (id === 'fx-from') fxFrom = v;
    else if (id.indexOf('tvm-') === 0) { var k = id.slice(4); if (k === 'BG') tvm.BEGIN = v === '1'; else tvm[k] = v; return; }   // TVM recalculates on Solve only
    else if (id.indexOf('rt-') === 0) rt[id.slice(3)] = v;
    else if (id.indexOf('sg-') === 0) sg[id.slice(3)] = v;
    else if (id.indexOf('ln-') === 0) ln[id.slice(3)] = v;
    else if (id === 'pc2-unit') return setUnit(v);
    else if (id.indexOf('pc2-') === 0) { var pk = id.slice(4); pace[pk] = v; if (pk === 'pace' || pk === 'speed') pace.src = pk; return; }   // recalculated on Solve
    else if (id === 'pc-jpy') pc.jpy = v === '1';
    else if (id.indexOf('pc-') === 0) pc[id.slice(3)] = v;
    else return;
    draw();
  }
  function onClick(e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k) return press(b.dataset.k);
    if (b.dataset.solve) return tvmSolve(b.dataset.solve);
    if (b.dataset.pace) return paceSolve(b.dataset.pace);
    if (b.dataset.preset) { var km = +b.dataset.preset; pace.dist = String(+(pace.unit === 'km' ? km : km / MI).toFixed(3)); draw(); return; }
    if (b.dataset.tape) { var t = tape[+b.dataset.tape]; if (t) { expr += String(+t.r.toPrecision(12)); draw(); } return; }
    if (b.dataset.copy) { if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy.replace(/,/g, '')).catch(function () {}); return; }
    if (b.dataset.act2 === 'tape-clear') { tape = []; onTape([]); draw(); return; }
    if (b.dataset.act2 === 'px2y') return priceToYield();
  }
  return {
    init: function (el, mktGetter, tapeSaver) {
      root = el; getMkt = mktGetter; if (tapeSaver) onTape = tapeSaver;
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      root.addEventListener('beforeinput', function (e) {
        var el = e.target;
        if (e.inputType !== 'deleteContentBackward' || el.tagName !== 'INPUT' || el.getAttribute('inputmode') !== 'decimal') return;
        var a = el.selectionStart, b = el.selectionEnd;
        if (a !== b || a < 2 || el.value[a - 1] !== ',') return;
        e.preventDefault();
        el.value = el.value.slice(0, a - 2) + el.value.slice(a - 1);
        try { el.setSelectionRange(a - 2, a - 2); } catch (x) {}
        onInput({ target: el });
      });
      root.addEventListener('change', onInput);
    },
    chips: chipsHTML,
    setTape: function (list) { tape = (list || []).filter(function (t) { return t && isFinite(t.r); }).slice(0, TAPE_MAX); ans = tape.length ? tape[0].r : 0; },
    select: function (t) { tool = t; draw(); },
    draw: draw,
    _test: { ln: ln, lnCalc: lnCalc, sg: sg, sgCalc: sgCalc, sgTax: sgTax, groupStr: groupStr, groupExpr: groupExpr, liveFormat: liveFormat, rt: rt, ratesHTML: ratesHTML, pace: pace, paceSolve: paceSolve, setUnit: setUnit, toSec: toSec, hms: hms, evaluate: evaluate, parseNum: parseNum, tvmSolve: tvmSolve, tvm: tvm, bond: bond, toCont: toCont, fromCont: fromCont }
  };
})();
