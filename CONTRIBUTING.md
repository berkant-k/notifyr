# Contributing to Notifyr

Thanks for taking the time. Notifyr is a small project and contributions of any
size are welcome — including "this documentation is wrong" and "this error
message confused me".

## Getting set up

Requires Node >= 20.9 (Next.js 16). There is an `.nvmrc` if you use nvm.

```bash
git clone https://github.com/berkant-k/notifyr.git
cd notifyr
npm install
npm run dev        # http://localhost:3000
```

## Before you open a pull request

Run what CI runs. All four must pass:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs the same four on Node 20.x and 22.x.

## Tests

Tests live in `tests/` and run under vitest with no dev server and no network.
`tests/api.test.ts` imports the App Router route handlers directly and calls
them with plain `Request` objects, which is why the suite is fast and portable.

Please add a test with behaviour changes. A useful habit: after writing one,
break the code deliberately and confirm the test fails. A test that cannot fail
is not a test.

The suites are organised by concern — `validation`, `subscription`, `store`,
`endpointId`, `headers`, `api`. Add to the matching one rather than creating a
new file per change.

## Style

There is no formatter configured; match the surrounding code. A few conventions
worth keeping:

- **Comments explain why, not what.** Most comments in this codebase exist
  because the code looks wrong until you know a constraint — an R4-only
  validator, a serverless instance boundary, a URL path segment. Those are worth
  writing down. `// increment the counter` is not.
- **`null` means absent.** `getEndpoint`, `addMessage` and `getSnapshot` all
  return `null` for a missing endpoint; `createEndpoint` returns `null` for a
  taken id. Keep that consistent rather than introducing thrown errors.
- **Storage methods stay async**, even though the in-memory implementation is
  synchronous. That is what lets a database implementation drop in without
  touching callers.

## Commit messages

Short imperative subject lines, e.g. `fix: keep counters cumulative past the
retention cap`. Conventional Commit prefixes are used but not enforced.

## Where help is most useful

See [docs/DESIGN.md](docs/DESIGN.md#where-help-is-most-useful). The two biggest
gaps are a shared storage backend (which also unlocks SSE) and support for the
R4 backport notification format.

## Reporting bugs

Open an issue using the bug report template. The single most useful thing you
can include is **the raw notification body** your FHIR server sent, plus which
server and FHIR version produced it — most bugs in a validator are really
disagreements about what a payload should look like.

Please redact anything real before pasting. If the payload cannot be shared, a
description of its shape is still better than nothing.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

Note that several properties that look like vulnerabilities are documented,
intentional trade-offs — no authentication, guessable endpoint ids, headers
displayed in full. Those are described in the README and SECURITY.md rather than
being bugs.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
