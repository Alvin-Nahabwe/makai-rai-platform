-- DropIndex
DROP INDEX "invitations_token_key";

-- AlterTable
ALTER TABLE "invitations" DROP COLUMN "token",
ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "tokenHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "sessionEpoch" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- A plaintext token cannot satisfy this. D-097 becomes structurally
-- unrepresentable rather than something reviewers must remember to check.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_tokenHash_is_sha256_hex"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- The Legacy org was inserted by 20260803034110 so SET NOT NULL could apply.
-- It now has no members and no projects.
--
-- This DELETE works because migrations run as `makrai`, a SUPERUSER, and
-- superusers bypass RLS unconditionally; FORCE ROW LEVEL SECURITY binds a
-- non-superuser OWNER, not a superuser (D-079). A migration run under a
-- non-superuser owner would need `SET LOCAL app.current_org_id` first.
--
-- The NOT EXISTS guards make this a no-op wherever the row is load-bearing.
-- Both known databases hold zero tenant rows; this will also run against
-- databases nobody here has seen.
DELETE FROM "organizations" o
 WHERE o.id = '00000000-0000-0000-0000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM "projects"    p WHERE p."orgId" = o.id)
   AND NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."orgId" = o.id);
