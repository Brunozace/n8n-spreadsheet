# Your first spreadsheet automation

This starter checks a small business's sales spreadsheet and produces three Excel reports: valid sales with calculated totals, rows needing review, and a summary. All practice data is fictional.

The protected Spanish website is now in this folder. Start with [WINDOWS-SETUP.md](WINDOWS-SETUP.md) for the local pilot, [DEPLOYMENT.md](DEPLOYMENT.md) for later hosting, and [WORKFLOW-DIFF.md](WORKFLOW-DIFF.md) for the workflow comparison. The practice instructions below are preserved. Note: the local `sample-sales.xlsx` already has V009's price set to 4000 and therefore gives 7 valid, 3 review and 61,000 CLP. Download the website's separate sample to reproduce the original 6 valid, 4 review and 53,000 CLP fixture. Your original file has not been overwritten.

## Start with the demo

1. Unzip this folder.
2. Open your n8n editor and create a blank workflow. If you have not set up n8n yet, stop here; choosing your setup is our next step.
3. Open the workflow menu (three dots), choose **Import from File**, and select **01-demo.json**. Do not import the whole ZIP.
4. Click **Execute Workflow**. This version contains its own practice data and needs no account connections or API keys.
5. Open **Check sales** to inspect the results. You should see 6 valid entries, 4 entries needing review, and **53,000 CLP** in valid sales.
6. Open each **Download ...** node. In its output, select the binary file and use **Download**. You get `valid.xlsx`, `review.xlsx`, and `summary.xlsx` separately.

The total is explicitly marked INCOMPLETE because four rows have been excluded. It is not the total for the full input file.

## Then try uploading Excel

1. Create a second blank workflow and import **02-upload.json**.
2. Click **Execute Workflow**. A test upload form should open. If it does not, open **Upload practice spreadsheet** and use its Test URL while the workflow is listening.
3. Upload **sample-sales.xlsx** and submit it.
4. Return to the n8n editor. The form's receipt message only confirms upload, not successful validation.
5. Check that all nodes completed. Inspect **Check sales** and download the three output files as above.

Keep this workflow unpublished while practicing. The form has no authentication and is intended for fictional test files. Before using it with a client, configure access and agree how their data is stored and deleted.

## What the boxes mean

| Node | Job |
|---|---|
| Start demo / Upload practice spreadsheet | Starts a run |
| Practice sales / Read Sales sheet | Supplies each sales row |
| Check sales | Checks the values, flags problems, calculates totals |
| Valid sales / Needs review / Summary | Prepares each report |
| Download ... | Creates an Excel file |

## Input format

Use a single worksheet named **Sales**, with the following exact headers in row 1. Each row represents one sales line with its own unique transaction ID. If your business reuses order IDs for multiple line items, give each line a separate identifier or adapt the duplicate rule first.

| Header | Required value |
|---|---|
| transaction_id | Text identifier, preferably stored as text to retain leading zeros |
| product | Product or service name |
| quantity | Positive whole number |
| unit_price_clp | Nonnegative whole number of Chilean pesos; zero is allowed |

Enter prices as numeric cells such as `2500`. Excel may display thousands separators through cell formatting. Text such as `2.500`, `2,500` or `$2500` is rejected because it is ambiguous. Plain numeric text such as `2500` is accepted. Use values, not formulas, for the starter input: the extractor reads stored spreadsheet values and does not recalculate formulas.

The program trims surrounding spaces. Duplicate IDs are compared without regard to case; every occurrence is held for review. It never guesses a missing price or silently chooses a duplicate to retain. It does not edit the original file.

Extra columns are not carried into the valid-sales report. Review rows retain the extracted original record as JSON text. `input_record` means the position among extracted records, not the Excel row number; blank Excel rows can be skipped by extraction.

## Practice exercise

Make a copy of the sample spreadsheet. If the second V007 row represents a different real sale, change its ID to V008; otherwise delete that duplicate after checking the source. Fill the missing price only when you know it. Fix the negative quantity only if it is a data-entry error; refunds need a different workflow. Run the file again and see which warnings disappear.

## Scope and current status

- The core validation and embedded JavaScript were tested locally. Bruno confirms that the practice workflows have also run successfully in his local Windows/Docker n8n instance. See WORKFLOW-DIFF.md and the test report for the separate website workflow's verification.
- The input Excel file was generated, inspected and visually checked. `expected-results.json` gives a reference for the original practice file.
- Whole-number quantities and CLP only; no dates, tax calculation, discounts, refunds, inventory changes, multi-sheet consolidation or currency conversion.
- Empty or incorrect-schema input produces an error. Files are limited to 10,000 extracted rows. The demo is designed for small files; file-size limits should be configured before production use.
- When a report has no records, its Excel file contains a `NO_ROWS` status message. That message is not a sales record.
- Duplicate detection operates within one uploaded file. There is no cross-run database or history. Repeating an upload creates the same report; it does not append sales anywhere.
- No email is sent and no customer spreadsheet is overwritten. The workflow requires no AI model or AI API calls. Your n8n hosting may have a cost.

If an imported node shows an error, copy its error message or share a screenshot so we can adapt it to your installed n8n version. For upload issues, confirm the form field is `data`, the extractor uses binary field `data`, and the worksheet is named `Sales`.

## Turning this into a service

The first useful customer is a business repeatedly exporting the same sales spreadsheet and manually checking it. Ask for a fictional or anonymized example, agree the calculation and duplicate rules, then measure how long the manual task takes. Customize only after confirming that repeated problem. A one-time setup fee can cover the adaptation; recurring fees should correspond to actual hosting, monitoring and support work.

The next version can watch an agreed folder or run on a schedule and deliver the report automatically. That needs the client's account connection, failure alerts and protection against processing the same file twice. This starter is the practice foundation, not that production service yet.

## For developers

`core.mjs` is the dependency-free validation function. `build-workflows.mjs` embeds it in both workflows. `sample-data.json` is the demo fixture. To regenerate the workflow JSON files and test the logic, with Node.js installed, run:

```bash
node build-workflows.mjs
node test.mjs
```

Regenerating the JSON creates new node IDs. It does not update an already imported n8n workflow. The sample Excel file is supplied ready to use.

Official documentation and schema sources consulted:

- https://docs.n8n.io/workflows/export-import/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.formtrigger/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.extractfromfile/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.converttofile/
- https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Form/common.descriptions.ts
- https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Files/ConvertToFile/actions/spreadsheet.operation.ts
- https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/SpreadsheetFile/v2/fromFile.operation.ts
