# Slack now

## Slack now

`slack.channels.feed`: curator answers and operator items,
except delivery/health items and the block items: anomaly, cycle limit,
course check and conversation waiting. A block addressed to you by others
gets a feed line once its thread is out; the line links the thread, or comes
without the link when the thread post fails for good. A thread blocked as a
secret gets a blocked-post item, which takes the line's place. A reply
in the thread answers a question block; on another block type it is not processed
and raises an item. Close on that line closes the block without an answer, as
your unblock with the reason `closed by the operator from the feed`; on an
already closed block it only clears the line. Every block line says what Close
does above the block's reason. An `external-quiet:` item line
ends with its inbox action.
`slack.channels.orchestrators`: block threads addressed to the operator by
others. Answer in the existing block thread. A later reply on an answered
block is a follow-up, the same as `board followup`.

## Slack addressing

With a `projects[].spurProjects[].shortName`, `spurProjects[].shortName` or
board-wide operator, a new operator message in
`slack.channels.orchestrators` starts a conversation. A leading registered
`@shortName` selects that Spur project and is stripped. With absent or unknown
leading name, complete text, retaining any
unknown prefix, goes to `slack.defaultAddressee`, else board-wide operator, else
first project with an operator; else Board replies once with the valid prefixes.
Middle mentions or Slack `<@U…>` address nobody; unknown names cause no lookup
error. The operator checks short-name collisions with workspace names.
A task key after the prefix attaches it.

Read `board inbox`; reply via `board answer`. Each operator thread message rings again; `close` or ✅ in the
thread closes it. Replies use `projects[].spurProjects[].displayName` and `icon`, top-level ones too,
else project name and the icon of the author's role on the block's task: orchestrator only on its
column's task, else curator or worker; `board` for operator. No session:
`board status` lists it as waiting.
