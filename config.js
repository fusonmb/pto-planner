/**
 * Google Sheets configuration for the Leave Planner.
 *
 * This file MUST be committed.  GitHub Pages only serves what is in the repo,
 * so gitignoring it would break the deployed app.  That is safe: an OAuth
 * client ID and a browser API key are public by design.  What protects them is
 * the authorized JavaScript origin on the OAuth client and the referrer +
 * API restrictions on the key -- not secrecy.  There is no client secret here;
 * this app does not use one.
 *
 * Restrictions in force for these values:
 *   OAuth client  origin  https://fusonmb.github.io   (no redirect URIs)
 *   API key       sites   https://fusonmb.github.io/*
 *                 APIs    Sheets, Drive, Picker only
 *   Consent       Testing, scope drive.file, two test users
 *
 * See config.example.js for the full Google Cloud walkthrough.
 */
LeaveStore.configure({
  clientId: "831104318690-6md9m3dq5l10t9ej6a4bv3u6grv6etnd.apps.googleusercontent.com",
  apiKey: "AIzaSyDAjBKhGHOnRs5StDSJeMQfNesIJ2GBTZ4",
  fileName: "Leave Planner",
});
