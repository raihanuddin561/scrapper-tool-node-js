# Local Google Maps Lead Scraper

A local Express application that collects business leads from Google Maps, crawls public business websites for email addresses, streams progress over Server-Sent Events (SSE), previews rows, and exports XLSX or CSV files.

## Requirements

- Node.js 20 or newer
- Internet access for Google Maps and business websites
- Chromium installed through Playwright

## Install and run

```powershell
cd "d:\scrapping tools\emailscrapper"
npm install
npx playwright install chromium
npm start
```

Open <http://127.0.0.1:3000>.

For a clean Windows machine, run `npx playwright install chromium` after `npm install`. If Chromium reports missing operating-system libraries in a managed environment, run `npx playwright install-deps chromium` from an elevated shell.

## Usage

1. Enter a Google Maps search query, for example `cafe and restaurant abbotsford australia`.
2. Choose a limit of 1–200 leads.
3. Choose XLSX or CSV.
4. Start scraping and keep the page open. Progress, logs, and each completed row appear live.
5. Download the generated file when the job completes.

Exports remain in server memory for 30 minutes. Restarting the server invalidates active exports. The application does not persist lead data.

## Validation

```powershell
npm run check
```

## Responsible use

Only scrape and contact businesses where your use complies with Google Maps terms, website terms, applicable anti-spam laws, privacy laws, and all licensing and authorization requirements. The application cannot determine whether a particular use is lawful. Respect robots.txt and website rate limits; do not collect data from local or private network targets.
