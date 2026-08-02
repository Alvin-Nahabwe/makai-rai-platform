import { describe, it, expect } from 'vitest';
import { can, ACTIONS, ROLES } from '../../lib/authz/policy';
import type { OrgRole } from '@prisma/client';

describe('policy.ts', () => {
  // Matrix encoding: position maps to ['owner','admin','assessor','reviewer','viewer']
  // x = allowed, . = denied
  const matrix: Record<string, string> = {
    'org:read': 'xxxxx',
    'org:update': 'xx...',
    'org:delete': 'x....',
    'member:list': 'xxxxx',
    'member:invite': 'xx...',
    'member:remove': 'xx...',
    'member:grant_owner': 'x....',
    'project:create': 'xxx..',
    'project:read': 'xxxxx',
    'project:update': 'xxx..',
    'project:delete': 'xx...',
    'assessment:create': 'xxx..',
    'assessment:read': 'xxxxx',
    'assessment:respond': 'xxx..',
    'assessment:complete': 'xxx..',
    'assessment:delete': 'xx...',
    'remediation:update': 'xxx..',
  };

  describe('matrix-driven assertions', () => {
    it('should assert every (role x action) pair from the matrix', () => {
      Object.entries(matrix).forEach(([action, permissions]) => {
        ROLES.forEach((role, idx) => {
          const allowed = permissions[idx] === 'x';
          const result = can(role as OrgRole, action as any);
          expect(result).toBe(allowed);
        });
      });
    });
  });

  describe('escalation guards', () => {
    it('should NOT allow admin to grant owner role', () => {
      expect(can('admin', 'member:grant_owner')).toBe(false);
    });

    it('should NOT allow viewer to perform any write action', () => {
      const writeActions = [
        'project:create',
        'project:update',
        'project:delete',
        'assessment:create',
        'assessment:respond',
        'assessment:complete',
        'assessment:delete',
        'member:invite',
        'member:remove',
        'org:update',
        'org:delete',
        'remediation:update',
      ];
      writeActions.forEach(action => {
        expect(can('viewer', action as any)).toBe(false);
      });
    });

    it('should NOT allow reviewer to perform any write action', () => {
      const writeActions = [
        'project:create',
        'project:update',
        'project:delete',
        'assessment:create',
        'assessment:respond',
        'assessment:complete',
        'assessment:delete',
        'member:invite',
        'member:remove',
        'org:update',
        'org:delete',
        'remediation:update',
      ];
      writeActions.forEach(action => {
        expect(can('reviewer', action as any)).toBe(false);
      });
    });
  });

  describe('matrix integrity', () => {
    it('should have matrix keys that exactly match ACTIONS', () => {
      const matrixKeys = Object.keys(matrix).sort();
      const actionsKeys = ACTIONS.slice().sort();
      expect(matrixKeys).toEqual(actionsKeys);
    });
  });
});
