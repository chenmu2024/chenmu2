# Cintas Invoice Checker

Privacy-first validation MVP for comparing two Cintas invoice PDFs and showing objective billing changes.

## V0
- Runs as a static Cloudflare Pages site.
- Source invoice PDFs are parsed in the visitor's browser.
- Uses PDF.js in the browser for digital PDF text extraction.
- Compares printed total, unit price, quantity, new/removed line items, and common fees.
- Does **not** determine whether a charge is an overcharge or violates a contract.

## Cloudflare Pages
- Production branch: `main`
- Root directory: `cintas-invoice-checker`
- Build command: leave blank (or `exit 0`)
- Build output directory: `public`

## Disclaimer
Independent invoice comparison tool. Not affiliated with, endorsed by, or sponsored by Cintas Corporation. This is not legal, accounting, or contractual advice.
