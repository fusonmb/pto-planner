/**
 * Google Sheets configuration for the Leave Planner.
 *
 * Copy to config.js and fill in.  config.js MUST be committed -- GitHub Pages
 * only serves files that are in the repo, so gitignoring it would break the
 * deployed app.  That is safe: an OAuth client ID and a browser API key are
 * public by design.  What protects them is the authorized JavaScript origin
 * on the OAuth client and the HTTP-referrer restriction on the API key, not
 * secrecy.  Never put a client *secret* here -- this app does not use one.
 *
 * Without config.js the planner runs exactly as before, on localStorage.
 *
 * Google Cloud setup:
 *   1. New project.  Enable the Google Sheets API, Google Drive API and
 *      Picker API.
 *   2. OAuth consent screen: External.  Add yourself and your spouse as test
 *      users.  Expect an "unverified app" warning until it is submitted for
 *      verification -- acceptable for two users.
 *   3. OAuth client (Web application).  Authorized JavaScript origins:
 *        https://fusonmb.github.io
 *        http://localhost:8799        (only if testing locally)
 *   4. API key, restricted by HTTP referrer to the same origins.
 *   5. Create a Google Sheet named exactly the fileName below, open
 *      Extensions > Apps Script, paste apps-script/Code.gs, and run setup().
 *   6. Share the Sheet with your spouse as Viewer or Editor -- Drive's own
 *      permissions are the app's permission model.  A Viewer sees the plan
 *      with every editing control disabled.
 *
 * The scope is drive.file, which reaches only files this app created or the
 * user explicitly picked.  That avoids Google's restricted-scope security
 * assessment.  The cost: a Sheet merely *shared* with your spouse stays
 * invisible to the app until she selects it once via "Pick a Sheet".  That
 * one-time step is the price of the narrow scope -- do not widen to
 * drive.readonly to avoid it.
 */
LeaveStore.configure({
  clientId: "YOUR-CLIENT-ID.apps.googleusercontent.com",
  apiKey: "YOUR-API-KEY",
  fileName: "Leave Planner",
});
