# Notes

Notes on a transparent board that drops over every monitor at once, like the
scratchpad. They are drawn like the rest of Omarchy: the menu's background,
border and font, with Hyprland's corner rounding.

- **Plugin ID:** `io.github.kimm-stensborg.notes`
- **Kind:** service + overlay
- **License:** MIT
- **Requires:** Omarchy 4 (Quattro) with `omarchy-shell`

## What it does

- **SUPER + N** shows the board on all monitors. Esc hides it, and so does
  the keyboard going anywhere else -- a window behind it, the menu -- since a
  board that cannot hear you is no use standing there. The note you
  were last on is in hand as it opens -- the top of the pile on the screen you
  summoned it from -- so the arrows have somewhere to start and you can see
  where you are. There is always one in hand: delete the note you are on and
  the nearest takes over.
- **New notes:** "+ New note", `N`, or a double-click on empty space. A new
  note never lands exactly on one already there -- it steps down and to the
  right until it has a place of its own, so it can't hide inside another. A
  board with nothing on it -- the first time you open Notes, or the moment
  you delete the last note -- puts one out for you, open in the middle and
  ready to type in, rather than showing you an empty screen.
- **Writing:** click a note to write in it, or press `Enter` on it. It
  lifts out to the middle of its screen and is shown at twice the size,
  so what you are writing is the thing in front of you rather than one card
  among many; `Esc` -- or `Alt+Enter`, the other half of the `Enter` that
  opened it -- puts it back exactly where it was. A note too big to be
  blown up that far is enlarged as far as it fits. The note you're on wears
  the active window border and comes to the front of the pile, so a note
  under another is never read through it.
- **Moving:** notes have no title bar -- drag the note itself, anywhere on
  it, including from one monitor to another. `SUPER` + drag works too, as
  Hyprland moves windows, where the compositor lets it through.
- **Tiling:** `Alt+T` lines every note up in a grid on its own screen,
  filled from the top left, and `Alt+T` again lets them flow back to where
  they were. The cells are the screen's rather than the notes': three rows
  stand in its height and the columns share out its width, so the grid
  fits whatever screen it is on and meets both edges. Past three rows the
  board scrolls -- the wheel over the glass between the notes, and arrowing
  onto a note below the fold brings it up. Tiling moves no note on disk, so
  nothing is lost, but the grid itself is remembered until you press `Alt+T`
  again -- hiding the board, or restarting the shell, leaves it be. Moving a
  note by hand also ends the tiled view.
- **Reminders:** `Alt+R` sets a time on the note you're on -- a preset, or
  type `45m`, `2h`, `1h30`, `3d`, `9:00`, `3pm` or `tomorrow 8:30`. The note comes
  out to the middle of its screen to be asked, as it does for writing, and
  goes back once you have answered. When it comes
  up you get a notification, and clicking it opens the board with that note
  shown the same way -- out in the middle, big enough to read across the
  room -- so the reminder lands on the note itself and not on a board you
  then have to search. The note shows its reminder in the corner until then. Reminders
  ring whether the board is up or not, and one that fell due while the shell
  was down rings when it comes back. They are one-shot: ringing clears them,
  and so does `Alt+R` then "Clear".
- **Deleting:** `Del` (or a right-click) deletes the note you're on, after a
  yes or no; from inside a note -- writing in it, or shown on its own -- it is
  `Alt+Del`, since `Del` there belongs to the text. The note comes out to the
  middle of its screen to be asked and goes back if you keep it, so the
  question is put on the note itself at a size you can read rather than on a
  card an inch across. The note nearest the one that went takes over, so the
  board is never left pointing at nothing, and `Ctrl+Z` brings it back --
  the last twenty deleted notes, newest first, one press each, for as long
  as the shell is running. The note comes back in hand.
- **Theme:** everything follows `omarchy theme set`.
- **Unplugged monitors:** notes whose monitor is gone borrow the screen you
  are looking at and show `↩ <monitor>`. They go back home as soon as it is
  plugged in again, and they only get a new home if you drag them there.
  Monitors are recognised by model and serial, so two identical screens, or
  a dock that renumbers DP-5 / DP-7, can't mix up your notes.

## Formatting

Notes are written in a small markdown dialect. A note shows it formatted and
puts the plain text back the moment you click into it.

