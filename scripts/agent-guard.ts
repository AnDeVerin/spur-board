// Claude Code PreToolUse hook for Bash (.claude/settings.json). Refuses commands that skip the
// git hooks, force-push or merge a PR, and says why on stderr with exit 2.
//
// Not a sandbox: a quote- and heredoc-aware lexer splits the command into simple commands
// (including those inside $(...), backticks, <(...), `bash -c` and `eval`) and checks each
// argv. Forms it does not follow are listed under "Not caught" in AGENTS.md.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

type Decision = { allow: true } | { allow: false; rule: Rule; reason: string };
type Rule = 'no-verify' | 'hooks-path' | 'force-push' | 'merge' | 'nesting';

const REASONS: Record<Rule, string> = {
  'no-verify':
    'it skips the git hooks (gitleaks and formatting on commit, changed-file and direct-package checks on push) - fix what the hook reports instead',
  'hooks-path':
    'changing core.hooksPath or git config through the environment turns off the repo git hooks',
  'force-push': 'it rewrites remote history - push a new commit instead',
  merge: 'agents never merge a pull request - a human merges',
  nesting: 'substitutions nest deeper than 8 levels, so the guard cannot check the command',
};

const MAX_DEPTH = 8;
const ALLOW: Decision = { allow: true };

function deny(rule: Rule): Decision {
  return { allow: false, rule, reason: REASONS[rule] };
}

class NestingError extends Error {}

// Stands in for the output of a substitution inside a word.
const SUBSTITUTED = '$()';

