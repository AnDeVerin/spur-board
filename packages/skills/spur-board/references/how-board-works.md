# How the Board works

Choose the topic for the decision or action in front of you:

- [Columns and gates](how-board-works-columns.md): find the executor, placement rules and gate requirements.
- [Turns and delivery](how-board-works-turns.md): acknowledge work, submit or return, handle doorbells and repeated returns.
- [Blocks and escalation](how-board-works-blocks.md): route a question or escalate a block.
- [Slack conversations](how-board-works-slack.md): choose a channel, address an agent and answer in a thread.
- [Done follows the ticket](how-board-works-done.md): check when a task is finished.

## Browser access

With `web.port` and `web.publicOrigin` configured, a second loopback listener serves browser
assets, health and catalog operations whose `web` binding is enabled. It uses the same registry,
authorization, idempotency and operation hooks as the agent API, with the operator caller.
Only `comment.add` and `block.answer` are enabled writes. Token and skill routes stay on the
agent API. The web listener is off by default and a failed bind does not stop the agent API.

A private-network proxy must preserve Host. Exact Origin, Host, JSON and fetch-metadata checks
reject foreign browser pages; anyone with network or local access can still act as operator.
Logs include the web channel and untrusted forwarded client/user-agent metadata. Persistent
event channels and history labels are supplied by the separate channel-context slice.
Missing UI assets return a 503 build hint while health and operations remain available.
