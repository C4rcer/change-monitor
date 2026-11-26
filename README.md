# Heron: Website Change Monitor

Firefox add-on (desktop) that watches web pages, or one part of a page, and
tells you when the text changes. Every check runs in the browser: no account,
no server, no cloud. Free, every feature unlocked, no ads, no tracking,
optional Ko-fi tip.

Why this one: the change monitor people actually use on AMO, Distill Web
Monitor (17k daily users), is freemium with a cloud account, and its AMO build
dates from 2023. Update Scanner (4k) was last updated in 2020 and Check4Change
(4k) sits at 3.6 stars. Heron uses only `fetch`, `alarms` and `storage`, so
there are no site-specific parts to break.

Desktop only: there is no Android emulator on the build machine, so nothing
could be tested on Firefox for Android, and two things Heron leans on (the
number on the toolbar button, and pointing at a part of the page with a mouse)
are desktop features. The manifest has no `gecko_android` block and the listing
says so.

Not part of YouTube/Twitch Enhancer: that add-on only runs on youtube.com and
twitch.tv, has no alarms, no notifications and nothing that watches pages.

## Features

- **Watch a whole page or one part.** "Watch this page" in the popup, or
  "Watch one part": point at the part on the page, click, done. Arrow up and
  down widen and narrow the selection, Esc cancels.
- **Checks on a schedule per watch**: 5, 15 or 30 minutes, 1, 3, 6 or 12 hours,
  a day, a week. One alarm, always set to the next due watch. Checks that were
  due while Firefox was closed run when it starts.
- **When something changes**: a number on the toolbar button (how many watches
  have something new), a "Changed" row in the popup with a one-line sample
  ("24.99 -> 19.99"), and a desktop notification if you switched that on. More than
  three changes in one run give one summary notification.
- **What changed**: a view per watch with the added text in green, the removed
  text in red, and the changed words marked inside an edited line. Unchanged
  text is folded away. The last 10 versions are kept.
- **The list**: last check, last change, pause and resume, check now, open the
  page, edit (name, address, part, interval) and delete (two clicks).
- **Export and import** of the watch list as a JSON file (names, addresses,
  parts, intervals; never page text).
- **Problems are shown, not hidden**: not found, server error, blocked, needs
  sign-in, can't connect, timed out, part not found, too large, not text. A
  watch that keeps failing puts a "!" on the toolbar button.

## How a check works

1. One `GET` for the page with `credentials: "omit"`, `cache: "no-store"` and
   `referrerPolicy: "no-referrer"`, 20 s time limit, at most 5 MB.
2. The bytes are decoded with the page's own character set (header, BOM or
   `<meta>`), then parsed with `DOMParser`: nothing in the page runs and nothing
   it links to is loaded.
3. Only readable text is kept, one line per block (paragraph, heading, list
   item, table row). Scripts, styles, `noscript`, iframes, form menus and
   blocks hidden in the markup are left out, so a new tracking token or a
   changed class name never counts as a change.
4. The text is compared with the last saved version. If it differs, the new
   text is saved as a new version and the watch is marked changed.
5. The differences are worked out when you look (Myers diff by line, then by
   word inside a line that was edited).

Plain text, JSON and feeds are watched as their lines of text. Images, PDFs and
downloads are refused ("Not text").

## What Heron can't see, and how it tells you

