-- Retire documents.archived_at: the archive lifecycle is already expressed by
-- status = 'archived' and the document.archived audit event. The column had a single
-- write site and zero readers or API exposure, so the drop is behaviour-preserving.
ALTER TABLE "documents" DROP COLUMN "archived_at";--> statement-breakpoint
