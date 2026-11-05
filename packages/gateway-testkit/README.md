# Gateway conformance coverage

Fake gateway targets run the complete shared conformance suite in CI. A fake target cannot declare
only a subset. The manual Slack target declares its supported case IDs from the same registry and
reports one pass or fail for each declared case. Its cases cover real delivery, marker lookup,
thread-history recovery, bot echoes, and guided inbound interactions. The live target
uses the production gateway and does not inject faults into its client.

The live run is manual because it requires a private test channel and human actions. Run it with
`pnpm smoke:live` as described in the repository README. Compare its observations with the fake
after each run. Add a focused fake regression test for a discrepancy that can be modeled; list any
remaining difference here with the observed behavior and consequence.

## Known differences

- The fake deterministically covers 429 and Retry-After. Several live runs did not encounter 429,
  even during bounded write bursts. The live runner no longer provokes one: it reports rate-limit
  as NOT RUN unless a normal delivery receives an incidental 429. In that case it waits for
  Retry-After, retries, and reports whether delivery was confirmed.
