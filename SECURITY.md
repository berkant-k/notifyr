# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/berkant-k/notifyr/security) and choose
**Report a vulnerability**. That opens a private thread with the maintainers.

Please include what you did, what happened, and what you expected. A proof of
concept helps but is not required to file.

There is no bounty programme. Reports are handled on a best-effort basis by a
small maintainer team; expect an initial response within a couple of weeks.

## Known and intentional trade-offs

Notifyr is a **debugging tool**, not a production service. Several properties
below look like vulnerabilities and are documented, deliberate decisions.
Reporting them is not necessary; proposals to improve them are welcome as normal
issues or pull requests.

- **There is no authentication.** Anyone who knows an endpoint id can read every
  notification sent to it, through the dashboard or through the API. Endpoint
  ids are the only access control.

- **Endpoint ids may be user-chosen, and are therefore guessable.** A random
  UUID is not worth guessing; `test`, `demo` or `my-hook` are. Anyone who
  guesses an id sees its traffic, and can claim an unused name first.

- **Request headers are stored and displayed in full, including
  `Authorization`.** Verifying the credential a FHIR server actually sent is a
  primary reason to inspect a webhook, so values are not masked. The consequence
  is that **a dashboard URL is equivalent to the credentials it displays**.
  Credential-bearing headers are visually flagged, which is a labelling aid and
  not a protection.

- **Anything POSTed is stored and displayed verbatim**, including malformed
  payloads. Do not send real patient data or any other sensitive information.

- **`npm audit` reports advisories against lodash**, which the `fhir` package
  ships bundled inside its own tarball. It cannot be patched by `overrides` or
  by Dependabot, and no file in `fhir`'s shipped JavaScript references lodash,
  so no code path loads it. See
  [docs/DESIGN.md](docs/DESIGN.md#dependency-notes).

## What is worth reporting

Things outside the list above, for example:

- Reading or modifying data belonging to an endpoint id you do not know
- Stored or reflected XSS in the dashboard, particularly via a crafted
  notification body, header value or validation message
- Server-side request forgery, path traversal or prototype pollution reachable
  from a posted payload
- Denial of service beyond the documented caps (100 messages per endpoint, 500
  endpoints, 1 MB body limit)
- Any way to escape the endpoint id character rules and reach an unintended route

## Deploying your own instance

If you host Notifyr, treat every dashboard URL as public. Use random endpoint
ids, do not point production FHIR servers at it, and put it behind your own
authentication if it needs to be private. The in-memory store also means data is
lost on restart and is not shared across serverless instances — see the README's
limitations before deploying.
