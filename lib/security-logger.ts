/**
 * Structured security event logger.
 * Outputs JSON to stdout for Docker/ELK/CloudWatch consumption.
 * No external dependencies.
 *
 * No email address is ever written (RL 2.3, 7.12). Callers log ids (`userId`,
 * `invitationId`, `orgId`) and never an address; `__tests__/lint/no-email-in-log-calls.test.ts`
 * holds that for every call site. This file is the net behind it: every string and every key
 * in the entry goes through `redactEmails`, so an address that arrives inside a provider's
 * error message is replaced before the line is written.
 */

import { redactEmails } from './redact';

export type SecurityEvent =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILURE'
  | 'AUTH_ACCOUNT_LOCKED'
  | 'AUTH_REGISTER'
  | 'AUTH_LOGOUT'
  | 'AUTH_LOGOUT_EVERYWHERE'
  | 'AUTH_PASSWORD_CHANGED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'AUTH_TOKEN_DECODE_FAILURE'
  | 'INPUT_VALIDATION_FAILURE'
  | 'ADMIN_ACTION'
  | 'ASSESSMENT_CREATED'
  | 'ASSESSMENT_COMPLETED'
  | 'EVIDENCE_UPLOADED'
  | 'EVIDENCE_DELETED'
  | 'EVIDENCE_INTEGRITY_FAILURE'
  | 'ACCOUNT_DEACTIVATED'
  | 'ORG_MEMBER_ACTION'
  // v0.6.0 (contract, "Security event names"). Ids and counts only: NFR-OBS-01, NFR-PRIV-03.
  | 'DECISION_SAVED'
  | 'DECISION_WITHDRAWN'
  | 'FINDING_RAISED'
  | 'FINDING_CLOSED'
  | 'RISK_ACCEPTED'
  | 'SEAL_CREATED'
  | 'SEAL_CHECK_FAILED'
  | 'DOCUMENT_ISSUED'
  | 'DOCUMENT_WITHDRAWN'
  | 'DOCUMENT_INTEGRITY_FAILURE'
  | 'DOCUMENT_ISSUE_BUSY'
  | 'EXPORT_MADE'
  | 'ACCOUNT_DELETED'
  | 'REMINDER_RUN'
  | 'REMINDER_TOKEN_UNSET_OR_MALFORMED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET_COMPLETED'
  | 'SIGN_IN_ALERT';

export type SecuritySeverity = 'info' | 'warn' | 'error' | 'critical';

interface SecurityLogEntry {
  timestamp: string;
  level: SecuritySeverity;
  event: SecurityEvent;
  userId?: string;
  ip?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}

/**
 * Log a security event as structured JSON to stdout.
 */
export function logSecurityEvent(
  event: SecurityEvent,
  severity: SecuritySeverity,
  context?: {
    userId?: string;
    ip?: string;
    userAgent?: string;
    details?: Record<string, unknown>;
  },
): void {
  const entry: SecurityLogEntry = {
    timestamp: new Date().toISOString(),
    level: severity,
    event,
    ...context,
  };

  const line = JSON.stringify(redactEmails(entry));

  // Use appropriate console method based on severity
  switch (severity) {
    case 'critical':
    case 'error':
      console.error(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}
