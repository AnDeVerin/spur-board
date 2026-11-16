# Kit and gallery: build, serving and tests

- `pnpm ds:build` runs `packages/web/kit/build.ts` and writes the git-ignored kit folder at the
  top of design/: the DS script (global `DS`, React and ReactDOM bundled as `DS.React` and
  `DS.ReactDOM`), the DS stylesheet (tokens, component styles and the fonts inlined as data
  URLs), the gallery folder, compiled prototype scripts and the build info file (commit, commit
  date, dirty flag, sorted runtime exports). No build time: one commit gives byte-identical files.
- Serve the gallery from a loopback static server on 127.0.0.1, outside 4777, 7777 and the stand
  band 4780-4799 (it belongs to the board-stand Sidecar): port 0, or e.g.
  `python3 -m http.server 4391 --bind 127.0.0.1 --directory design`; open `/kit/gallery/` and stop
  the server when done. It needs no network.
- `packages/web/test/kit.test.ts` builds the kit twice and checks the outputs. It runs in the
  process project; the command is in `CONTRIBUTING.md` `## Web shell`.
