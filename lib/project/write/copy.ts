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
});