| Write | Key | Shows as |
|---|---|---|
| `**bold**` | `Ctrl + B` | **bold** |
| `*italic*` | `Ctrl + I` | *italic* |
| `__underline__` | `Ctrl + U` | underlined |
| `~~strike~~` | `Ctrl + D` | struck through |
| `` `code` `` | `Ctrl + E` | tinted in your accent colour |
| `# Heading` | `Ctrl + 1` | large bold heading (`##` / `###`, `Ctrl + 2` / `3`) |
| `- item` | `Ctrl + L` | bullet in your accent colour |
| `1. item` | `Ctrl + N` | numbered line, the number as you wrote it (`1)` works too) |
| `[ ] task` | `Ctrl + K` | checkbox you can click to tick |
| `https://…` or `www.…` | | a link in your accent colour; click it to open it in your browser |

Select some text and the toolbar turns to these, since holding a selection is
asking what can be done to it. Every key toggles, so pressing it again takes
the mark off. With nothing
selected, `Ctrl + B` and friends take the word the cursor is in. Ticked
lines are dimmed and struck through, and `- [ ] task` works too.

`Ctrl + N` counts on from the line above, so pressing it down a list numbers
it 1, 2, 3. `Enter` in a list starts the next item -- the same bullet, the
next number, an empty box -- and `Enter` on an item with nothing in it ends
the list. `Shift + Enter` is a plain new line.

Only web addresses become links, so nothing written in a note can open a file
or run a command. Clicking anywhere else on the line still picks up the note
or opens it for writing.

## Install

```bash
omarchy plugin add https://github.com/kimm-stensborg/omarchy-notes.git
omarchy plugin enable io.github.kimm-stensborg.notes
```

Plugins land disabled so you can read the code first. There is no bar
widget: the board is summoned with a key. Add it to
`~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + N", "Notes", "omarchy-shell shell toggle io.github.kimm-stensborg.notes '{}'")
```

## Remove

```bash
omarchy plugin remove io.github.kimm-stensborg.notes
```

Your notes stay in `~/Documents/notes.json`.

## Keys

| Key | Action |
|---|---|
| `SUPER + N` | Show / hide the board |
| `N` | New note on the current screen |
| double-click | New note at the pointer |
| `Alt + ↑ ↓ ← →` | Go to the nearest note that way, across monitors; wraps round at the ends |
| `↑` `↓` | Scroll the note you are on, a line at a time |
| `PageUp` `PageDown` | Jump to the top or the foot of the note |
| `Enter` | Write in the note you are on, shown big in the middle |
| `Alt + Enter` | Put a note shown on its own back where it lives |
| `Alt + R` | Set or clear a reminder on the note you are on |
| `Alt + T` | Line every note up in a grid on its own screen, and back again |
| `Del` | Delete the note you are on, after a yes or no |
| `Alt + Del` | The same from inside a note, where `Del` is the text's |
| drag | Move a note, anywhere on it, across monitors |
| right-click | Delete that note, after a yes or no |
| `Esc` | Put a note that is shown on its own back where it lives, then hide the board |
| `Ctrl + Z` | Bring back the last deleted note; again for the one before it |

The toolbar at the top of the screen you are working on says which of these
are live where you stand, so the keys are in front of you rather than in this
table: a note you are writing in offers different ones than an empty board,
and a question offers only its own two answers.

The note you are on wears the active window border and stands a little proud
of the board, with a shadow under it, so you can see where the arrows have
taken you across a screenful of cards. `Alt + arrow` works while writing too: it leaves the
note and moves to the next one.

## Files

| File | What |
|---|---|
| `~/Documents/notes.json` | Your notes, their reminders, and whether the board is tiled. Plain JSON, written atomically, safe to edit by hand; the board picks up the change. |
| `Model.js` | File format, monitor identity, placement, tiling, reminder times and markdown logic |
| `Store.qml` | Service: loads and saves the file, watches the clock for reminders, and knows which monitor is which |
| `Overlay.qml` / `NoteWindow.qml` / `Note.qml` | The board: one window per screen, and the notes on it |

A reminder is a time on the note itself, so it is written down with the
note. `Store.qml` is kept loaded whether the board is showing or not, which
is what lets a reminder arrive while you are working in something else; the
notification carries its click action as argv rather than a shell line, so a
note's own text can never become a command.

Each note records its monitor and its position as a fraction of that screen,
so notes keep their place when the resolution or scale changes. If the file
can't be read, it is kept as `notes.json.corrupt-<time>` and never
overwritten, and the board holds on to the notes it already had -- a typo in
a hand edit never empties it. Your next change on the board writes those
notes back; fixing the file by hand works too. A hand edit that lands while
the board still has a change of its own to write is merged with it rather
than lost: the notes you touched on the board are the board's, the rest are
the file's.

## Tests

```bash
node test.js
```

The shell keeps Notes loaded, so code changes take effect after
`omarchy restart shell`.
