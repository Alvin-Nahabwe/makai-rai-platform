/**
 * The words of the three project writers' outcomes (audit B rows 53 to 67 and 370 to 375, as plan 1A Task 17 rules
 * them): the refusal lines and the error summary of lib/projects/writeRefusal.ts, and the words of Archive and
 * Unarchive. Client importers: components/project/ProjectForm.tsx (through writeRefusal.ts), ArchiveProjectControl.tsx
 * and UnarchiveProjectButton.tsx (ruling X-2).
 */
export const PROJECT_WRITE_COPY = Object.freeze({
  forbidden: 'You can no longer change this project. Ask an Owner or Admin if you need to.',
  gone: 'This project no longer exists.',
  archivedForm: 'This project is archived. Nothing in it can be changed.',
  tryAgain: 'Something went wrong. Please try again.',
  /** The form's error summary: one problem, or n of them. */
  summary: (n: number) => (n === 1
    ? 'There is a problem with this project. What you typed is kept.'
    : `There are ${n} problems with this project. What you typed is kept.`),
  /** Archive on S-10: the trigger, the confirmation, the status lines and Retry. */
  archive: Object.freeze({
    trigger: 'Archive project',
    objectName: (project: string) => `Archive ${project}?`,
    consequence: 'Nothing in it can be changed until it is unarchived. No reminders are sent. Its issued documents stay stored and can still be downloaded.',
    action: 'Archive project',
    archiving: 'Archiving...',
    slow: 'Still archiving. The connection is slow.',
    archived: 'Archived. Nothing in this project can be changed until it is unarchived.',
    /** No reply in time, or no usable reply: the outcome is not known. Retry keeps the request id, which the route answers again. */
    lost: 'Not archived yet. We did not get a reply in time, so it may already be archived. Select Retry. It will not archive twice.',
    failed: 'Not archived. Something went wrong. Please try again.',
    retry: 'Retry',
  }),
  /** Unarchive on S-32. */
  unarchive: Object.freeze({
    button: 'Unarchive',
    /** The button's accessible name, which names the project. */
    named: (project: string) => `Unarchive ${project}`,
    slow: 'Still unarchiving. The connection is slow.',
    /** No reply in time, or no usable reply: the outcome is not known. Retry keeps the request id, which the route answers again. */
    lost: 'Not unarchived yet. We did not get a reply in time, so it may already be unarchived. Select Retry. It will not unarchive twice.',
    failed: 'Not unarchived. Something went wrong. Please try again.',
    retry: 'Retry',
  }),
});
