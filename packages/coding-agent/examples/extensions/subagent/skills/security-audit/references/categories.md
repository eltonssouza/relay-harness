# The fourteen categories

Load this at step 3, before walking the entry points. Map every category onto the stack from step 1; a category with no equivalent is reported as n/a, not forced.

Work through each category with **source-to-sink analysis**: start from an untrusted source (request field, header, cookie, uploaded file, webhook body, queue message, third-party API response, LLM output), follow it through the code, and stop at the sink where it is interpreted, stored, or trusted. A finding is a path from source to sink with no adequate control on it.

**Variant analysis.** Every confirmed finding is a pattern. After confirming one, search the whole scope for the same shape (same helper, same query style, same missing check) and report every instance, or merge them into one finding with all locations.

### 1. Unlocked database (tenant / owner isolation)

Find reads and writes that are not scoped to the authenticated principal.

- On Supabase/Postgres: tables with RLS disabled, policies so permissive they are decorative (`using (true)`), policies that check `auth.uid()` on `SELECT` but not on `UPDATE`/`DELETE`/`INSERT ... WITH CHECK`, or a service-role key reachable from user-facing code that bypasses RLS entirely.
- On custom APIs: list, search, aggregate, report and export queries that do not filter by the authenticated user or by their organization / workspace / tenant.
- Identify the project's intended isolation mechanism **first**, then show where it is absent, bypassed, or inconsistently applied.
- Pay attention to the seams: admin and internal endpoints, cron and background jobs, webhook handlers, GraphQL resolvers (including nested resolvers and field-level access), raw SQL, direct `.rpc()` calls, search indexes, analytics exports, and any cache keyed without the tenant id.

### 2. Permission enforced only in the browser

Privileged operations (admin panels, settings, user management, billing, destructive writes) where the frontend hides the UI by role (`isAdmin`, `canEdit`, `role === 'owner'`, feature flags) but the server performs no equivalent check.

Method: enumerate every role gate in the frontend, map it to the endpoint(s) it guards, and verify the backend independently validates the privilege on **every** sensitive route. Also check the inverse: server-side checks that trust a role taken from a client-supplied header, body field, or unverified JWT claim. Check for privilege escalation through profile updates that accept `role`, `isAdmin`, `orgId`, or `plan` fields.

### 3. IDOR (broken object-level authorization)

Routes that read, update or delete an object by id (path, query, body, or a batch of ids) without verifying the object belongs to the caller's user or tenant.

Walk **every** backend route handler systematically, not a sample, and keep the coverage ledger. Watch for: sequential or guessable ids; a `findById` whose ownership check only runs on some branches; mass assignment that lets a client move an object between tenants; nested resources where the parent is checked but the child id is not (`/orgs/:orgId/invoices/:invoiceId` checking only `orgId`); bulk endpoints that check the first id only; file and object-storage paths built from user input; signed URLs with long or no expiry.

### 4. Exposed keys (hardcoded secrets)

API keys, tokens, passwords, signing secrets (JWT, webhook HMAC), private keys, and default credentials embedded in source, configs, `docker-compose`, charts, CI workflows, scripts, or documentation.

Special attention to:

- Public defaults that silently become the real secret when nobody overrides them: `${VAR:-some-default}`, `JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'`, chart `values.yaml` defaults.
- Missing startup validation that should refuse to boot on a default or empty secret.
- Git history: `git log -p -S "pattern"` and `git log --all --full-history -- <file>` for secrets that were committed and later removed. Those still require rotation; removal is not a fix.
- The built frontend bundle and mobile app, for keys inlined at build time (`NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`, `EXPO_PUBLIC_*`) that should have stayed server-side.
- Secrets reaching places they should not: logs, error messages, analytics events, URLs and query strings, client-side storage, and prompts sent to LLM providers.

Use a scanner if one is available (`gitleaks`, `trufflehog`, `detect-secrets`) as a source of leads, then confirm each hit by reading it.

**Redact everywhere.** Never reproduce a live secret in the report, the chat, or an issue: show at most a 4-character prefix plus length (`sk_live_abcd… , 40 chars`) and cite the file:line instead.

### 5. Untreated input in markup (XSS)

