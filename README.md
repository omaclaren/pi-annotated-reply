# pi-annotated-reply

Adds an annotated-reply workflow to [pi](https://github.com/badlogic/pi-mono). Construct prompts by annotating either the last model response, a file, or the current uncommitted git diff. Annotated text is loaded into pi’s main editor, ready to submit as your next prompt. Source files are never modified.

## Commands

| Command | Description |
|---------|-------------|
| `/reply` | Annotate the last model response |
| `/reply <path>` | Annotate a file (including saved `.diff` / `.patch` files; original file is not changed) |
| `/reply --raw` | Load raw content into editor without annotation header |
| `/reply --diff` | Collect uncommitted git changes (staged + unstaged + untracked text files) from the repo containing the current working directory |
| `/reply-editor` | Same as `/reply`, but opens in your external editor (`$VISUAL`/`$EDITOR`) |
| `/reply-editor <path>` | Same as `/reply <path>`, but opens in your external editor |
| `/load-content` | Alias for `/reply --raw` |
| `/load-content <path>` | Alias for `/reply <path> --raw` |
| `/load-content-editor` | Alias for `/reply-editor --raw` |
| `/load-content-editor <path>` | Alias for `/reply-editor <path> --raw` |
| `/reply-diff` | Review uncommitted git changes in annotation format |
| `/reply-diff-editor` | Review uncommitted git changes in external editor |
| `/annotated-reply` | Alias for `/reply` |
| `/annotated-reply <path>` | Alias for `/reply <path>` |
| `/annotated-reply-editor` | Alias for `/reply-editor` |
| `/annotated-reply-editor <path>` | Alias for `/reply-editor <path>` |
| `/annotated-reply-diff` | Review uncommitted git changes in annotation format |
| `/annotated-reply-diff-editor` | Review uncommitted git changes in external editor |

All commands accept:
- `--raw` to skip the annotation header and load bare content into the editor.
- `--diff` to collect the current repo diff against `HEAD` (tracked staged + unstaged changes) plus untracked text files from the repo containing the current working directory.
- With `--raw --diff`, the raw diff is loaded into the editor without the annotation template.
- With annotated mode (no `--raw`), repo diffs and saved `.diff` / `.patch` files are wrapped in a fenced `diff` block for syntax-highlighted markdown rendering.
- When `--diff` is provided, path arguments are rejected with a warning. To annotate a saved diff file, use `/reply <path>` or `/reply-editor <path>` instead.
- Saved `.diff` / `.patch` files can still be annotated via `/reply <path>` or `/reply-editor <path>`.

## Prefill format

The extension prefills content like:

```md
annotated reply below:
original source: last model response
user annotation syntax: [an: note]

---

<model response content>
```

or

```md
annotated reply below:
original source: file ./path/to/file.ts
user annotation syntax: [an: note]

---

<file content>
```

or

```md
annotated reply below:
original source: git diff HEAD (2 files changed, 15 insertions(+), 3 deletions(-), 1 untracked file)
user annotation syntax: [an: note]

---

~~~diff
diff --git a/src/index.ts b/src/index.ts
...
~~~
```

## Annotation style (suggested)

A simple default is `[an: note]`, inline with the source text.

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
- If `--diff` is used outside a git repo, the command shows a warning.
- If `--diff` finds no uncommitted changes, the command shows an info message.
- In a repo with no commits yet, `--diff` synthesizes reviewable “new file” diffs from the current tracked and untracked text files.

## License

MIT
