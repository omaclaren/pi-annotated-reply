# pi-annotated-reply

Adds an annotated-reply workflow to [pi](https://github.com/badlogic/pi-mono).

Run `/reply` to open your latest assistant response in the extension editor, prefilled as markdown:

```md
annotated reply below:

[assistant reply]

```

You can annotate inline however you like, save and exit, and the edited content is loaded into the main pi editor for normal submission.

## Commands

| Command | Description |
|---------|-------------|
| `/reply` | Open the last assistant reply for annotation in pi's extension editor |
| `/reply-editor` | Open the last assistant reply directly in your external editor (`$VISUAL`/`$EDITOR`) |
| `/annotated-reply` | Alias for `/reply` |

## Install

```bash
pi install npm:pi-annotated-reply
```

Or from git:

```bash
pi install https://github.com/omaclaren/pi-annotated-reply
```

Or run directly:

```bash
pi -e https://github.com/omaclaren/pi-annotated-reply
```

## Notes

- `/reply` uses pi's built-in extension editor (you can still press `Ctrl+G` there to jump to external editor).
- `/reply-editor` skips that extra step and launches your external editor immediately.
- If `$VISUAL`/`$EDITOR` is not set, `/reply-editor` automatically falls back to the built-in `/reply` editor.
- If the latest assistant message is incomplete or has no text content, the command shows a warning.
