// GlenCal vault: entries are encrypted on this device and never leave it.
//
// A random 256-bit data key (DEK) encrypts the entries with AES-GCM. The DEK is stored only in
// wrapped (encrypted) form, twice:
//   1. under a key derived from a passkey's PRF output (Face ID), or from a passphrase (PBKDF2);
//   2. under a key derived from a one-time recovery code the user saves in the Passwords app.
// While locked, the DEK is not in memory. Locking happens whenever the app is hidden.

var Vault = (function () {
  var DB = 'glencal', STORE = 'kv', KEY = 'vault';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var dek = null;      // CryptoKey while unlocked
  var rec = null;      // stored record

  function rnd(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var q = db.transaction(STORE).objectStore(STORE).get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }
  function idbPut(k, v) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(v, k);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  async function hkdf(secret, info) {
    var base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function pbkdf2(pass, salt) {
    var base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: 600000 },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(key, bytes) {
    var iv = rnd(12);
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, bytes);
    return { iv: iv, ct: new Uint8Array(ct) };
  }
  async function open(key, box) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.ct));
  }
  function importDEK(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }

  // ---- recovery code: 100 random bits as 20 base32 characters, shown as XXXX-XXXX-XXXX-XXXX-XXXX ----
  var B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  // no 0/O/1/I/L, 31 symbols
  function newRecoveryCode() {
    var b = rnd(20), s = '';
    for (var i = 0; i < 20; i++) s += B32[b[i] % 31];
    return s.match(/.{4}/g).join('-');
  }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  // ---- passkey with the PRF extension (Face ID). The PRF output never leaves the device. ----
  function passkeySupported() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }
  async function prfGet(credId, salt) {
    var a = await navigator.credentials.get({ publicKey: {
      challenge: rnd(32), allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: salt } } } } });
    var r = a.getClientExtensionResults();
    if (!r.prf || !r.prf.results || !r.prf.results.first) throw new Error('NO_PRF');
    return new Uint8Array(r.prf.results.first);
  }
  async function passkeyCreate() {
    var salt = rnd(32);
    var cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'GlenCal' },
      user: { id: rnd(16), name: 'GlenCal', displayName: 'GlenCal' },
      challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } } } });
    var ext = cred.getClientExtensionResults();
    if (!ext.prf || ext.prf.enabled === false) throw new Error('NO_PRF');
    var credId = new Uint8Array(cred.rawId);
    var secret = ext.prf.results && ext.prf.results.first ? new Uint8Array(ext.prf.results.first) : await prfGet(credId, salt);
    return { credId: credId, salt: salt, secret: secret };
  }

  // Earlier copies: before each save, the previous copy is kept if the newest kept one is over 30 minutes old.
  // Up to 20 copies (roughly the last few days of use), encrypted with the same key.
  var HIST_GAP = 30 * 60000, HIST_MAX = 20;
  async function writeData(items) {
    var box = await seal(dek, enc.encode(JSON.stringify(items)));
    if (rec.data) {
      rec.hist = rec.hist || [];
      var last = rec.hist[rec.hist.length - 1];
      if (!last || Date.now() - last.at > HIST_GAP) { rec.hist.push({ at: rec.savedAt || Date.now(), box: rec.data }); if (rec.hist.length > HIST_MAX) rec.hist.shift(); }
    }
    rec.data = box; rec.savedAt = Date.now();
    await idbPut(KEY, rec);
  }

  return {
    // 'new' (nothing set up yet) or 'locked'
    status: async function () {
      rec = await idbGet(KEY);
      return rec ? 'locked' : 'new';
    },
    method: function () { return rec ? rec.method : null; },
    isUnlocked: function () { return !!dek; },
    passkeySupported: passkeySupported,

    // method: 'device' (no prompt), 'passkey' or 'passphrase'. Returns the recovery code to show once (null for 'device').
    create: async function (method, passphrase, initial) {
      if (method === 'device') {
        // Non-extractable key stored on this device only. Opens with no prompt.
        var key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        rec = { v: 1, method: 'device', created: new Date().toISOString(), deviceKey: key };
        dek = key;
        try { await writeData(initial || []); }
        catch (e) {   // browser can't store a key object: keep the raw key instead
          var r0 = rnd(32);
          rec = { v: 1, method: 'device', created: rec.created, deviceRaw: r0 };
          dek = await importDEK(r0);
          await writeData(initial || []);
        }
        try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
        return null;
      }
      var raw = rnd(32);
      var code = newRecoveryCode();
      var r = { v: 1, method: method, created: new Date().toISOString() };
      var kek;
      if (method === 'passkey') {
        var pk = await passkeyCreate();
        r.credId = pk.credId; r.prfSalt = pk.salt;
        kek = await hkdf(pk.secret, 'glencal-passkey');
      } else {
        r.pwSalt = rnd(16);
        kek = await pbkdf2(passphrase, r.pwSalt);
      }
      r.wrapPrimary = await seal(kek, raw);
      r.wrapRecovery = await seal(await hkdf(enc.encode(normCode(code)), 'glencal-recovery'), raw);
      rec = r;
      dek = await importDEK(raw);
      await writeData(initial || []);
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
      return code;
    },

    unlock: async function (passphrase) {
      rec = rec || await idbGet(KEY);
      if (rec.method === 'device') {
        dek = rec.deviceKey || await importDEK(rec.deviceRaw);
        return this.read();
      }
      var kek;
      if (rec.method === 'passkey') kek = await hkdf(await prfGet(rec.credId, rec.prfSalt), 'glencal-passkey');
      else kek = await pbkdf2(passphrase || '', rec.pwSalt);
      var raw;
      try { raw = await open(kek, rec.wrapPrimary); } catch (e) { throw new Error('WRONG'); }
      dek = await importDEK(raw);
      return this.read();
    },

    unlockWithRecovery: async function (code) {
      rec = rec || await idbGet(KEY);
      var raw;
      try { raw = await open(await hkdf(enc.encode(normCode(code)), 'glencal-recovery'), rec.wrapRecovery); }
      catch (e) { throw new Error('WRONG'); }
      dek = await importDEK(raw);
      return this.read();
    },

    // Switch how the same data is unlocked ('device', 'passkey' or 'passphrase'). Must be unlocked.
    rekey: async function (method, passphrase) {
      if (!dek) throw new Error('LOCKED');
      var items = await this.read();
      return this.create(method, passphrase, items);   // entries are written together with the new key, in one step
    },

    read: async function () {
      if (!dek) throw new Error('LOCKED');
      if (!rec.data) return [];
      return JSON.parse(dec.decode(await open(dek, rec.data)));
    },
    save: async function (items) {
      if (!dek) throw new Error('LOCKED');
      await writeData(items);
    },
    // Next weeks' lines for the evening notification, encrypted with the same key as the entries.
    writeDigest: async function (obj) {
      if (!dek) return;
      await idbPut('digest', await seal(dek, enc.encode(JSON.stringify(obj))));
    },
    // earlier copies, newest first: [{ at, data }]
    history: async function () {
      if (!dek) throw new Error('LOCKED');
      var out = [];
      for (var i = (rec.hist || []).length - 1; i >= 0; i--) {
        try { out.push({ at: rec.hist[i].at, data: JSON.parse(dec.decode(await open(dek, rec.hist[i].box))) }); } catch (e) {}
      }
      return out;
    },
    lock: function () { dek = null; }
  };
})();
