# Verification results

Sales implementation verified on 20 October 2026 on Windows, Node 22.17.0, Docker Desktop and disposable n8n **2.43.7**, using fictional sales data. Quotation support was verified on 21 October 2026 with synthetic fixtures and a read-only test of Bruno's explicitly supplied workbook.

## Quotation version: checks actually run

| Check | Result |
|---|---|
| Original sales checks | All 12 passed before the quotation work and after the changes |
| Final `npm.cmd test` with `QUOTATION_TEST_FILE` set | 12 original checks plus 60 application/unit/security tests passed |
| Default `npm.cmd test` | The supplied-workbook acceptance case is skipped unless its local path is provided; it is not bundled with the repository |
| `04-quotation-review.json` structural check | Passed with Python UTF-8 mode; inactive export, no credential binding, valid connections |
| Real disposable n8n | 21 HTTP pipeline/completion tests passed, including both modes, the actual supplied quotation, all report downloads and original-file comparisons |
| Shared-formula reader | All shared formulas in the authorized acceptance workbook resolved safely; all formula cells audited, zero unverified |
| Headless Chrome with real n8n | Login, quotation upload, all four downloads, Excel readback, search, shortage filter, duplicate warning, inert HTML-like customer text, delete, invalid file and logout passed; no JavaScript errors |
| Mobile layout | Desktop and 375px screenshots inspected; no horizontal page overflow at 375px or 320px |
| Local Compose pilot | Website image rebuilt; original imported 03 and new 04 active only in localhost pilot; private fictional-data smoke checks passed; final duplicate-header rejection checked in installed 04 |
| Configuration and dependencies | Base/HTTPS Compose configuration validation passed; `npm.cmd audit --omit=dev` reported zero vulnerabilities at the check |

The final quotation acceptance check matched the expected engine, part and shortage counts and identified a missing description with its source cell. Customer-specific sheet names and findings are omitted from this public report. Existing quotation amounts, IVA and service discounts were preserved. Formula checks do not establish that prices or availability are commercially correct.

All generated Excel reports were reopened. The actual quotation's exported part identifiers, source rows, descriptions, quantities, shortage counts and monetary values were compared to the completed result. Downloads contain scalar values, never executable customer formulas. The downloaded original was byte-identical, and the source workbook's SHA-256 was unchanged after the test. No customer workbook or report was committed or distributed as an example.

Coverage includes false `.xlsx` files, wrong extension, size limits, missing/duplicate columns, an incomplete extra engine, an empty parts table, missing subtotal boundaries, duplicate ITEM values, valid repeated part numbers, blank versus zero FALTA, decimal CLP, stale/unsupported formulas, missing cached values, circular references, external references, namespace variants, malicious XML, shared formulas and session isolation. The original sales samples still produce **10 / 6 / 4 / 53,000 CLP** and **10 / 7 / 3 / 61,000 CLP**.

`npm.cmd run setup:local` was run against the separate `sales-pilot` Compose project. The new quotation workflow was installed as a local setup action after isolated testing; the original `bruno-n8n` instance was not used for these tests or changed. The setup helper initially could not see the existing imported 03 because n8n's warn-level logger suppressed its list output. It created an extra 03 copy; that helper-created copy (`salesWebPilotV1`) was then unpublished. The user's original imported 03 remained unchanged and active, with one active sales webhook. The helper now explicitly reads the list at info level and preserves both existing IDs and matching names. A repeat setup kept both workflows and passed its smoke checks. Existing pilot usernames, password hashes, encryption key and persistent volume were preserved. Temporary setup credentials were removed. The disposable test container, test volume and its private runtime configuration were deleted after verification.

Public HTTPS, hosting, external firewall checks, backup/restore drills and broader quotation-layout acceptance remain deployment tasks. No public deployment or purchase was performed. The earlier sales verification below remains as implementation history.

## Checks actually run

Follow-up during Bruno's Windows startup: the actual Compose deployment exposed a networking issue not covered by the earlier disposable n8n tests. With n8n attached only to the internal processing network, Docker Desktop kept the container healthy but did not publish port 5679. The corrected configuration adds a separate management bridge while retaining the localhost-only port binding. After recreation, Windows received HTTP 200 from the editor and both service health endpoints; the web container could reach n8n privately, and the same `sales-pilot_n8n_data` volume remained mounted. The user-map formatting error in local settings was also corrected without changing the existing password hash.

