# Review repair quotations

Open **http://localhost:3000/quotation.html** and use the same pilot login as the sales page. Upload the original `.xlsx` layout; you do not need to turn it into a Sales table.

This mode is for checking a quotation before someone relies on it. It brings the engine sheets together, lets you search parts or filter by engine, and separates declared shortages from missing information. It does not enter orders or update inventory.

## What the user gets

- A count of engines, quoted parts, parts needing review, and units explicitly marked as missing.
- Each engine's stored net, IVA and total, plus the existing summary amounts and discounts. Decimal CLP amounts are preserved; the screen displays two decimal places.
- A searchable parts list and a filter for declared shortages or rows needing review.
- Warnings with the sheet and cell to check in Excel.
- `repuestos.xlsx`: complete parts list and a separate sheet of positive declared shortages.
- `revision.xlsx`: warnings and, where relevant, stored versus independently checked values.
- `resumen.xlsx`: engines, existing summary amounts and an explanation of the checks.
- A byte-for-byte copy of the uploaded original.

An authorized multi-engine workbook was checked without modification, including shared formulas, declared shortages and a missing-description warning. Customer-specific findings remain local rather than being distributed with this repository. These checks do not confirm that the commercial prices or stock availability are correct.

## Compatible layout

Each engine sheet needs one parts table with these headers on the same row: `Grupo`, `ITEM`, `CANT` or `CANTIDAD`, `FALTA`, `NUMERO PARTE`, `DESCRIPCION`, `P.UNITARIO`, `TOTAL $`. Common spacing, case and accents are handled. The header may appear below the title and engine details, as it does in the supplied workbook.

`TOTAL NETO` (or `SUBTOTAL`) must follow the detail rows. Catalog tables below that boundary are used by supported lookup formulas but are not counted as quoted parts. A likely parts table with incomplete headers or no subtotal boundary is rejected. Unrecognized extra sheets are called out rather than silently counted as parts. `RESUMEN` is optional; trailing spaces in its name are accepted.

Quantity must be a positive whole number. Unit prices may be nonnegative decimal CLP amounts in this mode; a blank price is never treated as zero. FALTA must be a nonnegative whole number when entered. **Blank FALTA means unknown, not zero.** A declared shortage above the quoted quantity is flagged. Repeated ITEM values within one engine sheet flag every occurrence. Repeated part numbers are allowed: the same part can legitimately appear several times. Uploads are independent.

Use the fictional example on the webpage to see the format. Its figures and identifiers are invented for demonstration; no customer's workbook is distributed as the sample.

## Formula checks and limits

Recalculate and save a copy in Excel before uploading. The application reads the values stored in the file. A bounded parser independently checks arithmetic `+ - * /`, parentheses, percentages, cell/range references, `SUM`, and exact-match `VLOOKUP`. It resolves ordinary shared Excel formulas while keeping their original evidence. It never uses JavaScript `eval` on customer formulas, opens Excel, executes macros, or follows external workbook links.

Unsupported functions, array/data-table formulas, circular references, missing stored results, Excel errors, and differences larger than 0.01 are flagged. No missing result is filled in, even when the checker can calculate an expected value. Original quoted amounts remain the reported amounts, including amounts with warnings. The overall parts net is the sum of stored engine subtotals only when all are readable; otherwise it is unspecified. It is not an approved amount for billing, and it does not combine parts with service charges.

The sales mode still rejects formulas and retains all its original rules. Quotation support is a separate workflow, not a change to sales validation.

The default upload limit is 5 MB. The quotation reader accepts at most 10,000 nonempty physical rows across the whole workbook, including headers, summaries and catalogs, and the processor accepts at most 10,000 part records and 200,000 cells. Archive, XML, column, formula-size and execution-time bounds also apply. This version recognizes this repair-quotation layout; it is not a universal Excel interpreter or a quotation editor.

## Local setup and updates

Follow [WINDOWS-SETUP.md](WINDOWS-SETUP.md) first. The additional workflow is **04-quotation-review.json**, with Header Auth `X-Pilot-Key` matching the existing `N8N_WEBHOOK_SECRET`. Its private production webhook is `/webhook/quotation-web`; bind the credential and publish only in the private pilot instance. Docker Compose supplies the private URL to Node. Direct Node startup derives this URL from the sales webhook host, or uses `N8N_QUOTATION_WEBHOOK_URL` if set.

For the first local installation, `npm.cmd run setup:local` installs missing website workflows, binds them automatically and builds the app using your existing `.env`. It never overwrites an existing workflow ID. You can use the editor instructions instead, especially for updating an existing workflow.

Rebuild the website after updates:

```powershell
docker compose up -d --build --wait
```

The source workflow is inactive and contains no credential binding. `npm.cmd run build:workflow` regenerates 03 and 04 only. Import updated workflows and rebind credentials when changing their validation logic. The practice workflows and the original `bruno-n8n` container are separate.

## Retention and verification

The same session isolation, 15-minute RAM-only result expiry, explicit deletion, logout cleanup and n8n execution-retention settings cover both modes. No customer workbook is written to an application upload directory. Downloaded files remain on the user's device. See [DEPLOYMENT.md](DEPLOYMENT.md).

`npm.cmd test` runs synthetic unit and HTTP tests; its workflow adapter is not real n8n. `npm.cmd run test:live` runs both modes through a disposable real n8n container and removes its resources. To also repeat the specific supplied-workbook acceptance check, set `QUOTATION_TEST_FILE` to its local path for that command. The file is read only; the test checks the expected counts, all four downloads and an unchanged original hash. The acceptance test is intentionally skipped when no path is provided. It targets the original acceptance workbook, not arbitrary customer files. Do not add customer spreadsheets to source control.

Before expanding the pilot, check several more authorized quotations in this same layout, including changed price catalogs and summary formulas. Have a person responsible for quotations review the output. Public HTTPS, hosting, backup restoration and operational checks remain in [DEPLOYMENT.md](DEPLOYMENT.md); nothing has been deployed publicly.
