# Workflow inspection before implementation

Inspected on 19 October 2026. There was no `workflow.json` (or a `workflow` directory containing `.json`). The additional local export is `02 - Upload a sales spreadsheet.json`.

That original export remains unchanged on the local computer and is excluded from Git because it contains instance metadata. The portable `02-upload.json` practice workflow is included in this repository.

Compared that export with `02-upload.json` before changing project files:

- The same nine nodes, names, node types, node versions and connections are present.
- `Check sales` contains exactly the same validation JavaScript. The three report-preparation Code nodes also contain exactly the same JavaScript.
- The export omits default parameters: Code `mode: runOnceForAllItems`, file nodes' `binaryPropertyName: data`, form `responseMode: onReceived`, and form response `respondWith: text`. This is export normalization, not a change to sales rules.
- Worksheet `Sales`, row-1 headers, empty-cell inclusion, raw values, filenames, and `NO_ROWS` handling are unchanged.
- Node IDs, webhook ID and positions changed. The export adds instance/workflow metadata, `nodeGroups: []`, and `settings.binaryMode: separate`.
- The practice form still acknowledges receipt before processing finishes. It is not a completed-results API.

Bruno reports that the practice workflows ran successfully in his local Windows/Docker n8n. The obsolete statement in START-HERE.md has been corrected. The supplied practice workflow JSON files, core.mjs and original sample have been preserved.

Read-only inspection found the existing `bruno-n8n` container running **n8n 2.43.7** on `127.0.0.1:5678`. The installed Webhook v2.2, Code v2, and Respond to Webhook v1.5 schemas were inspected. The deployment configuration pins that installed n8n image by digest.

## Separate website workflow

`03-web-upload.json` is a new, inactive workflow; `scripts/build-web-workflow.mjs` builds it without modifying either practice workflow. It reuses the exact `processSales` function from `core.mjs`.

The Node server validates and extracts the workbook, then privately sends `POST /webhook/sales-web` with a Header Auth credential. The body is `{ "requestId": "unique-request-id", "rows": [...] }`. n8n returns `{ "requestId": "unique-request-id", "result": { "valid": [...], "review": [...], "summary": {...} } }` only after validation finishes. The Node server verifies the response and writes the three Excel reports with customer text stored as text. Customers use only the website.

Import requires binding a new Header Auth credential to **Private website request**, with Name `X-Pilot-Key` and Value matching `N8N_WEBHOOK_SECRET`. The shareable JSON intentionally contains no credential names, IDs or secret values. Publish this workflow only inside the private pilot instance after that binding; the distributed file remains inactive.

The baseline fixture in `sample-data.json` and `expected-results.json` expects **10 input, 6 valid, 4 review, 53,000 CLP**. Inspection found that the local `sample-sales.xlsx` already contains V009's price of 4000, so that preserved file correctly produces **10 input, 7 valid, 3 review, 61,000 CLP**. The website's separate downloadable sample is generated from the baseline fixture, so it reproduces 53,000 CLP without overwriting Bruno's workbook. The corrected sample is tested by changing only V009's price in memory. Repeating an upload produces a fresh report; there is no cross-upload duplicate database or external sales write.

The supplied `sample-sales - Copy.xlsx` also preserves the original missing-price case (53,000 CLP). Its XML uses namespace prefixes, which the new server reader supports. Both supplied spreadsheets remain unchanged.

See [TEST-RESULTS.md](TEST-RESULTS.md) for the real n8n, browser, HTTP and file checks actually executed.

Primary references checked: [Webhook authentication and responses](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/), [Respond to Webhook behavior](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/), and [execution retention settings](https://docs.n8n.io/hosting/configuration/environment-variables/executions/).
