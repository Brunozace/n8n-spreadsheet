# Ventas claras: protected spreadsheet pilot

A Spanish website for small businesses to upload a sales workbook, understand data problems, and download `valid.xlsx`, `review.xlsx` and `summary.xlsx`.

It now also has a separate **repair quotation review** at **http://localhost:3000/quotation.html**: engine summaries, searchable parts, declared shortages, cell-level warnings and three quotation reports. See [QUOTATIONS.md](QUOTATIONS.md) for the supported layout, formula checks and use of the supplied workbook.

**Start here: [Windows setup](WINDOWS-SETUP.md).** You will create your own pilot password and two secrets, start Docker Compose, then import and bind the new private n8n workflow. No hosting purchase or public deployment is needed.

With `.env` already configured, `npm.cmd run setup:local` installs missing website workflows and builds the localhost pilot automatically. It preserves existing workflow IDs and your separate original n8n container.

The browser talks to a small Node server. Node protects access and reads the workbook. A private n8n webhook runs the unchanged validation from `core.mjs`. Node checks that processing finished and creates safe Excel downloads. Customers never open n8n.

| File | Purpose |
|---|---|
| `public/` | Spanish interface, mobile layout and review preview |
| `server.mjs`, `lib/` | Authentication, upload checks, isolated temporary results and Excel files |
| `03-web-upload.json` | New inactive workflow; bind Header Auth before local publication |
| `04-quotation-review.json`, `quotation-core.mjs` | Separate quotation workflow and safe formula/parts checks |
| `compose.yaml`, `Dockerfile` | Local web service and persistent private n8n storage |
| `compose.https.yaml`, `Caddyfile` | Optional future HTTPS deployment |
| `.env.example` | Settings placeholders; copy to a private `.env` |
| `tests/`, `scripts/test-live.mjs` | Repeatable application and disposable real n8n tests |

The blank Sales template and separate baseline sample are downloadable after signing in. Uploads default to 5 MB and at most 10,000 extracted records. Sales formula input is rejected; quotation formulas are handled separately as described in QUOTATIONS.md. Customer text is exported as text. Results and an unchanged copy of the upload live temporarily in memory and expire after 15 minutes, or sooner on deletion, logout or restart. Starting another upload on the same page deletes its previous result.

The supplied spreadsheets differ: `sample-sales - Copy.xlsx` gives **10 input, 6 valid, 4 review, 53,000 CLP**; `sample-sales.xlsx` already has V009's price set to 4000 and gives **10 input, 7 valid, 3 review, 61,000 CLP**. Both were preserved. The downloadable example reproduces the first case.

Read [verification results](TEST-RESULTS.md), [workflow comparison](WORKFLOW-DIFF.md), and [deployment, backups and retention](DEPLOYMENT.md). Your existing practice workflows remain available; Bruno has already run them successfully in local n8n. `START-HERE.md` retains their practice instructions.
