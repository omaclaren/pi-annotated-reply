import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type AnnotationSource = {
	label: string;
	markdown: string;
};

type AnnotationSourceResult =
	| { ok: true; source: AnnotationSource }
	| { ok: false; message: string; level: "warning" | "error" };

type ParsedCommand = {
	command: string;
	args: string[];
};

type ExternalEditorResult =
	| { ok: true; edited: string }
	| { ok: false; cancelled: true }
	| { ok: false; message: string };

type RunReplyOptions = {
	externalEditor: boolean;
	raw: boolean;
	diff: boolean;
};

type ReplyFlags = {
	raw: boolean;
	diff: boolean;
	cleanArgs: string;
};

function parseCommandSpec(spec: string): ParsedCommand | null {
	const parts = spec.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!parts || parts.length === 0) return null;

	const unquote = (token: string) => {
		if (
			(token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
			(token.startsWith("'") && token.endsWith("'") && token.length >= 2)
		) {
			return token.slice(1, -1);
		}
		return token;
	};

	const [commandToken, ...argTokens] = parts;
	const command = unquote(commandToken ?? "").trim();
	if (!command) return null;

	return {
		command,
		args: argTokens.map((token) => unquote(token).trim()).filter((token) => token.length > 0),
	};
}

function parsePathArgument(args: string): string | null {
	const trimmed = args.trim();
	if (!trimmed) return null;

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
	) {
		return trimmed.slice(1, -1).trim();
	}

	return trimmed;
}

function normalizePathInput(pathInput: string): string {
	const trimmed = pathInput.trim();
	if (trimmed.startsWith("@")) return trimmed.slice(1).trim();
	return trimmed;
}

function expandHome(pathInput: string): string {
	if (pathInput === "~") return process.env.HOME ?? pathInput;
	if (!pathInput.startsWith("~/")) return pathInput;

	const home = process.env.HOME;
	if (!home) return pathInput;

	return join(home, pathInput.slice(2));
}

function getLastAssistantSource(ctx: ExtensionCommandContext): AnnotationSourceResult {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const maybe = extractAssistantSource(entry);
		if (!maybe) continue;
		return maybe;
	}

	return { ok: false, level: "warning", message: "No assistant reply found in the current branch." };
}

function extractAssistantSource(entry: SessionEntry): AnnotationSourceResult | null {
	if (entry.type !== "message") return null;

	const message = entry.message;
	if (!("role" in message) || message.role !== "assistant") return null;

	if (message.stopReason !== "stop") {
		return {
			ok: false,
			level: "warning",
			message: `Latest assistant reply is incomplete (${message.stopReason}). Wait for completion, then run the command again.`,
		};
	}

	const textBlocks = message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text);

	const markdown = textBlocks.join("\n\n").trimEnd();
	if (!markdown.trim()) {
		return {
			ok: false,
			level: "warning",
			message: "Latest assistant reply has no text content to annotate.",
		};
	}

	return {
		ok: true,
		source: {
			label: "last model response",
			markdown,
		},
	};
}

function getFileSource(ctx: ExtensionCommandContext, args: string): AnnotationSourceResult {
	const rawPathArg = parsePathArgument(args);
	if (!rawPathArg) {
		return {
			ok: false,
			level: "warning",
			message: "Missing file path. Usage: /reply <path> or /reply-editor <path>",
		};
	}

	const normalizedInput = normalizePathInput(rawPathArg);
	if (!normalizedInput) {
		return {
			ok: false,
			level: "warning",
			message: "Missing file path after normalization.",
		};
	}

	const expandedInput = expandHome(normalizedInput);
	const resolvedPath = isAbsolute(expandedInput) ? expandedInput : resolve(ctx.cwd, expandedInput);

	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(resolvedPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			level: "error",
			message: `Could not access file: ${normalizedInput} (${message})`,
		};
	}

	if (!stats.isFile()) {
		return {
			ok: false,
			level: "warning",
			message: `Path is not a file: ${normalizedInput}`,
		};
	}

	let markdown: string;
	try {
		markdown = readFileSync(resolvedPath, "utf-8").trimEnd();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			level: "error",
			message: `Failed to read file: ${normalizedInput} (${message})`,
		};
	}

	if (markdown.includes("\u0000")) {
		return {
			ok: false,
			level: "warning",
			message: `File appears to be binary and is not suitable for text annotation: ${normalizedInput}`,
		};
	}

	return {
		ok: true,
		source: {
			label: `file ${normalizedInput}`,
			markdown,
		},
	};
}

function buildPrefill(source: AnnotationSource): string {
	return `annotated reply below:\noriginal source: ${source.label}\n\n---\n\n${source.markdown}\n\n`;
}

