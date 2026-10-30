/**
 * A content version: `5.0.0`, `0.0.1-fixture`. No quote, slash, line break or second hyphen can match, so a value
 * that passes can be joined into a file name or written into SQL. The loader checks it before any read and the
 * registry migration renderer checks it before any write; both import it from here, so a route that loads
 * content does not carry the module that turns values into owner-role SQL.
 */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
