/**
 * A just-enough nginx config reader for the lint tests that guard
 * `docker/nginx/default.conf`.
 *
 * Those tests assert where a directive sits in the block tree (directly in a
 * server, not inside a location; before another directive), which a regular
 * expression over the text cannot answer. This is the one parser they share.
 */

export type NginxNode = { name: string; args: string[]; children?: NginxNode[] };

/**
 * Directives end in `;`, blocks open with `{`, `#` starts a comment, and a quote
 * pairs only with its own kind (so the single quotes inside a double-quoted CSP
 * are literal, and the `;` inside it does not end the directive).
 */
export function parseNginx(source: string): NginxNode[] {
  let pos = 0;

  function parseBlock(): NginxNode[] {
    const nodes: NginxNode[] = [];
    let words: string[] = [];
    let word = '';
    let inWord = false;

    const endWord = () => {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    };

    while (pos < source.length) {
      const ch = source[pos];

      if (ch === '#') {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        pos++;
        inWord = true;
        while (pos < source.length && source[pos] !== quote) word += source[pos++];
        pos++; // closing quote
        continue;
      }
      if (ch === ';') {
        pos++;
        endWord();
        if (words.length > 0) nodes.push({ name: words[0], args: words.slice(1) });
        words = [];
        continue;
      }
      if (ch === '{') {
        pos++;
        endWord();
        const children = parseBlock();
        nodes.push({ name: words[0] ?? '', args: words.slice(1), children });
        words = [];
        continue;
      }
      if (ch === '}') {
        pos++;
        return nodes;
      }
      if (/\s/.test(ch)) {
        endWord();
        pos++;
        continue;
      }
      word += ch;
      inWord = true;
      pos++;
    }
    return nodes;
  }

  return parseBlock();
}

/** Every node in the tree, blocks included, each with the chain of blocks above it. */
export function walk(
  nodes: NginxNode[],
  ancestors: NginxNode[] = [],
): { node: NginxNode; ancestors: NginxNode[] }[] {
  return nodes.flatMap((node) => [
    { node, ancestors },
    ...(node.children ? walk(node.children, [...ancestors, node]) : []),
  ]);
}

/** Every directive (a node that is not a block), with the chain of blocks it sits inside. */
export function directivesOf(nodes: NginxNode[]): { node: NginxNode; ancestors: NginxNode[] }[] {
  return walk(nodes).filter(({ node }) => !node.children);
}

/**
 * The raw text of every `name` directive, from the keyword to its terminating `;`,
 * across all of its arguments (quoted or not), with comments removed.
 *
 * For checks that must not depend on how `parseNginx` splits a directive. nginx
 * reads `${name}` as a variable reference wherever it appears, but `parseNginx`
 * opens a block at any `{` outside quotes, so an unquoted `${http_user_agent}`
 * argument never reaches the parsed arguments. It also keeps each quoted argument
 * separate, while nginx lets a variable name end where one argument ends.
 *
 * Follows nginx's own reading: a `#` starts a comment only at the start of a token;
 * a quote pairs with its own kind, and a backslash escapes inside it.
 */
export function rawDirectives(source: string, name: string): string[] {
  let clean = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      clean += ch;
      if (ch === '\\' && i + 1 < source.length) clean += source[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    const prev = clean[clean.length - 1];
    if (ch === '#' && (prev === undefined || /[\s;{}]/.test(prev))) {
      while (i < source.length && source[i] !== '\n') i++;
      clean += '\n';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    clean += ch;
  }

  const found: string[] = [];
  const keyword = new RegExp(`(?<=^|[\\s;{}])${name}(?![A-Za-z0-9_])`, 'g');
  for (const m of clean.matchAll(keyword)) {
    let end = m.index + name.length;
    let q: string | null = null;
    for (; end < clean.length; end++) {
      const ch = clean[end];
      if (q) {
        if (ch === '\\') end++;
        else if (ch === q) q = null;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ';') break;
    }
    found.push(clean.slice(m.index, end + 1).trim());
  }
  return found;
}
