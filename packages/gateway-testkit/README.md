# Gateway conformance coverage

Fake gateway targets run the complete shared conformance suite in CI. A fake target cannot declare
only a subset. The manual Slack target declares its supported case IDs from the same registry and
reports one pass or fail for each declared case. Its cases cover real delivery, marker lookup,
thread-history recovery, rate limits, bot echoes, and guided inbound interactions. The live target
uses the production gateway and does not inject faults into its client.

The live run is manual because it requires a private test channel and human actions. Run it with
`pnpm smoke:live` as described in the repository README. Compare its observations with the fake
after each run. Add a focused fake regression test for a discrepancy that can be modeled; list any
remaining difference here with the observed behavior and consequence.

## Known differences

- A local fake can force a 429 on the next write, but a real run accepted 30 serial posts without
  one. The live probe now edits one dedicated message up to 120 times or 90 seconds and reports a
  failure unless it observes a 429, waits for Retry-After and confirms the marked retry.