- **Parts drawn by JavaScript.** A background fetch gets the HTML the server
  sends; it does not open the page or run its scripts. When you pick a part,
  Heron fetches the page the way a check would and looks for that part in it.
  If it is missing, or is there but empty, it says so on the spot ("Heron can't
  see this part") and offers to pick another part or watch the whole page
  instead. For a whole page it compares what it fetched with the text you have
  on screen and warns when it found less than half of the words.
- **Pages behind a sign-in.** Not supported, on purpose. Checks never send
  cookies, so they can not act on an account, keep a session alive or trip a
  site's security alarms, and private pages never end up in the saved versions.
  A page that forwards signed-out visitors to a sign-in page is recognised and
  shown as "Needs sign-in".
- **Pictures and layout.** Only text is compared.
- **Anything while Firefox is closed.** Missed checks are caught up at startup.
- **Sites that refuse automatic requests** (403, 429): shown as "Blocked".
- **Noisy pages.** A whole page that prints the time or a different teaser on
  every load counts as changed every time. Pick the part you care about.

## Privacy and permissions

- Required: `alarms`, `storage`, `activeTab`, `scripting`. No site access at
  install.
- `optional_host_permissions: ["*://*/*"]` is only the ceiling Firefox needs to
  see in the manifest. What is actually asked for is `*://<that host>/*`, for
  the one site, at the moment a watch is added (popup, dashboard, import). When
  the last watch for a site is deleted, Heron removes that permission again.
- `notifications` is optional and asked for when the setting is switched on.
  Notifications are used for changes only.
- The manifest sets its own `extension_pages` CSP (`script-src 'self';
  object-src 'none'`). Firefox's MV3 default adds `upgrade-insecure-requests`,
  which silently turns every `http://` fetch into `https://`; loopback is
  exempt, so a test against 127.0.0.1 would never show it. The E2E watches an
  `http://` page on a non-loopback host name and has a control session without
  the CSP line, where the same check fails.
- The in-page picker runs only on a tab where the user pressed a button in the
  popup. Its overlay sits in a closed shadow root, is styled through the CSSOM
  only (works under a strict page CSP) and ignores untrusted (scripted) events.
- No data leaves the browser except the checks themselves, which go straight to
  the watched pages. `data_collection_permissions: none`.

## Limits

| What | Limit | Why |
| --- | --- | --- |
| Shortest interval | 5 minutes | sites are not hammered |
| Same site | one request at a time, 1.5 s apart, 3 sites side by side | same |
| Text kept per version | first 100,000 characters (cut at a line end, flagged on the watch) | storage |
| Versions per watch | 10, and 400,000 characters in total | storage |
| Watches | 200 | storage |
| Page size | 5 MB | memory |
| Time limit per check | 20 s | below the 30 s after which Firefox stops an idle event page |

A check that could not connect or timed out is tried again after 10 minutes
(up to three times) instead of waiting a whole interval.

## The background page

`background.js` is a non-persistent event page (an ES module). Firefox stops it
after about 30 s without work and starts it again for the alarm, a message or a
permission change, so all state lives in `storage.local`:

| Key | Holds |
| --- | --- |
| `watches` | the list: name, address, part (CSS selector), interval, paused, times, unread count, last problem, warning |
| `snap:<id>` | the saved versions of one watch (`versions: [{ at, text }]`, oldest first) |
| `settings` | default interval, notifications on or off |
| `pending` | a "watch this page / one part" that is waiting for the permission prompt or for the click in the page |
| `lastAdd` | outcome of the last add, for the popup |
| `stats` | number of changes caught (for the one-time thank-you card) |
| `supportNudge` | which thank-you cards were shown (template) |

The background is the only writer of `watches`; the popup, the dashboard and
the changes view read storage and send messages. Writes are queued one after
another so two of them can not overwrite each other.

## Layout

```
src/                       everything that ships
  manifest.json
  background.js            schedule, fetch, compare, badge, notifications, messages
  content/picker.js        in-page picker and confirmation card (injected on demand)
  popup/                   toolbar popup: this page, the list
  app/                     dashboard (also the options page): list, add by address,
                           edit, settings, export and import, limits, Support
  changes/                 "what changed" view of one watch
  shared/config.js         limits, intervals, problem and warning texts
  shared/extract.js        bytes -> text: decoding, readable text, part lookup
  shared/diff.js           Myers diff by line and by word
  shared/list.js           the watch list used by popup and dashboard
  shared/util.js           small helpers
  shared/base.css          colors, buttons, list
  shared/support.*         Ko-fi pill + one-time milestone card: a rating ask first, tips later (from the template)
  shared/more-addons.*     "More free add-ons" card + rate link (same file in every add-on; set `live: true` as listings are approved)
  icons/icon.svg           toolbar and add-on icon
  icons/icon-96.png        the same icon for notifications (tools/make_icon_png.py)
store-assets/listing.json  AMO listing text, category, Ko-fi contributions_url
store-assets/screenshots/  1280x800 listing images (made by tests/screenshots.py)
tests/                     real-Firefox E2E, local test server, screenshot generator
tools/release.py           build / lint / submit / status / contrib / screenshots
```

## Develop and test

```powershell
python tools/release.py lint                 # build + web-ext lint the zip (expect 0/0/0)
python -m pip install selenium pillow        # once, ideally in a venv, for the tests
python tests/e2e_firefox.py                  # all four sessions, 195 checks, about 2 minutes
python tests/e2e_firefox.py prompt           # one session by name
python tests/screenshots.py                  # regenerate store screenshots
```

The E2E installs the extracted built zip in throwaway headless, muted Firefox
profiles and serves pages from `tests/server.py` under made-up host names
(`network.dns.localDomains`). The pages change between checks. Result on Firefox 147: 195 of 195.

| Session | Checks | What it covers |
| --- | --- | --- |
| `main` | 160 | The whole add-on, with the popup opened in a tab and optional permissions granted without the prompt (`extensions.webextOptionalPermissionPrompts=false`; asking still takes a real click). Adding a page; a check that finds nothing although the page's scripts, styles and tokens differ on every request; a check that finds a change; the change view (added, removed, edited words, folding, older changes); picking one part with the mouse (outline, arrow keys, Esc, an element without an id, a page with a strict CSP, the same part twice); parts drawn by JavaScript; the schedule through the alarm, pause and resume, spacing on one site; every kind of problem; the storage limits; character sets, tables, plain text; notifications; edit, delete, export and import; the Ko-fi links; and that no check in the whole run carried a cookie. |
| `prompt` | 21 | The real toolbar button, the real popup and Firefox's real permission prompt, answered "no" and then "yes": from the popup (one site, then a second site), from the dashboard's add form, and for notifications. Shows that the prompt names exactly one site and that activeTab alone gives the popup the tab's address. |
| `suspend` | 13 | `extensions.background.idle.timeout` set to 2 s. The background page is seen "stopped", the alarm wakes it on time and the change is found from what was stored, the badge survives, a click wakes it, and a half-finished "watch one part" still lands after a stop. |
| `control` | 1 | The same add-on with the `content_security_policy` line removed: the `http://` check on a non-loopback host fails and the server never sees a request. |

Things measured in Firefox 147 while building this:

- The toolbar popup stays open while Firefox shows the permission prompt. The add
  is still parked in `storage.local` first and finished from `permissions.onAdded`,
  so it also works if a Firefox version closes the popup.
- The prompt for `*://host/*` reads "Access your data for sites in <host> domains".
- An alarm set a few seconds ahead fires on time and wakes a stopped event page.
- `notifications.getAll()` works headless with `alerts.useSystemBackend=false`
  (no real Windows toast during tests).
- `nsIDOMWindowUtils.sendMouseEvent` no longer exists. For a trusted click inside
  the real popup, the test runs `content.synthesizeMouseEvent("mousedown" / "mouseup", x, y, { button: 0, clickCount: 1 })`
  in a frame script on `browser.webextension-popup-browser`.
- A fetch to a `.invalid` host did not fail fast on this machine: it hung until
  the 20 s limit. The test uses a closed port on a `network.dns.localDomains`
  host for "can't connect" (about 2 s on Windows).

Manual: `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on -> `src/manifest.json`.

## Release

```powershell
python tools/release.py submit --notes "First release"
python tools/release.py screenshots          # after the listing exists
python tools/release.py status
```

Bump `version` in `src/manifest.json` for every later submit.
