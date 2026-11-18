# Round layout

Run the commands from the tested checkout (`qa-stand`) with `R` set to the round directory;
`<home>` is the `home` from `pnpm stand up`.

```
qa/<task>/<sha8>/r<N>/
  plan.md            written before the first scenario
  report.md          written last
  violations.json    pnpm stand violations > "$R/violations.json"
  stand.json         pnpm stand status --json > "$R/stand.json"
  events.jsonl       pnpm stand board task history '<key>' --json >> "$R/events.jsonl"
                     (one line per stand task the round touched)
  fakes-outbox.json  pnpm stand fake slack outbox > "$R/fakes-outbox.json"
  fakes-spur.json    pnpm stand fake spur inspect > "$R/fakes-spur.json"
  daemon.log         pnpm stand logs > "$R/daemon.log"
  <name>.png         browser-tool screenshots of the stand webUrl, never the live board
  screens/           prototype and build pairs (references/prototype-vs-build.md)
  board.sqlite       node --input-type=module -e 'import { copyDatabase } from
                       "./packages/core/src/store/copy.ts";
                       copyDatabase(process.argv[1], process.argv[2]);' \
                       "<home>/board.sqlite" "$R/board.sqlite"
```

- Snapshot the database after the last action with `copyDatabase`
  (`packages/core/src/store/copy.ts`): it writes one consistent file with `VACUUM INTO` while the
  daemon keeps writing. Never `cp` the live `board.sqlite` and its `-wal`; a checkpoint between
  the copies loses rows or breaks the file. The host may have no sqlite CLI; read it with
  `node:sqlite`.
