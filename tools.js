// GlenCal TOOLS: calculator with tape, FX converter, TVM, rates, % change. Works offline; nothing is stored or sent.
var Tools = (function () {
  'use strict';
  var root = null, tool = 'calc', getMkt = function () { return null; };
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
  var KEYS = ['C', '⌫', '%', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '(', '0', '.', ')', '±', 'ANS', '^', '='];
  function calcHTML() {
    var preview = '';
    if (expr) { try { preview = fmt(evaluate(expr, ans)); } catch (e) { preview = ''; } }
    return '<div class="calc">' +
      '<div class="cdisp"><div class="cexpr">' + esc(expr || ' ') + '</div><button type="button" class="cres" data-copy="' + esc(preview) + '" aria-label="Copy result">' + esc(preview || (expr ? '…' : '0')) + '</button></div>' +
      '<div class="ckeys">' + KEYS.map(function (k) {
        var cls = k === '=' ? ' eq' : /[÷×−+^%()]/.test(k) ? ' op' : (k === 'C' || k === '⌫' || k === '±' || k === 'ANS') ? ' fn' : '';
        return '<button type="button" class="ck2' + cls + '" data-k="' + esc(k) + '">' + esc(k) + '</button>';
      }).join('') + '</div>' +
      '<div class="tapehead"><span>TAPE</span>' + (tape.length ? '<button type="button" class="btn link" data-act2="tape-clear">Clear</button>' : '') + '</div>' +
      '<div class="tape">' + (tape.length ? tape.map(function (t, n) {
        return '<button type="button" class="tl" data-tape="' + n + '"><span class="te">' + esc(t.e) + '</span><span class="tr2">= ' + esc(fmt(t.r)) + '</span></button>';
      }).join('') : '<p class="small">Your workings appear here. Tap a line to reuse its result. Shorthand: 10m, 2.5k, 1bn.</p>') + '</div></div>';
  }
  function press(k) {
    if (k === 'C') expr = '';
    else if (k === '⌫') expr = expr.slice(0, -1);
    else if (k === '±') expr = expr ? '−(' + expr + ')' : '−';
    else if (k === 'ANS') expr += 'ans';
    else if (k === '=') {
      if (!expr) return;
      try { var r = evaluate(expr, ans); tape.unshift({ e: expr.replace(/ans/g, fmt(ans)), r: r }); tape = tape.slice(0, 50); ans = r; expr = String(+r.toPrecision(12)); }
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
  var fxAmt = '1,000,000', fxFrom = 'USD';
  function usdValues() {
    var m = getMkt(), u = { USD: 1 };
    ((m && m.items) || []).forEach(function (q) { var p = PAIRS[q.k]; if (p && q.price) u[p[0]] = p[1] === 'dir' ? q.price : 1 / q.price; });
    return { u: u, when: m && m.updated };
  }
  function fxHTML() {
    var v = usdValues(), amt = parseNum(fxAmt), list = ORDER.filter(function (c) { return v.u[c]; });
    if (list.length < 2) return '<p class="empty">No rates yet. Open the app online once so the latest rates can load.</p>';
    if (list.indexOf(fxFrom) < 0) fxFrom = 'USD';
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
  var tvm = { N: '120', IY: '3.5', PV: '500000', PMT: '', FV: '0', PY: '12', BEGIN: false };
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
    tvm[which] = String(+res.toPrecision(10));
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
  var rt = { rate: '4.00', from: '2', notional: '10m', dur: '4.5', move: '10', cpn: '4.25', yrs: '10', bfreq: '2', yld: '4.40', px: '' };
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

  // ---------- shell ----------
  var TOOLS = [['calc', 'Calc'], ['fx', 'FX'], ['tvm', 'TVM'], ['rates', 'Rates'], ['pct', '% Chg']];
  function chipsHTML() {
    return TOOLS.map(function (t) { return '<button class="chip" type="button" data-tool="' + t[0] + '" aria-pressed="' + (tool === t[0]) + '">' + t[1] + '</button>'; }).join('');
  }
  function draw() {
    if (!root) return;
    var focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
    var pos = focused && document.activeElement.selectionStart;
    root.innerHTML = '<div class="toolsbox">' + (tool === 'calc' ? calcHTML() : tool === 'fx' ? fxHTML() : tool === 'tvm' ? tvmHTML() : tool === 'rates' ? ratesHTML() : pcHTML()) + '<div id="tmsg" class="err" hidden></div></div>';
    if (focused && document.getElementById(focused)) {   // keep typing position while results update
      var el = document.getElementById(focused); el.focus();
      try { if (pos != null) el.setSelectionRange(pos, pos); } catch (e) {}
    }
  }
  function flash(m) { var e = document.getElementById('tmsg'); if (e) { e.textContent = m; e.hidden = false; } }
  function onInput(e) {
    var id = e.target.id; if (!id) return;
    var v = e.target.value;
    if (id === 'fx-amt') fxAmt = v; else if (id === 'fx-from') fxFrom = v;
    else if (id.indexOf('tvm-') === 0) { var k = id.slice(4); if (k === 'BG') tvm.BEGIN = v === '1'; else tvm[k] = v; return; }   // TVM recalculates on Solve only
    else if (id.indexOf('rt-') === 0) rt[id.slice(3)] = v;
    else if (id === 'pc-jpy') pc.jpy = v === '1';
    else if (id.indexOf('pc-') === 0) pc[id.slice(3)] = v;
    else return;
    draw();
  }
  function onClick(e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k) return press(b.dataset.k);
    if (b.dataset.solve) return tvmSolve(b.dataset.solve);
    if (b.dataset.tape) { var t = tape[+b.dataset.tape]; if (t) { expr += String(+t.r.toPrecision(12)); draw(); } return; }
    if (b.dataset.copy) { if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy.replace(/,/g, '')).catch(function () {}); return; }
    if (b.dataset.act2 === 'tape-clear') { tape = []; draw(); return; }
    if (b.dataset.act2 === 'px2y') return priceToYield();
  }
  return {
    init: function (el, mktGetter) {
      root = el; getMkt = mktGetter;
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      root.addEventListener('change', onInput);
    },
    chips: chipsHTML,
    select: function (t) { tool = t; draw(); },
    draw: draw,
    _test: { evaluate: evaluate, parseNum: parseNum, tvmSolve: tvmSolve, tvm: tvm, bond: bond, toCont: toCont, fromCont: fromCont }
  };
})();