// Words dropped at command position, so `then git push -f` checks `git push -f`.
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'do',
  'done',
  'while',
  'until',
  '!',
  'time',
]);

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};
const ANSI_C_ESCAPE =
  /\\(?:([abeEfnrtv\\'"?])|([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|c(.))/y;

/** One $'...' escape; a code point beyond Unicode decodes to nothing. */
function decodeEscape(match: RegExpExecArray): string {
  const [, simple, octal, hex, u4, u8, control] = match;
  if (simple !== undefined) return SIMPLE_ESCAPES[simple] ?? simple;
  if (control !== undefined) return String.fromCharCode(control.charCodeAt(0) & 0x1f);
  const code =
    octal !== undefined ? parseInt(octal, 8) & 0xff : parseInt(hex ?? u4 ?? u8 ?? '', 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * Splits shell text into simple commands (argv after quote removal), appending them to
 * `segments`. Substitutions are lexed recursively into the same list.
 */
class Lexer {
  pos = 0;
  readonly text: string;
  readonly segments: string[][];

  constructor(text: string, segments: string[][]) {
    this.text = text;
    this.segments = segments;
  }

  /** Reads commands until EOF or, in a substitution, the `)` that closes it. */
  commands(depth: number, inSubstitution: boolean): void {
    if (depth > MAX_DEPTH) throw new NestingError();
    const text = this.text;
    let words: string[] = [];
    let word = '';
    let started = false;
    let quoted = false;
    let parens = 0;
    let redirect: 'none' | 'target' | 'heredoc' | 'heredoc-tabs' = 'none';
    const heredocs: Heredoc[] = [];

    const endSegment = () => {
      if (words.length > 0) this.segments.push(words);
      words = [];
    };
    const endWord = () => {
      if (!started) return;
      if (redirect !== 'none') {
        if (redirect !== 'target') {
          heredocs.push({ delimiter: word, stripTabs: redirect === 'heredoc-tabs', quoted });
        }
        redirect = 'none';
      } else if (!quoted && (word === '{' || word === '}')) {
        endSegment();
      } else if (!(words.length === 0 && !quoted && KEYWORDS.has(word))) {
        words.push(word);
      }
      word = '';
      started = false;
      quoted = false;
    };

    while (this.pos < text.length) {
      const c = text[this.pos] ?? '';
      const next = text[this.pos + 1];
      if (c === '\\') {
        this.pos += 2;
        if (next === '\n') continue;
        word += next ?? '\\';
        started = true;
        quoted = true;
      } else if (c === "'") {
        const close = text.indexOf("'", this.pos + 1);
        const end = close === -1 ? text.length : close;
        word += text.slice(this.pos + 1, end);
        this.pos = end + 1;
        started = true;
        quoted = true;
      } else if (c === '"') {
        this.pos += 1;
        word += this.double(depth, true);
        started = true;
        quoted = true;
      } else if (c === '$' && next === "'") {
        word += this.ansiC();
        started = true;
        quoted = true;
      } else if (c === '$' && next === '(') {
        this.pos += 2;
        this.commands(depth + 1, true);
        word += SUBSTITUTED;
        started = true;
      } else if (c === '`') {
        this.pos += 1;
        this.backtick(depth);
        word += SUBSTITUTED;
        started = true;
      } else if (c === ' ' || c === '\t') {
        endWord();
        this.pos += 1;
      } else if (c === '\n') {
        endWord();
        endSegment();
        this.pos += 1;
        this.heredocBodies(heredocs.splice(0), depth);
      } else if (c === '#' && !started) {
        const newline = text.indexOf('\n', this.pos);
        this.pos = newline === -1 ? text.length : newline;
      } else if ((c === '<' || c === '>') && next === '(') {
        // Process substitution: a command of its own.
        this.pos += 2;
        this.commands(depth + 1, true);
        word += SUBSTITUTED;
        started = true;
      } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
        if (started && !quoted && /^\d+$/.test(word)) {
          word = '';
          started = false;
        } else {
          endWord();
        }
        const op = /^(<<<|<<-|<<|&>>|&>|>>|>&|>\||<&|<>|>|<)/.exec(text.slice(this.pos))?.[0] ?? c;
        this.pos += op.length;
        redirect = op === '<<' ? 'heredoc' : op === '<<-' ? 'heredoc-tabs' : 'target';
      } else if (c === ';' || c === '&' || c === '|') {
        endWord();
        endSegment();
        const op = /^(&&|\|\||;;|\|&|[;&|])/.exec(text.slice(this.pos))?.[0] ?? c;
        this.pos += op.length;
      } else if (c === '(') {
        endWord();
        endSegment();
        if (inSubstitution) parens += 1;
        this.pos += 1;
      } else if (c === ')') {
        endWord();
        endSegment();
        this.pos += 1;
        if (inSubstitution && parens === 0) return;
        parens = Math.max(0, parens - 1);
      } else {
        word += c;
        started = true;
        this.pos += 1;
      }
    }
    endWord();
    endSegment();
  }

  /**
   * Reads a double-quoted string after its opening quote (closeOnQuote) or an unquoted heredoc
   * body to EOF. Only `$(...)` and backticks are commands there.
   */
  double(depth: number, closeOnQuote: boolean): string {
    const text = this.text;
    let out = '';
    while (this.pos < text.length) {
      const c = text[this.pos] ?? '';
      const next = text[this.pos + 1] ?? '';
      if (c === '"' && closeOnQuote) {
        this.pos += 1;
        return out;
      }
      if (c === '\\' && next === '\n') {
        this.pos += 2;
      } else if (c === '\\' && (next === '\\' || next === '$' || next === '`' || next === '"')) {
        out += next;
        this.pos += 2;
      } else if (c === '$' && next === '(') {
        this.pos += 2;
        this.commands(depth + 1, true);
        out += SUBSTITUTED;
      } else if (c === '`') {
        this.pos += 1;
        this.backtick(depth);
        out += SUBSTITUTED;
      } else {
        out += c;
        this.pos += 1;
      }
    }
    return out;
  }

  /** Reads a backtick substitution after its opening backtick and lexes its body. */
  backtick(depth: number): void {
    const text = this.text;
    let body = '';
    while (this.pos < text.length) {
      const c = text[this.pos] ?? '';
      const next = text[this.pos + 1] ?? '';
      this.pos += 1;
      if (c === '`') break;
      if (c === '\\' && (next === '`' || next === '\\' || next === '$')) {
        body += next;
        this.pos += 1;
      } else {
        body += c;
      }
    }
    new Lexer(body, this.segments).commands(depth + 1, false);
  }

  /** Reads $'...' from its `$` and decodes its escapes as bash does. */
  ansiC(): string {
    const text = this.text;
    let out = '';
    this.pos += 2;
    while (this.pos < text.length) {
      const c = text[this.pos] ?? '';
      if (c === "'") {
        this.pos += 1;
        return out;
      }
      ANSI_C_ESCAPE.lastIndex = this.pos;
      const escape = c === '\\' ? ANSI_C_ESCAPE.exec(text) : null;
      if (escape !== null) {
        out += decodeEscape(escape);
        this.pos += escape[0].length;
      } else {
        out += c;
        this.pos += 1;
      }
    }
    return out;
  }

  /** Reads the heredoc bodies queued on the line just ended; unquoted ones are scanned. */
  heredocBodies(heredocs: Heredoc[], depth: number): void {
    const text = this.text;
    for (const heredoc of heredocs) {
      const lines: string[] = [];
      while (this.pos < text.length) {
        const newline = text.indexOf('\n', this.pos);
        const end = newline === -1 ? text.length : newline;
        const line = text.slice(this.pos, end);
        this.pos = end + 1;
        const bare = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
        if (bare === heredoc.delimiter) break;
        lines.push(line);
      }
      if (!heredoc.quoted) new Lexer(lines.join('\n'), this.segments).double(depth, false);
    }
  }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_WITH_VALUE = new Set(['-u', '--unset', '-C', '--chdir']);
const SUDO_SHORT_WITH_VALUE = 'ughpCDrtTU';
const DOAS_SHORT_WITH_VALUE = 'uC';
const SUDO_LONG_WITH_VALUE = new Set([
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--close-from',
  '--chdir',
  '--role',
  '--type',
  '--command-timeout',
  '--other-user',
]);
// Only the separate forms (`-o L`, `--output L`); `-oL` and `--output=L` are one word.
const STDBUF_WITH_VALUE = new Set(['-i', '-o', '-e', '--input', '--output', '--error']);
const TIMEOUT_WITH_VALUE = new Set(['-s', '--signal', '-k', '--kill-after']);

function setsGitConfigEnv(word: string): boolean {
  return word.startsWith('GIT_CONFIG');
}

/**
 * Drops leading assignments and wrapper commands. Returns a decision instead when one assigns
 * GIT_CONFIG* or when `env -S` carries the command in a string.
 */
function unwrap(argv: string[], depth: number): string[] | Decision {
  let words = argv;
  for (;;) {
    while (words[0] !== undefined && ASSIGNMENT.test(words[0])) {
      if (setsGitConfigEnv(words[0])) return deny('hooks-path');
      words = words.slice(1);
    }
    const name = basename(words[0] ?? '');
    let i = 1;
    if (name === 'env') {
      while (i < words.length) {
        const w = words[i] ?? '';
        const split = /^(-S|--split-string=?)(.*)$/.exec(w);
        if (split !== null) {
          // env -S splits its string into the command and its first arguments.
          const separate = split[2] === '' && !w.endsWith('=');
          const value = separate ? (words[i + 1] ?? '') : (split[2] ?? '');
          return decideAt([value, ...words.slice(i + (separate ? 2 : 1))].join(' '), depth + 1);
        }
        if (ENV_WITH_VALUE.has(w)) i += 2;
        else if (w.startsWith('-')) i += 1;
        else if (ASSIGNMENT.test(w)) {
          if (setsGitConfigEnv(w)) return deny('hooks-path');
          i += 1;
        } else break;
      }
    } else if (name === 'command' || name === 'nohup' || name === 'exec') {
      while ((words[i] ?? '').startsWith('-')) i += words[i] === '-a' ? 2 : 1;
    } else if (name === 'nice') {
      while ((words[i] ?? '').startsWith('-')) i += words[i] === '-n' ? 2 : 1;
    } else if (name === 'sudo' || name === 'doas') {
      const shortWithValue = name === 'sudo' ? SUDO_SHORT_WITH_VALUE : DOAS_SHORT_WITH_VALUE;
      let shell = false;
      while (i < words.length) {
        const w = words[i] ?? '';
        if (w === '--') {
          i += 1;
          break;
        }
        if (w.startsWith('--')) {
          if (w === '--shell' || w === '--login') shell = true;
          i += SUDO_LONG_WITH_VALUE.has(w) ? 2 : 1;
          continue;
        }
        if (!/^-[A-Za-z]/.test(w)) break;
        let consumed = 1;
        for (let index = 1; index < w.length; index += 1) {
          const letter = w.charAt(index);
          if (shortWithValue.includes(letter)) {
            if (index === w.length - 1) consumed = 2;
            break;
          }
          if (name === 'sudo' && (letter === 's' || letter === 'i')) shell = true;
        }
        i += consumed;
      }
      // sudo -s/-i runs the rest through a shell, as `bash -c` does.
      if (shell && i < words.length) return decideAt(words.slice(i).join(' '), depth + 1);
    } else if (name === 'stdbuf') {
      while ((words[i] ?? '').startsWith('-')) i += STDBUF_WITH_VALUE.has(words[i] ?? '') ? 2 : 1;
    } else if (name === 'setsid') {
      while ((words[i] ?? '').startsWith('-')) i += 1;
    } else if (name === 'timeout') {
      while ((words[i] ?? '').startsWith('-')) i += TIMEOUT_WITH_VALUE.has(words[i] ?? '') ? 2 : 1;
      i += 1;
    } else {
      return words;
    }
    words = words.slice(i);
  }
}

/** True when `token` (without any `=value`) abbreviates `option` to at least `min` chars. */
function abbreviates(token: string, option: string, min: number): boolean {
  const name = token.split('=')[0] ?? '';
  return name.length >= min && option.startsWith(name);
}

const GIT_GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);
const COMMIT_SHORT_WITH_VALUE = 'mFcCtuS';
const COMMIT_SHORT_SEPARATE_VALUE = 'mFcCt';
const COMMIT_LONG_WITH_VALUE = [
  '--message',
  '--file',
  '--author',
  '--date',
  '--template',
  '--reuse-message',
  '--reedit-message',
  '--fixup',
  '--squash',
  '--cleanup',
  '--trailer',
  '--pathspec-from-file',
];

function isHooksPath(key: string): boolean {
  return key.toLowerCase().startsWith('core.hookspath');
}

function decideGit(args: string[]): Decision {
  let i = 0;
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const token = args[i] ?? '';
    if (GIT_GLOBAL_WITH_VALUE.has(token)) {
      if ((token === '-c' || token === '--config-env') && isHooksPath(args[i + 1] ?? '')) {
        return deny('hooks-path');
      }
      i += 2;
    } else {
      if (token.startsWith('--config-env=') && isHooksPath(token.slice('--config-env='.length))) {
        return deny('hooks-path');
      }
      i += 1;
    }
  }
  const sub = args[i] ?? '';
  const rest = args.slice(i + 1);

  // Values of options that take one are skipped. After `--` only positionals follow; for push
  // a leading `+` there still forces the update.
  let skip = false;
  let positionalOnly = false;
  for (const token of rest) {
    if (skip) {
      skip = false;
      continue;
    }
    if (positionalOnly) {
      if (sub === 'push' && token.startsWith('+')) return deny('force-push');
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
    } else if (token.startsWith('--')) {
      if (abbreviates(token, '--no-verify', 6)) return deny('no-verify');
      skip =
        sub === 'commit' &&
        !token.includes('=') &&
        COMMIT_LONG_WITH_VALUE.some((option) => abbreviates(token, option, 4));
      if (
        sub === 'push' &&
        ['--force', '--force-with-lease', '--force-if-includes', '--mirror'].some((option) =>
          abbreviates(token, option, 4),
        )
      ) {
        return deny('force-push');
      }
    } else if (/^-[A-Za-z]/.test(token)) {
      const letters = token.slice(1);
      if (sub === 'commit') {
        for (let index = 0; index < letters.length; index += 1) {
          const letter = letters.charAt(index);
          if (letter === 'n') return deny('no-verify');
          if (COMMIT_SHORT_WITH_VALUE.includes(letter)) {
            skip = index === letters.length - 1 && COMMIT_SHORT_SEPARATE_VALUE.includes(letter);
            break;
          }
        }
      } else if (sub === 'push') {
        for (let index = 0; index < letters.length; index += 1) {
          const letter = letters.charAt(index);
          if (letter === 'f') return deny('force-push');
          if (letter === 'o') {
            skip = index === letters.length - 1;
            break;
          }
        }
      }
    } else if (sub === 'push' && token.startsWith('+')) {
      return deny('force-push');
    }
  }
  if (sub === 'config' && writesHooksPath(rest)) return deny('hooks-path');
  return ALLOW;
}

const CONFIG_WITH_VALUE = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '--default',
  '--comment',
  '--value',
]);
const CONFIG_WRITES = ['--unset', '--unset-all', '--add', '--replace-all'];
const CONFIG_SECTION_OPS = ['remove-section', 'rename-section'];

function writesHooksPath(args: string[]): boolean {
  const positional: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? '';
    if (CONFIG_WITH_VALUE.has(token)) i += 1;
    else if (token.startsWith('-')) flags.push(token);
    else positional.push(token);
  }
  const [first = '', second = ''] = positional;
  // An editor can change any key, so it can change core.hooksPath.
  if (first === 'edit' || flags.includes('--edit') || flags.includes('-e')) return true;
  const sectionOp = CONFIG_SECTION_OPS.includes(first);
  if (sectionOp || CONFIG_SECTION_OPS.some((op) => flags.includes(`--${op}`))) {
    const section = (sectionOp ? second : first).toLowerCase();
    return section === 'core' || section.startsWith('core.');
  }
  if (first === 'set' || first === 'unset') return second.toLowerCase() === 'core.hookspath';
  if (first.toLowerCase() !== 'core.hookspath') return false;
  return flags.some((flag) => CONFIG_WRITES.includes(flag)) || positional.length >= 2;
}

