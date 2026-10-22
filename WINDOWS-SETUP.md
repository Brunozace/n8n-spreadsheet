# Run the protected pilot on Windows

This starts a Spanish website at **http://localhost:3000** and a separate private n8n editor at **http://localhost:5679**. Your existing `bruno-n8n` container on port 5678 is left alone. Customers never need the n8n editor.

You need Docker Desktop running with Linux containers, and Node.js 22.17 or later. The Docker image includes Node; the local installation is used for tests and password hashing. These instructions use PowerShell in this project folder.

## 1. Install and check

```powershell
cd C:\Users\bruno\Downloads\Spreadsheet_Automation_Starter
node --version
docker compose version
npm ci
npm test
```

Read [TEST-RESULTS.md](TEST-RESULTS.md) for the checks actually run during implementation. `npm test` is repeatable without your existing n8n container; its HTTP tests use a clearly identified isolated test backend. The real n8n check is separate.

## 2. Set local passwords and secrets

Create a local settings file only if you do not already have one:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
node scripts/hash-password.mjs
```

Enter a unique pilot password with at least 12 characters when asked. It is hidden while typing. Copy the resulting hash, not the password, into `.env`:

```dotenv
PILOT_USERS_JSON='{"bruno":"PASTE_THE_COMPLETE_HASH_HERE"}'
```

Keep the outer single quotes: the hashes contain `$`, which must stay literal. For a second customer, generate a second hash and add another entry, such as `"cliente2":"SECOND_HASH"`, inside the same JSON object. Give each person their own account. Do not put passwords on the command line or commit `.env`.

Replace only `PASTE_THE_COMPLETE_HASH_HERE` in the example above. Keep the `{"bruno":"..."}` wrapper: placing the hash alone after `PILOT_USERS_JSON=` prevents the website from starting.

Run this command **twice** to generate two different secrets:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put one value in `N8N_WEBHOOK_SECRET` and the other in `N8N_ENCRYPTION_KEY`. Do not leave the example placeholders. The webhook secret connects the website to n8n; the encryption key protects saved n8n credentials. Keep the encryption key unchanged after startup and store a protected backup.

The other defaults are ready for local use: 5 MB per upload, 10,000 extracted records, 15-minute result retention, and an 8-hour login session. Use `localhost` consistently; `APP_ORIGIN` must exactly match the website address you use, without a trailing slash. If changing `WEB_PORT`, also change `APP_ORIGIN` to the same port.

## 3. Start the separate pilot

After completing `.env`, the quickest setup is now:

```powershell
npm.cmd run setup:local
```

This builds the website and installs any missing 03/04 workflows into this project's private localhost n8n, binds the secret without printing it, publishes them locally and checks them with fictional data. It keeps existing workflow IDs and the persistent volume. It briefly restarts the pilot and clears temporary web sessions/results. It does not touch `bruno-n8n` or deploy publicly. Temporary credential files under `.tmp/local-setup-*` are removed when the command exits; if the computer loses power during setup, delete only that leftover setup directory before sharing the project. Continue by opening **http://localhost:3000/quotation.html** and signing in with your existing pilot username/password.

The manual alternative below is useful when importing a changed workflow or choosing credentials in the editor yourself. The automated helper does not overwrite an existing workflow; if a check reports an existing workflow is not ready, use these manual binding/publication steps.

```powershell
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
docker compose port n8n 5678
```

The first build downloads images and can take several minutes. Wait for both services to be healthy. The last command should show `127.0.0.1:5679` (or your configured editor port). In `docker compose ps`, n8n should show `127.0.0.1:5679->5678/tcp`, not just `5678/tcp`. Open **http://localhost:5679** and create the n8n owner account. This administrator password is separate from the pilot website password.

Import **03-web-upload.json** through the workflow menu's **Import from File**. It is intentionally inactive and has no embedded credentials. Open **Private website request** and create a **Header Auth** credential:

| Field | Value |
|---|---|
| Name | `X-Pilot-Key` |
| Value | The exact `N8N_WEBHOOK_SECRET` from your `.env` |

Save that credential and select it on the node. Confirm **Respond** is **Using Respond to Webhook Node**. Save and publish this workflow **inside this local pilot instance** so its `/webhook/sales-web` URL is registered. The editor is bound to your computer's loopback address; publishing here does not deploy the website publicly. Do not publish the unauthenticated practice form for customers.

Open **http://localhost:3000** and sign in with `bruno` and the password you entered. Download the blank template or the separate sample, then upload an `.xlsx` file. A successful result includes the counts, the CLP total, a review preview and three download buttons. Download the reports within 15 minutes. You can also download the unchanged uploaded original while its result exists.

For repair quotations, also import **04-quotation-review.json**. On **Private website request**, select the same Header Auth credential, then save and publish this second workflow in the local pilot. Its path is `quotation-web`. Open **http://localhost:3000/quotation.html**, or use **Cotizaciones de reparación** on the sales page. Upload the quotation in its existing layout. See [QUOTATIONS.md](QUOTATIONS.md) for what it checks and the three new reports. The downloadable quotation example is fictional and separate from your original workbook.

## 4. Check the full path

1. Upload the website's **sample**: expect **10 input / 6 valid / 4 review / 53,000 CLP**. Open all three downloaded Excel files.
2. In a copy of that sample, set V009's missing price to `4000`, save, and upload: expect **10 / 7 / 3 / 61,000 CLP**.
3. Try a file without the `product` header, one without the `Sales` sheet, and one containing a formula. Each must show a clear error and produce no successful result.
4. Include two IDs differing only in case or surrounding spaces. Both occurrences must appear in review.
5. Sign in from a second browser/account. A download URL copied from the first session must be refused.

The local `sample-sales.xlsx` already has V009's price set to `4000`. It was preserved and should give 61,000 CLP. The supplied `sample-sales - Copy.xlsx` contains the original missing-price case and gives 53,000 CLP, as does the website's downloadable sample. See [WORKFLOW-DIFF.md](WORKFLOW-DIFF.md).

To repeat the automated real n8n test with Docker Desktop running:

```powershell
npm.cmd run test:live
```

This creates its own temporary n8n container and volume, imports copies of both website workflows with a synthetic credential, runs actual uploads and downloads, and deletes its test resources. It never imports into your existing n8n database. If interrupted, clean up only the recorded test environment with `node scripts/start-test-n8n.mjs --stop`. Use `npm.cmd` instead of `npm` if PowerShell blocks npm's script wrapper.

If the workflow is unpublished, its credential does not match, or n8n cannot finish within the timeout, the website shows an error. An upload receipt alone is never treated as completed processing. `/healthz` checks that the web process is alive; it does not prove the workflow is ready, so always perform the sample upload after setup or changes.

## Everyday commands

If the editor says `ERR_CONNECTION_REFUSED` while n8n is healthy, confirm the published port above. The corrected Compose file gives n8n a management network in addition to the internal processing network; this lets Docker Desktop publish its localhost port. Apply updated configuration with `docker compose up -d --wait`. This preserves the n8n volume; do not use `down -v` to troubleshoot a connection error.

If the website keeps restarting, run `docker compose logs --tail 10 web`. A `PILOT_USERS_JSON` JSON error means the setting needs the complete user-to-hash object shown in step 2. After fixing `.env`, run `docker compose up -d --force-recreate --wait web`. Do not paste `.env`, password hashes or secrets into support messages.

```powershell
# See concise service output. Avoid enabling verbose request/body logs.
docker compose logs --tail 50 web n8n

# Stop while preserving n8n workflows and credentials.
docker compose stop

# Start again.
docker compose up -d

# Rebuild the web service after source changes.
docker compose up -d --build web
```

Do not use `docker compose down -v` unless you deliberately want to erase the pilot's n8n storage. Restarting or rebuilding the web container signs users out and discards all temporary upload results. The customer's original file on their computer is never modified.

After changing accounts/passwords or other web settings in `.env`, run `docker compose up -d --force-recreate web`. This immediately discards existing sessions/results and applies the new account list. After changing the webhook secret, update the n8n credential to the same value before testing again.

## Run Node directly while developing

You can keep only the pilot n8n container running and run the website in PowerShell:

```powershell
docker compose stop web
docker compose up -d n8n
npm start
```

The `.env` `N8N_WEBHOOK_URL` uses `localhost:5679` for this mode. Docker Compose supplies `http://n8n:5678/webhook/sales-web` to the web container instead. Keep `.env` `HOST=127.0.0.1` for direct local use. Press Ctrl+C to stop Node.

Regenerate the two website workflows with `npm run build:workflow`. Reimport them into the pilot and rebind the credential if necessary. Do not run the older `build-workflows.mjs` merely to update the website: that generator replaces practice workflow node IDs.
