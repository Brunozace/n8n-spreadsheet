# Deploy later: a small protected pilot

The project is prepared locally. No public host, domain, paid service, or certificate has been purchased or deployed. First run [WINDOWS-SETUP.md](WINDOWS-SETUP.md). The simple deployment uses one Node web process, one private n8n process, SQLite in a persistent Docker volume, and optional Caddy HTTPS. It is intended for a few invited customers, with individual passwords and no subscriptions or payments.

## What runs where

The browser talks only to the Node website. Node authenticates the session, checks the `.xlsx` archive and worksheet, extracts the records, and sends JSON to a private n8n webhook with `X-Pilot-Key`. The n8n Code node uses the existing `processSales` function. Only a completed response with the correct request ID and expected structure can become a successful result. Node builds the Excel reports, writes customer strings as text, and serves session-protected download links.

The browser receives no n8n URL, editor credential, encryption key or webhook secret. The processing Docker network is internal. n8n also joins a separate management bridge so Docker Desktop can publish the editor port; that bridge permits outbound connectivity. The editor's published port is bound to `127.0.0.1` only. The optional HTTPS proxy routes solely to the web service and does not join the management bridge. Never add a public n8n editor route or a public mapping for port 5679.

The default upload limit is 5 MB (`MAX_UPLOAD_MB`), with 10,000 extracted records. The parser also caps decompressed archive size, XML complexity, worksheet dimensions and cell values to keep a small compressed file from consuming unbounded resources. Formula input is rejected rather than evaluated. Missing values are never filled in. The total excludes every review record; the UI and summary report say so explicitly.

## HTTPS deployment procedure

When you choose a host, use a maintained Linux server with Docker Compose, adequate memory for the two 1 GB container limits and the OS, and a domain you control. This project does not choose or purchase the host. The shipped n8n image is pinned to the locally inspected **2.43.7** image digest. Before public use, check security updates, test any update on a separate instance, and repin the tested image. The Node base image is pinned to 22.22.0-bookworm-slim.

1. Copy the source and configuration to the host. Do not copy customer spreadsheets, local test artifacts, `.env`, or your existing n8n database through source control.
2. Create a new host-local `.env` using `.env.example`. Generate fresh pilot accounts and secrets. Restrict `.env` to the service administrator (for example `chmod 600 .env`). Keep an encrypted copy of the n8n encryption key separately.
3. Set `DOMAIN` to your chosen hostname, `ACME_EMAIL` to your address, `APP_ORIGIN=https://your-hostname`, and `SECURE_COOKIE=true`. The HTTPS overlay also enforces HTTPS origin, secure cookies and production mode.
4. Point the domain's DNS at the server. Permit public ports 80 and 443 for Caddy. Restrict SSH to your administrator network; leave ports 3000 and 5679 closed publicly. Docker port-publishing rules matter as well as the host firewall: keep their existing loopback bindings.
5. When ready to deploy, validate and start:

```sh
docker compose -f compose.yaml -f compose.https.yaml config --quiet
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

Caddy obtains and renews the HTTPS certificate. Its configuration proxies only the website and disables access logging. Ports 80/443 and valid DNS must be available for certificate issuance. Do not use the local HTTP setup for remote customers. [Caddy's HTTPS documentation](https://caddyserver.com/docs/automatic-https) explains the DNS and network requirements.

Use an SSH tunnel from your administrator computer to configure n8n:

```powershell
ssh -L 5679:127.0.0.1:5679 your-admin@your-server
```

Then open `http://localhost:5679` locally, create the owner account, import `03-web-upload.json`, bind Header Auth, and publish it as described in the Windows guide. n8n's `N8N_SECURE_COOKIE=false` is limited to this loopback HTTP editor reached through an encrypted tunnel; it does not control customer cookies. A private VPN is another option. Never share the editor with customers.