const MERGE_PATH = /(^|\/)pulls\/\d+\/merge(\/|\?|$)/;

const GH_WITH_VALUE = new Set(['-R', '--repo']);

function decideGh(args: string[]): Decision {
  // gh takes -R/--repo before and after `pr`, so the subcommand is the second positional.
  const positional: string[] = [];
  for (let i = 0; i < args.length && positional.length < 2; i += 1) {
    const token = args[i] ?? '';
    if (GH_WITH_VALUE.has(token)) i += 1;
    else if (!token.startsWith('-')) positional.push(token);
  }
  if (positional[0] === 'pr' && positional[1] === 'merge') return deny('merge');
  if (
    positional[0] === 'api' &&
    args.some(
      (token) =>
        MERGE_PATH.test(token) ||
        token.includes('mergePullRequest') ||
        token.includes('enablePullRequestAutoMerge'),
    )
  ) {
    return deny('merge');
  }
  return ALLOW;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
// Commands that only read or print their arguments, so `echo git push -f` is text.
const TEXT_ONLY = new Set([
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'sort',
  'uniq',
  'man',
  'which',
  'type',
  'whatis',
  'apropos',
]);
const DECLARES = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

function decideCommand(argv: string[], depth: number): Decision {
  const words = unwrap(argv, depth);
  if (!Array.isArray(words)) return words;
  const [first, ...args] = words;
  if (first === undefined) return ALLOW;
  const name = basename(first);
  if (name === 'git') return decideGit(args);
  if (name === 'gh') return decideGh(args);
  if (DECLARES.has(name)) {
    return args.some((arg) => !arg.startsWith('-') && setsGitConfigEnv(arg))
      ? deny('hooks-path')
      : ALLOW;
  }
  if (name === 'eval') return decideAt(args.join(' '), depth + 1);
  if (SHELLS.has(name)) {
    let command = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] ?? '';
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) command = true;
      else if (arg === '-o' || arg === '+o') i += 1;
      else if (arg.startsWith('-') || arg.startsWith('+')) continue;
      else return command ? decideAt(arg, depth + 1) : ALLOW;
    }
    return ALLOW;
  }
  if (TEXT_ONLY.has(name)) return ALLOW;
  // Any other command may run its arguments (xargs, flock, ionice, ...). Check from every git or
  // gh word, since the first one may be an option value (`xargs -I git gh pr merge 1`). Each
  // slice starts with git or gh, so it is decided directly and never falls back again.
  for (const [index, arg] of args.entries()) {
    const base = basename(arg);
    if (base !== 'git' && base !== 'gh') continue;
    const decision = decideCommand(args.slice(index), depth);
    if (!decision.allow) return decision;
  }
  return ALLOW;
}

