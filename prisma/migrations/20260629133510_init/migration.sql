-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'assessor');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('in_progress', 'completed');

-- CreateEnum
CREATE TYPE "AssessmentMode" AS ENUM ('full', 'quick');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('terms_of_service', 'privacy_policy', 'research_data_usage');

-- CreateEnum
CREATE TYPE "RemediationTier" AS ENUM ('gap', 'attention');

-- CreateEnum
CREATE TYPE "EvidenceLevel" AS ENUM ('self_attestation', 'artifact_uploaded');

-- CreateEnum
CREATE TYPE "DevelopmentStage" AS ENUM ('concept', 'development', 'testing', 'deployed', 'retired');

-- CreateEnum
CREATE TYPE "DatasetSize" AS ENUM ('small_lt1k', 'medium_1k_100k', 'large_100k_1m', 'very_large_gt1m', 'unknown');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'assessor',
    "termsAccepted" BOOLEAN NOT NULL DEFAULT false,
    "termsAcceptedAt" TIMESTAMP(3),
    "researchConsent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_metadata" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "aiSystemType" TEXT,
    "aiSystemTypeOther" TEXT,
    "institution" TEXT,
    "department" TEXT,
    "country" TEXT,
    "developmentStage" "DevelopmentStage",
    "deploymentSector" TEXT,
    "deploymentSectorOther" TEXT,
    "targetPopulation" TEXT,
    "processesPersonalData" BOOLEAN,
    "datasetSize" "DatasetSize",
    "datasetType" TEXT,
    "datasetTypeOther" TEXT,
    "datasetDescription" TEXT,
    "teamSize" INTEGER,
    "fundingSource" TEXT,
    "regulatoryContext" TEXT,
    "projectStart" TIMESTAMP(3),
    "projectEnd" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessments" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AssessmentStatus" NOT NULL DEFAULT 'in_progress',
    "mode" "AssessmentMode" NOT NULL DEFAULT 'full',
    "engineState" JSONB NOT NULL,
    "reportData" JSONB,
    "overallScore" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_items" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "areaName" TEXT NOT NULL,
    "tier" "RemediationTier" NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceLevel" "EvidenceLevel" NOT NULL DEFAULT 'self_attestation',
    "artifactPath" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remediation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consentType" "ConsentType" NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "granted" BOOLEAN NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "projects_createdById_idx" ON "projects"("createdById");

-- CreateIndex
CREATE INDEX "projects_orgId_idx" ON "projects"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "project_metadata_projectId_key" ON "project_metadata"("projectId");

-- CreateIndex
CREATE INDEX "assessments_projectId_idx" ON "assessments"("projectId");

-- CreateIndex
CREATE INDEX "assessments_userId_idx" ON "assessments"("userId");

-- CreateIndex
CREATE INDEX "assessments_orgId_idx" ON "assessments"("orgId");

-- CreateIndex
CREATE INDEX "remediation_items_assessmentId_idx" ON "remediation_items"("assessmentId");

-- CreateIndex
CREATE INDEX "consent_records_userId_idx" ON "consent_records"("userId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_metadata" ADD CONSTRAINT "project_metadata_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_items" ADD CONSTRAINT "remediation_items_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_items" ADD CONSTRAINT "remediation_items_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
