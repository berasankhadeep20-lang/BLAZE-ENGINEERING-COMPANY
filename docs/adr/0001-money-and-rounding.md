# ADR 0001: Money, quantity and rounding

**Status:** accepted (M0)

## Decision
- Money is an integer number of **paise**; quantity is an integer number of **thousandths**; GST rates are **basis points** (1800 = 18%).
- All division goes through `divRound` / `mulDivRound` (exact BigInt arithmetic, halves rounded away from zero). Money input is parsed from
  strings; more than two decimals is rejected rather than silently rounded.
- Rounding points: line amount = round(qty x rate); intra-state tax halves (CGST, SGST) are each rounded per line; inter-state IGST is rounded per line;
  delivery is taxed as its own one-line item.
- The invoice total is rounded to the nearest rupee and the difference is stored and printed as an explicit **round-off**.

## Why
Binary floating point cannot represent 0.1 exactly (0.1 + 0.2 != 0.3), so sums drift by a paisa and invoices stop adding up. Integers are exact.
Rounding per line (not on the grand total) matches how the sample bill's printed columns add up.

## Consequences
- For intra-state supply, CGST + SGST can differ by one paisa from the IGST that the same taxable value would produce. This is expected.
- `computeBill` is the single source of truth for totals; UI, print and reports must never recompute tax themselves.
- Verified against the sample bill: before-tax 2542.37, CGST 228.81, SGST 228.81, tax 457.62, pre-round 2999.99, round-off +0.01, total 3000.00.