Before inviting anyone, upload the baseline and corrected sample through the HTTPS website, download and open all reports, confirm another session cannot fetch them, and confirm a missing webhook credential produces an error. Test timeouts using an isolated test backend, not by deliberately breaking a client's running upload. Review [TEST-RESULTS.md](TEST-RESULTS.md) to distinguish implemented tests from host-specific work still pending.

## Accounts and secrets

`PILOT_USERS_JSON` contains one username and scrypt password hash per account. Passwords are entered through `node scripts/hash-password.mjs`; do not put plaintext passwords in `.env`. Use individual accounts, strong unique passwords, and a private channel to give users their initial password. There is no self-registration, password reset, subscription system or multi-instance session store. To revoke access, remove the account or replace its hash and recreate the web container; that clears all sessions and temporary results immediately.

Session cookies are HttpOnly and SameSite, and Secure under HTTPS. Requests that change state require the expected origin and CSRF protection. The server limits login attempts, upload frequency, concurrent uploads, session count and retained bytes. Keep the app behind one trusted proxy. Rate limiting uses the connection address; it does not trust arbitrary `X-Forwarded-For` headers. As a result, the small pilot's network limits may be shared behind Caddy. Tune carefully after observing actual use; use a proper edge rate limiter before opening to a large audience.

Store `N8N_WEBHOOK_SECRET` only in the server environment and the n8n Header Auth credential. Store `N8N_ENCRYPTION_KEY` securely and do not casually rotate it: encrypted credentials depend on it. Do not log these values or spreadsheet contents. A container administrator can inspect environment variables; access to Docker is administrator access.

## Data retention and deletion

The quotation page and `04-quotation-review.json` use the same authentication, private network and retention controls as the sales page. Bind and publish both private workflows when enabling both modes. Quotations additionally pass extracted cell values and formula evidence to n8n; these are customer data too. Do not pin or log this input. See [QUOTATIONS.md](QUOTATIONS.md) for the quotation-specific limits and formula boundaries. Saved IVA/discount amounts are read from the customer's workbook, not supplied as financial advice or new business rules.

| Data | Where it exists | When it is removed |
|---|---|---|
| Customer's original local workbook | Customer's computer | The customer controls it; this service never changes it |
| Uploaded bytes, extracted data and generated reports | Web process memory; no upload/results directory or volume | On configured result expiry (15 minutes by default), explicit deletion/logout, session expiry, or process restart; access is denied once expired |
| Failed or timed-out upload | Temporary request/process memory | Discarded after the request finishes/fails; no downloadable successful result is created |
| n8n execution input/output | Execution memory; any operational database metadata is in `n8n_data` | Saving success, failure, manual execution and progress data is disabled; pruning is a fallback described below |
| n8n workflows, owner account and encrypted credential | Persistent `sales-pilot_n8n_data` Docker volume | Kept until deliberately changed/deleted; included in protected operational backups |
| Application sessions | Web process memory | 8 hours by default, logout, account-change restart or process restart |
| Container operational logs | Docker's local logging storage | Rotated at two 5 MB files per service; no request bodies or spreadsheets intentionally logged |

The server keeps at most three jobs per session, two concurrent uploads and 128 MB of retained result data by default. At capacity it refuses new uploads. The website deletes its previous result when a new upload starts, so customers should download first. Expired results are inaccessible immediately; the memory cleanup sweep runs at most 60 seconds later. RAM-only retention is not a promise of cryptographic erasure: an in-flight download, garbage collection, OS swap or crash dump can outlive an application reference. Use encrypted disks/swap and disable production process dumps. Downloads saved on customer devices remain until customers delete them.

Besides the configurable upload limit, this pilot accepts at most 1,000 ZIP entries, 32 MB total decompressed data, 16 MB per archive component, 250,000 cells, 64 columns, and cell positions within the first 100,001 worksheet rows. An extracted record must fit within 30,000 characters so its original JSON fits in an Excel cell. XML depth and element counts are bounded. Merged Sales cells, duplicate or missing headers, data without headers, macros, embedded objects and external workbook links are rejected with an explanation. These are protective input limits, not automatic corrections; extra named columns remain in review JSON but are omitted from valid sales as before.