| Check | Result |
|---|---|
| Original `node test.mjs`, before implementation | 12 checks passed |
| Final `npm.cmd test` | Original 12 checks plus 29 application/security tests passed |
| New workflow structural checker | Valid JSON, nodes/connections valid, inactive, no credential binding included |
| `node scripts/test-live.mjs --reuse --keep` | 12 tests passed through real n8n, including the parent test |
| Fresh disposable n8n setup | Credential import, workflow import, publication and actual webhook/Code-node smoke passed |
| Docker web image build | Passed; production dependencies installed with `npm ci --omit=dev --ignore-scripts` |
| Base and HTTPS Compose configuration | Both validated with `docker compose config --quiet` |
| `npm.cmd audit --omit=dev` | Zero reported vulnerabilities at this check; this is not a security certification |
| Headless Chrome browser checks | Login/errors, template/sample, upload, all downloads, review reasons, pagination, deletion and logout passed; no browser JavaScript errors |
| Browser visual checks | Desktop and 375px mobile screenshots inspected; no horizontal page overflow at 375px or 320px; mobile review cards show the reasons directly |

`npm test` uses an explicitly identified local HTTP adapter for repeatability without Docker. That adapter runs the new workflow's embedded Code node; it is not called a real n8n test. `test:live` instead sends requests to a real, isolated n8n container and validates the response through the same Node upload/download endpoints. The Chrome browser path was also exercised with Node connected to this real n8n backend.

## Verified numerical results

| Input | Input records | Valid | Review | Valid sales CLP |
|---|---:|---:|---:|---:|
| Supplied `sample-sales - Copy.xlsx` | 10 | 6 | 4 | 53,000 |
| Website's generated baseline sample | 10 | 6 | 4 | 53,000 |
| Baseline copy with only V009's price changed to 4000 | 10 | 7 | 3 | 61,000 |
| Supplied `sample-sales.xlsx` (already corrected when inspected) | 10 | 7 | 3 | 61,000 |

For both supplied workbooks, the actual downloaded `valid.xlsx` rows were compared to the expected records and amounts, `review.xlsx` to the returned review reasons/original values, and `summary.xlsx` to all summary fields. The downloaded original matched the upload byte for byte. No supplied workbook was rewritten.

## Safety and failure coverage

Tests exercised fake/truncated Excel files, wrong extensions/MIME, missing Sales sheet, missing/duplicate headers, unlabelled data, merged cells, formulas with cached results, oversize uploads, 10,000 accepted versus 10,001 rejected records, XML depth/DTD rejection, macro/external-link rejection and excessive ZIP expansion.

Business checks cover all occurrences of case/space-insensitive duplicate IDs, duplicate scope resetting on a second upload, zero versus missing prices, invalid quantities, unsafe totals, no-row reports and unchanged original inputs. Formula-looking customer text remains an Excel string; worksheet XML contains no formula elements in generated reports. OOXML text escapes and literal escape-looking text round-trip without silent changes.

HTTP checks cover authentication, origin/CSRF protection, another user's access, another session using the same account, expiry, deletion, logout and unchanged original downloads. A receipt, malformed or mismatched result, incorrect total, backend error, oversized response and timeout all fail without exposing successful download links. Failure and timeout scenarios use controlled test backends; they were not induced in Bruno's existing n8n instance.

One timing-sensitive expiry assertion initially failed under concurrent test load. It measured password-hashing time as part of a 100ms allowance. The test now measures from completed login with a realistic session allowance; the expiry behavior was retained and the full suite passed afterward.

## Repeat the checks

```powershell
npm.cmd ci
npm.cmd test
# Docker Desktop must be running for this command.
npm.cmd run test:live
```

The live script creates a labelled, uniquely named test container and volume, imports a copy of `03-web-upload.json` with synthetic credentials, publishes only that copy and removes its resources afterward. Temporary credentials live under ignored `.test-runtime/`. If interrupted, run `node scripts/start-test-n8n.mjs --stop`. It verifies ownership before removing the recorded container/volume and checks that its temporary directory is inside this project. Do not share that private directory.

## Still requires Bruno's setup or a future host

The new workflow was not imported or published in Bruno's existing `bruno-n8n` instance. His confirmation that the two practice workflows ran successfully is preserved separately from these tests. Follow the Windows guide to choose real passwords, create the pilot n8n owner account, bind Header Auth and enable the new workflow in the chosen pilot instance. Then repeat a sample upload there.

No public domain, TLS certificate, firewall deployment, backup/restore exercise, large-scale load test or multi-browser compatibility campaign was performed. Excel files were decoded and inspected programmatically; Microsoft Excel's desktop UI was not used to open them. The optional HTTPS configuration is prepared and syntax-checked, but actual HTTPS and operational recovery must be tested on the selected host before inviting customers. No service was purchased and no public deployment was made.
