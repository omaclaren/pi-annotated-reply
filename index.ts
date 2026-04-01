import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type AnnotationSource = {
	label: string;
	markdown: string;
	format?: "plain" | "diff";
};

type AnnotationSourceResult =
	| { ok: true; source: AnnotationSource }
	| { ok: false; message: string; level: "info" | "warning" | "error" };

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
			format: detectSourceFormat(normalizedInput, markdown),
		},
	};
}

function detectSourceFormat(pathOrLabel: string, markdown: string): "plain" | "diff" {
	const lower = pathOrLabel.trim().toLowerCase();
	if (lower.endsWith(".diff") || lower.endsWith(".patch")) return "diff";

	const normalized = markdown.replace(/\r\n/g, "\n").trim();
	if (!normalized) return "plain";
	if (/^(```|~~~)diff\b[\s\S]*\n\1\s*$/i.test(normalized)) return "diff";
	if (/^diff --git a\/.+ b\/.+/m.test(normalized)) return "diff";
	if (/^---\s+.+$/m.test(normalized) && /^\+\+\+\s+.+$/m.test(normalized) && /^@@\s+/m.test(normalized)) return "diff";
	return "plain";
}

function splitGitPathOutput(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function formatSpawnFailure(
	result: { stdout?: string | Buffer | null; stderr?: string | Buffer | null },
	args: string[],
): string {
	const stderr = typeof result.stderr === "string"
		? result.stderr.trim()
		: (result.stderr ? result.stderr.toString("utf-8").trim() : "");
	const stdout = typeof result.stdout === "string"
		? result.stdout.trim()
		: (result.stdout ? result.stdout.toString("utf-8").trim() : "");
	return stderr || stdout || `git ${args.join(" ")} failed`;
}

function readTextFileIfPossible(path: string): string | null {
	try {
		const content = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
		if (content.includes("\u0000")) return null;
		return content;
	} catch {
		return null;
	}
}

function buildSyntheticNewFileDiff(filePath: string, content: string): string {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	const diffLines = [
		`diff --git a/${filePath} b/${filePath}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${filePath}`,
		`@@ -0,0 +1,${lines.length} @@`,
	];

	if (lines.length > 0) {
		diffLines.push(lines.map((line) => `+${line}`).join("\n"));
	}

	return diffLines.join("\n");
}

function getGitDiffSource(ctx: ExtensionCommandContext): AnnotationSourceResult {
	const repoRootArgs = ["rev-parse", "--show-toplevel"];
	const repoRootResult = spawnSync("git", repoRootArgs, {
		cwd: ctx.cwd,
		encoding: "utf-8",
	});
	if (repoRootResult.status !== 0) {
		return {
			ok: false,
			level: "warning",
			message: "Not inside a git repository.",
		};
	}
	const repoRoot = repoRootResult.stdout.trim();

	const hasHead =
		spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf-8",
		}).status === 0;

	const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
	const untrackedResult = spawnSync("git", untrackedArgs, {
		cwd: repoRoot,
		encoding: "utf-8",
	});
	if (untrackedResult.status !== 0) {
		return {
			ok: false,
			level: "error",
			message: `Failed to list untracked files: ${formatSpawnFailure(untrackedResult, untrackedArgs)}`,
		};
	}
	const untrackedPaths = splitGitPathOutput(untrackedResult.stdout ?? "").sort();

	let diffOutput = "";
	let statSummary = "";
	let currentTreeFileCount = 0;

	if (hasHead) {
		const diffArgs = ["diff", "HEAD", "--unified=3", "--find-renames", "--no-color", "--"];
		const diffResult = spawnSync("git", diffArgs, {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		if (diffResult.status !== 0) {
			return {
				ok: false,
				level: "error",
				message: `Failed to collect git diff: ${formatSpawnFailure(diffResult, diffArgs)}`,
			};
		}
		diffOutput = diffResult.stdout ?? "";

		const statArgs = ["diff", "HEAD", "--stat", "--find-renames", "--no-color", "--"];
		const statResult = spawnSync("git", statArgs, {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		if (statResult.status === 0) {
			const statLines = splitGitPathOutput(statResult.stdout ?? "");
			statSummary = statLines.length > 0 ? (statLines[statLines.length - 1] ?? "") : "";
		}
	} else {
		const trackedArgs = ["ls-files", "--cached"];
		const trackedResult = spawnSync("git", trackedArgs, {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		if (trackedResult.status !== 0) {
			return {
				ok: false,
				level: "error",
				message: `Failed to inspect tracked files: ${formatSpawnFailure(trackedResult, trackedArgs)}`,
			};
		}

		const trackedPaths = splitGitPathOutput(trackedResult.stdout ?? "");
		const currentTreePaths = Array.from(new Set([...trackedPaths, ...untrackedPaths])).sort();
		currentTreeFileCount = currentTreePaths.length;
		diffOutput = currentTreePaths
			.map((filePath) => {
				const content = readTextFileIfPossible(join(repoRoot, filePath));
				if (content == null) return "";
				return buildSyntheticNewFileDiff(filePath, content);
			})
			.filter((section) => section.length > 0)
			.join("\n\n");
	}

	const untrackedSections = hasHead
		? untrackedPaths
			.map((filePath) => {
				const content = readTextFileIfPossible(join(repoRoot, filePath));
				if (content == null) return "";
				return buildSyntheticNewFileDiff(filePath, content);
			})
			.filter((section) => section.length > 0)
		: [];

	const fullDiff = [diffOutput.trimEnd(), ...untrackedSections].filter(Boolean).join("\n\n");
	if (!fullDiff.trim()) {
		return {
			ok: false,
			level: "info",
			message: "No uncommitted changes to review.",
		};
	}

	const summaryParts: string[] = [];
	if (hasHead && statSummary) {
		summaryParts.push(statSummary);
	}
	if (!hasHead && currentTreeFileCount > 0) {
		summaryParts.push(`${currentTreeFileCount} file${currentTreeFileCount === 1 ? "" : "s"} in current tree`);
	}
	if (untrackedPaths.length > 0) {
		summaryParts.push(`${untrackedPaths.length} untracked file${untrackedPaths.length === 1 ? "" : "s"}`);
	}

	const labelBase = hasHead ? "git diff HEAD" : "git diff (no commits yet)";
	const label = summaryParts.length > 0 ? `${labelBase} (${summaryParts.join(", ")})` : labelBase;

	return {
		ok: true,
		source: {
			label,
			markdown: fullDiff,
			format: "diff",
		},
	};
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

function formatSourceMarkdownForPrefill(source: AnnotationSource): string {
	if (source.format === "diff") {
		return wrapAsDiffFence(source.markdown);
	}
	return source.markdown;
}

function buildPrefill(source: AnnotationSource): string {
	return `annotated reply below:\noriginal source: ${source.label}\nuser annotation syntax: [an: note]\nprecedence: later messages supersede these annotations unless user explicitly references them\n\n---\n\n${formatSourceMarkdownForPrefill(source)}\n\n--- end annotations ---\n\n`;
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

	const pathArg = parsePathArgument(args);
	if (options.diff && pathArg) {
		ctx.ui.notify(
			"This command reviews current git changes and does not take a path. To annotate a saved diff file, use /reply <path> or /reply-editor <path>.",
			"warning",
		);
		return;
	}

	let sourceResult: AnnotationSourceResult;
	if (options.diff) {
		sourceResult = getGitDiffSource(ctx);
	} else if (pathArg) {
		sourceResult = getFileSource(ctx, args);
	} else {
		sourceResult = getLastAssistantSource(ctx);
	}

	if (!sourceResult.ok) {
		ctx.ui.notify(sourceResult.message, sourceResult.level);
		return;
	}

	const source = sourceResult.source;

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
		const message = "message" in result ? result.message : "Unknown error";
		ctx.ui.notify(`External editor failed: ${message}`, "error");
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
		description: "Annotate the last model response, or a file with /reply <path>. Use --raw to skip header, --diff to review uncommitted git changes.",
		handler: async (args, ctx) => {
			const { raw, diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw, diff });
		},
	});

	pi.registerCommand("reply-editor", {
		description: "Like /reply, but opens in external editor ($VISUAL/$EDITOR). Use --raw to skip header, --diff to review uncommitted git changes.",
		handler: async (args, ctx) => {
			const { raw, diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: true, raw, diff });
		},
	});

	pi.registerCommand("load-content", {
		description: "Alias for /reply --raw",
		handler: async (args, ctx) => {
			const { diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw: true, diff });
		},
	});

	pi.registerCommand("load-content-editor", {
		description: "Alias for /reply-editor --raw",
		handler: async (args, ctx) => {
			const { diff, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: true, raw: true, diff });
		},
	});

	pi.registerCommand("reply-diff", {
		description: "Review uncommitted git changes in annotation format",
		handler: async (args, ctx) => {
			const { raw, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw, diff: true });
		},
	});

	pi.registerCommand("reply-diff-editor", {
		description: "Review uncommitted git changes in external editor",
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
		description: "Review uncommitted git changes in annotation format",
		handler: async (args, ctx) => {
			const { raw, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: false, raw, diff: true });
		},
	});

	pi.registerCommand("annotated-reply-diff-editor", {
		description: "Review uncommitted git changes in external editor",
		handler: async (args, ctx) => {
			const { raw, cleanArgs } = extractReplyFlags(args);
			await runReply(ctx, cleanArgs, { externalEditor: true, raw, diff: true });
		},
	});
}
