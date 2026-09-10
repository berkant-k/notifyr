# UI review

Findings from a review of the app's two screens on 2026-09-09 — the endpoint
dashboard first, the landing page second — kept as a task list so they can be
worked through and ticked off. Dashboard findings are numbered plainly; landing
page findings carry an `L` prefix.

Reviewed two ways: reading the components, and driving the running app in Chrome
at 1280×900 against an endpoint seeded with a handshake, three heartbeats, an
event-notification violating an `id-only` expectation, and two invalid bodies.
Findings marked **measured** were observed in the browser rather than inferred
from the code.

## Dashboard

## How to read this

- **P1** — fix first: either a correctness bug or the thing that makes the page
  hard to use for its actual job.
- **P2** — clear improvement, contained.
- **P3** — worth doing, no urgency.

Effort is rough: **S** under an hour, **M** an afternoon, **L** more than that.

## Layout and information architecture

- [x] **1. The notification list is below the fold. (P1, M)** *Measured:* at
      1280×900 the fold lands mid-way through *Response overrides* — **no
      notification rows are visible on load**. **Done:** sticky right rail at
      `lg`+ holding the webhook URL and both settings cards, list and counters
      on the left, single column below `lg`; shell widened to `lg:max-w-6xl`
      with the home page pinned to its old width. *Re-measured: all rows above
      the fold at the same viewport.*
- [ ] **2. Three separate ways of counting. (P2, S)** Two large Valid/Invalid
      cards, three per-type tiles and a "5 valid notifications" caption spend
      two cards and ~250px on five numbers. Merge into one strip:
      `Valid · Invalid │ Handshake · Heartbeat · Event notification`, divided
      into the "did it validate" and "what kind" groups.
- [x] **3. Settings cards spend most of their height on prose. (P2, S)**
      **Done, by a different route than merging them:** every card's explanation
      moved behind an info icon (`InfoTip`), leaving a title and its control.
      Three cards became four without the rail growing.
- [x] **21. The webhook URL spends a whole card on one line. (P3, S)**
      **Done** — in the rail, and down to a title, the URL and a copy button.

## The notification list

- [ ] **4. Rows do not look interactive. (P2, S)** A hover tint is the only
      affordance. Add a chevron on hover/focus and an explicit `focus-visible`
      ring.
- [x] **5. 100 messages are stored and 10 are shown. (P1, M)** `MAX_STORED_MESSAGES`
      is 100, `MAX_RECENT_MESSAGES` is 10, and the messages route hardcodes the
      latter. With a two-minute heartbeat the interesting rows are evicted from
      view fast. **Done:** the messages route takes `?limit=` (clamped to what
      the store retains, nonsense values falling back to the default), the poll
      hook passes it and restarts the loop when it changes so a raised limit
      cannot be answered with "nothing changed", and the list has a
      "Show more — 10 of up to 100 kept" control that steps ×5.
- [x] **6. No filtering. (P1, M)** During a soak test the one event-notification
      is buried in heartbeats. **Done:** chips for all / handshake / heartbeat /
      event / invalid, filtering the loaded rows, with a "Showing 3 of 10
      loaded" line while a filter is active and a distinct empty state that
      offers to clear it. Deliberately **no per-chip counts** — they would count
      loaded rows while the card above counts every notification of that type
      ever received, and `Heartbeat 0` under `Heartbeat 3` reads as a bug.
- [x] **7. Absolute time only. (P2, S)** *Measured:* rows read `10:02:24`. For a
      live tool freshness is the signal. **Done:** rows read `8s ago` / `3m ago`,
      with the full local timestamp on hover and the ISO value in a `<time
      datetime>` element. The label is redrawn by the same rule as the overdue
      gauge — the poll advances its clock only when a displayed label would
      differ, so a recent row ticks second by second and a list of hour-old rows
      is left alone until the hour turns. *Verified: `13s ago` to `15s ago` to
      `19s ago` on a fresh arrival, and unchanged across 4s for minute-old rows.*
