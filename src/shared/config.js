// Limits and defaults, in one place so the README and the listing can quote them.

export const LIMITS = {
  minInterval: 5, // minutes between checks of one watch: sites are not hammered
  maxInterval: 60 * 24 * 30,
  snapshotChars: 100000, // text kept per saved version of a page
  versions: 10, // saved versions per watch (the newest one is the current text)
  historyChars: 400000, // all saved versions of one watch together
  watches: 200,
  bodyBytes: 5 * 1024 * 1024, // a page bigger than this is not read
  fetchTimeoutMs: 20000, // below Firefox's 30 s event-page idle timeout
  hostGapMs: 1500, // pause between two checks on the same site
  parallelHosts: 3,
  retryMinutes: 10, // a check that could not connect is tried again this soon (first 3 times)
  nameChars: 120,
  urlChars: 2000,
  selectorChars: 1000,
  pendingMs: 10 * 60 * 1000, // how long an unfinished "watch one part" stays open
};

/** Offered in the interval menus, in minutes. */
export const INTERVALS = [5, 15, 30, 60, 180, 360, 720, 1440, 10080];

export const DEFAULT_SETTINGS = {
  interval: 60,
  notify: false, // desktop notifications, off until the user switches them on
};

export const KEYS = {
  watches: "watches",
  settings: "settings",
  pending: "pending",
  lastAdd: "lastAdd",
  stats: "stats",
  snap: (id) => "snap:" + id,
};

/** Problems a check can run into. `sticky` ones will not fix themselves. */
export const ERRORS = {
  permission: { sticky: true, short: "Needs access", text: "Heron no longer has access to this site. Give it back to keep checking." },
  missing: { sticky: true, short: "Part not found", text: "The watched part is not in the page any more. The site may have been rebuilt: pick the part again." },
  selector: { sticky: true, short: "Bad selector", text: "The CSS selector of this watch is not valid." },
  login: { sticky: true, short: "Needs sign-in", text: "This page sends visitors who are not signed in to a sign-in page. Heron checks without your cookies, so it can't see it." },
  blocked: { sticky: false, short: "Blocked", text: "The site refused the check (it wants a sign-in, or it blocks automatic requests)." },
  notfound: { sticky: false, short: "Not found", text: "The page was not found (it may have been moved or removed)." },
  server: { sticky: false, short: "Server error", text: "The site answered with a server error." },
  http: { sticky: false, short: "Error", text: "The site answered with an error." },
  network: { sticky: false, short: "Can't connect", text: "Could not connect to the site. If the address now forwards to another site, edit the watch to use the new address." },
  timeout: { sticky: false, short: "Timed out", text: "The site took too long to answer." },
  toobig: { sticky: true, short: "Too large", text: "The page is larger than 5 MB, so Heron does not read it." },
  type: { sticky: true, short: "Not text", text: "This address is not a text page (it may be an image, a PDF or a download)." },
};

/** Things worth telling the user about a watch that still works. */
export const WARNINGS = {
  partial: "Much of this page is drawn by JavaScript or shown only when signed in. Heron sees the HTML the server sends, so it may miss changes here.",
  thin: "The HTML the server sends for this page has almost no text. The page is probably drawn by JavaScript, so Heron may not see its changes.",
  differs: "In the HTML the server sends, this part reads differently from what you see in the page. Heron watches the server's version.",
  truncated: "This is a very long page: only its first 100,000 characters are watched.",
};
