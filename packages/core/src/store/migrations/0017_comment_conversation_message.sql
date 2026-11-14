-- Inbound edits and deletes, and the conversation cursor, look a comment up by the conversation
-- and the message it was posted as. Not unique: the schema has never enforced one comment per
-- message, and a duplicate would then fail the inbound write instead of reading the first row.
CREATE INDEX comment_conversation_message ON comment (conversation_ref, message_ref);
