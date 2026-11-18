# Web UI: task blocks and comments

The **Blocks** and **Comments** sections of the [task view](web-ui-task-view.md) and its three
writes: answer, follow up and comment.

**Blocks** shows the total and the number open, with open blocks first. Each item names its
author, addressee, age and reason, its resolution and question-answer channel when known, and
its replies, oldest first. Completed code blocks retain their completion reference.
Agent names use configured Spur project display names, with project and
session identifiers as fallbacks; the operator reads as `you`. Empty blocks read
`No blocks on this task.`

Each block is its own box with a header band: id, author and age, addressee, then status. An
open block is always shown whole. A closed block starts folded to three lines of its reason,
with `… Show all · 2 replies · outcome` naming what is hidden. A click on the folded text,
**Show all** or the band unfolds it; a click while text is selected does not. The band or
`Collapse B<n>` folds it again. A short closed block with no replies and no outcome has no fold
control. A draft or an open follow-up keeps its block unfolded. The fold state lasts while the
view is open, across History and refreshes.

Only an open question (`needs_input`) addressed to the operator has an answer form. **Send answer** calls
`block.answer`. An answered question shows **Follow up**. It opens the same field,
`Follow-up on B<n>`, with **Send follow-up**, which calls `block.followup`, and an icon
**Cancel** that closes it and sends nothing. A sent follow-up closes the field and shows as the
block's next reply. Cancel after a failed send keeps the text and its key. **Comments** lists
task comments with their authors, ids and ages, excluding block replies. Empty comments read
`No comments on this task.` above the usable composer. Empty Blocks, Comments and History lines
use the same inner padding as Why rows. **Add comment** calls `comment.add` for the task. Answering agent
blocks, and editing or deleting comments remain outside this view.

The forms retain exact text on failure and announce the error. Blank or whitespace-only text
and text longer than 20,000 characters are rejected locally. Sending guards against duplicate
clicks. Retrying unchanged text after an uncertain failure reuses its intent key; editing it
creates a new intent. Drafts remain while the daemon or live updates are unavailable; fields
and send actions are disabled with a reason until recovery. A short reconnect keeps them usable.

After success the view rereads authoritative task data. While that read runs it says
`Answer sent. Refreshing task…`, `Follow-up sent. Refreshing task…` or
`Comment added. Refreshing task…`. If the read fails, the
success remains confirmed and **Refresh task** retries only the read. It cannot resend that
successful intent. Text edited during a send survives completion of the earlier revision.
Closing the dialog does not persist drafts. Unsent text survives the reload after a board
update: a send in progress finishes first, and text whose send failed comes back as unsent
text, so sending it again makes a new request.

If a question closes, is withdrawn or is reassigned while you type, a newer unsent revision
stays visible as selectable **Unsent answer draft** text. It is read-only: it offers no send. An unchanged confirmed submission clears after canonical
reconciliation. Pending and uncertain intent state survives eligibility changes and History
navigation; only the submitted revision may be cleared by its completion.
Pending or uncertain submitted text is labelled **Answer draft (unconfirmed)**, so it can be
copied without implying that the write failed or offering another send on a closed block.

Archived tasks show `This task is archived. Answers and comments cannot be sent.` The fields
and send actions are disabled, preserving pending, failed and newer drafts. Reactivating the
task enables still-eligible forms again. History and read-only **Refresh task** recovery for an already
confirmed write remain available while archived.
