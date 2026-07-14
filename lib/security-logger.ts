/**
 * Structured security event logger.
 * Outputs JSON to stdout for Docker/ELK/CloudWatch consumption.
 * No external dependencies.
 */

export type SecurityEvent =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILURE'
  | 'AUTH_ACCOUNT_LOCKED'
  | 'AUTH_REGISTER'
  | 'AUTH_LOGOUT'
  | 'AUTH_PASSWORD_CHANGED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INPUT_VALIDATION_FAILURE'
  | 'ADMIN_ACTION'
  | 'ASSESSMENT_CREATED'
  | 'ASSESSMENT_COMPLETED';

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

  // Use appropriate console method based on severity
  switch (severity) {
    case 'critical':
    case 'error':
      console.error(JSON.stringify(entry));
      break;
    case 'warn':
      console.warn(JSON.stringify(entry));
      break;
    default:
      console.log(JSON.stringify(entry));
  }
}
