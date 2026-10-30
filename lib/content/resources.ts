import type { ResourcesFile } from '@/types/content';
import { NotImplementedError } from '@/lib/http/errors';

/** The `data/resources.json` loader (FR-CNT-05). Typed stub that throws until the producer merges. */

// CONTRACT_STUB: CNT
export function loadResources(): ResourcesFile {
  throw new NotImplementedError('CNT');
}
