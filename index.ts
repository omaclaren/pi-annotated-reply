import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";

type LastAssistantResult =
	| { ok: true; markdown: string }
	| { ok: false; message: string; level: "warning" | "error" };

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

	const edited = await ctx.ui.editor("Annotated reply", buildPrefill(lastReply.markdown));
	if (edited === undefined) {
		ctx.ui.notify("Cancelled annotated reply.", "info");
		return;
	}

	ctx.ui.setEditorText(edited);
	ctx.ui.notify("Annotated reply loaded into the editor. Submit when ready.", "info");
}

export default function (pi: ExtensionAPI) {
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		await runReply(ctx);
	};

	pi.registerCommand("reply", {
		description: "Open the last assistant reply for annotation and load it into the editor",
		handler,
	});

	pi.registerCommand("annotated-reply", {
		description: "Alias for /reply",
		handler,
	});
}