- [ ] **8. The Events column is a raw counter. (P2, M)** *Measured:* the column
      reads 0, 1, 2, 1 down the page and means nothing without arithmetic. Show
      the delta from the previous notification, which is also what makes a
      missed delivery visible — see
      [VALIDATION.md](VALIDATION.md#5-cross-notification-checks).
- [x] **9. Events and Topic vanish below `md`. (P3, M)** The most FHIR-specific
      data is what small screens lose. **Done:** below `md` the row carries a
      second line with the event count and topic, so the values move rather than
      disappear. *Half verified: at desktop width the second line is present in
      the DOM with the right content and correctly hidden, while the columns
      show. The below-`md` rendering is still unseen — the browser will not
      resize below its minimum width — though it is the exact complement of the
      rule that was verified.*
- [x] **22. The list and the modal disagree about time. (P2, S)** *Measured:*
      the row reads `10:02:24` (local, `en-GB`), the modal header reads
      `2026-09-09T07:02:24.643Z` (raw ISO, UTC). Same event, two formats, three
      hours apart. **Done with finding 7:** both now use one `lib/time` module —
      the list shows the relative label, the modal shows the full local
      timestamp with its zone, and both expose the ISO value through `<time
      dateTime>`. *Verified: title reads `09/09/2026, 16:04:45 GMT+3` against a
      `datetime` of `2026-09-09T13:04:45.463Z`.*

## Detail modal

- [x] **10. No focus management — the accessibility bug. (P1, M)** *Measured*
      with the modal open: `focusIsInsideDialog: false` (focus stayed on the row
      button behind the overlay), `document.body` overflow `visible` (background
      scrolls), 14 background buttons still tabbable. It announces
      `role="dialog" aria-modal="true"` while behaving like a div, which is
      worse for a screen reader than not claiming it. Needs: focus moved in on
      open, restored to the triggering row on close, Tab trapped, background
      scroll locked. Escape already works. **Done:** focus moves to the panel
      on open and back to the triggering row on close, body scroll is locked and
      restored to its previous value, and Tab wraps at both ends. The wrap alone
      was not enough — *measured:* focus still escaped after six Tabs, because
      Chrome makes the modal's scrollable body focusable without a tabindex, so
      it matched neither end of the focusable list. A `focusin` guard that pulls
      focus back when it lands outside the panel is the backstop.
      *Re-measured: focus inside after 10 Tabs and 4 shift-Tabs.*
- [x] **11. `aria-label` is static. (P2, S)** **Done** — `aria-labelledby`
      now resolves to the notification summary.
- [x] **12. Backdrop close loses a text selection. (P3, S)** **Done** — the
      overlay closes on `mousedown` on itself rather than on any `click` that
      bubbles, so a selection dragged out of the panel no longer dismisses it.
- [ ] **23. Info-level noise sits at the same weight as real findings. (P2, S)**
      *Measured:* the payload warning and `INFO Encounter.class Value set … could
      not be found` render identically. Order fatal → error → warning → info,
      lead with a count (`2 errors · 3 warnings`), and collapse info behind a
      disclosure.

## Accessibility

- [ ] **14. No dark mode. (P2, M)** `globals.css` pins `color-scheme: light`. A
      token pass now is much cheaper than after more components exist.
- [ ] **15. The overridden-status marker is colour + `*` + a `title` tooltip.
      (P2, S)** Tooltips are not keyboard reachable and `*` is unexplained
      anywhere on the page. Use a visible `forced` tag plus a legend under the
      list.
- [ ] **16. New notifications arrive silently. (P2, S)** A visually-hidden
      `aria-live="polite"` region on the summary — never the list itself —
      announcing "3 new notifications".
- [ ] **17. `LiveIndicator` pulses regardless of reduced-motion. (P3, S)** The
      guard in `globals.css` covers only the row animation.
- [ ] **18. Inconsistent focus-visible styling. (P2, S)** The response-override
      toggle has a ring, and the new filter chips and "Show more" have one;
      Refresh, Copy and the message rows still do not.

## States and copy

- [ ] **19. `Endpoint.createdAt` is stored and never shown. (P2, S)** On a
      dashboard whose data dies with the process, endpoint age and "held in
      memory, lost on restart" belong on the page, not only in the global
      footer.
- [ ] **20. A stale list looks live while polling backs off. (P2, S)** Past ~10s
      of failure, band the list with "Last updated 45s ago".

## Done

- [x] **30. The walkthrough left the dashboard.** It used to expand in place and
      was rendered only while no notifications had arrived — so the first
      heartbeat made six screens of guide vanish underneath whoever was reading
      it. It is now a permanent one-line link to `/dashboard/:id/guide`, opening
      in a second tab so it can sit beside the dashboard while each step is
      pasted into a FHIR server. The samples there carry that endpoint's own URL.
- [x] **31. The counters card no longer grows when data arrives.** *Measured:*
      it went 112px to 143px the first time a notification landed, because the
      continuity toggle and the "missed" subtitles appeared — pushing the list
      down while someone was watching it. The toggle moved into the header row,
      which is always rendered, and the subtitle is a reserved fixed-height slot.
      *Re-measured across a first handshake and a heartbeat carrying an event
      gap: counters 130px to 130px, list top 407px to 407px, nothing moved.*
- [x] **33. The hydration error behind the dev overlay's "1 Issue".** It was
      there in every screenshot this session and went uninvestigated until it was
      reported. Cause: `webhookUrlInBrowser` branched on `typeof window`, so the
      server rendered `/hook/berk` and the client rendered
      `http://localhost:3000/hook/berk` into the same text node — the first
      bullet in React's own list of causes. Both pages now resolve the URL from
      request headers in the server component and pass it down, and the browser
      helper is gone rather than left as a trap. *Verified: console carries only
      `[HMR] connected`, and the overlay badge no longer reports an issue.*
- [x] **32. Findings are visible from the list.** A row carrying warnings or
      notes now shows a dot beside its result — amber for warnings, slate for
      notes only — in a fixed-width column, so rows never shift. Errors already
      speak through the Invalid badge; this is for the findings that leave a
      message valid, which were previously invisible unless every row was opened
      one at a time. That is exactly how a counter restart went unnoticed.
- [x] **28. The dashboard now fits one screen at `lg`.** The page is exactly as
      tall as the shell leaves it and the notification list absorbs the
      remainder, scrolling inside its own frame under a sticky column header.
      The first attempt capped the list at a guessed `calc(100vh-27rem)`, which
      *measured* 179px of overflow once the list filled and 283px with the
      continuity panel open; letting flex do the arithmetic means the counters,
      panel and filters can change height without anyone re-deriving a constant.
      One measured number remains — 182px of chrome (53px header, 49px footer,
      40px padding top and bottom). Below `lg` the page stacks and scrolls
      normally.
      *Re-measured: 0px overflow with 13 rows loaded and the panel open.*
- [x] **29. Explanations moved into `InfoTip`.** Deliberately not a `title`
      attribute and not hover-only, which is finding 15's complaint: it opens on
      hover, on focus and on tap, closes on Escape, and the panel is tied to the
      trigger with `aria-describedby`. *Verified: opens on hover and on the
      keyboard path, closes on leave and Escape, aria association resolves.*
- [x] **26. The webhook URL was clipped in the rail.** Introduced by finding 1:
      at ~320px the URL scrolled horizontally and hid the endpoint id, the one
      part worth reading back. It wraps now.
- [x] **27. The arrival animation fired on things that had not arrived.**
      Also introduced by finding 1's neighbours: "Show more" and every filter
      change re-mounted rows, so they flashed emerald as if new — as did the
      whole list on first paint, which predates this session. The animation is
      now driven by ids the list has not rendered before. *Measured: 0 of 13
      rows animated after "Show more", 1 of 20 after a genuine heartbeat.*
- [x] **25. `1 entry include a resource`.** *Measured* in the modal: `count()`
      pluralised the noun but not the verb. Fixed in `src/lib/payload.ts` to
      `entry includes` / `entries include`.

## Not investigated

Nothing outstanding.

# Landing page

Reviewed the same way: reading `src/app/page.tsx` and its disclosures, then
driving the page — submitting an invalid id, generating a random one, opening
every disclosure — at a 1912×682 viewport.

## Layout and hierarchy

- [x] **L1. The primary action is below the prose, and nearly below the fold.
      (P1, M)** *Measured:* the Create button sat 586px down a 682px viewport.
      **Done:** the card now follows the heading and its one-paragraph pitch,
      with the "why" prose and bullets moved below it. *Re-measured: 329px, a
      257px lift.* The memory/no-auth caveat moved into the card at reading size
      rather than 12px grey — part of L13.
- [x] **L2. Content hugs the left on wide screens. (P2, S)** *Measured:* at
      1912px the card's left edge is 501px in with 836px of empty space to its
      right. The `max-w-4xl` wrapper is centred, but the prose (`max-w-2xl`) and
      card (`max-w-xl`) are left-aligned inside it, so the visual weight sits
      well left of centre. **Done:** one column capped at reading width and
      centred, with the inner caps removed. *Re-measured at 1912px: 613px left,
      628px right — the 15px is the scrollbar.*
- [x] **L3. The `h1` repeats the header verbatim. (P3, S)** The header already
      reads `Notifyr` and `FHIR Subscription Tester`; the `h1` was exactly
      those two strings joined. **Done:** it now says what the tool gives you,
      and the intro no longer repeats the heading.

## The create form

- [x] **L4. The URL preview renders invalid ids as if they were real. (P1, S)**
      *Measured:* typing `bad id!` showed `/hook/bad id!` under the field — a
      URL that can never exist — and nothing objected until submit. **Done:**
      the id is checked on every keystroke with the same `lib/endpointId` rules
      the server applies; an invalid value replaces the preview with the reason,
      and the preview returns as soon as the value is usable. *Re-measured with
      no submit: field marked invalid, error shown, no fake URL.*
- [x] **L5. The error appears below the submit button. (P2, S)** **Done** as
      part of L4 — server and live errors share one region directly under the
      field. *Re-measured: the alert now sits below the input, above the
      button.*
- [x] **L6. No `aria-invalid` on the failing input. (P2, S)** **Done** as part
      of L4 — `aria-invalid` tracks the problem state and the border turns rose
      with it, so the field is marked for assistive tech and by sight.
      *Re-measured: `true` while invalid, `false` once valid.*
- [x] **L7. Focus stays on the button after a failed submit. (P3, S)**
      *Measured.* **Done:** both the local check and a server rejection put the
      caret back in the field.
- [x] **L8. A long paste is silently truncated. (P3, S)** `maxLength={64}` cuts
      the value with no explanation, even though the 64-character rule is
      stated above the field. **Done:** the attribute is gone and the length
      rule explains itself like every other. *Re-measured: 72 characters are
      accepted and answered with "cannot be longer than 64 characters".*

## Documentation disclosures

- [x] **L9. Code samples clip horizontally with no affordance. (P1, S)**
      *Measured:* 2 of 3 blocks overflowed, the worst hiding 224px — including
      the backport extension URLs in the Subscription sample, the thing a new
      user is meant to copy. **Done:** `CodeBlock` wraps instead of scrolling.
      *Re-measured: 0 of 3 clipped, worst overflow 0px.* Wrapped continuation
      lines start at the left margin rather than hanging under their key, which
      is the cost of the trade.
- [x] **L10. The walkthrough asks for a URL the visitor cannot have yet.
      (P2, S)** *Measured:* the landing page sample carries
      `https://your-notifyr-host/hook/your-hook-id`, because no endpoint exists
      at that point. **Done:** the guide says so when it has no URL to show,
      and points at the dashboard where the sample arrives pre-filled.
- [x] **L11. Heading structure is broken. (P2, S)** *Measured:* the document
      runs `h1 → h4 → h4 → h4 → h4 → h4 → h4 → h3 → h3`. The three disclosure
      titles are bare `summary` elements with no heading semantics, so browsing
      by heading found no section boundaries at all. **Done:** each summary
      carries an `h2`, and the panels' own headings were re-levelled under it.
      *Re-measured with everything open: `1-2-3-3-3-3-3-2-3-2-3-3`, zero skipped
      levels.* The first attempt introduced an `h2 → h4` skip in References by
      demoting headings that were already right.
- [x] **L12. Nothing signposts how much is behind each disclosure. (P3, S)**
      *Measured:* opening all three takes the page from 1017px to 4058px — six
      screens. **Done:** each summary carries a line saying what is inside.

## Copy and trust

- [x] **L13. The security caveat is said three times, in the smallest type on
      the page. (P2, S)** **Done:** one sentence in the create card at reading
      size, folding in what the bottom footnote used to say separately; the
      footnote is gone. The global footer still carries the site-wide line,
      which is where a site-wide warning belongs. A second footnote repeats it at the bottom and the
      global footer says it again. Three quiet
      mentions read as none. Say it once, at body size, next to the button that
      creates the thing.
- [ ] **L14. Contrast unverified. (P2, S)** *Not measured* — Tailwind v4 emits
      `lab()` colours, which defeated two attempts at a computed check. By the
      palette's hex values `slate-500` passes AA and `slate-400` does not; the
      landing page uses `slate-500` throughout its 12px text and the dashboard
      rail uses `slate-400` for hints. *Partly addressed:* the id field's
      placeholder moved from `slate-400` to `slate-500`. Still worth one pass
      with a real tool.
- [x] **L15. No skip link. (P3, S)** **Done** — a `.skip-link` to `#main`,
      parked above the viewport and revealed on focus, in the shared layout.
      **Not verified in the browser:** Chrome applies `:focus` only while the
      document itself has focus, and an automated window is never foreground —
      `document.hasFocus()` came back `false`, so the link measured as hidden
      whatever the CSS said. Worth one press of Tab in a real window.

## If you only do three

**L1** (the action above the pitch), **L4** (stop advertising URLs that cannot
exist), **L9** (make the sample readable). Between them they fix the path a
first-time visitor actually walks.
