# Northbridge · Crew Dispatch

**Synthetic demonstration — not a production dispatch service.** A working local dispatcher console and crew offer inbox for emergency restoration work. Offer sequencing, expiry escalation, capacity reservation, recovery and audit events live in SQLite—not in the browser.

## The product

**Primary user:** an emergency-service dispatcher at fictional Northbridge Restoration. **Promise:** send an eligible crew a five-minute offer, escalate promptly when declined or expired, and prevent conflicting assignments. **Smallest workflow:** create a request → manually verify its service location → inspect eligible crew ranking → offer to Crew A → decline/expire → offer to Crew B → accept → mark en route, arrived, in progress and completed.

The riskiest dependency is coordinating simultaneous acceptance, expiration and capacity usage. The demo resolves this with server-authoritative simulated time, SQLite `BEGIN IMMEDIATE` transactions, indexed assignment/offer uniqueness constraints, and persistent deadline polling. External SMS, geocoding and deployment are deliberately not required.

## Browser preview with private GitHub Codespaces

Open this repository in **GitHub Codespaces → Create codespace on main**. The devcontainer installs the required Node version, starts the synthetic demo, and forwards port 4173 **privately**. Open the forwarded port in the Codespaces Ports panel. This is a browser-accessible development preview, not a public production deployment. GitHub Codespaces may have usage limits or charges; check your account before launching.

The demo server binds to `127.0.0.1`; if port forwarding in your Codespace cannot connect to it, run `npm start` and use the local port link in the integrated terminal. Never change the server to bind `0.0.0.0` without implementing real authentication.

## Optional role-restricted preview (synthetic data only)

The default `AUTH_MODE=demo` intentionally permits identity switching and **must stay on localhost or a private Codespaces port**. To test role boundaries, run `AUTH_MODE=preview` with an operator-supplied dispatcher access key and a JSON map of separately generated crew keys. **Each key must be unique and at least 32 characters. Never commit keys or a populated `.env`.** Generate random keys with `openssl rand -hex 32` (once per identity).

```sh
# Example: supply secrets through your shell or an uncommitted .env file.
export AUTH_MODE=preview
export PREVIEW_DISPATCHER_KEY="$(openssl rand -hex 32)"
export PREVIEW_CREW_KEYS_JSON="$(node -e 'console.log(JSON.stringify(Object.fromEntries([..."ABCDEFGH"].map(id=>[id,require("crypto").randomBytes(32).toString("hex")]))))')"
npm start
```

**Retain the generated values securely before starting**; you need them to sign in. Alternatively supply individually generated keys through a secret manager. In the sign-in screen choose dispatcher or a specific crew. In preview mode:

- The browser receives an HttpOnly, Secure, SameSite=Strict session cookie, expiring after eight hours. Sessions are kept in server memory and are lost on restart.
- The server applies role checks to each API route and derives crew identity from the session rather than trusting a claimed crew ID or demo header. Browser actions carry an in-memory CSRF token. Login attempts are throttled.
- Dispatchers can see the operations dashboard, while crews only see offers for their own identity. Sign out to switch roles.
- Local HTTP browsers may not persist Secure cookies; use an HTTPS private Codespaces forwarded URL when exercising this mode.

This is **not a production identity system, nor multi-tenant authorization**. The deployment boundary remains a private developer preview; do not enable a public Codespaces port or use real customer data. For production, integrate a reviewed identity provider, organization-scoped database rows/queries, durable session storage, tenant isolation tests, audit attribution, backups, and retention controls.

## Run locally

Requirements: **Node.js 22.16+** (its `node:sqlite` and TypeScript stripping APIs are experimental on this runtime).

```sh
npm install
cp .env.example .env                 # optional; defaults work without it
npm start
# open http://127.0.0.1:4173
```

The server binds to `127.0.0.1` intentionally. On first run it seeds a fictional organization with **8 crews, 4 skills, 3 regions and 15 jobs**. Subsequent runs reuse `./data/crew-dispatch.sqlite`. Use **Reset synthetic data** in the interface to recreate the fixture. The reset erases the *demo database's* state; never point it at real data.

```sh
npm test             # domain and HTTP authorization/invariant tests
npm run typecheck    # TypeScript check
```

There are no paid integrations and no production credentials. No real notifications are sent.

