/**
 * Leave Planner — Google Sheets storage.
 *
 * The app's calc engine is synchronous and reads/writes through loadData()
 * and saveData().  Rewriting it to be async would touch every save path, so
 * this store keeps that contract instead:
 *
 *   hydrate()  pull the Sheet into an in-memory cache (async, once at start)
 *   read()     the cache, synchronously — what loadData() returns
 *   write(d)   update the cache and localStorage now, push to the Sheet after
 *
 * localStorage is always written, so a failed or absent Sheet degrades to the
 * old behaviour rather than losing edits.  The Sheet is the source of truth
 * when reachable; a hand-edit made in the Sheets mobile app is picked up on
 * the next hydrate().
 *
 * Credentials below are public by design — an OAuth client ID and a
 * referrer-restricted API key.  The authorized JavaScript origin is what
 * protects them.  No secrets belong in this repo.
 */
"use strict";

var LeaveStore = (function () {

  var CLIENT_ID = "";      // set in config.js, or left blank for local-only
  var API_KEY = "";
  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var PICKER_POLL_MS = 100;      // gapi arrives async; poll for it
  var SIGNIN_TIMEOUT_MS = 120000;  // backstop; error_callback is primary
  var PICKER_TIMEOUT_MS = 10000;
  var FILE_NAME = "Leave Planner";
  var STORE_KEY = "leavePlannerData";
  var FILE_ID_KEY = "leavePlannerFileId";
  var TOKEN_KEY = "leavePlannerToken";
  var TOKEN_MARGIN_MS = 60000;   // treat as expired a minute early
  var APP_ID = null;             // defaults to the client id prefix

  var SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
  var DRIVE = "https://www.googleapis.com/drive/v3";

  var TAB = { config: "Config", types: "LeaveTypes", leave: "Leave",
              holidays: "Holidays" };

  var state = {
    mode: "local",        // 'local' until a Sheet is opened
    token: null,
    fileId: null,
    canEdit: true,
    revision: null,       // Drive headRevisionId seen at last read
    cache: null,
    types: [],
    pending: null,        // in-flight flush, so saves serialize
    dirty: false,
    onStatus: function () {},
  };

  // ---------------------------------------------------------------- helpers

  function log(kind, msg) { state.onStatus({ kind: kind, message: msg }); }

  function iso(d) { return d.toISOString().slice(0, 10); }

  function isoOf(v) {
    if (v instanceof Date) return iso(v);
    var s = String(v || "").trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[0];
    // Sheets may hand back a locale date string; parse defensively
    var d = new Date(s);
    return isNaN(d) ? "" : iso(d);
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function emptyData() {
    return { entries: {}, holidays: {}, removedHolidays: [],
             anchor: null, hireDate: null, birthDate: null };
  }

  function localRead() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : emptyData();
    } catch (e) { return emptyData(); }
  }

  function localWrite(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch (e) { log("error", "Could not write local storage: " + e.message); }
  }

  // ------------------------------------------------------------------ auth

  var tokenClient = null;

  function configured() { return !!(CLIENT_ID && API_KEY); }

  /* GIS delivers success on `callback` but popup problems -- blocked, closed,
     dismissed -- on `error_callback`.  Wiring only the former means a blocked
     popup never settles the promise: the UI simply hangs with no error at
     all.  Both are routed to whichever sign-in is currently waiting. */
  var pendingAuth = null;

  /**
   * Google issues an access token good for about an hour but no refresh
   * token, and the token was previously kept in memory only -- so every page
   * load started with nothing and had to ask again.  On a desktop that ask
   * is invisible, because a live Google session answers it silently.  A
   * phone often cannot: browser privacy rules block the quiet path, and the
   * user gets a popup every single time.
   *
   * Keeping the token until it actually expires removes that ask on both.
   * It does sit in localStorage, which is a real trade -- but the plan data
   * is already there, and the token reaches nothing beyond the one Sheet
   * this app was granted, so it exposes no more than is already present.
   */
  function saveToken(token, expiresInSec) {
    var ttl = (Number(expiresInSec) || 3600) * 1000;
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify({
        token: token, expiresAt: Date.now() + ttl,
      }));
    } catch (e) { /* private mode: fall back to memory only */ }
  }

  function savedToken() {
    try {
      var raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.token) return null;
      if (Date.now() + TOKEN_MARGIN_MS >= o.expiresAt) return null;
      return o.token;
    } catch (e) { return null; }
  }

  function dropToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  function initAuth() {
    if (!configured()) return false;
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      return false;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPE,
      callback: function (resp) { if (pendingAuth) pendingAuth.ok(resp); },
      error_callback: function (err) { if (pendingAuth) pendingAuth.fail(err); },
    });
    return true;
  }

  function authErrorMessage(err) {
    var type = err && err.type;
    if (type === "popup_failed_to_open") {
      return "Google's sign-in popup was blocked — allow popups for this "
           + "site and try again.";
    }
    if (type === "popup_closed") {
      return "Google sign-in was closed before it finished.";
    }
    return "Google sign-in failed" + (type ? " (" + type + ")." : ".");
  }

  function signIn(opts) {
    opts = opts || {};
    if (!state.token) {
      var saved = savedToken();
      if (saved) state.token = saved;
    }
    if (state.token) return Promise.resolve(state.token);
    return new Promise(function (resolve, reject) {
      if (!tokenClient && !initAuth()) {
        // distinguish "no credentials" from "the Google library never loaded"
        reject(new Error(configured()
          ? "Google sign-in did not load — check your connection and reload."
          : "Google sign-in is not configured."));
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        settle(function () {
          reject(new Error(
            "Google sign-in did not respond — check for a blocked popup, "
            + "then try again."));
        });
      }, SIGNIN_TIMEOUT_MS);

      function settle(fn) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingAuth = null;
        fn();
      }

      pendingAuth = {
        ok: function (resp) {
          settle(function () {
            if (resp && resp.error) { reject(new Error(resp.error)); return; }
            state.token = resp.access_token;
            saveToken(resp.access_token, resp.expires_in);
            resolve(resp.access_token);
          });
        },
        fail: function (err) {
          settle(function () { reject(new Error(authErrorMessage(err))); });
        },
      };
      tokenClient.requestAccessToken({ prompt: opts.silent ? "" : "consent" });
    });
  }

  /**
   * Reuse an existing grant before asking for anything.  prompt:"consent"
   * re-shows the whole permission screen even when the user granted it long
   * ago, so an explicit click used to mean clicking through Google every
   * single time.  Try silently first and only escalate when the quiet
   * attempt says interaction is genuinely required -- never after the user
   * has just closed the popup themselves, which would reopen it in their
   * face.
   */
  function authenticate(opts) {
    if (opts.silent) return signIn({ silent: true });
    return signIn({ silent: true }).catch(function (err) {
      if (/closed before it finished/i.test(err.message)) throw err;
      return signIn({ silent: false });
    });
  }

  function signOut() {
    if (state.token && window.google && google.accounts) {
      google.accounts.oauth2.revoke(state.token, function () {});
    }
    state.token = null;
    dropToken();
    state.mode = "local";
    state.fileId = null;
    log("info", "Signed out — using this browser's local copy.");
  }

  function api(url, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers.Authorization = "Bearer " + state.token;
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(url, {
      method: opts.method || "GET", headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) {
        state.token = null;
        dropToken();
        throw new Error("Google sign-in expired — sign in again.");
      }
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("Google API " + res.status + ": " + t.slice(0, 200));
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  // ------------------------------------------------------------- file open

  function rememberedFile() {
    try { return localStorage.getItem(FILE_ID_KEY); } catch (e) { return null; }
  }

  function forgetFile() {
    try { localStorage.removeItem(FILE_ID_KEY); } catch (e) { /* ignore */ }
  }

  /* A file the picker granted once is reachable straight away.  If that
     grant has since gone -- file deleted, un-shared, or a different Google
     account signed in -- drop it and fall back to the name search rather
     than failing the whole connect on a stale id. */
  function openOwn() {
    var remembered = rememberedFile();
    if (!remembered) return searchByName();
    return useFile(remembered).catch(function () {
      forgetFile();
      return searchByName();
    });
  }

  function searchByName() {
    var q = encodeURIComponent(
      "name='" + FILE_NAME + "' and mimeType=" +
      "'application/vnd.google-apps.spreadsheet' and trashed=false");
    return api(DRIVE + "/files?q=" + q + "&fields=files(id,name)")
      .then(function (r) {
        if (r.files && r.files.length) return r.files[0].id;
        throw new Error(
          'No Sheet named "' + FILE_NAME + '" that this app can see. ' +
          "Create it, or use Pick a Sheet to select one shared with you.");
      })
      .then(function (id) {
        return useFile(id).catch(function (err) {
          // drive.file lists a file the app may still not open: the classic
          // hand-made Sheet that has never been through the picker.
          if (/\b40[34]\b/.test(err.message)) {
            throw new Error(
              'Found "' + FILE_NAME + '" but this app cannot open it yet. '
              + 'Click "Pick a Sheet" and select it once to grant access.');
          }
          throw err;
        });
      });
  }

  /**
   * drive.file only grants access to files this app created or the user
   * explicitly picked, so a Sheet merely *shared* with someone is invisible
   * until they select it once here.  That one-time step is the cost of not
   * requesting a restricted scope — it is not a bug to route around.
   */
  /**
   * api.js defines gapi, but the Picker is a *module* that only exists after
   * gapi.load("picker") has run -- nothing did that, so google.picker was
   * always undefined and "Pick a Sheet" could never open.  Both Google
   * scripts are async/defer, so gapi itself may not be there yet when the
   * button is clicked; wait for it rather than failing the first attempt.
   */
  function loadPicker() {
    if (window.google && window.google.picker) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var waited = 0;
      (function wait() {
        if (window.gapi && window.gapi.load) {
          window.gapi.load("picker", {
            callback: function () {
              if (window.google && window.google.picker) resolve();
              else reject(new Error("Google Picker failed to initialise."));
            },
            onerror: function () {
              reject(new Error("Google Picker failed to load."));
            },
          });
          return;
        }
        waited += PICKER_POLL_MS;
        if (waited > PICKER_TIMEOUT_MS) {
          reject(new Error(
            "Google's picker script did not load \u2014 check your connection "
            + "or any script blocker, then try again."));
          return;
        }
        setTimeout(wait, PICKER_POLL_MS);
      })();
    });
  }

  function pickShared() {
    return loadPicker().then(function () { return pickFrom(); });
  }

  /**
   * The Picker only ties its grant to *this* app when it is told the app id
   * (the Cloud project number).  Without it the pick appears to succeed and
   * grants nothing, so the drive.file scope still cannot open the file and
   * the follow-up files.get returns a bare 404 -- which is exactly what a
   * hand-made Sheet looked like.  The project number is the numeric prefix
   * of the OAuth client id, so it never has to be configured separately.
   */
  function appId() {
    if (APP_ID) return APP_ID;
    var m = /^(\d+)-/.exec(CLIENT_ID || "");
    return m ? m[1] : null;
  }

  function pickFrom() {
    return new Promise(function (resolve, reject) {
      var view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(false).setSelectFolderEnabled(false);
      var builder = new google.picker.PickerBuilder()
        .setOAuthToken(state.token).setDeveloperKey(API_KEY)
        .addView(view);
      var app = appId();
      if (app) builder.setAppId(app);
      builder
        .setCallback(function (d) {
          if (d.action === google.picker.Action.PICKED) {
            resolve(useFile(d.docs[0].id));
          } else if (d.action === google.picker.Action.CANCEL) {
            reject(new Error("No Sheet selected."));
          }
        })
        .build().setVisible(true);
    });
  }

  /* Verify first, then remember.  Storing the id up front left a bad one
     behind whenever the open failed, so the next connect retried a file it
     already knew it could not read. */
  function useFile(id) {
    return api(DRIVE + "/files/" + id +
               "?fields=id,name,headRevisionId,capabilities(canEdit)")
      .then(function (meta) {
        state.fileId = id;
        try { localStorage.setItem(FILE_ID_KEY, id); } catch (e) { /* ignore */ }
        state.canEdit = !!(meta.capabilities && meta.capabilities.canEdit);
        state.revision = meta.headRevisionId || null;
        state.mode = "sheet";
        log("info", state.canEdit
          ? 'Connected to "' + meta.name + '" sheet.'
          : 'Connected to "' + meta.name + '" sheet — read-only '
            + '(you are a Viewer).');
        return id;
      });
  }

  // ------------------------------------------------------------------ read

  function batchGet(ranges) {
    var qs = ranges.map(function (r) {
      return "ranges=" + encodeURIComponent(r);
    }).join("&");
    return api(SHEETS + "/" + state.fileId + "/values:batchGet?" + qs +
               "&valueRenderOption=UNFORMATTED_VALUE" +
               "&dateTimeRenderOption=FORMATTED_STRING");
  }

  function grid(res, i) {
    var vr = res.valueRanges && res.valueRanges[i];
    return (vr && vr.values) || [];
  }

  function count(o) { return Object.keys(o || {}).length; }

  /**
   * A Sheet with no leave rows, against a browser that has a plan, is a
   * first connection -- not an instruction to erase the plan.  Overwriting
   * localStorage here would destroy both copies at once, which is the one
   * unrecoverable failure in this design.
   */
  function needsSeeding(fromSheet, fromLocal) {
    return count(fromSheet.entries) === 0 && count(fromLocal.entries) > 0;
  }

  /** Pull the whole Sheet into the app's data shape. */
  function hydrate() {
    if (state.mode !== "sheet") {
      state.cache = localRead();
      return Promise.resolve(state.cache);
    }
    return batchGet([TAB.config, TAB.types, TAB.leave, TAB.holidays])
      .then(function (res) {
        var data = emptyData();
        readConfigInto(grid(res, 0), data);
        state.types = readTypes(grid(res, 1));
        readLeaveInto(grid(res, 2), state.types, data);
        readHolidaysInto(grid(res, 3), data);

        var local = localRead();
        if (needsSeeding(data, local)) {
          if (!state.canEdit) {
            // a Viewer on an empty Sheet: show what this browser has rather
            // than a blank plan, and touch nothing
            state.cache = local;
            log("info", "This Sheet has no leave yet — showing this "
                      + "browser's copy. You have Viewer access, so it "
                      + "cannot be uploaded.");
            return state.cache;
          }
          // the one-time migration: this browser's plan becomes the Sheet's
          state.cache = local;
          state.dirty = true;
          log("info", "Moving this browser's plan into the Sheet…");
          return flush().then(function () {
            log("saved", "Plan migrated to Google Sheets.");
            return state.cache;
          });
        }

        state.cache = data;
        localWrite(data);            // keep the offline fallback current
        return data;
      })
      .then(refreshRevision);
  }

  function readConfigInto(rows, data) {
    var cfg = {};
    for (var i = 1; i < rows.length; i++) {
      var k = String(rows[i][0] || "").trim();
      if (k) cfg[k] = rows[i][1];
    }
    if (cfg.hireDate) data.hireDate = isoOf(cfg.hireDate) || null;
    if (cfg.childBirthDate) data.birthDate = isoOf(cfg.childBirthDate) || null;
    var aDate = cfg.anchorSunday ? isoOf(cfg.anchorSunday) : "";
    if (aDate && cfg.anchorBalance !== "" && cfg.anchorBalance !== undefined) {
      data.anchor = { date: aDate, balance: num(cfg.anchorBalance) };
    }
  }

  function readTypes(rows) {
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[0]) continue;
      out.push({
        key: String(r[0]).trim(), label: String(r[1] || r[0]).trim(),
        color: r[2], model: String(r[3] || "").trim(),
        grantHours: r[9], wholeHoursOnly: r[11] === true || r[11] === "TRUE",
        active: r[12] === true || r[12] === "TRUE",
      });
    }
    return out;
  }

  /** Which entry field a type feeds — mirrors fieldOf_() in Code.gs. */
  function fieldOf(type) {
    if (type.model === "biweekly") return "b";
    if (type.model === "grant") return "nr";
    return null;
  }

  function activeTypes(types) {
    return types.filter(function (t) { return t.active && t.key; });
  }

  function readLeaveInto(rows, types, data) {
    var act = activeTypes(types);
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var d = isoOf(r[0]);
      if (!d) continue;
      var day = data.entries[d] || { b: 0, nr: 0, label: "" };
      for (var c = 0; c < act.length; c++) {
        var f = fieldOf(act[c]);
        var h = num(r[1 + c]);
        if (f && h) day[f] = Math.round((day[f] + h) * 100) / 100;
      }
      var label = r[1 + act.length];
      if (label) day.label = String(label).slice(0, 80);
      if (day.b || day.nr || day.label) data.entries[d] = day;
    }
  }

  function readHolidaysInto(rows, data) {
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var d = isoOf(r[0]);
      if (!d) continue;
      var source = String(r[2] || "custom").trim().toLowerCase();
      if (source === "removed") {
        if (data.removedHolidays.indexOf(d) < 0) data.removedHolidays.push(d);
        delete data.holidays[d];
      } else if (source === "custom") {
        data.holidays[d] = String(r[1] || "Holiday");
      }
      // 'builtin' rows are a mirror of the hardcoded list; the app already
      // has them, so they are read for display only
    }
  }

  // ------------------------------------------------------------ pulling

  /**
   * Has the Sheet moved since this tab last read it?
   *
   * Drive can push change notifications, but only to a public HTTPS endpoint
   * it can call -- a server.  This app is static files on GitHub Pages, so
   * there is nothing to push to and pulling is the only option.  One Drive
   * field is cheap enough to ask for whenever the tab is looked at.
   *
   * Resolves to one of:
   *   local     -- not connected to a Sheet at all
   *   unchanged -- the Sheet is exactly where we left it
   *   changed   -- the Sheet moved and this tab has nothing unsaved
   *   conflict  -- the Sheet moved AND this tab has unsaved edits
   */
  function pollRemote() {
    if (state.mode !== "sheet" || !state.fileId) {
      return Promise.resolve({ state: "local" });
    }
    return api(DRIVE + "/files/" + state.fileId + "?fields=headRevisionId")
      .then(function (m) {
        var rev = m.headRevisionId || null;
        if (!rev || rev === state.revision) return { state: "unchanged" };
        if (state.dirty || state.pending) {
          return { state: "conflict", revision: rev };
        }
        return { state: "changed", revision: rev };
      });
  }

  /**
   * Re-read the Sheet if it has moved.  Refuses by default when this tab has
   * unsaved edits: overwriting them would lose work that exists nowhere
   * else.  force:true is the user answering "yes, discard mine".
   */
  function pull(opts) {
    opts = opts || {};
    return pollRemote().then(function (r) {
      var may = r.state === "changed" || (opts.force && r.state === "conflict");
      if (!may) return r;
      if (opts.force) state.dirty = false;   // deliberately discarding
      return hydrate()
        .then(refreshRevision)
        .then(function () {
          log("info", "Updated from the Sheet.");
          return { state: "pulled" };
        });
    });
  }

  // ----------------------------------------------------------------- write

  function refreshRevision() {
    if (state.mode !== "sheet") return Promise.resolve(state.cache);
    return api(DRIVE + "/files/" + state.fileId + "?fields=headRevisionId")
      .then(function (m) {
        state.revision = m.headRevisionId || null;
        return state.cache;
      });
  }

  /**
   * Advisory conflict check.  There is a window between this read and the
   * write that follows, so it catches a spouse's edit made minutes ago, not
   * one made in the same second.  That is adequate for two people who rarely
   * edit at once, and this design should not be stretched further.
   */
  function assertUnchanged() {
    if (!state.revision) return Promise.resolve();
    return api(DRIVE + "/files/" + state.fileId + "?fields=headRevisionId")
      .then(function (m) {
        if (m.headRevisionId && m.headRevisionId !== state.revision) {
          throw new Error("CONFLICT");
        }
      });
  }

  function leaveRows(data, types) {
    var act = activeTypes(types);
    var head = ["Date"]
      .concat(act.map(function (t) { return t.label || t.key; }))
      .concat(["Label", "Updated"]);
    var stamp = new Date().toISOString();
    var dates = Object.keys(data.entries).sort();
    var body = dates.map(function (d) {
      var e = data.entries[d];
      var row = [d];
      for (var i = 0; i < act.length; i++) {
        var f = fieldOf(act[i]);
        row.push(f ? (e[f] || 0) : 0);
      }
      row.push(e.label || "");
      row.push(stamp);
      return row;
    });
    return [head].concat(body);
  }

  function holidayRows(data) {
    var head = ["Date", "Name", "Source"];
    var body = [];
    Object.keys(data.holidays).sort().forEach(function (d) {
      body.push([d, data.holidays[d], "custom"]);
    });
    data.removedHolidays.slice().sort().forEach(function (d) {
      body.push([d, "", "removed"]);
    });
    return [head].concat(body);
  }

  function configRows(data) {
    var out = [["Key", "Value", "Notes"]];
    if (data.hireDate) out.push(["hireDate", data.hireDate, ""]);
    if (data.birthDate) out.push(["childBirthDate", data.birthDate, ""]);
    if (data.anchor) {
      out.push(["anchorSunday", data.anchor.date, ""]);
      out.push(["anchorBalance", data.anchor.balance, ""]);
    }
    return out;
  }

  /**
   * Whole-tab rewrite: clear, then write.  Chosen over tracking row indices
   * because a hand-edit in the Sheets mobile app would desynchronize any
   * index we held.  The cost is that a save clobbers a simultaneous manual
   * edit, which the revision check above is there to catch.
   */
  function pushAll() {
    var data = state.cache;
    var payload = {
      valueInputOption: "RAW",
      data: [
        { range: TAB.leave, values: leaveRows(data, state.types) },
        { range: TAB.holidays, values: holidayRows(data) },
      ],
    };
    var cfg = configRows(data);
    if (cfg.length > 1) payload.data.push({ range: TAB.config, values: cfg });

    return assertUnchanged()
      .then(function () {
        // clear the ranges first so deleted rows actually disappear
        return api(SHEETS + "/" + state.fileId + "/values:batchClear", {
          method: "POST",
          body: { ranges: [TAB.leave + "!A2:Z", TAB.holidays + "!A2:Z"] },
        });
      })
      .then(function () {
        return api(SHEETS + "/" + state.fileId + "/values:batchUpdate", {
          method: "POST", body: payload,
        });
      })
      .then(refreshRevision)
      .then(function () { state.dirty = false; log("saved", "Saved to Google Sheets."); });
  }

  // ------------------------------------------------------------ public API

  function read() {
    if (!state.cache) state.cache = localRead();
    return state.cache;
  }

  /** Synchronous for the calc engine; the Sheet write trails behind. */
  function write(data) {
    state.cache = data;
    localWrite(data);
    if (state.mode !== "sheet") return;
    if (!state.canEdit) { log("error", "Read-only: not saved to the Sheet."); return; }
    state.dirty = true;
    schedulePush();
  }

  var timer = null;
  function schedulePush() {
    if (timer) clearTimeout(timer);
    // coalesce a burst of day-by-day saves into one Sheet write
    timer = setTimeout(function () { timer = null; flush(); }, 800);
  }

  function flush() {
    if (state.mode !== "sheet" || !state.dirty || !state.canEdit) {
      return Promise.resolve();
    }
    if (state.pending) return state.pending.then(flush);
    state.pending = pushAll()
      .catch(function (err) {
        if (err.message === "CONFLICT") {
          log("conflict", "The Sheet changed elsewhere. Your edit is saved in "
                        + "this browser but not pushed — reload to merge.");
        } else {
          log("error", "Could not save to the Sheet: " + err.message
                     + " (your edit is saved in this browser).");
        }
      })
      .then(function () { state.pending = null; });
    return state.pending;
  }

  function connect(opts) {
    opts = opts || {};
    if (!configured()) {
      return Promise.reject(new Error(
        "Google Sheets is not configured — add config.js with a client ID."));
    }
    return authenticate(opts)
      .then(function () { return opts.pick ? pickShared() : openOwn(); })
      .then(hydrate);
  }

  return {
    configure: function (o) {
      CLIENT_ID = o.clientId || CLIENT_ID;
      API_KEY = o.apiKey || API_KEY;
      FILE_NAME = o.fileName || FILE_NAME;
      APP_ID = o.appId || APP_ID;
    },
    onStatus: function (fn) { state.onStatus = fn; },
    connect: connect,
    signOut: signOut,
    hydrate: hydrate,
    pollRemote: pollRemote,
    pull: pull,
    read: read,
    write: write,
    flush: flush,
    isSheet: function () { return state.mode === "sheet"; },
    storeKey: function () { return STORE_KEY; },
    hasRememberedSheet: function () { return !!rememberedFile(); },
    isDirty: function () { return !!(state.dirty || state.pending); },
    canEdit: function () { return state.canEdit; },
    configured: configured,
    // exposed for tests
    _internals: { readLeaveInto: readLeaveInto, readHolidaysInto: readHolidaysInto,
                  readConfigInto: readConfigInto, readTypes: readTypes,
                  leaveRows: leaveRows, holidayRows: holidayRows,
                  emptyData: emptyData, isoOf: isoOf,
                  loadPicker: loadPicker, pickShared: pickShared,
                  useFile: useFile, openOwn: openOwn,
                  forgetFile: forgetFile, rememberedFile: rememberedFile,
                  resetAuth: function () {
                    tokenClient = null; pendingAuth = null;
                    state.token = null; dropToken();
                  },
                  appId: appId, pickFrom: pickFrom,
                  authenticate: authenticate,
                  savedToken: savedToken, saveToken: saveToken,
                  dropToken: dropToken,
                  needsSeeding: needsSeeding },
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LeaveStore;
