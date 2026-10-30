# Northbridge · Crew Dispatch

**Synthetic demonstration — not a production dispatch service.** A working local dispatcher console and crew offer inbox for emergency restoration work. Offer sequencing, expiry escalation, capacity reservation, recovery and audit events live in SQLite—not in the browser.

## The product

**Primary user:** an emergency-service dispatcher at fictional Northbridge Restoration. **Promise:** send an eligible crew a five-minute offer, escalate promptly when declined or expired, and prevent conflicting assignments. **Smallest workflow:** create a request → manually verify its service location → inspect eligible crew ranking → offer to Crew A → decline/expire → offer to Crew B → accept → mark en route, arrived, in progress and completed.

The riskiest dependency is coordinating simultaneous acceptance, expiration and capacity usage. The demo resolves this with server-authoritative simulated time, SQLite `BEGIN IMMEDIATE` transactions, indexed assignment/offer uniqueness constraints, and persistent deadline polling. External SMS, geocoding and deployment are deliberately not required.

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
npm test             # 16 domain/invariant tests
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
7. The data APIs also support editing a crew's operational skills, authorized areas, declared availability, current workload, capacity, base coordinates and simulated channel (`POST /api/crews/:id`). **The current UI displays crew status but does not expose all configuration fields yet.**

## Why this is deterministic

- One pending offer per job and one current assignment per job are guarded by SQLite partial unique indexes.
- An acceptance verifies recipient, pending status, exclusive expiry deadline, job/sequence state, current eligibility and capacity before reserving and assigning in one transaction.
- Expiration, cancellations and acceptance serialize through `BEGIN IMMEDIATE`. At the exact deadline, expiry wins. A double acceptance cannot create two assignments.
- Capacity is checked both in domain logic and database triggers. A reservation is released on completion/cancellation.
- A polling worker reads persisted deadlines on startup and each second; an operation key suppresses repeated logical expiry events.
- Notifications are only simulated. A queue write never asserts a human receipt. Failed channels remain visible and retryable while an offer is live.
- Crew-specific endpoints authorize by a **fictional demo token** and expose only the recipient's offers; dispatcher endpoints require a **forgeable demo header**. **Neither mechanism is real authentication or safe for public hosting.**

## Architecture and status

| Layer | Implementation |
| --- | --- |
| Browser | Accessible, responsive HTML/CSS/vanilla JS dispatcher and crew views |
| HTTP | Node built-in `http` server; JSON actions and audit CSV |
| Domain | `src/domain.ts` — ranked eligibility, transitions, offers, reservations, event/audit models |
| Data | `src/db.ts` — SQLite schema, constraints, transactions and durable local file |
| Tests | `tests/domain.test.ts` — 16 invariant tests including restart, contention and expired offers |
| Delivery | Local-only; no SMS/email, maps, tracking or external data |

**Actual verification at the time of this publication:** 16/16 domain tests passed; `tsc --noEmit` passed; basic HTTP and bridged browser smoke tests were performed in the authoring environment. These are not production load, deployment, security or penetration tests.

**Still to do before any real pilot:** implement real authentication and organization-scoped authorization; migrations and data retention; proper secrets management; more extensive concurrent-process integration/load tests; operator-editable crew configuration UI; visibility on pending notification acknowledgments; safe deployment; monitoring and backups. Do not expose this demo server to the Internet as-is.

## Pilot proposal

1. Ask dispatchers: What creates the most lost time in emergency callout? What data determines crew eligibility? Who can override a refusal? Which location evidence suffices? When is manual intervention mandatory?
2. Establish baseline time-to-assignment and manual intervention rate from historical, de-identified jobs, not invented metrics.
3. Re-run historical scenarios in **shadow mode**, with no crew notifications and no operational assignments.
4. Evaluate median/90th-percentile assignment latency, intervention rate, notification failure exposure, and zero conflicting assignments/unauthorized acceptances.
5. Stop on any double assignment, cross-crew data exposure or unauthorized acceptance; only then decide whether to trial approved delivery connectors and controlled live dispatch.

## Source and rights

This is an original implementation for fictional **Northbridge Restoration**. All crew names, addresses and request histories in this repository are synthetic. The project does not incorporate third-party code, branding, customer records or proprietary materials; no performance or adoption claims are presented as measured outcomes.