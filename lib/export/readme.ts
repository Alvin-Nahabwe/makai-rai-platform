/**
 * README.txt of every team export (SRS 6.3, line 1414): what each file is, the format id, how to
 * check a seal, and why link evidence is not in the archive. Fixed text: no name, title or other
 * value a team wrote goes into it (NFR-PRIV-03), so it is the same in every export.
 */
export const README_TEXT = `MAK-AI RAI Platform team export

This archive holds your organisation's records as they stood at the moment of export.

Files
- export.json: every record of the export, in the format makrai.team-export/1. It lists the organisation, its members with their names and roles at export time, and for each project every version of every decision, every evidence item, finding, finding event, mitigation version, accepted risk, stage review, seal and issued document, and every document event. Evidence that was uploaded but never attached to a saved version is listed separately under unattachedEvidence. Every time is in UTC. The JSON schema of this format is docs/formats/team-export-1.json in the platform's source repository.
- evidence/: every evidence file whose bytes are still held, each named with its evidence id, a hyphen and its file name. The file name in the folder keeps only letters, digits, dots, hyphens and underscores; the name as it was uploaded is in export.json under fileName, and the entry under file.
- documents/: the PDF of every issued document, each named with its document id and .pdf.
- README.txt: this file.

How to check a seal
Each seal in export.json carries its manifest as base64 and its fingerprint. Decode the manifest to bytes, compute the SHA-256 of the manifest bytes, and compare it with the fingerprint written in lowercase hexadecimal. If the two are equal, the manifest is the one the platform sealed. You can check an evidence file or an issued PDF the same way, against its sha256.

Links
Link evidence is listed in export.json with its address, but no file for it is in the archive, because the platform never fetched what a link points to.

Erased items
Where the operator erased an item's bytes or text at the controller's instruction, the item stays in export.json with the erased value empty, and a tombstone records when and why.
`;
