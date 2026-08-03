-- Existing single-tenant rows predate organizations. Give them a home org so
-- the NOT NULL constraints below can be applied without data loss.
INSERT INTO "organizations" ("id","name","slug","createdAt","updatedAt")
  VALUES ('00000000-0000-0000-0000-000000000001','Legacy','legacy', now(), now())
  ON CONFLICT ("slug") DO NOTHING;

UPDATE "projects"    SET "orgId" = '00000000-0000-0000-0000-000000000001' WHERE "orgId" IS NULL;
UPDATE "assessments" SET "orgId" = '00000000-0000-0000-0000-000000000001' WHERE "orgId" IS NULL;

ALTER TABLE "project_metadata"  ADD COLUMN IF NOT EXISTS "orgId" TEXT;
UPDATE "project_metadata" m SET "orgId" = p."orgId" FROM "projects" p WHERE m."projectId" = p."id";

ALTER TABLE "remediation_items" ADD COLUMN IF NOT EXISTS "orgId" TEXT;
UPDATE "remediation_items" r SET "orgId" = a."orgId" FROM "assessments" a WHERE r."assessmentId" = a."id";

-- DropForeignKey
ALTER TABLE "assessments" DROP CONSTRAINT "assessments_projectId_fkey";

-- DropForeignKey
ALTER TABLE "project_metadata" DROP CONSTRAINT "project_metadata_projectId_fkey";

-- DropForeignKey
ALTER TABLE "remediation_items" DROP CONSTRAINT "remediation_items_assessmentId_fkey";

-- DropIndex
DROP INDEX "assessments_orgId_idx";

-- DropIndex
DROP INDEX "assessments_projectId_idx";

-- DropIndex
DROP INDEX "assessments_userId_idx";

-- DropIndex
DROP INDEX "project_metadata_projectId_key";

-- DropIndex
DROP INDEX "projects_createdById_idx";

-- DropIndex
DROP INDEX "projects_orgId_idx";

-- DropIndex
DROP INDEX "remediation_items_assessmentId_idx";

-- AlterTable: now safe — backfill above guarantees no NULLs remain
ALTER TABLE "assessments" ALTER COLUMN "orgId" SET NOT NULL;

-- AlterTable: column was added nullable above and backfilled; constrain now
ALTER TABLE "project_metadata" ALTER COLUMN "orgId" SET NOT NULL;

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "orgId" SET NOT NULL;

-- AlterTable: column was added nullable above and backfilled; constrain now
ALTER TABLE "remediation_items" ALTER COLUMN "orgId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "assessments_orgId_projectId_idx" ON "assessments"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "assessments_orgId_userId_idx" ON "assessments"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_orgId_id_key" ON "assessments"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "project_metadata_orgId_projectId_key" ON "project_metadata"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "projects_orgId_createdById_idx" ON "projects"("orgId", "createdById");

-- CreateIndex
CREATE UNIQUE INDEX "projects_orgId_id_key" ON "projects"("orgId", "id");

-- CreateIndex
CREATE INDEX "remediation_items_orgId_assessmentId_idx" ON "remediation_items"("orgId", "assessmentId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_metadata" ADD CONSTRAINT "project_metadata_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "projects"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "projects"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_items" ADD CONSTRAINT "remediation_items_orgId_assessmentId_fkey" FOREIGN KEY ("orgId", "assessmentId") REFERENCES "assessments"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
