# Parser regression fixtures

These fixtures are deliberately simplified and contain no customer names, account numbers, addresses, or other source-document identifiers.

They model recurring Cintas invoice structures observed in public documents so parser changes can be checked against stable expectations.

## Covered layouts

1. Modern rental/facility row
   - Material code
   - Description
   - FREQ
   - EXCH
   - QTY
   - Unit price with 3 decimals
   - Line total with 2 decimals
   - Tax flag

2. Repeated material rows
   - Same material can appear multiple times.
   - Quantity should aggregate conservatively.
   - Multiple distinct unit prices for the same material should not be collapsed into one invented price.

3. Recurring service fee
   - Fee line can contain only one monetary value.

4. Special Programs Breakdown
   - Rows after the "SPECIAL PROGRAMS BREAKDOWN" marker on that page are summaries and must not be counted again.

5. Price-adjustment notice
   - A notice can coexist with an invoice change.
   - Detection is informational; it must not be labeled an overcharge.

Public layouts reviewed during development include municipal, school, court, and community-development-district documents. The production parser must continue to prefer false-negative / review states over invented financial values.
