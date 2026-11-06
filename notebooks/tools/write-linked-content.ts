/**
 * Rewrites the `linked-content` cell of each technical notebook from the running content bundle.
 * Run from the repository root: `npx tsx notebooks/tools/write-linked-content.ts [content-version]`
 * (default: `running` in data/content/index.json). Only that one cell changes; see writeLinkedContent.ts.
 */
import { writeLinkedContent } from './writeLinkedContent';

for (const file of writeLinkedContent(process.cwd(), process.argv[2])) {
  console.log(`${file}: linked-content cell written`);
}
