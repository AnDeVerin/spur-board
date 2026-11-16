# Sample prototype

The smallest prototype that follows [design/README.md](../../README.md): it mounts `DS.ThemeSwitch`
and `DS.Chip` from the kit, applies the `DS.quiet` class to each row, and builds one missing part by
hand, the summary strip, marked proposed. Copy this folder to start a new slice.

## Kit

Built on the kit of commit `a7e2237` (`BUILD.json`: `"dirty": false`). Exports used: `Chip`,
`React`, `ReactDOM`, `ThemeSwitch`, `quiet`.

## Run

```bash
pnpm ds:build
python3 -m http.server 4391 --bind 127.0.0.1 --directory design
```

Open `http://127.0.0.1:4391/prototypes/_sample/`. Stop the server when done.

## States

Add `&theme=light` or `&theme=dark` to any state; the default, and any other value, is dark. The
theme switch in the bottom bar changes the theme in place.

| State                                                         | URL                                  |
| ------------------------------------------------------------- | ------------------------------------ |
| Default: four rows, one per chip tone, and the proposed strip | `/prototypes/_sample/?state=default` |
| Empty: the labelled message "Empty state: no items"           | `/prototypes/_sample/?state=empty`   |

In the empty state the proposed strip and the theme switch stay visible. An unknown `state` opens
the default.

## Proposed parts

| Part          | Class              | Why proposed                                    |
| ------------- | ------------------ | ----------------------------------------------- |
| Summary strip | `proposed-summary` | The design system has no summary component yet. |

`--proposed-outline-dash` in `proto.css` is the one value with no token.

## Fixture

`fixture.json` holds invented items: no real people, hosts or tasks.
