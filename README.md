# Relay Merchant Operations

Relay is a working demo of how an Indian payments company could onboard a merchant. A merchant submits business details and supporting documents, tracks the application, and responds if something needs fixing. The owner sees all applications in a review queue, compares the evidence, and decides when to approve.

PAN, GST, bank verification, and merchant ID creation use simulators. The app uses Next.js, TypeScript, Tailwind CSS, and SQLite. AI document extraction is available through OpenRouter or Ollama.

## Run locally

1. Use Node.js 22.13 or later and run `npm ci`.
2. Copy `.env.example` to `.env.local` if you do not already have one. On Windows PowerShell, use `Copy-Item .env.example .env.local`.
3. Set the following values in `.env.local`. Choose an owner password of at least 12 characters.

   ```dotenv
   RELAY_OWNER_ID=relay-owner
   RELAY_OWNER_PASSWORD=choose-a-local-password
   ```

4. Run `npm run dev` and open [Relay on localhost](http://127.0.0.1:3000/).

Choose **Owner** and use the credentials you set to open the manager dashboard. Choose **Merchant** to create a test account and submit applications. A merchant only sees applications and inbox messages for that account.

For a production build, run `npm run build` and then `npm start`. Both the dev and production commands start the callback worker alongside the web app. Restart Relay after changing environment settings.

## Submission files

The SQLite snapshot at `data/relay-review.sqlite` is included intentionally so reviewers can open a populated dashboard and inspect earlier cases. On first use, copy it to a local working file so your test accounts and changes stay in that copy. On Windows PowerShell, run `Copy-Item data/relay-review.sqlite data/relay-review-local.sqlite`. On macOS or Linux, run `cp data/relay-review.sqlite data/relay-review-local.sqlite`. Then add this line to `.env.local` before starting Relay.

```dotenv
RELAY_DB_PATH=data/relay-review-local.sqlite
```

The snapshot keeps the applications, verification attempts, callback history, and merchant IDs. It has no saved merchant logins or sessions. Set your own owner credentials in `.env.local` for the dashboard and create a fresh merchant account for submission and inbox testing. If you leave `RELAY_DB_PATH` unset, Relay uses `data/relay.sqlite` and fills a fresh database with fictional demo cases on first use.

The environment template `.env.example` is included for the submission check. If a separate environment file with a review-only API key is supplied, its inclusion is intentional and lets the evaluator try AI extraction. Copy those values into the local `.env.local` file. Active API keys and owner passwords belong in the private environment file. The sample application and full verification walkthrough work without an AI key.

## Try the main workflow

Use a fresh database for this walkthrough if the submitted snapshot already contains Monsoon Paperworks. Set `RELAY_DB_PATH=data/relay-walkthrough.sqlite` and restart Relay. Keep GST mandatory for this demo.

1. Sign in as a merchant. Open **New application**, choose **Use sample application**, and click **Submit application**. This loads a fictional merchant, Monsoon Paperworks, with a legal name that deliberately differs from the GST record.
2. Sign out, sign in as **Owner**, and open the application from the dashboard. Wait for the callbacks. PAN and bank should pass, and GST should send the application to **Needs review**. Open the GST check to compare the submitted, extracted, and simulated registry values.
3. Choose **Request correction** and enter a clear reason, such as “Please update the legal name to match the GST certificate.”
4. Sign back in as the same merchant. Open **Inbox**, choose **Review and correct**, and click **Use extracted legal name** before resubmitting. Relay reruns GST and keeps the passing PAN and bank checks.
5. Sign back in as **Owner**. When the application reaches **Ready to approve**, choose **Approve application**. Relay creates a merchant ID through a separate callback.
6. Open **Demo controls**, choose **Replay setup success callback**, and refresh. The merchant ID stays the same and the activity trail shows one **Merchant ID created** event.

To deliver checks yourself during a presentation, set `RELAY_VERIFICATION_MODE=hold` before starting Relay. In steps 2 and 5, open **Demo controls** and choose **Deliver pending callbacks**. Merchant ID setup still runs automatically after approval.

## How the workflow works

| Application status | What it means |
| --- | --- |
| **Missing information** | The merchant used **Send for review** to share an incomplete application. The owner can see what is missing and request specific items. |
| **Verifying** | Relay is waiting for verification results. It can run a check as soon as that check has the information it needs. |
| **Needs review** | A mandatory check failed or timed out, supporting evidence needs review, or Relay found a possible duplicate. |
| **Awaiting correction** | The owner sent a request. The merchant can see the reason and respond from their inbox. |
| **Ready to approve** | All mandatory checks pass for the current data and the owner has resolved any holds. |
| **Approved** | The owner approved the application. Merchant ID setup can still be in progress, active, or failed. |
| **Closed as duplicate** | The owner confirmed a duplicate and closed the case. The merchant can see the status. |

PAN, GST, and bank checks are required by default. Set `RELAY_REQUIRE_GST=false` to make GST optional for new applications. If a merchant supplies complete GST evidence, Relay still checks it and shows the result. Each application keeps the policy it started with.

If a merchant changes bank details before approval, Relay verifies the updated bank details. Checks for unchanged information keep their results. Before approval, the server checks the current evidence and verification results again. A failed merchant ID setup can be retried with **Retry setup**.

### Duplicate checks

Relay looks for an exact PAN or GSTIN match, the same bank account and IFSC together, or the same legal name and city after normalizing the text. The owner can see why the application matched and open the linked case. They must record why the application can continue or close it as a duplicate. The merchant sees their own status without getting access to the matched application.

### Callbacks and retries

The callback worker delivers verification and setup results through a separate HTTP request. SQLite saves the jobs, results, and activity history so they survive a restart. Replaying a callback does not process the same result twice. An old result stays attached to its original attempt after a retry or change.

Retryable delivery failures wait 2, 5, and 15 seconds before trying again. After four failed attempts, Relay records a dead letter, meaning the worker stopped retrying that delivery. The owner can see the issue and start a fresh check or request another setup attempt.

In hold mode, use **Simulate callback outage** on a held check in **Demo controls** to see retries and dead-letter recovery. Use **Fail next provisioning attempt** before approval to test setup recovery.

### What the owner sees

The dashboard shows each application’s status, blocker, time in its current state, and last update. The detail page shows submitted and extracted values, provider results, and an activity trail. The seven-day exception rate shows the share of recent submissions that encountered missing required information, a review hold, a mandatory check failure or timeout, or a provisioning failure. Each application counts once. The dashboard also shows the current dead-letter count.

## AI document extraction

From **New application**, choose **Use sample documents** or upload a fictional PAN card, GST certificate, or bank proof. Relay accepts PNG, JPEG, and unlocked PDFs up to 8 MB per document and two pages per PDF. PDF pages are turned into images in the browser before extraction. The merchant can review the suggested values, replace unreadable documents, or fill in missing values by hand. The same document reader is available for corrections.

Relay shows document readability and missing fields separately from verification results. The model reads the document. Simulated checks and the owner decide whether the application can be approved.

| Option | Settings in `.env.local` |
| --- | --- |
| **OpenRouter** | `EXTRACTION_PROVIDER=openrouter` and `OPENROUTER_API_KEY`. Relay tries `nvidia/nemotron-3.5-super-vl:free` first and can switch to `google/gemma-4-31b-it:free` if the first provider is at capacity. |
| **Ollama Cloud** | Leave `EXTRACTION_PROVIDER` unset and set `OLLAMA_API_KEY`. The default model is `gemma4`. Use `OLLAMA_MODEL` to override it. |
| **Local Ollama** | Leave `EXTRACTION_PROVIDER` unset, set `OLLAMA_MODE=local`, and run Ollama locally with a vision model. Relay defaults to `gemma4:e4b` and connects to `http://127.0.0.1:11434`. Set `OLLAMA_MODEL` or `OLLAMA_LOCAL_URL` to change those defaults. |
| **Without AI** | Use **Use sample application** or enter the values from your fictional documents by hand. |

Cloud providers can hit usage or capacity limits. Cloud mode sends the document images to the configured provider, so use fictional documents. Relay keeps masked identifiers, fingerprints used for comparison, and extraction status. It does not retain uploaded images or raw model replies.

## Run the tests

```sh
npm run typecheck
npm run build
npm run test:workflow
```

The test suite starts Relay against temporary databases. It covers merchant and owner access, missing information, duplicate holds and closure, simulated checks, approval, callback retries, and merchant ID creation.

## Project layout

| Folder | What is inside |
| --- | --- |
| `app/` | Pages and API routes for sessions, applications, extraction, and callbacks |
| `components/` | Merchant intake and inbox, owner queue and review screens |
| `lib/` | Validation, workflow rules, simulators, SQLite storage, and AI provider code |
| `scripts/` | Launch commands, callback worker, and workflow tests |
| `data/` | SQLite databases. The submission snapshot is the copy prepared for review. |