function decideAt(command: string, depth: number): Decision {
  const segments: string[][] = [];
  try {
    new Lexer(command, segments).commands(depth, false);
  } catch (error) {
    if (error instanceof NestingError) return deny('nesting');
    throw error;
  }
  for (const argv of segments) {
    const decision = decideCommand(argv, depth);
    if (!decision.allow) return decision;
  }
  return ALLOW;
}

/** Whether the guard lets a Bash tool call run `command`. */
export function decide(command: string): Decision {
  return decideAt(command, 0);
}

function main(): number {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    process.stderr.write(`agent-guard: invalid hook input: ${String(error)}\n`);
    return 2;
  }
  const payload = input as { tool_name?: unknown; tool_input?: { command?: unknown } } | null;
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') {
    // The matcher sends only Bash calls; a Bash payload without a command must not pass.
    const tool = payload?.tool_name;
    if (tool !== undefined && tool !== 'Bash') return 0;
    process.stderr.write('agent-guard: blocked input: no tool_input.command in Bash hook input\n');
    return 2;
  }
  const decision = decide(command);
  if (decision.allow) return 0;
  process.stderr.write(`agent-guard: blocked ${decision.rule}: ${decision.reason}\n`);
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    // A guard that crashes blocks the call rather than letting it through.
    process.stderr.write(`agent-guard: failed, blocking: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
