# Prototype against build

A tester round on a UI task whose issue names `design/prototypes/<slice>/`: screenshot each
prototype state next to the built screen, in both themes, and give each pair a verdict.

## When

- The handoff names `design/prototypes/<slice>/` and the change is visible web UI.
- In a dry run only the prototype side is taken and every verdict cell is `-`.

## Inputs

- The handoff carries the prototype folder, the states to compare and the decisions section: the
  filled `## Design System decisions` section the developer returned
  (`docs/design-system-decisions.md`).
- No states in the handoff: take the list from the issue, else every row of the slice README
  States table.
- No decisions section: every visible difference is `finding`, and the report says the section
  was missing.

## Serving the prototype

- Command: the slice README `## Run`, else the `## Run` of `design/README.md`; run it from the
  tested checkout.
- Bind 127.0.0.1 only.
- Keep the README port unless it is 4777 or 7777 (the live board), inside the stand band
  4780-4799, or already in use. Otherwise use port 0
  (`python3 -m http.server 0 --bind 127.0.0.1 ...`) and read the port the server prints.
- Record the command, the actual port and the server PID in the plan.
- Stop the server at round end, on pass, fail or error, and check that the port no longer
  listens: `ss -ltn` shows no line for it.

## The build

- Open the build only at the `webUrl` that `pnpm stand up` printed through the board-stand
  Sidecar (`qa-stand`, `docs/qa-stand.md`); never the live board's web address, never a loopback
  server of the build.
- No stand `webUrl` -> FAIL with the reason "no stand webUrl"; a dry run needs none.
- The browser tool cannot run, or cannot reach 127.0.0.1 -> FAIL with that reason.
- Exception: a change whose visible UI is only in `packages/web/src/ds/` (the prototype
  `tokens.css` copy included) and that no screen uses yet takes the `pnpm ds:build` gallery as its
  build side. Serve `design/` on one loopback server, open the prototype at `/prototypes/<slice>/`
  and the gallery at `/kit/gallery/`, pair each state with its gallery example; the `webUrl`
  bullets above do not apply, and the report names the exception.

## Pairs

- For each state, take a prototype and a build screenshot at the same viewport and theme.
- Wide: 1440x900, dark and light.
- Narrow: 390x844, dark and light, for each state that renders a modal or a side panel. Judge by
  what the prototype shows, not by the URL: board-v1 `/?state=block-failed` opens a task without
  `open=`. The plan lists the narrow states.
- Theme: the prototype gets `theme=<theme>` in its URL; the build switches with the shell's theme
  switch.

## Plan

- Per state: its URL, how the build reached the same state (scenario, `pnpm stand seed`, fakes,
  `pnpm stand clock`) and the viewports.
- The prototype runs on a fixed clock and its own fixture: record the stand clock you set.

## Names

- Screenshots go to `screens/` in the round directory (`qa-report`), never inside the checkout.
- `screens/<state>-<theme>-proto.png` and `screens/<state>-<theme>-build.png`; a narrow pair
  adds `-390` to the state: `screens/<state>-390-<theme>-proto.png`.
- `<state>` comes from the state URL in the README States table:
  1. open the URL as written on the served root;
  2. for the name, strip a leading `/prototypes/<slice>`, and drop the `theme` parameter;
  3. turn each character outside `[A-Za-z0-9._-]` into `-`, collapse runs of `-` and trim them
     at both ends;
  4. an empty result is `index`.
- Examples: `/` -> `index`; `/?open=509` -> `open-509`; `/?open=509&followup=1` ->
  `open-509-followup-1`; the `_sample` URL `/prototypes/_sample/?state=default` ->
  `state-default`.
- `<theme>` is `dark` or `light`.

## Not data

- Compare parts, layout, tokens and states, not data. The stand data (`stand-org/board#1`) never
  matches the prototype fixture; a difference in names, numbers, keys or age text alone is not a
  finding.

## Report table

The report adds one row per pair, after the coverage line:

```
| State | Theme | Verdict |
|---|---|---|
| index | dark | match |
| open-509-390 | light | decision row 3 |
```

- `match` - no visible difference.
- `decision row <n>` - the difference is row `<n>` of the decisions section.
- `finding` - an unlisted difference, i.e. one that no row of the decisions section covers. Any
  `finding` fails the round; name the part and both screenshots.

## Example: board-v1 dry run

```bash
R="$SPUR_SESSION_ARTIFACTS_DIR/qa/issue-<N>/<sha8>/r1"; mkdir -p "$R/screens"
python3 -m http.server 4391 --bind 127.0.0.1 --directory design/prototypes/board-v1 &
PID=$!   # plan: command, port 4391, PID
# browser tool, 1440x900: /?theme=dark, /?theme=light, /?open=509&theme=dark,
#   /?open=509&theme=light; 390x844: /?open=509&theme=dark, /?open=509&theme=light
kill "$PID"; ss -ltn | grep ':4391 '   # prints nothing
ls "$R/screens"
# index-dark-proto.png  index-light-proto.png  open-509-390-dark-proto.png
# open-509-390-light-proto.png  open-509-dark-proto.png  open-509-light-proto.png
```
