// js-yaml 4 ships no type declarations, and @types/js-yaml is not a dependency of this project.
// The lint tests that read workflow files as YAML use only `load`, so only `load` is declared.
declare module 'js-yaml' {
  /** Parses one YAML document with the default schema; anchors and aliases are resolved, duplicate keys throw. */
  export function load(input: string, options?: { filename?: string; json?: boolean }): unknown;
}