## Operator walkthrough

1. In **Dispatch overview**, select job `J001` to see the rules-ranked, eligible crews (A then B); ineligible rows explain missing skills, region, availability or capacity. Straight-line proximity is a tie-breaker **not a travel-time estimate**.
2. Choose **Start offer sequence**. Crew A receives an offer for five minutes in simulated time.
3. Switch to **Crew offer inbox**, select Crew A and decline. Switch back: B receives the next offer. A's late attempt is rejected.
4. Switch to Crew B and accept before expiry. One capacity slot and one current assignment are created atomically.
5. As dispatcher, advance the job from **assigned → en route → arrived → in progress → completed**, observing timeline and audit records. You can also **Advance clock** to trigger expirations or **Run worker** to exercise recovery.
6. Select `J006` for missing-location review, `J007` for an outside-region request, `J009` for a simulated notification failure, or `J014` for an exhausted historical offer sequence. Try **Retry channel**, **Confirm location**, and a fresh offer sequence. Export the audit CSV at the bottom of the dispatch console.
7. In **Crew capacity / status**, select **Edit** to change a crew's operational skills, authorized areas, declared availability, current workload, capacity, base coordinates, or simulated channel. Invalid updates and removal of requirements for an active assignment are rejected atomically.

## Why this is deterministic

- One pending offer per job and one current assignment per job are guarded by SQLite partial unique indexes.
- An acceptance verifies recipient, pending status, exclusive expiry deadline, job/sequence state, current eligibility and capacity before reserving and assigning in one transaction.
- Expiration, cancellations and acceptance serialize through `BEGIN IMMEDIATE`. At the exact deadline, expiry wins. A double acceptance cannot create two assignments.
- Capacity is checked both in domain logic and database triggers. A reservation is released on completion/cancellation.
- A polling worker reads persisted deadlines on startup and each second; an operation key suppresses repeated logical expiry events.
- Notifications are only simulated. A queue write never asserts a human receipt. Failed channels remain visible and retryable while an offer is live.
- In default demo mode, crew identities and dispatcher headers are deliberately forgeable and never suitable for public hosting. Optional preview mode adds server-side role sessions; it is still a single synthetic organization and not production-ready.

## Architecture and status

| Layer | Implementation |
| --- | --- |
| Browser | Accessible, responsive HTML/CSS/vanilla JS dispatcher and crew views |
| HTTP | Node built-in `http` server; JSON actions and audit CSV |
| Domain | `src/domain.ts` — ranked eligibility, transitions, offers, reservations, event/audit models |
| Data | `src/db.ts` — SQLite schema, constraints, transactions and durable local file |
| Tests | `tests/*.test.ts` — domain, HTTP integration and role/CSRF boundary tests |
| Delivery | Local-only; no SMS/email, maps, tracking or external data |

**Verification:** run `npm test` and `npm run typecheck` for current results. The initial demo passed 16 domain tests and bridged browser smoke tests; subsequent tests include crew configuration, preview login and role/CSRF boundaries. These are not production load, deployment, security or penetration tests.

**Still to do before any real pilot:** production identity-provider integration and organization-scoped authorization; migrations and data retention; proper secrets management; more extensive concurrent-process integration/load tests; visibility on pending notification acknowledgments; safe deployment; monitoring and backups. Do not expose this demo server to the Internet as-is.

## Pilot proposal

1. Ask dispatchers: What creates the most lost time in emergency callout? What data determines crew eligibility? Who can override a refusal? Which location evidence suffices? When is manual intervention mandatory?
2. Establish baseline time-to-assignment and manual intervention rate from historical, de-identified jobs, not invented metrics.
3. Re-run historical scenarios in **shadow mode**, with no crew notifications and no operational assignments.
4. Evaluate median/90th-percentile assignment latency, intervention rate, notification failure exposure, and zero conflicting assignments/unauthorized acceptances.
5. Stop on any double assignment, cross-crew data exposure or unauthorized acceptance; only then decide whether to trial approved delivery connectors and controlled live dispatch.

## Source and rights

This is an original implementation for fictional **Northbridge Restoration**. All crew names, addresses and request histories in this repository are synthetic. The project does not incorporate third-party code, branding, customer records or proprietary materials; no performance or adoption claims are presented as measured outcomes.
