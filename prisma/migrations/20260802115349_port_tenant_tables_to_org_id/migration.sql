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
DROP INDEX "projects_orgId_idx";

-- DropIndex
DROP INDEX "remediation_items_assessmentId_idx";

-- AlterTable
-- Added nullable here (not NOT NULL yet): the backfill below must populate
-- these columns on existing rows before they can be constrained. Doing
-- `ADD COLUMN ... NOT NULL` directly, as a naive schema diff would emit,
-- fails immediately against any table that already has rows.
ALTER TABLE "project_metadata" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "remediation_items" ADD COLUMN     "orgId" TEXT;

-- Backfill: one organization per existing user, that user as owner.
-- One org per user (not a single shared "Legacy" org) preserves the current
-- visibility boundary: today each user sees only their own projects, and
-- since org membership becomes the visibility rule, collapsing everyone into
-- one org would let every existing user read every other's assessments.
INSERT INTO "organizations" ("id", "name", "slug", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       u."name" || '''s Organization',
       'org-' || substr(md5(u."id"), 1, 12),
       now(), now()
FROM "users" u;

INSERT INTO "memberships" ("id", "orgId", "userId", "role", "status", "createdAt")
SELECT gen_random_uuid(), o."id", u."id", 'owner', 'active', now()
FROM "users" u
JOIN "organizations" o ON o."slug" = 'org-' || substr(md5(u."id"), 1, 12);

-- Point existing rows at their creator's org.
UPDATE "projects" p
SET "orgId" = m."orgId"
FROM "memberships" m
WHERE m."userId" = p."createdById" AND p."orgId" IS NULL;

UPDATE "assessments" a
SET "orgId" = p."orgId"
FROM "projects" p
WHERE p."id" = a."projectId";

UPDATE "project_metadata" pm
SET "orgId" = p."orgId"
FROM "projects" p
WHERE p."id" = pm."projectId";

UPDATE "remediation_items" ri
SET "orgId" = a."orgId"
FROM "assessments" a
WHERE a."id" = ri."assessmentId";

-- Any row whose creator no longer exists cannot be assigned an owner; drop it.
DELETE FROM "projects" WHERE "orgId" IS NULL;

-- AlterTable
ALTER TABLE "assessments" ALTER COLUMN "orgId" SET NOT NULL;

-- AlterTable
ALTER TABLE "project_metadata" ALTER COLUMN "orgId" SET NOT NULL;

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "orgId" SET NOT NULL;

-- AlterTable
ALTER TABLE "remediation_items" ALTER COLUMN "orgId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "assessments_orgId_projectId_idx" ON "assessments"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "assessments_orgId_status_idx" ON "assessments"("orgId", "status");

-- CreateIndex
CREATE INDEX "assessments_orgId_userId_idx" ON "assessments"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_orgId_id_key" ON "assessments"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "project_metadata_orgId_projectId_key" ON "project_metadata"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "projects_orgId_createdAt_idx" ON "projects"("orgId", "createdAt");

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
