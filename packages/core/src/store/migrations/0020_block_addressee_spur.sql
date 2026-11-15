-- An operator conversation started in Slack is addressed to one Spur project. The block keeps
-- that Spur project here; every other block has NULL and is routed by `addressee_role` alone.
ALTER TABLE block ADD COLUMN addressee_spur_project TEXT;
