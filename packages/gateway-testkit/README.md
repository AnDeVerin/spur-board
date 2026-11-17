# Gateway conformance coverage

Fake gateway targets run the complete shared conformance suite in CI. A fake target cannot declare
only a subset. The manual Slack target declares its supported case IDs from the same registry and
reports one pass or fail for each declared case. Its cases cover real delivery, marker lookup,
thread-history recovery, bot echoes, and guided inbound interactions. The live target
uses the production gateway and does not inject faults into its client.

The live run is manual because it requires a private test channel and human actions. Run it with
`pnpm smoke:live` as described in [Live Slack conformance](#live-slack-conformance). Compare its
observations with the fake after each run. Add a focused fake regression test for a discrepancy
that can be modeled; list any remaining difference here with the observed behavior and
consequence.

## Known differences

- The fake deterministically covers 429 and Retry-After. Several live runs did not encounter 429,
  even during bounded write bursts. The live runner no longer provokes one: it reports rate-limit
  as NOT RUN unless a normal delivery receives an incidental 429. In that case it waits for
  Retry-After, retries, and reports whether delivery was confirmed.

## Live Slack conformance

Run this check from a repository clone after `pnpm install`. Invite the Slack app to the designated
private test channel, and stop any running daemon process that uses the same app token. Concurrent
Socket Mode connections can split events between the daemon and this check.

Run the live gateway check manually in that channel:

```sh
BOARD_LIVE_CHANNEL=<test-channel-id> BOARD_LIVE_CHANNEL_NAME=<test-channel-name> pnpm smoke:live
```

Use the daemon's local `config.yaml` and mode-protected `secrets.env`. The secrets file must provide
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`; the test channel ID and expected name come only from
`BOARD_LIVE_CHANNEL` and `BOARD_LIVE_CHANNEL_NAME`. The command looks up the channel with
`conversations.info` and requires its ID and name to match, its privacy flag to be true, and its
type to be a channel rather than a direct message. The bot token needs `groups:read` to read private
channel metadata. The command rejects configured delivery channels, shared channels, pending external shares, or archived channels,
non-interactive input and `CI=true` before sending a live post. It never prints tokens, the channel
ID or the channel name. It prints timed instructions for a thread reply,
edit, button press, slash command, mention, and a reply while disconnected. Press Enter after each
guided action. A case fails if its required observation does not arrive.
The guided slash instruction uses `slack.command` from the local config.

To rerun only the thread mention, use:

```sh
BOARD_LIVE_CHANNEL=<test-channel-id> BOARD_LIVE_CHANNEL_NAME=<test-channel-name> pnpm smoke:live --case guided-mention
```

The focused run creates a root thread and reports only the mention case. In Slack, use **Reply in
thread** on that root message, type `@`, select the app from autocomplete, and include the prompt's
marker. The mention prompt allows five minutes; other guided prompts allow 90 seconds. Rate-limit
is outside the supported live case set. The report says `NOT RUN rate-limit` unless a normal
delivery happens to receive a 429; then it records whether the `Retry-After` wait and retry worked.

Run this check before M1 acceptance (#66), after each Slack SDK update, and before every release.
Capture the final case report for the change review.