n8n is configured with `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`, `EXECUTIONS_DATA_SAVE_ON_ERROR=none`, `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false`, and `EXECUTIONS_DATA_SAVE_ON_PROGRESS=false`, both globally and in the new workflow. `EXECUTIONS_DATA_PRUNE=true`, a one-hour age limit, 100-execution cap, and 15-minute prune intervals provide a fallback for metadata or accidentally saved completed executions. The one-hour hard-delete buffer and cleanup schedule mean deletion is not exact to the second; budget roughly two hours plus cleanup intervals for any mistakenly persisted completed run. This is not a policy of retaining customer spreadsheets for two hours: normal payload saving is disabled. Verify settings after imports/upgrades and keep real data out of manually pinned node output. [n8n documents the retention and timeout variables here](https://docs.n8n.io/hosting/configuration/environment-variables/executions/).

The workflow's execution timeout is 60 seconds; the web request timeout is 65 seconds by default. A web timeout does not guarantee that n8n immediately stopped, but the execution has its own cap and makes no external sales writes. There is no automatic retry or cross-upload deduplication. Reuploading creates a new isolated calculation.

## Backup and restore

Back up **configuration and n8n workflow/credential state**, not customer spreadsheets. The web container has no customer-data volume. Use encrypted, access-restricted backup storage and define a short operational backup schedule, for example daily with seven daily copies. Retention must match what you tell pilot customers. Remove older copies through your backup system. Do not include debug exports with customer execution data, customer downloads, crash dumps, or logs in routine backups.

To take a consistent local n8n backup in PowerShell, pause new uploads and stop the services first. The default volume is `sales-pilot_n8n_data`; verify it with `docker volume inspect sales-pilot_n8n_data` before proceeding. These commands create a copy and do not remove the volume:

```powershell
docker compose stop web n8n
New-Item -ItemType Directory -Force -Path backups | Out-Null
$pilotBackupDirectory = (Resolve-Path -LiteralPath backups).Path
$pilotBackupName = 'n8n-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.tgz'
docker run --rm --user root --entrypoint tar --mount type=volume,src=sales-pilot_n8n_data,dst=/source,readonly --mount "type=bind,src=$pilotBackupDirectory,dst=/backup" n8nio/n8n@sha256:3db21366be1d3c77c1708963129c051948573019659e8873e0294be035ffc1b2 -czf "/backup/$pilotBackupName" -C /source .
docker compose up -d
```

Encrypt and move that archive into your protected backup store. Back up `.env` separately with equal protection; the archive alone is insufficient without the matching encryption key. The archive may contain operational metadata and any payload accidentally saved by altered settings, so treat it as sensitive. The commands above are a documented procedure, not evidence that a backup or restore was run against Bruno's existing instance.

Test a restore into a **new** named volume and isolated Compose project, never over your only live volume. Extract the archive into the new volume with the same image and preserve owner IDs. Configure that test instance with the matching encryption key, different loopback ports, and no external credentials/destinations. Confirm the owner login, credential decryption and sample upload all work. Only replace a live installation during a planned maintenance window after that test. Never use `down -v` as a routine restart command. [n8n's Docker guide explains persistent storage](https://docs.n8n.io/hosting/installation/server-setups/docker-compose/).

## Before a wider public launch

Choose the host/domain and test actual HTTPS, firewall rules, operational backups and a restore. Review current dependency/container advisories and n8n's licensing terms for the way you offer the service. Agree the data retention notice, support contact and expected spreadsheet format with pilot customers. Check the relevant Chilean privacy and business obligations with an appropriate local adviser. These deployment and business decisions have not been completed by preparing code.

Run a modest load test with realistic permitted workbooks and monitor memory, failed requests and availability without capturing customer data. Review parser and authentication security before allowing uninvited users. This single-process pilot loses sessions/results on restart, has manual account administration, and does not provide high availability or a queue. Wider access may justify stronger identity management and an external session/temporary-result store with the same isolation and deletion guarantees; those additions are outside this version.
