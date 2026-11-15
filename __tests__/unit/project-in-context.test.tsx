import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Identity } from '@/lib/auth/identity';
import type { ShellProject } from '@/lib/shell/types';

/**
 * components/layout/ProjectInContext.tsx: the `@project` slot's renderer (owner ruling R4). Code review M5 (fix round 2):
 * an address whose stage segment names no stage is the page's 404, so the slot shows no project block there either, and it
 * reads nothing for it.
 */
const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shell/project', () => ({ loadShellProject: load }));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

import { ProjectInContext } from '@/components/layout/ProjectInContext';

const identity: Identity = { userId: 'u1', email: 'u1@x.test', name: 'U', platformRole: 'assessor', mustChangePassword: false };
const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const project: ShellProject = { id: ID, name: 'P', stages: [{ stage: 'pre-processing', questions: 2, noDecision: 2 }] };

beforeEach(() => { load.mockReset().mockResolvedValue(project); });

describe('ProjectInContext', () => {
  it('R4: a project-level page and a stage page render the slot for the identity and address the slot page gives', async () => {
    expect(await ProjectInContext({ identity, params: { slug: 'a', id: ID } })).not.toBeNull();
    expect(await ProjectInContext({ identity, params: { slug: 'a', id: ID, stage: 'pre-processing' } })).not.toBeNull();
    expect(load).toHaveBeenCalledWith(identity, { slug: 'a', id: ID });
  });

  it('M5: a stage segment that names no stage (the page is a 404) gives no block and reads nothing', async () => {
    for (const stage of ['bogus', '__proto__', 'Pre-processing']) {
      expect(await ProjectInContext({ identity, params: { slug: 'a', id: ID, stage } }), stage).toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('S2: no project to show (the loader\'s null) renders nothing', async () => {
    load.mockResolvedValue(null);
    const out = await ProjectInContext({ identity, params: { slug: 'a', id: ID } });
    expect(out === null ? '' : renderToStaticMarkup(out)).toBe('');
  });
});
