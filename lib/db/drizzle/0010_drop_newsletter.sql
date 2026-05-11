-- Drop the newsletter feature: tables, indexes, and any leftover state.
-- The newsletter signup flow has been removed from the API and frontend;
-- this migration cleans the schema so the table no longer drifts from
-- the codebase.
DROP TABLE IF EXISTS "newsletter_subscriptions";