function isSingleDiffFence(markdown: string): boolean {
	const trimmed = markdown.trim();
	if (!trimmed) return false;
	return /^(```|~~~)diff[^\n]*\n[\s\S]*\n\1[ \t]*$/i.test(trimmed);
}

function wrapAsDiffFence(markdown: string): string {
	if (isSingleDiffFence(markdown)) return markdown;

	const trimmed = markdown.trimEnd();
	const marker = trimmed.includes("```") ? "~~~" : "```";
	return `${marker}diff\n${trimmed}\n${marker}`;
}

function loadEditedContentIntoEditor(ctx: ExtensionCommandContext, edited: string): void {
	ctx.ui.setEditorText(edited);
	ctx.ui.notify("Annotated content loaded into the editor. Submit when ready.", "info");
}

async function editInBuiltInEditor(ctx: ExtensionCommandContext, source: AnnotationSource): Promise<void> {
	const edited = await ctx.ui.editor("Annotate source", buildPrefill(source));
	if (edited === undefined) {
		ctx.ui.notify("Cancelled annotation.", "info");
		return;
	}

	loadEditedContentIntoEditor(ctx, edited);
}

async function openInExternalEditor(
	ctx: ExtensionCommandContext,
	prefill: string,
	commandSpec: string,
): Promise<ExternalEditorResult> {
	const parsed = parseCommandSpec(commandSpec);
	if (!parsed) {
		return {
			ok: false,
			message: `Could not parse editor command from $VISUAL/$EDITOR: ${commandSpec}`,
		};
	}

	const result = await ctx.ui.custom<ExternalEditorResult>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Opening external editor (${parsed.command})...`);
		let settled = false;
		const finish = (value: ExternalEditorResult) => {
			if (settled) return;
			settled = true;
			done(value);
		};

		loader.onAbort = () => finish({ ok: false, cancelled: true });

		void (async () => {
			const tempFile = join(tmpdir(), `pi-annotate-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
			let tuiStopped = false;
			try {
				writeFileSync(tempFile, prefill, "utf-8");
				if (settled) return;

				tui.stop();
				tuiStopped = true;

				const run = spawnSync(parsed.command, [...parsed.args, tempFile], {
					stdio: "inherit",
				});

				if (run.error) {
					finish({ ok: false, message: run.error.message });
					return;
				}

				if (run.status !== 0) {
					finish({ ok: false, message: `External editor exited with status ${run.status}.` });
					return;
				}

				const edited = readFileSync(tempFile, "utf-8").replace(/\n$/, "");
				finish({ ok: true, edited });
			} catch (error) {
				finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
			} finally {
				try {
					unlinkSync(tempFile);
				} catch {
					// ignore cleanup errors
				}
				if (tuiStopped) {
					tui.start();
					tui.requestRender(true);
				}
			}
		})();

		return loader;
	});

	return result ?? { ok: false, cancelled: true };
}

async function runReply(
	ctx: ExtensionCommandContext,
	args: string,
	options: RunReplyOptions,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("This command requires interactive mode.", "error");
		return;
	}

	await ctx.waitForIdle();

	const sourceResult = parsePathArgument(args)
		? getFileSource(ctx, args)
		: getLastAssistantSource(ctx);

	if (!sourceResult.ok) {
		ctx.ui.notify(sourceResult.message, sourceResult.level);
		return;
	}

	const source = options.diff
		? { ...sourceResult.source, markdown: wrapAsDiffFence(sourceResult.source.markdown) }
		: sourceResult.source;

	const content = options.raw
		? source.markdown + "\n"
		: buildPrefill(source);

	if (!options.externalEditor) {
		if (options.raw) {
			ctx.ui.setEditorText(content);
			ctx.ui.notify(`Raw content from ${source.label} loaded into editor.`, "info");
		} else {
			await editInBuiltInEditor(ctx, source);
		}
		return;
	}

	const commandSpec = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
	if (!commandSpec) {
		ctx.ui.notify("No $VISUAL/$EDITOR found. Falling back to built-in editor.", "warning");
		if (options.raw) {
			ctx.ui.setEditorText(content);
			ctx.ui.notify(`Raw content from ${source.label} loaded into editor.`, "info");
		} else {
			await editInBuiltInEditor(ctx, source);
		}
		return;
	}

	const result = await openInExternalEditor(ctx, content, commandSpec);
	if (!result.ok) {
		if ("cancelled" in result && result.cancelled) {
			ctx.ui.notify("Cancelled.", "info");
			return;
		}
		ctx.ui.notify(`External editor failed: ${result.message}`, "error");
		return;
	}

	loadEditedContentIntoEditor(ctx, result.edited);
}

function extractReplyFlags(args: string): ReplyFlags {
	const raw = /(^|\s)--raw(?=\s|$)/.test(args);
	const diff = /(^|\s)--diff(?=\s|$)/.test(args);
	const cleanArgs = args
		.replace(/(^|\s)--raw(?=\s|$)/g, " ")
		.replace(/(^|\s)--diff(?=\s|$)/g, " ")
		.trim();
	return { raw, diff, cleanArgs };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("reply", {
		description: "Annotate the last model response, or a file with /reply <path>. Use --raw to skip header, --diff to wrap content in a diff fence.",
		handler: async (args, ctx) => {
			const { raw, diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw, diff });
		},
	});

	pi.registerCommand("reply-editor", {
		description: "Like /reply, but opens in external editor ($VISUAL/$EDITOR). Use --raw to skip header, --diff to wrap content in a diff fence.",
		handler: async (args, ctx) => {
			const { raw, diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: true, raw, diff });
		},
	});

	pi.registerCommand("reply-diff", {
		description: "Alias for /reply --diff",
		handler: async (args, ctx) => {
			const { raw, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw, diff: true });
		},
	});

	pi.registerCommand("reply-diff-editor", {
		description: "Alias for /reply-editor --diff",
		handler: async (args, ctx) => {
			const { raw, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: true, raw, diff: true });
		},
	});

	pi.registerCommand("annotated-reply", {
		description: "Alias for /reply",
		handler: async (args, ctx) => {
			const { raw, diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw, diff });
		},
	});

	pi.registerCommand("annotated-reply-editor", {
		description: "Alias for /reply-editor",
		handler: async (args, ctx) => {
			const { raw, diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: true, raw, diff });
		},
	});

	pi.registerCommand("annotated-reply-diff", {
		description: "Alias for /reply-diff",
		handler: async (args, ctx) => {
			const { raw, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw, diff: true });
		},
	});

	pi.registerCommand("annotated-reply-diff-editor", {
		description: "Alias for /reply-diff-editor",
		handler: async (args, ctx) => {
			const { raw, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: true, raw, diff: true });
		},
	});
}
