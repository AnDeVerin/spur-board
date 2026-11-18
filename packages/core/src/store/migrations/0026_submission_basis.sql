ALTER TABLE submission ADD COLUMN basis TEXT;
ALTER TABLE submission ADD COLUMN source_sha TEXT;
ALTER TABLE submission ADD COLUMN basis_reason TEXT;
ALTER TABLE submission ADD COLUMN tested_source_id INTEGER REFERENCES submission(id);
