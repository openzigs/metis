-- Epic #724: Add isSpec flag to documents table for spec-checking scan mode.
ALTER TABLE "documents" ADD COLUMN "isSpec" BOOLEAN NOT NULL DEFAULT false;
