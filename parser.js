// GlenCal fallback parser: turns plain text into dated bullet items.
// Runs entirely on the phone. Used when the on-device AI step is skipped or fails.
// Dates are read day-first (23/11 = 23 Nov).

var GC = (function () {
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  var MON_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\\.?';
  var DOW_WORDS = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|thur|sun|mon|tue|wed|thu|fri|sat';
  var DOW_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  var DAY_MS = 86400000;

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromISO(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function mkDate(y, m, d) { var x = new Date(y, m, d); return (x.getMonth() === m && x.getDate() === d) ? x : null; }

  // No year given: use this year, unless that is more than ~6 months ago, then next year.
  function guessYear(m, d, ref) {
    var x = mkDate(ref.getFullYear(), m, d);
    if (!x) return null;
    if (ref - x > 183 * DAY_MS) x = mkDate(ref.getFullYear() + 1, m, d);
    return x;
  }
  function fullYear(y) { y = +y; return y < 100 ? 2000 + y : y; }

  function to24(h, mi, ap) {
    if (h < 1 || h > 12 || mi > 59) return null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return pad(h) + ':' + pad(mi);
  }

  function extractTime(s) {
    var m = s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
    if (m) {
      var ap2 = m[6].toLowerCase();
      var ap1 = m[3] ? m[3].toLowerCase() : ap2;
      var a = to24(+m[1], +(m[2] || 0), ap1);
      var b = to24(+m[4], +(m[5] || 0), ap2);
      if (a && b && !m[3] && a > b) a = to24(+m[1], +(m[2] || 0), 'am'); // "11-1pm"
      if (a && b) return { time: a + '–' + b, rest: s.replace(m[0], ' ') };
    }
    m = s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
    if (m) {
      var t = to24(+m[1], +(m[2] || 0), m[3].toLowerCase());
      if (t) return { time: t, rest: s.replace(m[0], ' ') };
    }
    m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (m) return { time: pad(+m[1]) + ':' + m[2], rest: s.replace(m[0], ' ') };
    m = s.match(/\bnoon\b/i);
    if (m) return { time: '12:00', rest: s.replace(m[0], ' ') };
    return { time: '', rest: s };
  }

  function extractDate(s, ref) {
    var m, x = null, flag = '';
    if ((m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
      x = mkDate(+m[1], m[2] - 1, +m[3]);
    } else if ((m = s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MON_RE + '(?:,?\\s+(\\d{4}))?(?![a-z])', 'i')))) {
      var mo = MONTHS[m[2].toLowerCase()];
      x = m[3] ? mkDate(+m[3], mo, +m[1]) : guessYear(mo, +m[1], ref);
    } else if ((m = s.match(new RegExp('\\b' + MON_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?', 'i')))) {
      var mo2 = MONTHS[m[1].toLowerCase()];
      x = m[3] ? mkDate(+m[3], mo2, +m[2]) : guessYear(mo2, +m[2], ref);
    } else if ((m = s.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/))) {
      x = m[3] ? mkDate(fullYear(m[3]), m[2] - 1, +m[1]) : guessYear(m[2] - 1, +m[1], ref);
    } else if ((m = s.match(/\bday after (tomorrow|tmr|tmrw)\b/i))) {
      x = addDays(ref, 2);
    } else if ((m = s.match(/\b(today|tonight|tdy)\b/i))) {
      x = addDays(ref, 0);
    } else if ((m = s.match(/\b(tomorrow|tmr|tmrw|tml)\b/i))) {
      x = addDays(ref, 1);
    } else if ((m = s.match(new RegExp('\\b(next\\s+|this\\s+|coming\\s+)?(' + DOW_WORDS + ')\\b\\.?', 'i')))) {
      var want = DOW_INDEX[m[2].toLowerCase().slice(0, 3)];
      var diff = (want - ref.getDay() + 7) % 7;
      var pre = (m[1] || '').trim().toLowerCase();
      if (pre === 'next') {
        if (diff === 0) diff = 7;
        flag = '"' + m[0].trim() + '" could mean this week or next week. Check the date.';
      }
      x = addDays(ref, diff);
    }
    if (!m || !x) return { date: null, rest: s, flag: '' };
    var rest = s.replace(m[0], ' ');
    // drop a weekday word sitting next to an explicit date, e.g. "Mon 23 Nov"
    rest = rest.replace(new RegExp('^[\\s,(]*(' + DOW_WORDS + ')\\b\\.?[\\s,)]*', 'i'), ' ')
               .replace(new RegExp('[\\s,(]*\\b(' + DOW_WORDS + ')\\b\\.?[\\s,)]*$', 'i'), ' ');
    return { date: x, rest: rest, flag: flag };
  }

  // Light, safe cleanup of common texting shorthand. Names, numbers and places are never touched.
  var SHORTHAND = [
    [/\bw\/o\b/gi, 'without'], [/\bw\/(?=\s|$)/gi, 'with'], [/\bw\/(?=\S)/gi, 'with '],
    [/\b(w|wif)\b(?=\s)/gi, 'with'], [/\s\bn\b\s/gi, ' and '], [/\s&\s/g, ' and '],
    [/\babt\b/gi, 'about'], [/\bmtg\b/gi, 'meeting'], [/\bappt\b/gi, 'appointment'],
    [/\bbday\b/gi, 'birthday'], [/\bb4\b/gi, 'before'], [/\bppl\b/gi, 'people'],
    [/\bmsg\b/gi, 'message'], [/\bpls\b/gi, 'please'], [/\bthru\b/gi, 'through']
  ];
  function tidy(s) {
    SHORTHAND.forEach(function (r) { s = s.replace(r[0], r[1]); });
    return s.replace(/^\s*(need to|have to|gotta|must|remember to|rmb to|don't forget to|dont forget to|pls|please)\s+/i, '');
  }

  function cleanTitle(s) {
    s = tidy(' ' + s + ' ');
    for (var i = 0; i < 3; i++) {
      s = s.replace(/\(\s*\)/g, ' ')
           .replace(/^[\s\-*•·–—>,;:|]+/, '')
           .replace(/[\s\-–—,;:|(]+$/, '')
           .replace(/^(on|at|by|from|for|due)\b\s*/i, '')
           .replace(/\s+\b(on|at|by|from|for|due)$/i, '')
           .replace(/\s{2,}/g, ' ')
           .trim();
    }
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  // Parse pasted text line by line. A line holding only a date ("23 Nov") sets the
  // date for the undated lines under it, so "23 Nov / - Meet xxx" works.
  function parseText(text, ref) {
    ref = ref || new Date();
    ref = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
    var out = [], ctx = '';
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var raw = line.trim();
      if (!raw) return;
      var s = ' ' + raw.replace(/^[\-*•·–]+\s*/, '') + ' ';
      var t = extractTime(s); s = t.rest;
      var d = extractDate(s, ref); s = d.rest;
      var place = '';
      var pm = s.match(/@\s*([^,;]+)/);
      if (pm) { place = pm[1].trim(); s = s.replace(pm[0], ' '); }
      var title = cleanTitle(s);
      if (d.date && !title && !t.time) { ctx = iso(d.date); return; }
      if (!title) return;
      out.push({ title: title, date: d.date ? iso(d.date) : ctx, time: t.time, place: place, src: raw, flag: d.flag, cat: inferCat(title + ' ' + place) });
    });
    return out;
  }

  // "3pm", "15:30", "3-5pm" typed into a form -> stored "HH:MM" form; anything else kept as typed.
  function normTime(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (/^\d{2}:\d{2}(–\d{2}:\d{2})?$/.test(v)) return v;
    var t = extractTime(' ' + v + ' ');
    return t.time || v;
  }

  function fmtTime(t) {
    if (!t) return '';
    return String(t).split(/[-–]/).map(function (one) {
      var m = one.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return one.trim();
      var h = +m[1], h12 = h % 12 || 12;
      return h12 + (m[2] !== '00' ? ':' + m[2] : '') + (h < 12 ? 'am' : 'pm');
    }).join('–');
  }

  // ---- categories: one emoji each, checked in this order (first match wins) ----
  var CATS = [
    { id: 'festive', emoji: '🎄', name: 'Festive', words: 'christmas|xmas|x\'mas|new year|nye|cny|chinese new year|lunar new year|hari raya|deepavali|diwali|thanksgiving|easter|halloween|countdown' },
    { id: 'money', emoji: '💰', name: 'Money & admin', words: 'insurance|policy|premium|tax|taxes|iras|bill|bills|pay|payment|bank|credit card|loan|mortgage|cpf|invest|investment|renewal|renew|rent|salary|reimbursement|subscription|will|lawyer|notary' },
    { id: 'travel', emoji: '✈️', name: 'Travel', words: 'flight|fly|flying|trip|hotel|airport|check-in|vacation|holiday|staycation|ferry|passport|visa|airbnb|layover|sq\\d+|tr\\d+' },
    { id: 'health', emoji: '🩺', name: 'Health', words: 'doctor|dr|dentist|dental|clinic|hospital|screening|check-up|checkup|physio|physiotherapy|specialist|vaccine|vaccination|jab|blood test|scan|mri|x-ray|optometrist|eye test|therapy|therapist|pharmacy|medication|gp' },
    { id: 'fitness', emoji: '🏃', name: 'Fitness', words: 'gym|running|run club|jog|jogging|yoga|pilates|swim|swimming|tennis|badminton|football|futsal|cycling|spin class|hiit|workout|marathon|hike|hiking|climbing|bouldering|golf|personal training|pt session' },
    { id: 'celebrate', emoji: '🎉', name: 'Celebrations', words: 'birthday|bday|party|wedding|anniversary|celebration|engagement|baby shower|housewarming|farewell|reunion|graduation' },
    { id: 'food', emoji: '🍽️', name: 'Food & drinks', words: 'dinner|lunch|brunch|breakfast|supper|drinks|coffee|cafe|bar|restaurant|dim sum|bbq|buffet|omakase|tea|beer|wine|cocktails|eat|meal|makan|hawker|steak|sushi|ramen' },
    { id: 'work', emoji: '💼', name: 'Work', words: 'meeting|review|submit|submission|report|deadline|client|presentation|office|offsite|team|interview|forecast|quarterly|q[1-4]|board|deck|audit|sync|standup|stand-up|workshop|conference|training|webinar|project|proposal|memo|appraisal|performance|eod|kpi|budget' },
    { id: 'errands', emoji: '🛍️', name: 'Errands', words: 'haircut|hair|groceries|grocery|collect|collection|pick up|pickup|drop off|delivery|laundry|car service|servicing|repair|post office|shopping|buy|return|cleaner|cleaning|renovation|plumber|aircon' },
    { id: 'social', emoji: '👥', name: 'Social', words: 'meet|meetup|catch up|catchup|hangout|hang out|visit|movie|movies|concert|show|game|karaoke|ktv|gathering|playdate|church|wedding dinner' },
    { id: 'holiday', emoji: '🇸🇬', name: 'SG holidays', words: '' },
    { id: 'finance', emoji: '📈', name: 'ECON', words: '' },
    { id: 'bills', emoji: '💳', name: 'Finances', words: '' },
    { id: 'other', emoji: '📌', name: 'Other', words: '' }
  ];
  CATS.forEach(function (c) { c.re = c.words ? new RegExp("(^|[^a-z0-9'])(" + c.words + ")(?=$|[^a-z0-9'])", 'i') : null; });
  var CAT_BY_ID = {};
  CATS.forEach(function (c) { CAT_BY_ID[c.id] = c; });

  function inferCat(text) {
    var s = ' ' + String(text || '').toLowerCase() + ' ';
    for (var i = 0; i < CATS.length; i++) if (CATS[i].re && CATS[i].re.test(s)) return CATS[i].id;
    return 'other';
  }

  // true for a real calendar date written YYYY-MM-DD
  function fromISOok(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    return !!(m && mkDate(+m[1], m[2] - 1, +m[3]));
  }

  return { parseText: parseText, normTime: normTime, fmtTime: fmtTime, iso: iso, fromISO: fromISO, fromISOok: fromISOok, addDays: addDays,
           CATS: CATS, CAT_BY_ID: CAT_BY_ID, inferCat: inferCat };
})();

if (typeof module !== 'undefined') module.exports = GC;
