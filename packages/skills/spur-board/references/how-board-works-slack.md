# Slack now

## Slack now

`slack.channels.feed`: curator answers and operator items,
except delivery/health/ended-worker items and blocks.
`slack.channels.orchestrators`: block threads addressed to the operator by
others. Answer in the existing block thread.

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
else project name and role icon (`board` for operator). No session:
`board status` lists it as waiting.
