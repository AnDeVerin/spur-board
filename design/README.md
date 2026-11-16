# Design

Prototypes of spur-board screens. A prototype is the spec for a screen: it mounts the same design
system components the app uses, so any difference between a prototype and the app is visible and
deliberate. Nothing in `design/` is part of the app build or the npm tarball (`scripts/package.ts`
rejects every path under it).

## Layout

```text
design/
  README.md              this file
  kit/                   output of pnpm ds:build, git-ignored
  prototypes/<slice>/
    index.html           loads the kit, proto.css and the compiled app.jsx
    app.jsx              the screen and its states, mounting DS.<Name>
    proto.css            styles of the hand-built parts, tokens only
    fixture.json         invented sample data
    README.md            the kit commit, the states and the proposed parts
```

`prototypes/_sample/` is the smallest working slice; copy it to start one. `prototypes/board-v1/`
predates the kit: it is plain JavaScript with every part hand-built.

## Run

```bash
pnpm ds:build
python3 -m http.server 4781 --bind 127.0.0.1 --directory design
```

Then open `http://127.0.0.1:4781/prototypes/<slice>/?state=<name>&theme=light` (or `dark`) and
`http://127.0.0.1:4781/kit/gallery/` for the gallery. Any static server works; serve `design/`, not
the slice, so the slice can reach `../../kit/`. No network and no daemon are needed.

`pnpm ds:build` writes the kit into `design/kit/`:

- `ds.js` - one classic script that defines the global `DS`: every export of
  `packages/web/src/ds/index.ts`, plus `DS.React` and `DS.ReactDOM` (`react-dom/client`);
- `ds.css` - tokens, component styles and the JetBrains Mono fonts inlined as `data:` URLs, so
  it is large (about 380 KB) and needs no font files;
- `gallery/` - every example of every component and the token table, with a theme switch;
- `prototypes/<slice>/app.js` - each `app.jsx` compiled to calls of `DS.React.createElement`;
- `BUILD.json` - `commit`, `commitDate`, `dirty` and `exports`, the sorted runtime exports of
  `DS` (types are erased). No build time, so two builds of one commit are byte-identical.

The build empties its output folder first. `node packages/web/kit/build.ts --out <dir>` writes
elsewhere, and refuses (exit 1, nothing deleted) a folder that is or contains the repo root,
`design/`, `design/prototypes/`, `packages/`, `packages/web/` or `packages/web/src/`, and any
non-empty folder without a `BUILD.json` from an earlier kit build.

## React

React is bundled inside `ds.js`. The page and the kit share that one copy through `DS.React` and
`DS.ReactDOM`, so hooks inside `DS` components work. A prototype loads no React of its own and
uses no `import`: `app.jsx` is a plain script compiled with the `DS.React` pragma.

## Rules

- Mount design system components as `DS.<Name>`, e.g. `<DS.Chip tone="warn">`. Class exports
  such as `DS.quiet` go in `className`.
- A part the design system lacks is built by hand and marked proposed: a `proposed-<name>` class,
  a `data-proposed` attribute and a visible "proposed" label. The prototype README lists each
  proposed part.
- `proto.css` uses tokens from `packages/web/src/ds/tokens.css` only. A value with no token is
  declared at the top as `--proposed-<name>`; raw colors elsewhere fail `scripts/web.test.ts`.
- Each state opens by URL: `?state=<name>&theme=light|dark`, dark by default.
- The prototype README records the kit commit from `BUILD.json` and lists every state with its
  URL.
- Fixtures hold invented sample data: no real people, hosts, tasks or messages.
- Never import from `design/` in app code, and never ship it.
