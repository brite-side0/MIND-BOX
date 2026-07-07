-- Full-text search for the catalog (#): replaces the in-memory substring scan
-- in listCatalog with a Postgres tsvector match + ts_rank ordering.
--
-- search_vector is a STORED generated column so it stays in sync with title/
-- description automatically (no trigger, no app-side maintenance). Title is
-- weighted 'A' and description 'B' so title matches rank above description
-- matches. A GIN index makes the @@ match fast at catalog scale.
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("description", '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resources_search_vector" ON "resources" USING GIN ("search_vector");
