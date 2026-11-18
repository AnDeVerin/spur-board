# Task history

## Task history

`board task history <task>` lists the task's journal events oldest first by
time; events at one time keep journal order. Each names who acted and its channel
(`via`): `web` or `slack` where the daemon received the write, `cli` or `mcp` as
the client reported it; scheduled work and older clients have none. The summary
says what changed:

| Event                                                               | Summary                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `session_state_changed`                                             | `Session <id>: <from> → <to>`, plus `, ended (killed)` and the like                                                 |
| `checks_changed`                                                    | `Checks on <repo>#<n>: 2 failed: <names>`, else `3/4 green, 1 pending`                                              |
| `head_moved`                                                        | `New head <sha7> on <repo>#<n>`                                                                                     |
| `mergeable_changed`, `pr_state_changed`                             | `Mergeable on <ref>: <from> → <to>`, `PR <ref>: <from> → <to>`                                                      |
| `ticket_status_changed`                                             | `Ticket status: <from> → <to>`                                                                                      |
| `review_submitted`                                                  | `Review by <reviewer> on <ref>: <state>`                                                                            |
| `task_moved`                                                        | `Moved <from> → <to>: <reason> (<gates>)`                                                                           |
| `task_shadow_moved`                                                 | `Would move <from> → <to> (shadow mode): <reason> (<gates>)`                                                        |
| `pr_facts_changed`, `session_facts_changed`, `ticket_facts_changed` | `PR <ref>:`, `Session <id>:` or `Ticket <key>:` with up to 3 changes and `+N more`; `first observed` the first time |
| `block_*`, `comment_*`, `doorbell_*`                                | the ID with its addressee, outcome, revision or reason                                                              |
| `turn_opened`, `turn_taken`, `turn_closed`                          | executor, taker, outcome                                                                                            |

Checks count the required ones, else all but skipped. A facts row leaves out what
other rows say (head, checks, PR state, mergeability, reviews, ticket status) and
update and activity times; with nothing else changed it is not shown.
