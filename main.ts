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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, old path to new path, in the order they ran. */
  readonly moves: Array<[string, string]> = [];
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
  /** A path exists when an earlier edit left a file there, or the disk holds anything at it (file or directory). */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
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
      if (tree.exists(p)) throw new Fail('exists', p);
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

// ---- section 3: a file's lines, its line break, and whether it ends with one ----

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---- section 5: matching lines at three tiers ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at one tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first tier at which O occurs at or after `from` with an occurrence passing `pred`. */
function findTierFiltered(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  pred: (pos: number) => boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from).filter(pred);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NEntry {
  text: string;
  ctx: boolean;
  oIdx: number; // for a context line, its index in O; -1 otherwise
}

/** The lines N writes in place of the matched O at position pos. */
function buildReplacement(lines: string[], pos: number, o: string[], n: NEntry[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = (/^[ \t]*/.exec(lines[pos]!) ?? [''])[0]!;
    p = (/^[ \t]*/.exec(o[0]!) ?? [''])[0]!;
  }
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx) {
      out.push(lines[pos + e.oIdx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Split body lines into O lines and N entries. Body lines: ' ' context, '-' old, '+' new. */
function bodyON(body: string[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const text = l.slice(1);
      o.push(text);
      n.push({ text, ctx: true, oIdx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** A hunk/chunk body's O and N. `\` lines are markers, not lines; an empty line is a context line. */
function hunkON(body: string[]): { o: string[]; n: NEntry[] } {
  const norm = body.filter((l) => !l.startsWith('\\')).map((l) => (l === '' ? ' ' : l));
  return bodyON(norm);
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) last = i;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

// ---- section 6: unified diffs ----

interface Hunk {
  a: number; // old start line, 1-based
  body: string[]; // raw body lines: ' ', '-', '+', '\' or '' (empty: a context line)
}

interface UniSection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isDiffGitLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function headerPath(l: string): string {
  let p = l.slice(4).split('\t')[0]!;
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks in order to a file model, each to the result of the ones before it. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h.body);
    const noEol = hunkNoEol(h.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const inserted = n.map((e) => e.text);
      const runsToEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...inserted);
      if (runsToEnd) model.final = !noEol;
      d += n.length;
    } else {
      const found = findTier(model.lines, o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + o.length === model.lines.length;
      const repl = buildReplacement(model.lines, best, o, n, found.tier);
      model.lines.splice(best, o.length, ...repl);
      if (runsToEnd) model.final = !noEol;
      d += n.length - o.length;
    }
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Draft {
    diffOld: string | null;
    diffNew: string | null;
    hdrOld: string | null;
    hdrNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
  }
  const sections: Draft[] = [];
  let cur: Draft | null = null;
  let inHeader = false;
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    cur = { diffOld, diffNew, hdrOld: null, hdrNew: null, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const m = DIFF_GIT.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) startSection(null, null);
      cur!.hdrOld = headerPath(l);
      cur!.hdrNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          hunk.body.push(b);
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.hdrNew = headerPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldRaw = s.hdrOld ?? s.renameFrom ?? s.diffOld;
    const newRaw = s.hdrNew ?? s.renameTo ?? s.diffNew;
    const oldPath = oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw;
    const newPath = newRaw === null || newRaw === '/dev/null' ? null : newRaw;
    const isCreate = oldPath === null || s.isCreate;
    const isDelete = !isCreate && (newPath === null || s.isDelete);
    if (isCreate) {
      if (newPath === null) {
        edits.push(() => {});
        continue;
      }
      edits.push((tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.exists(newPath)) throw new Fail('exists', newPath);
        const plus: string[] = [];
        for (const h of s.hunks) {
          for (const b of h.body) {
            if (b.startsWith('+')) plus.push(b.slice(1));
          }
        }
        let noEol = false;
        for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const h = s.hunks[hi]!;
          let lastPlus = -1;
          for (let k = 0; k < h.body.length; k++) if (h.body[k]!.startsWith('+')) lastPlus = k;
          if (lastPlus >= 0) {
            const next = h.body[lastPlus + 1];
            noEol = next !== undefined && next.startsWith('\\');
            break;
          }
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      if (oldPath === null) {
        edits.push(() => {});
        continue;
      }
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      });
      continue;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.exists(newPath)) throw new Fail('exists', newPath);
        const model = splitFile(before);
        applyHunks(model, s.hunks, strict, oldPath);
        tree.now.set(newPath, joinFile(model));
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
      });
      continue;
    }
    const path = (oldPath ?? newPath)!;
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const model = splitFile(before);
      applyHunks(model, s.hunks, strict, path);
      tree.now.set(path, joinFile(model));
    });
  }
  return edits;
}

