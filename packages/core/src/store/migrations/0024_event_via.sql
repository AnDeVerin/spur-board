-- How the write behind each journal event arrived: web or slack; NULL for CLI, MCP, agents, board.
ALTER TABLE event ADD COLUMN via TEXT;
