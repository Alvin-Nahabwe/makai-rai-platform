/**
 * README.txt of every download of records (SRS 6.3, line 1414): what each file is, the format id, how to
 * check a seal, and why link evidence is not in the ZIP file. Fixed text: no name, title or other
 * value a team wrote goes into it (NFR-PRIV-03), so it is the same in every download. Its words are the
 * copy audit's (C 401, C 402, C 408; G-d3's title), each checked against what lib/data/export.ts writes:
 * finding events are only `reopened` or `withdrawn`, and document events only `withdrawn`, with a reason
 * (migration 20261030000300_v060_03_tenant); `evidence/` and `documents/` hold only files whose bytes are
 * still stored; erased values are null and each erasure has a row under `tombstones`. C 401's last
 * sentence ("MAK-AI can send the format description on request") is left out: no code can show it true.
 */
export const README_TEXT = `MAK-AI RAI Platform: downloaded records

This ZIP file holds your organisation's records, or one project's, as they stood when they were downloaded.

Files
- export.json: every record in this ZIP file, in the format makrai.team-export/1. It lists the organisation and its members, with their names and roles. For each project it lists the project's details and every decision version, evidence item, finding, mitigation version, accepted risk, stage review, seal and issued document. It also records when a finding was reopened or withdrawn, and when a document was withdrawn and why. Evidence that was uploaded but never attached to a saved version is listed under unattachedEvidence. All times are UTC.
- evidence/: every evidence file still held, named with its evidence id, a hyphen and its file name. Some characters are removed from the names, and long names are shortened. The original name is in export.json under fileName.
- documents/: the PDF of every issued document still held, named with its document id and .pdf.
- README.txt: this file.

How to check a seal
Each seal in export.json carries its manifest as base64 and its fingerprint. Decode the manifest to bytes, compute the SHA-256 of the manifest bytes, and compare it with the fingerprint written in lowercase hexadecimal. If the two are equal, the manifest is the one the platform sealed. You can check an evidence file or an issued PDF the same way, against its sha256.

Links
Link evidence is listed in export.json with its address, but no file for it is in the ZIP file, because the platform never fetched what a link points to.

Erased items
Where MAK-AI erased a file or text at your organisation's request, the item stays in export.json with the erased value empty. A separate entry records when and why it was erased.
`;
