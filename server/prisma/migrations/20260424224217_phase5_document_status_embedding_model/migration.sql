-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "deletedAt" DATETIME,
    CONSTRAINT "documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_documents" ("checksum", "deletedAt", "filename", "id", "mimeType", "projectId", "sizeBytes", "storagePath", "uploadedAt", "uploadedById") SELECT "checksum", "deletedAt", "filename", "id", "mimeType", "projectId", "sizeBytes", "storagePath", "uploadedAt", "uploadedById" FROM "documents";
DROP TABLE "documents";
ALTER TABLE "new_documents" RENAME TO "documents";
CREATE INDEX "documents_projectId_idx" ON "documents"("projectId");
CREATE INDEX "documents_projectId_status_idx" ON "documents"("projectId", "status");
CREATE INDEX "documents_checksum_idx" ON "documents"("checksum");
CREATE TABLE "new_knowledge_chunks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "md5" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL DEFAULT 'metis-offline-hash-v1',
    "vectorRef" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_chunks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "knowledge_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_knowledge_chunks" ("createdAt", "documentId", "id", "md5", "metadata", "position", "projectId", "text", "vectorRef") SELECT "createdAt", "documentId", "id", "md5", "metadata", "position", "projectId", "text", "vectorRef" FROM "knowledge_chunks";
DROP TABLE "knowledge_chunks";
ALTER TABLE "new_knowledge_chunks" RENAME TO "knowledge_chunks";
CREATE INDEX "knowledge_chunks_projectId_idx" ON "knowledge_chunks"("projectId");
CREATE INDEX "knowledge_chunks_documentId_position_idx" ON "knowledge_chunks"("documentId", "position");
CREATE INDEX "knowledge_chunks_md5_idx" ON "knowledge_chunks"("md5");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
