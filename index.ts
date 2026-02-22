import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type LastAssistantResult =
	| { ok: true; markdown: string }
	| { ok: false; message: string; level: "warning" | "error" };

type ParsedCommand = {
	command: string;
	args: string[];
};

type ExternalEditorResult =
	| { ok: true; edited: string }
	| { ok: false; cancelled: true }
	| { ok: false; message: string };

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

function getLastAssistantMarkdown(ctx: ExtensionCommandContext): LastAssistantResult {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const maybe = extractAssistantMarkdown(entry);
		if (!maybe) continue;
		return maybe;
	}

	return { ok: false, level: "warning", message: "No assistant reply found in the current branch." };
}

function extractAssistantMarkdown(entry: SessionEntry): LastAssistantResult | null {
	if (entry.type !== "message") return null;

	const message = entry.message;
	if (!("role" in message) || message.role !== "assistant") return null;

	if (message.stopReason !== "stop") {
		return {
			ok: false,
			level: "warning",
			message: `Latest assistant reply is incomplete (${message.stopReason}). Wait for completion, then run /reply again.`,
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

	return { ok: true, markdown };
}

function buildPrefill(markdown: string): string {
	return `annotated reply below:\n\n${markdown}\n\n`;
}

function loadEditedReplyIntoEditor(ctx: ExtensionCommandContext, edited: string): void {
	ctx.ui.setEditorText(edited);
	ctx.ui.notify("Annotated reply loaded into the editor. Submit when ready.", "info");
}

async function editInBuiltInReplyEditor(ctx: ExtensionCommandContext, markdown: string): Promise<void> {
	const edited = await ctx.ui.editor("Annotated reply", buildPrefill(markdown));
	if (edited === undefined) {
		ctx.ui.notify("Cancelled annotated reply.", "info");
		return;
	}

	loadEditedReplyIntoEditor(ctx, edited);
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
			const tempFile = join(tmpdir(), `pi-annotated-reply-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
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

async function runReply(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/reply requires interactive mode.", "error");
		return;
	}

	await ctx.waitForIdle();

	const lastReply = getLastAssistantMarkdown(ctx);
	if (!lastReply.ok) {
		ctx.ui.notify(lastReply.message, lastReply.level);
		return;
	}

	await editInBuiltInReplyEditor(ctx, lastReply.markdown);
}

async function runReplyEditor(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/reply-editor requires interactive mode.", "error");
		return;
	}

	await ctx.waitForIdle();

	const lastReply = getLastAssistantMarkdown(ctx);
	if (!lastReply.ok) {
		ctx.ui.notify(lastReply.message, lastReply.level);
		return;
	}

	const commandSpec = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
	if (!commandSpec) {
		ctx.ui.notify("No $VISUAL/$EDITOR found. Falling back to /reply editor.", "warning");
		await editInBuiltInReplyEditor(ctx, lastReply.markdown);
		return;
	}

	const result = await openInExternalEditor(ctx, buildPrefill(lastReply.markdown), commandSpec);
	if (!result.ok) {
		if ("cancelled" in result && result.cancelled) {
			ctx.ui.notify("Cancelled annotated reply.", "info");
			return;
		}
		ctx.ui.notify(`External editor failed: ${result.message}`, "error");
		return;
	}

	loadEditedReplyIntoEditor(ctx, result.edited);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("reply", {
		description: "Open the last assistant reply for annotation and load it into the editor",
		handler: async (_args, ctx) => {
			await runReply(ctx);
		},
	});

	pi.registerCommand("reply-editor", {
		description: "Open the last assistant reply directly in your external editor and load it into the editor",
		handler: async (_args, ctx) => {
			await runReplyEditor(ctx);
		},
	});

	pi.registerCommand("annotated-reply", {
		description: "Alias for /reply",
		handler: async (_args, ctx) => {
			await runReply(ctx);
		},
	});
}
