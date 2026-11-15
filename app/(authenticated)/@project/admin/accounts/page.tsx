/**
 * The `@project` slot's page for this address (owner ruling R4): it is not a project's page, so there is no project block.
 * The slot mirrors every signed-in page, one empty page per address, because Next.js keeps a slot's last page on a
 * client-side navigation to an address the slot has no page for, which would leave a project's block in the rail
 * (__tests__/unit/shell-project-slot.test.ts holds the mirror to app/(authenticated)).
 */
export default function NoProject() {
  return null;
}