Frontend: `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `[innerHTML]`, `@html`, `bypassSecurityTrust*`, markdown or HTML rendered without sanitization, user-controlled URLs in `href`/`src`/`action` (`javascript:`, `data:`), `eval` / `new Function` / `setTimeout(string)`, dynamic `<script>` or style injection, `postMessage` handlers that do not check `event.origin`.

Backend: user input reaching HTML emails, server-side templates, or responses without escaping; template engines with auto-escaping turned off; SSR of untrusted JSON into a `<script>` tag; responses served with a wrong `Content-Type` that a browser will render; user-uploaded SVG or HTML served from the application's origin.

Check whether a sanitization library exists in the project, whether it is actually applied at each point you found, and whether its configuration is permissive enough to be useless.

### 6. Injection into the server (SQL, command, template, path)

Untrusted input interpreted as code or as a location on the server:

- **SQL / NoSQL**: string-built queries, ORM raw escape hatches (`$queryRawUnsafe`, `sequelize.literal`, `.raw()`, `whereRaw`), dynamic identifiers (`ORDER BY ${field}`) not allow-listed, MongoDB operators accepted from JSON bodies (`{"$ne": null}`, `$where`).
- **OS command**: `exec`, `execSync`, `child_process` with `shell: true`, `os.system`, `subprocess(..., shell=True)`, backticks, with any interpolated value. The safe shape is an argument array with no shell.
- **Server-side template injection**: user input used as the template itself rather than as its data (Jinja, Handlebars, EJS, Twig, Velocity).
- **Path traversal**: file reads, writes, downloads, and archive extraction built from user input. A check with `startsWith(root)` without a trailing separator lets `/root-evil` pass for `/root`; the safe check resolves the path and compares by segment. Zip and tar extraction must reject entries that escape the target directory (zip slip).
- **Other interpreters**: LDAP filters, XPath, regular expressions built from input (ReDoS), `eval` in any language, header injection (CRLF in redirects or headers), and log injection (newlines that forge entries).
- **Formula injection**: CSV and spreadsheet exports with cells starting `=`, `+`, `-`, `@`.

### 7. Authentication and session

- **Passwords**: hashed with argon2, bcrypt or scrypt with sane cost; never MD5/SHA-1/SHA-256 alone; no password length cap below 64; no plaintext in logs.
- **JWT**: verified, not just decoded (`jwt.decode` versus `jwt.verify`); algorithm pinned (no `none`, no RS/HS confusion); `exp`, `iss`, and `aud` checked; short access-token lifetime; revocation story for logout and password change.
- **Sessions**: session id rotated at login and privilege change (fixation); invalidated on logout and password reset; cookie flags `HttpOnly`, `Secure`, `SameSite`.
- **Account recovery**: reset and magic-link tokens random, single-use, short-lived, and bound to the user; the same response for known and unknown accounts (enumeration), including timing.
- **Brute force**: rate limiting or lockout on login, reset, OTP, and invite-code endpoints.
- **MFA**: cannot be skipped by calling the post-MFA endpoint directly or by replaying an old step.
- **OAuth/OIDC**: `state` checked, PKCE for public clients, `redirect_uri` matched exactly (no prefix or wildcard match), ID token signature and `nonce` verified, account linking by verified email only.

### 8. SSRF and outbound requests

Any server-side request whose URL, host, or path comes from input: webhook targets, link previews, image or PDF fetchers, import-from-URL, OAuth discovery, integrations with configurable base URLs.

Check for: no allow-list of hosts; blocking based on the hostname string instead of the resolved IP (DNS rebinding); internal ranges reachable (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254.169.254` cloud metadata, `::1`, IPv6-mapped IPv4); redirects followed into internal addresses; non-HTTP schemes (`file:`, `gopher:`); the response body returned to the caller.

### 9. File uploads and unsafe parsing

- **Uploads**: type checked by content and not only by extension or client-supplied MIME; size limit; filename sanitized; stored outside the web root or in a private bucket; served with `Content-Disposition: attachment` or from a separate domain; image processing libraries with known parser CVEs.
- **Deserialization**: `pickle`, `yaml.load` without `SafeLoader`, Java/PHP/.NET native deserialization, `node-serialize`, any format that can instantiate arbitrary types.
- **XML**: external entities and DTDs enabled (XXE), billion-laughs expansion.
- **Prototype pollution** (JavaScript): deep merge, `Object.assign`, or query-string parsing of user objects that can set `__proto__` or `constructor.prototype`.