// ---- section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0; // index of the first line after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '<<<<<<< SEARCH' || l === '>>>>>>> REPLACE') break;
      if (l === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '<<<<<<< SEARCH') break;
      if (l === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(((p, o, n) => (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = splitFile(before);
      const found = findTier(model.lines, o, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const entries: NEntry[] = n.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const repl = buildReplacement(model.lines, pos, o, entries, found.tier);
      model.lines.splice(pos, o.length, ...repl);
      tree.now.set(p, joinFile(model));
    })(path, oldLines, newLines));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[]; // raw body lines: ' ', '-', '+' or '' (empty: a context line)
}

/** Apply one chunk; returns the cursor just after the lines written. */
function applyVChunk(model: FileModel, c: VChunk, cursor: number, strict: boolean, path: string): number {
  if (c.anchor !== null) {
    const found = findTier(model.lines, [c.anchor], strict, cursor);
    if (!found) throw new Fail('no-match', path);
    cursor = found.occ[0]! + 1;
  }
  const { o, n } = hunkON(c.body);
  if (o.length === 0) {
    const at = c.eof ? model.lines.length : cursor;
    model.lines.splice(at, 0, ...n.map((e) => e.text));
    return at + n.length;
  }
  const pred = c.eof ? (p: number): boolean => p + o.length === model.lines.length : (): boolean => true;
  const found = findTierFiltered(model.lines, o, strict, cursor, pred);
  if (!found) throw new Fail('no-match', path);
  const pos = found.occ[0]!;
  const repl = buildReplacement(model.lines, pos, o, n, found.tier);
  model.lines.splice(pos, o.length, ...repl);
  return pos + repl.length;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m.startsWith('+')) {
          raw.push(m);
          i++;
          continue;
        }
        if (blank(m)) {
          raw.push(m);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines = raw.map((r) => (r.startsWith('+') ? r.slice(1) : ''));
      edits.push(((p, fl) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (blank(m)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let open: VChunk | null = null;
      let sawChunk = false;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m.startsWith('@@')) {
          const anchorText = m.slice(2).trim();
          open = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(open);
          sawChunk = true;
          i++;
          continue;
        }
        if (m === '*** End of File') {
          if (open === null) throw new Exit2(`error: parse ${i + 1}`);
          open.eof = true;
          open = null;
          i++;
          continue;
        }
        if (m.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+')) {
          if (open === null) {
            if (sawChunk) throw new Exit2(`error: parse ${i + 1}`);
            open = { anchor: null, eof: false, body: [] };
            chunks.push(open);
            sawChunk = true;
          }
          open.body.push(m);
          i++;
          continue;
        }
        if (blank(m)) {
          if (open !== null) open.body.push(m);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (open !== null) {
        while (open.body.length > 0 && blank(open.body[open.body.length - 1]!)) open.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(((p, mt, ch) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.exists(mt)) throw new Fail('exists', mt);
        const model = splitFile(before);
        let cursor = 0;
        for (const c of ch) cursor = applyVChunk(model, c, cursor, strict, p);
        const text = joinFile(model);
        if (mt !== null) {
          tree.now.set(mt, text);
          tree.now.set(p, null);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, text);
        }
      })(path, moveTo, chunks));
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
  // A move pairs its old path's deletion with its new path's creation into one R line:
  // the old path existed before the patch and is gone, the new path did not exist and is here.
  const movedByNew = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      movedByNew.set(newP, oldP);
    }
  }
  const movedOld = new Set(movedByNew.values());
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const toWrite: Array<[string, string]> = [];
  const toDelete: string[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) toDelete.push(p);
    else toWrite.push([p, now]);
    if (movedOld.has(p)) continue; // the D half of a move
    if (movedByNew.has(p)) rows.push({ key: p, line: `R ${movedByNew.get(p)} -> ${p}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, t] of toWrite) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, t);
    }
    for (const p of toDelete) rmSync(p, { force: true });
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
