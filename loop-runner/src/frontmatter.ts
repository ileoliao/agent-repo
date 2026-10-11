/**
 * Small indentation-based YAML subset for agent and SKILL.md frontmatter. Dependency-free.
 * Supports: scalars (quoted, numbers, booleans), inline lists [a, b], block lists (- item),
 * nested maps, lists of maps (as used by VS Code's `handoffs`), | and > block scalars, # comments.
 */
export interface Parsed {
  meta: Record<string, any>;
  body: string;
}

interface Line { indent: number; text: string; raw: string }

export function parseFrontmatter(src: string): Parsed {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(src);
  if (!m) {
    return { meta: {}, body: src.trim() };
  }
  const lines: Line[] = m[1].split(/\r?\n/).map(raw => {
    const text = raw.trim();
    return { indent: raw.length - raw.trimStart().length, text, raw };
  });
  const [meta] = parseMap(lines, nextContent(lines, 0), 0);
  return { meta: meta ?? {}, body: m[2].trim() };
}

const isBlank = (l: Line) => l.text === '' || l.text.startsWith('#');
const KEY = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/;

function nextContent(lines: Line[], i: number): number {
  while (i < lines.length && isBlank(lines[i])) { i++; }
  return i;
}

function parseMap(lines: Line[], i: number, indent: number): [Record<string, any>, number] {
  const obj: Record<string, any> = {};
  while (i < lines.length) {
    i = nextContent(lines, i);
    const l = lines[i];
    if (!l || l.indent !== indent || l.text.startsWith('- ')) { break; }
    const kv = KEY.exec(l.text);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const rest = stripComment(kv[2] ?? '');
    i++;
    if (/^[|>][-+]?$/.test(rest)) {
      const block: string[] = [];
      let base = -1;
      while (i < lines.length && (lines[i].text === '' || lines[i].indent > indent)) {
        if (lines[i].text !== '' && base < 0) { base = lines[i].indent; }
        block.push(lines[i].raw.slice(Math.max(0, base)));
        i++;
      }
      obj[key] = rest.startsWith('|') ? block.join('\n').trim() : block.map(s => s.trim()).filter(Boolean).join(' ');
    } else if (rest === '') {
      const j = nextContent(lines, i);
      const n = lines[j];
      if (n && n.indent > indent) {
        [obj[key], i] = parseBlock(lines, j, n.indent);
      } else if (n && n.indent === indent && n.text.startsWith('- ')) {
        [obj[key], i] = parseList(lines, j, indent);
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = inlineValue(rest);
    }
  }
  return [obj, i];
}

function parseBlock(lines: Line[], i: number, indent: number): [any, number] {
  return lines[i].text.startsWith('- ') ? parseList(lines, i, indent) : parseMap(lines, i, indent);
}

function parseList(lines: Line[], i: number, indent: number): [any[], number] {
  const arr: any[] = [];
  while (i < lines.length) {
    i = nextContent(lines, i);
    const l = lines[i];
    if (!l || l.indent !== indent || !l.text.startsWith('- ')) { break; }
    const content = l.text.slice(2).trim();
    // Column where the item's content starts: "  - label: x" -> indent + 2.
    const contentIndent = indent + (l.text.length - l.text.slice(1).trimStart().length);
    if (KEY.test(content) && !/^["']/.test(content)) {
      // A map item: re-parse "- key: v" plus its continuation lines as a map at the content column.
      const sub: Line[] = [{ indent: contentIndent, text: content, raw: ' '.repeat(contentIndent) + content }];
      let j = i + 1;
      while (j < lines.length && (isBlank(lines[j]) || lines[j].indent > indent)) { sub.push(lines[j]); j++; }
      arr.push(parseMap(sub, 0, contentIndent)[0]);
      i = j;
    } else if (content === '') {
      const j = nextContent(lines, i + 1);
      if (lines[j] && lines[j].indent > indent) {
        let v; [v, i] = parseBlock(lines, j, lines[j].indent); arr.push(v);
      } else { arr.push(null); i++; }
    } else {
      arr.push(inlineValue(stripComment(content)));
      i++;
    }
  }
  return [arr, i];
}

/** Drop a trailing " # comment" that is outside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (q) { if (ch === q) { q = null; } }
    else if (ch === '"' || ch === "'") { q = ch; }
    else if (ch === '#' && (k === 0 || /\s/.test(s[k - 1]))) { return s.slice(0, k).trim(); }
  }
  return s.trim();
}

function inlineValue(v: string): any {
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? splitTopLevel(inner).map(s => scalar(s.trim())) : [];
  }
  return scalar(v);
}

/** Split "a, 'b, c', d" on commas outside quotes. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of s) {
    if (q) { if (ch === q) { q = null; } cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function scalar(v: string): any {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s === 'true') { return true; }
  if (s === 'false') { return false; }
  if (s === 'null' || s === '~') { return null; }
  if (/^-?\d+(\.\d+)?$/.test(s)) { return Number(s); }
  return s;
}
