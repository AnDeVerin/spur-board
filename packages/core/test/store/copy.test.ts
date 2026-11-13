import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { copyDatabase } from '../../src/index.ts';
import { openDatabase } from '../../src/store/store.ts';

const open: Database.Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'board-copy-'));
}

/** A WAL database at `file` with table `item` holding `rows`, kept open until the test ends. */
function walDatabase(file: string, rows: string[], userVersion = 7): Database.Database {
  const db = openDatabase(file);
  open.push(db);
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO item (name) VALUES (?)');
  for (const row of rows) insert.run(row);
  db.pragma(`user_version = ${String(userVersion)}`);
  return db;
}

function read(file: string): { rows: string[]; schema: string[]; userVersion: number } {
  const db = new Database(file, { readonly: true });
  try {
    return {
      rows: db.prepare('SELECT name FROM item ORDER BY id').pluck().all() as string[],
      schema: db.prepare('SELECT sql FROM sqlite_schema ORDER BY name').pluck().all() as string[],
      userVersion: db.pragma('user_version', { simple: true }) as number,
    };
  } finally {
    db.close();
  }
}

function partials(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.partial'));
}

describe('copyDatabase', () => {
  it('C1: copies rows, schema and user_version of a WAL source into one file', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['a', 'b']);
    const target = join(dir, 'copy.sqlite');

    copyDatabase(source, target);

    expect(read(target)).toEqual({
      rows: ['a', 'b'],
      schema: ['CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'],
      userVersion: 7,
    });
    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(partials(dir)).toEqual([]);
  });

  it('C1: copies from an open connection and leaves it open', () => {
    const dir = tempDir();
    const db = walDatabase(join(dir, 'board.sqlite'), ['a']);
    const target = join(dir, 'copy.sqlite');

    copyDatabase(db, target);

    expect(read(target).rows).toEqual(['a']);
    expect(db.open).toBe(true);
    expect(partials(dir)).toEqual([]);
  });

  it('C2: includes rows that are still only in a leftover -wal', () => {
    const live = tempDir();
    walDatabase(join(live, 'board.sqlite'), ['in-wal']);
    const mainOnly = join(tempDir(), 'main-only.sqlite');
    cpSync(join(live, 'board.sqlite'), mainOnly);
    const withoutWal = new Database(mainOnly, { readonly: true });
    expect(withoutWal.prepare('SELECT count(*) FROM sqlite_schema').pluck().get()).toBe(0);
    withoutWal.close();
    const crashed = tempDir();
    cpSync(join(live, 'board.sqlite'), join(crashed, 'board.sqlite'));
    cpSync(join(live, 'board.sqlite-wal'), join(crashed, 'board.sqlite-wal'));
    const target = join(tempDir(), 'copy.sqlite');

    copyDatabase(join(crashed, 'board.sqlite'), target);

    expect(read(target)).toMatchObject({ rows: ['in-wal'], userVersion: 7 });
  });

  it("C3: drops the target's stale -wal and -shm before the rename", () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['source']);
    const other = join(dir, 'other.sqlite');
    walDatabase(other, ['stale-1', 'stale-2']);
    const target = join(dir, 'copy.sqlite');
    cpSync(other, target);
    cpSync(`${other}-wal`, `${target}-wal`);
    cpSync(`${other}-shm`, `${target}-shm`);

    copyDatabase(source, target);

    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
    expect(read(target).rows).toEqual(['source']);
  });

  it('C3: leaves no aside copy of the replaced target after a copy', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['source']);
    const other = join(dir, 'other.sqlite');
    walDatabase(other, ['old']);
    const target = join(dir, 'copy.sqlite');
    cpSync(other, target);
    cpSync(`${other}-wal`, `${target}-wal`);

    copyDatabase(source, target);

    expect(readdirSync(dir).filter((name) => name.includes('.replaced-'))).toEqual([]);
    expect(read(target).rows).toEqual(['source']);
  });

  it('C3: replaces a damaged target that has no -wal, with no checkpoint', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['source']);
    const target = join(dir, 'copy.sqlite');
    writeFileSync(target, 'not a database, and no WAL to preserve');
    const steps: string[] = [];

    copyDatabase(source, target, (step) => steps.push(step));

    expect(read(target).rows).toEqual(['source']);
    expect(steps).toEqual(['partial', 'link', 'journal', 'rename']);
    expect(readdirSync(dir).filter((name) => name.includes('.replaced-'))).toEqual([]);
    expect(partials(dir)).toEqual([]);
  });

  it('C3: replaces a damaged target that has an empty -wal, with no checkpoint', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['source']);
    const target = join(dir, 'copy.sqlite');
    writeFileSync(target, 'not a database, and an empty WAL to preserve nothing');
    writeFileSync(`${target}-wal`, '');
    const steps: string[] = [];

    copyDatabase(source, target, (step) => steps.push(step));

    expect(read(target).rows).toEqual(['source']);
    expect(steps).toEqual(['partial', 'link', 'journal', 'rename']);
    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes('.replaced-'))).toEqual([]);
    expect(partials(dir)).toEqual([]);
  });

  it('C3: a failed link leaves the target with its committed rows and no leftovers', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['source']);
    const other = join(dir, 'other.sqlite');
    walDatabase(other, ['committed-in-wal']);
    // 220 bytes: `.partial` (228) and `-wal` still fit NAME_MAX 255, `<name>.replaced-<uuid>`
    // (266) does not, so the hard link of the checkpointed target fails.
    const target = join(dir, 't'.repeat(220));
    cpSync(other, target);
    cpSync(`${other}-wal`, `${target}-wal`);

    expect(() => {
      copyDatabase(source, target);
    }).toThrow(/ENAMETOOLONG/);

    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.includes('.replaced-'))).toEqual([]);
    expect(partials(dir)).toEqual([]);
    expect(read(target).rows).toEqual(['committed-in-wal']);
  });

  it('C7: a kill after any step leaves a complete database at the target path', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['new']);
    const other = join(dir, 'other.sqlite');
    walDatabase(other, ['committed-in-wal']);
    const target = join(dir, 'copy.sqlite');
    cpSync(other, target);
    cpSync(`${other}-wal`, `${target}-wal`);
    const seen: { step: string; rows: string[] | 'missing' }[] = [];

    copyDatabase(source, target, (step) => {
      // What a kill now leaves: the files at the target path, opened as SQLite would.
      const crashed = join(tempDir(), 'copy.sqlite');
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${target}${suffix}`)) cpSync(`${target}${suffix}`, `${crashed}${suffix}`);
      }
      seen.push({ step, rows: existsSync(crashed) ? read(crashed).rows : 'missing' });
    });

    for (const { step, rows } of seen) {
      expect(rows, step).toEqual(step === 'rename' ? ['new'] : ['committed-in-wal']);
    }
    expect(seen.map(({ step }) => step)).toEqual([
      'partial',
      'checkpoint',
      'link',
      'journal',
      'rename',
    ]);
    expect(readdirSync(dir).filter((name) => name.includes('.replaced-'))).toEqual([]);
  });

  it.each(['partial', 'checkpoint', 'link', 'journal'])(
    'C7: a failure after step %s leaves the target, rows included, and no leftovers',
    (failAt) => {
      const dir = tempDir();
      const source = join(dir, 'board.sqlite');
      walDatabase(source, ['new']);
      const other = join(dir, 'other.sqlite');
      walDatabase(other, ['committed-in-wal']);
      const target = join(dir, 'copy.sqlite');
      cpSync(other, target);
      cpSync(`${other}-wal`, `${target}-wal`);

      expect(() => {
        copyDatabase(source, target, (step) => {
          if (step === failAt) throw new Error(`injected at ${step}`);
        });
      }).toThrow(`injected at ${failAt}`);

      expect(read(target).rows).toEqual(['committed-in-wal']);
      expect(readdirSync(dir).filter((name) => name.includes('.replaced-'))).toEqual([]);
      expect(partials(dir)).toEqual([]);
    },
  );

  it('C4: refuses a missing source and leaves the target as it was', () => {
    const dir = tempDir();
    const target = join(dir, 'copy.sqlite');
    writeFileSync(target, 'existing target');

    expect(() => {
      copyDatabase(join(dir, 'missing.sqlite'), target);
    }).toThrow(/Cannot open database .*missing\.sqlite/);
    expect(readFileSync(target, 'utf8')).toBe('existing target');
    expect(existsSync(join(dir, 'missing.sqlite'))).toBe(false);

    const absent = join(dir, 'absent.sqlite');
    expect(() => {
      copyDatabase(join(dir, 'missing.sqlite'), absent);
    }).toThrow();
    expect(existsSync(absent)).toBe(false);
    expect(partials(dir)).toEqual([]);
  });

  it('C5: throws for a missing or unusable target directory and leaves no .partial', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['a']);
    const notADirectory = join(dir, 'file');
    writeFileSync(notADirectory, '');

    expect(() => {
      copyDatabase(source, join(dir, 'missing', 'copy.sqlite'));
    }).toThrow();
    expect(() => {
      copyDatabase(source, join(notADirectory, 'copy.sqlite'));
    }).toThrow();
    expect(partials(dir)).toEqual([]);
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });

  it('C6: refuses to copy a database onto itself', () => {
    const dir = tempDir();
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['a']);

    expect(() => {
      copyDatabase(source, join(dir, 'sub', '..', 'board.sqlite'));
    }).toThrow(/onto itself/);
    expect(read(source).rows).toEqual(['a']);
    expect(partials(dir)).toEqual([]);
  });

  it('C8: writes the copy owner-only under umask 022 over a 0644 target', () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    const source = join(dir, 'board.sqlite');
    walDatabase(source, ['a']);
    const target = join(dir, 'copy.sqlite');
    copyDatabase(source, target);
    chmodSync(target, 0o644);

    const previous = process.umask(0o022);
    try {
      copyDatabase(source, target);
    } finally {
      process.umask(previous);
    }

    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(read(target).rows).toEqual(['a']);
    expect(partials(dir)).toEqual([]);
  });
});
