// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

const normAt = (tier: number) => (s: string): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** The positions where O occurs in lines at one tier (section 5). */
function tierPositions(o: string[], lines: string[], tier: number): number[] {
  const norm = normAt(tier);
  const want = o.map(norm);
  const have = lines.map(norm);
  const out: number[] = [];
  for (let i = 0; i + want.length <= have.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (have[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its positions; null when it occurs at no tier. */
function findTier(o: string[], lines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = tierPositions(o, lines, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when none. */
function findTierFrom(o: string[], lines: string[], from: number, strict: boolean, eof: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = tierPositions(o, lines, t).filter((p) => p >= from && (!eof || p + o.length === lines.length));
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const norm = normAt(t);
    const want = norm(anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (norm(lines[i]!) === want) return i;
    }
  }
  return null;
}

/** One line of N: its text, and the index in O of the context line it is, or null when it is new. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines that replace O's match at position `at`, in tier `tier` (section 5). */
function replacement(o: string[], n: NewLine[], lines: string[], at: number, tier: number): string[] {
  const f = lead(lines[at]!);
  const p = lead(o[0]!);
  return n.map((l) => {
    if (l.ctx !== null) return lines[at + l.ctx]!;
    if (tier === 2 && l.text !== '' && l.text.trim() !== '' && l.text.startsWith(p)) return f + l.text.slice(p.length);
    return l.text;
  });
}

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function splitBody(body: { kind: string; text: string }[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: oIdx });
      oIdx += 1;
    } else if (b.kind === '-') {
      o.push(b.text);
      oIdx += 1;
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/** Whether the hunk or chunk's last context or `+` line is followed by a `\` line. */
function noFinalBreak(body: { kind: string; text: string }[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') return k + 1 < body.length && body[k + 1]!.kind === '\\';
  }
  return false;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** The moves the edits made, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified diff (section 6): its old start line and its body lines. */
interface Hunk {
  a: number;
  body: { kind: string; text: string }[];
}

/** One section of a unified diff (section 6). */
interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const hunkHeaderA = (l: string): number | null => {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  return m === null ? null : Number(m[1]);
};

/** The path a `--- ` or `+++ ` line names; null when it names no file (/dev/null). */
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk's body, from the line after its header, and the first line after it. */
function hunkBody(lines: string[], start: number): { body: { kind: string; text: string }[]; next: number } {
  const body: { kind: string; text: string }[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c, text: l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  return { body, next: j };
}

/** Apply a section's hunks to a file's lines, in order (section 6). */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    const noBreak = noFinalBreak(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const rep = n.map((l) => l.text);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...rep);
      if (atEnd) final = !noBreak;
    } else {
      const found = findTier(o, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = replacement(o, n, lines, best, found.tier);
      const touchesEnd = best + o.length === lines.length;
      lines.splice(best, o.length, ...rep);
      if (touchesEnd) final = !noBreak;
    }
    d += n.length - o.length;
  }
  return { lines, br: f.br, final };
}

/** The `+` lines of a section's hunks, and whether its last `+` line is followed by a `\` line. */
function createdContent(hunks: Hunk[]): { lines: string[]; noBreak: boolean } {
  const content: string[] = [];
  for (const h of hunks) {
    for (const b of h.body) {
      if (b.kind === '+') content.push(b.text);
    }
  }
  let noBreak = false;
  for (let hi = hunks.length - 1; hi >= 0; hi -= 1) {
    const h = hunks[hi]!;
    let seen = false;
    for (let k = h.body.length - 1; k >= 0; k -= 1) {
      if (h.body[k]!.kind === '+') {
        noBreak = k + 1 < h.body.length && h.body[k + 1]!.kind === '\\';
        seen = true;
        break;
      }
    }
    if (seen) break;
  }
  return { lines: content, noBreak };
}

/** One section of a unified diff as a single edit (section 6). */
function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameFrom ?? s.gitOld;
    const newPath = s.pairNew !== undefined ? s.pairNew : s.renameTo ?? s.gitNew;
    if (oldPath === null && newPath === null) return;
    const isDelete = newPath === null || s.deletedFile;
    const isCreate = !isDelete && (oldPath === null || s.newFile);
    const isMove = !isDelete && !isCreate && oldPath !== null && newPath !== null && oldPath !== newPath;
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isDelete) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isCreate) {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const { lines, noBreak } = createdContent(s.hunks);
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isMove) {
      const oldP = oldPath!;
      const newP = newPath!;
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.move(oldP, newP, joinFile(applyHunks(splitFile(cur), s.hunks, strict, oldP)));
      return;
    }
    const p = oldPath!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(splitFile(cur), s.hunks, strict, p)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  const newSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      hasPair = false;
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection();
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        sections.push(cur);
        inHeader = true;
        hasPair = true;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        const a = hunkHeaderA(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const { body, next } = hunkBody(lines, i + 1);
        cur.hunks.push({ a, body });
        i = next;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!hasPair) cur.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!hasPair) cur.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = hunkHeaderA(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = hunkBody(lines, i + 1);
      cur.hunks.push({ a, body });
      i = next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      cur.pairOld = headerPath(l);
      cur.pairNew = headerPath(lines[i + 1]!);
      sections.push(cur);
      inHeader = true;
      hasPair = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as a single edit (section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(oldLines, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = replacement(oldLines, n, f.lines, at, found.tier);
    const out = [...f.lines];
    out.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile({ lines: out, br: f.br, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One chunk of a V4A Update File section (section 8). */
interface V4aChunk {
  anchor: string | null;
  body: { kind: string; text: string }[];
  eof: boolean;
}

/** One V4A Add File section as an edit. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section as an edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as an edit (section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let lines = [...f.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, lines, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const rep = n.map((l) => l.text);
        lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      } else {
        const found = findTierFrom(o, lines, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.positions[0]!;
        const rep = replacement(o, n, lines, at, found.tier);
        lines.splice(at, o.length, ...rep);
        cursor = at + rep.length;
      }
    }
    const out = joinFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.now.set(path, out);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const end = last;
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      i += 1;
      while (i < end) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x === '') {
          fileLines.push('');
          i += 1;
          continue;
        }
        if (x.startsWith('+')) {
          fileLines.push(x.slice(1));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      edits.push(v4aDeleteEdit(l.slice('*** Delete File: '.length).trim()));
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      const startChunk = (anchor: string | null): void => {
        curChunk = { anchor, body: [], eof: false };
        chunks.push(curChunk);
      };
      while (i < end) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x.startsWith('@@')) {
          const anchor = x.slice(2).trim();
          startChunk(anchor === '' ? null : anchor);
          i += 1;
          continue;
        }
        if (x.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          curChunk = null;
          i += 1;
          continue;
        }
        if (blank(x)) {
          if (curChunk === null) {
            if (chunks.length === 0) startChunk(null);
            else {
              i += 1;
              continue;
            }
          }
          curChunk!.body.push({ kind: ' ', text: '' });
          i += 1;
          continue;
        }
        if (curChunk === null) {
          if (chunks.length === 0 && (x[0] === ' ' || x[0] === '-' || x[0] === '+')) {
            startChunk(null);
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
        }
        const c = x[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          curChunk!.body.push({ kind: c, text: x.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (curChunk !== null) {
        while (curChunk.body.length > 0 && curChunk.body[curChunk.body.length - 1]!.kind === ' ' && curChunk.body[curChunk.body.length - 1]!.text === '') curChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const shown: { key: string; text: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      shown.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    shown.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  shown.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = shown.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
