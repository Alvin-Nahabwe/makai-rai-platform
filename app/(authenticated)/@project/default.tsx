/**
 * The `@project` slot's fallback (owner ruling R4): on a full page load of any address the slot has no page for, there is
 * no project in context, so the shell shows no project block. Next.js 16 requires a default.js for every slot.
 */
export default function NoProject() {
  return null;
}
