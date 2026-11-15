import { describe, expectTypeOf, it } from 'vitest';
import type { ComponentProps } from 'react';
import type { RouteRow } from '@/components/ui/RouteRow';
import type { HomeData, RouteStop, StageOpen } from '@/lib/home/types';
import type { Tally } from '@/lib/ui/marks';

/** Plan 1B Task 9: Home's types are pinned to the kit's, so a change on either side fails to compile (`npx tsc --noEmit`). */
describe('Home types', () => {
  it("RouteStop equals RouteRow's stops element", () => {
    expectTypeOf<RouteStop>().toEqualTypeOf<ComponentProps<typeof RouteRow>['stops'][number]>();
  });

  it("StageOpen's tally is the kit's Tally, and HomeData has exactly the four variants", () => {
    expectTypeOf<StageOpen['tally']>().toEqualTypeOf<Tally>();
    expectTypeOf<HomeData['variant']>().toEqualTypeOf<'recorder' | 'reviewer' | 'viewer' | 'first-time'>();
  });
});
