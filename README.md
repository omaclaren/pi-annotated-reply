# pi-annotated-reply

Adds an annotated-reply workflow to [pi](https://github.com/badlogic/pi-mono). Construct prompts by annotating either the last model response or a file. Annotated text is loaded into pi’s main editor, ready to submit as your next prompt. Source files are never modified.

## Commands

| Command | Description |
|---------|-------------|
| `/reply` | Annotate the last model response |
| `/reply <path>` | Annotate a file (original file is not changed) |
| `/reply --raw` | Load raw content into editor without annotation header |
| `/reply-editor` | Same as `/reply`, but opens in your external editor (`$VISUAL`/`$EDITOR`) |
| `/reply-editor <path>` | Same as `/reply <path>`, but opens in your external editor |
| `/annotated-reply` | Alias for `/reply` |
| `/annotated-reply <path>` | Alias for `/reply <path>` |
| `/annotated-reply-editor` | Alias for `/reply-editor` |
| `/annotated-reply-editor <path>` | Alias for `/reply-editor <path>` |

All commands accept `--raw` to skip the annotation header and load bare content into the editor.

## Prefill format

The extension prefills content like:

```md
annotated reply below:
original source: last model response

---

<model response content>
```

or

```md
annotated reply below:
original source: file ./path/to/file.ts

---

<file content>
```

## Annotation style (suggested)

A simple pattern is to keep source text and add notes in square brackets, e.g. `[like this]`.

This is only a suggested pattern, not a strict format. Use whatever annotation style is clear for your workflow.

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

- If `$VISUAL`/`$EDITOR` is not set, `*-editor` commands automatically fall back to pi's built-in extension editor.
- If the latest assistant message is incomplete or has no text content, reply-based commands show a warning.
- File annotation reads the selected file content and injects an editable copy into the editor. The source file is never modified by this extension.

## License

MIT