### 10. Security configuration

- **CORS**: origin reflected from the request with `Access-Control-Allow-Credentials: true`; `null` origin allowed; suffix or regex matching that accepts `evil-example.com`.
- **CSRF**: cookie-authenticated state-changing requests without a CSRF token or `SameSite` protection; `GET` routes that change state.
- **Headers**: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `frame-ancestors` (clickjacking on sensitive pages).
- **Errors and debug**: stack traces, SQL, internal hostnames or file paths in responses; debug mode, GraphQL introspection, Swagger, or admin consoles exposed in production config.
- **Open redirects**: `redirect`, `next`, `returnTo` parameters not restricted to relative paths or an allow-list.
- **Defaults**: default admin accounts, sample data, permissive storage-bucket policies, publicly listable buckets.

### 11. Business logic and race conditions

Flaws no scanner finds, where every request is valid on its own:

- Price, quantity, discount, or currency taken from the client; negative or zero quantities; integer overflow on amounts; rounding that favors the attacker.
- Workflow steps that can be skipped or replayed (checkout without payment, approval without approver).
- **Race conditions**: check-then-act without a lock or a unique constraint (coupon used twice, balance spent twice, invite accepted twice, limits exceeded by parallel requests).
- **Webhooks received**: signature verified with a constant-time comparison over the raw body; timestamp checked against a replay window; events processed idempotently by event id.
- **Idempotency** of payment and other money-moving endpoints.

### 12. Supply chain and CI/CD

- **Dependencies**: run the ecosystem's audit (`npm audit --omit=dev`, `pnpm audit`, `pip-audit`, `osv-scanner`, `cargo audit`, `govulncheck`) and report reachable advisories; dependencies with install scripts; unpinned or floating versions where the project pins elsewhere; typosquatted names; lockfile missing or not used in CI.
- **CI workflows**: `pull_request_target` or `workflow_run` that checks out and runs PR code with secrets; untrusted input (`github.event.*.title`, `body`, `head_ref`) interpolated into `run:` scripts; third-party actions pinned by tag instead of commit SHA; `permissions:` not restricted; secrets available to forks; self-hosted runners on public repos.
- **Build and deploy**: containers running as root; base images not pinned by digest; secrets passed as build args (they persist in image layers); production credentials available to every branch.

### 13. Cryptography and data exposure

- **Randomness**: `Math.random`, `random.random`, or timestamps used for tokens, ids, OTPs, or nonces instead of a CSPRNG.
- **Algorithms**: ECB mode, static or reused IVs/nonces, home-made crypto, RSA without padding, MD5/SHA-1 for integrity or signatures, keys derived from passwords without a KDF.
- **Comparisons**: secrets, tokens, and HMACs compared with `==` instead of a constant-time function.
- **TLS**: certificate verification disabled (`rejectUnauthorized: false`, `verify=False`, `InsecureSkipVerify`).
- **Data exposure**: API responses that return whole database rows (password hashes, internal flags, other users' emails); PII in logs, error trackers, or analytics; sensitive data in URLs; data retained or exported beyond what the feature needs.

### 14. AI, LLM, and agent features

Audit this category whenever the project calls an LLM, embeds one, or is itself an agent or agent harness:

- **Prompt injection**: untrusted content (user messages, web pages, emails, documents, repository files, tool results, retrieved RAG chunks) placed in a prompt where it can change the model's instructions, especially when the model can then call tools.
- **Model output as a sink**: LLM output passed to `exec`, SQL, `eval`, file paths, HTML without escaping, or used to choose which tool runs with which arguments without validation or authorization.
- **Excessive agency**: tools that can delete, pay, send, deploy, or push without a human approval step; tool permissions broader than the feature needs; no allow-list of commands or paths.
- **Data boundaries**: retrieval or memory that can return another tenant's documents; secrets, system prompts, or PII sent to a provider; conversation logs stored with less protection than the source data.
- **Egress**: user content forwarded to a provider other than the one disclosed to the user, or to a fallback provider without consent.
- **Agent-facing files**: instructions in repository files (`AGENTS.md`, `CLAUDE.md`, rules, skills, prompt templates, MCP configs) that a coding agent will load and that could be modified by an untrusted contributor.
