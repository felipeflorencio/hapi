/**
 * Permission bridge for PTY-mode agy (Antigravity CLI) sessions.
 *
 * Adapts AGY hook permission requests to HAPI's shared permission RPC with Dual-Approval:
 * users can approve either locally in their terminal via /dev/tty or remotely via web/phone.
 * Whichever resolves first wins; the other interface is cleanly dismissed.
 */

import fs from 'node:fs';
import tty from 'node:tty';
import type { PermissionMode } from '@hapi/protocol/types';
import {
    BasePermissionHandler,
    resolveToolAutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion,
    type PermissionHandlerClient
} from '@/modules/common/permission/BasePermissionHandler';
import { logger } from '@/ui/logger';

export type AgyPermissionDecision = {
    permissionDecision: 'allow' | 'deny';
    reason?: string;
    permissionOverrides?: string[];
    answers?: Record<string, string[]> | null;
};

export const AGY_QUESTION_TOOL_NAME = 'ask_user_question';

function normalizeQuestionAnswers(
    answers: Record<string, string[]> | Record<string, { answers: string[] }> | undefined
): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    if (!answers) return result;
    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            result[key] = value;
        } else if (value && typeof value === 'object' && Array.isArray((value as { answers?: unknown }).answers)) {
            result[key] = (value as { answers: string[] }).answers;
        }
    }
    return result;
}

type PermissionResponse = {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: PermissionMode;
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

const AGY_AUTO_ALLOW_TOOLS = new Set<string>([
    'view_file',
    'list_dir',
    'find_by_name',
    'grep_search',
    'read_url_content',
    'search_web',
    'list_permissions',
    'ask_question',
    'ask_user_question'
]);

export function formatToolCallSummary(toolName: string, input: unknown): string {
    if (!input || typeof input !== 'object') {
        return toolName;
    }
    const rec = input as Record<string, unknown>;
    if (toolName === 'run_command' && typeof rec.CommandLine === 'string') {
        const cmd = rec.CommandLine.trim();
        const display = cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
        return `run_command ("${display}")`;
    }
    if ((toolName === 'write_to_file' || toolName === 'replace_file_content') && typeof rec.TargetFile === 'string') {
        return `${toolName} (${rec.TargetFile})`;
    }
    if (toolName === 'read_url_content' && typeof rec.Url === 'string') {
        return `read_url_content (${rec.Url})`;
    }
    if (toolName === 'search_web' && typeof rec.query === 'string') {
        return `search_web ("${rec.query}")`;
    }
    if (toolName === 'manage_task' && typeof rec.Action === 'string') {
        return `manage_task (${rec.Action}${rec.TaskId ? ` on ${rec.TaskId}` : ''})`;
    }
    if (toolName === 'define_subagent' && typeof rec.name === 'string') {
        return `define_subagent (${rec.name})`;
    }
    if (toolName === 'invoke_subagent' && Array.isArray(rec.Subagents)) {
        const names = (rec.Subagents as Array<{ Role?: string; TypeName?: string }>)
            .map((s) => s.Role || s.TypeName)
            .filter(Boolean)
            .join(', ');
        return `invoke_subagent (${names || `${rec.Subagents.length} subagents`})`;
    }
    for (const key of ['command', 'file', 'path', 'TargetFile', 'CommandLine', 'description', 'query', 'url']) {
        if (typeof rec[key] === 'string' && rec[key]) {
            const val = (rec[key] as string).trim();
            const display = val.length > 50 ? `${val.slice(0, 47)}...` : val;
            return `${toolName} (${key}: "${display}")`;
        }
    }
    return toolName;
}

export type TtyStreams = {
    ttyIn: NodeJS.ReadableStream & {
        isRaw?: boolean;
        setRawMode?: (mode: boolean) => void;
        unref?: () => void;
        destroy?: () => void;
        destroyed?: boolean;
    };
    ttyOut: NodeJS.WritableStream & {
        destroyed?: boolean;
        writable?: boolean;
        destroy?: () => void;
    };
    /** Whether to destroy ttyIn/ttyOut when the prompt finishes (default true). */
    closeOnFinish?: boolean;
};

function defaultTtyFactory(): TtyStreams | null {
    try {
        const ttyPaths = process.platform === 'win32'
            ? { read: '\\\\.\\CONIN$', write: '\\\\.\\CONOUT$' }
            : { read: '/dev/tty', write: '/dev/tty' };

        const readFd = fs.openSync(ttyPaths.read, 'r');
        const writeFd = fs.openSync(ttyPaths.write, 'w');
        const ttyIn = new tty.ReadStream(readFd);
        const ttyOut = new tty.WriteStream(writeFd);
        return { ttyIn, ttyOut, closeOnFinish: true };
    } catch (error) {
        logger.debug('[agyPermission] Could not open TTY for local prompt:', error);
        return null;
    }
}

export type AgyPermissionHandlerOptions = {
    /** Reads the session's current permission mode. */
    getPermissionMode: () => PermissionMode | undefined;
    /** Propagate a mode change chosen via the web approval. */
    onModeChange?: (mode: PermissionMode) => void;
    /** Whether local terminal prompting is enabled (defaults to true). */
    enableLocalPrompt?: boolean;
    /** Optional factory for TTY streams (useful for unit testing). */
    ttyFactory?: () => TtyStreams | null;
};

export class AgyPermissionHandler extends BasePermissionHandler<PermissionResponse, AgyPermissionDecision> {
    private readonly options: AgyPermissionHandlerOptions;
    private readonly sessionAllowedTools = new Set<string>();
    private readonly allowedCommandLiterals = new Set<string>();
    private readonly allowedCommandPrefixes = new Set<string>();
    private readonly activeLocalPrompts = new Map<string, (outcome: 'remote_approved' | 'remote_denied' | 'canceled') => void>();
    private promptQueue: Array<() => Promise<void>> = [];
    private isProcessingQueue = false;

    constructor(client: PermissionHandlerClient, options: AgyPermissionHandlerOptions) {
        super(client);
        this.options = options;
    }

    hasActiveLocalPrompt(): boolean {
        return this.activeLocalPrompts.size > 0;
    }

    /**
     * Decide whether an agy tool call may proceed. Resolves immediately for
     * auto-allowed tools/modes; otherwise presents Dual-Approval (concurrent
     * local TTY prompt and remote web/phone notification).
     */
    requestDecision(toolUseId: string, toolName: string, input: unknown): Promise<AgyPermissionDecision> {
        const mode = this.options.getPermissionMode();

        // 1. Already allowed for the session via a prior approval.
        if (toolName === 'run_command') {
            const command = (input as { CommandLine?: string } | null)?.CommandLine ?? '';
            if (command && this.isCommandAllowed(command)) {
                return Promise.resolve({ permissionDecision: 'allow' });
            }
        } else if (this.sessionAllowedTools.has(toolName)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 2. Pure read-only tools and native questions — never gated.
        if (AGY_AUTO_ALLOW_TOOLS.has(toolName)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 3. Mode-based auto-approval. agy's only auto-allow mode is 'always-proceed',
        // which resolveToolAutoApprovalDecision maps to 'approved_for_session'.
        if (resolveToolAutoApprovalDecision(mode, toolName, toolUseId)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 4. Dual-Approval: Ask user concurrently via remote modal and local terminal prompt.
        return new Promise<AgyPermissionDecision>((resolve, reject) => {
            let settled = false;

            const safeResolve = (decision: AgyPermissionDecision) => {
                if (settled) return;
                settled = true;
                resolve(decision);
            };

            const safeReject = (error: Error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };

            this.addPendingRequest(toolUseId, toolName, input, {
                resolve: safeResolve,
                reject: safeReject
            });
            logger.debug(`[agyPermission] Awaiting approval for ${toolName} (${toolUseId})`);

            if (this.options.enableLocalPrompt !== false) {
                this.enqueueLocalPrompt(toolUseId, toolName, input, {
                    onApprove: (allowForSession) => {
                        if (settled) return;

                        const pendingInput = input as { CommandLine?: string } | null;
                        const allowTools = allowForSession ? [toolName] : undefined;
                        if (allowForSession) {
                            if (toolName === 'run_command' && pendingInput?.CommandLine) {
                                this.allowedCommandLiterals.add(pendingInput.CommandLine);
                            } else {
                                this.sessionAllowedTools.add(toolName);
                            }
                        }

                        const permissionOverrides = this.buildPermissionOverrides(allowTools, pendingInput?.CommandLine);

                        this.pendingRequests.delete(toolUseId);
                        this.finalizeRequest(toolUseId, {
                            status: 'approved',
                            decision: allowForSession ? 'approved_for_session' : 'approved',
                            allowTools: permissionOverrides.length > 0 ? permissionOverrides : allowTools
                        });

                        safeResolve({
                            permissionDecision: 'allow',
                            permissionOverrides: permissionOverrides.length > 0 ? permissionOverrides : undefined
                        });
                    },
                    onDeny: (reason) => {
                        if (settled) return;

                        this.pendingRequests.delete(toolUseId);
                        this.finalizeRequest(toolUseId, {
                            status: 'denied',
                            decision: 'denied',
                            reason
                        });

                        safeResolve({
                            permissionDecision: 'deny',
                            reason:
                                reason ||
                                'The user declined this tool use. The tool was NOT run. Stop and wait for the user to tell you how to proceed.'
                        });
                    }
                });
            }
        });
    }

    registerQuestionRequest(
        toolUseId: string,
        canonicalInput: { questions: unknown }
    ): Promise<Record<string, string[]> | null> {
        return new Promise<Record<string, string[]> | null>((resolve, reject) => {
            this.addPendingRequest(toolUseId, AGY_QUESTION_TOOL_NAME, canonicalInput, {
                resolve: (decision) => resolve(decision.answers ?? null),
                reject
            });
        });
    }

    cancelAll(reason: string): void {
        for (const dismiss of this.activeLocalPrompts.values()) {
            try {
                dismiss('canceled');
            } catch {}
        }
        this.activeLocalPrompts.clear();
        this.promptQueue = [];
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'denied'
        });
    }

    cancelPendingQuestions(reason: string): void {
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'denied',
            filter: (toolName) => toolName === AGY_QUESTION_TOOL_NAME
        });
    }

    protected async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingPermissionRequest<AgyPermissionDecision>
    ): Promise<PermissionCompletion> {
        this.dismissLocalPrompt(response.id, response.approved ? 'remote_approved' : 'remote_denied');

        if (pending.toolName === AGY_QUESTION_TOOL_NAME) {
            const answers = response.approved ? normalizeQuestionAnswers(response.answers) : null;
            pending.resolve({
                permissionDecision: response.approved ? 'allow' : 'deny',
                reason: response.reason,
                answers
            });
            return {
                status: response.approved ? 'approved' : 'denied',
                reason: response.reason,
                answers: response.approved ? normalizeQuestionAnswers(response.answers) : undefined
            };
        }

        const pendingInput = pending.input as { CommandLine?: string } | null;
        const allowTools = response.allowTools ?? (
            response.approved && response.decision === 'approved_for_session'
                ? [pending.toolName]
                : undefined
        );
        if (response.approved && allowTools && allowTools.length > 0) {
            for (const tool of allowTools) {
                if (tool === 'run_command') {
                    const cmd = pendingInput?.CommandLine;
                    if (cmd) {
                        this.allowedCommandLiterals.add(cmd);
                    }
                } else if (tool.startsWith('command(')) {
                    this.rememberCommandPermission(tool);
                } else {
                    this.sessionAllowedTools.add(tool);
                }
            }
        }

        if (response.mode) {
            this.options.onModeChange?.(response.mode);
        }

        const completion: PermissionCompletion = {
            status: response.approved ? 'approved' : 'denied',
            reason: response.reason,
            mode: response.mode,
            allowTools
        };

        const permissionOverrides = this.buildPermissionOverrides(allowTools, pendingInput?.CommandLine);

        if (response.approved) {
            pending.resolve({
                permissionDecision: 'allow',
                permissionOverrides: permissionOverrides.length > 0 ? permissionOverrides : undefined
            });
        } else {
            pending.resolve({
                permissionDecision: 'deny',
                reason:
                    response.reason ||
                    'The user declined this tool use. The tool was NOT run. Stop and wait for the user to tell you how to proceed.'
            });
        }

        return completion;
    }

    protected handleMissingPendingResponse(response: PermissionResponse): void {
        logger.debug(`[agyPermission] No pending request for response ${response.id} (already resolved?)`);
    }

    private enqueueLocalPrompt(
        toolUseId: string,
        toolName: string,
        input: unknown,
        callbacks: {
            onApprove: (allowForSession: boolean) => void;
            onDeny: (reason: string) => void;
        }
    ): void {
        let isTaskCancelled = false;

        const task = (): Promise<void> => {
            if (isTaskCancelled) {
                return Promise.resolve();
            }

            return new Promise<void>((resolveTask) => {
                const factory = this.options.ttyFactory ?? defaultTtyFactory;
                const ttyStreams = factory();
                if (!ttyStreams) {
                    resolveTask();
                    return;
                }

                const { ttyIn, ttyOut } = ttyStreams;
                let wasRaw = false;
                try {
                    wasRaw = Boolean(ttyIn.isRaw);
                    if (!wasRaw && typeof ttyIn.setRawMode === 'function') {
                        ttyIn.setRawMode(true);
                    }
                } catch {}

                if (typeof ttyIn.unref === 'function') {
                    try {
                        ttyIn.unref();
                    } catch {}
                }

                let promptDone = false;
                const finishPrompt = (
                    outcome: 'approved' | 'approved_for_session' | 'denied' | 'canceled' | 'remote_approved' | 'remote_denied'
                ) => {
                    if (promptDone) return;
                    promptDone = true;
                    this.activeLocalPrompts.delete(toolUseId);

                    let msg = '\r\x1b[K\n';
                    if (outcome === 'approved') {
                        msg = '\r\x1b[K   \x1b[32m✔ Approved locally.\x1b[0m\n';
                    } else if (outcome === 'approved_for_session') {
                        msg = '\r\x1b[K   \x1b[32m✔ Approved for session locally.\x1b[0m\n';
                    } else if (outcome === 'denied' || outcome === 'canceled') {
                        msg = '\r\x1b[K   \x1b[31m✖ Declined locally.\x1b[0m\n';
                    } else if (outcome === 'remote_approved') {
                        msg = '\r\x1b[K   \x1b[32m✔ Approved via remote (mobile/web).\x1b[0m\n';
                    } else if (outcome === 'remote_denied') {
                        msg = '\r\x1b[K   \x1b[31m✖ Declined via remote.\x1b[0m\n';
                    }

                    const shouldClose = ttyStreams.closeOnFinish !== false;
                    const destroyStreams = () => {
                        try {
                            if (!ttyIn.destroyed) {
                                ttyIn.removeListener('data', onData);
                                if (shouldClose) {
                                    if (!wasRaw && typeof ttyIn.setRawMode === 'function') {
                                        try { ttyIn.setRawMode(false); } catch {}
                                    }
                                    ttyIn.destroy?.();
                                }
                            }
                        } catch {}
                        try {
                            if (shouldClose && !ttyOut.destroyed) {
                                ttyOut.destroy?.();
                            }
                        } catch {}
                        resolveTask();
                    };

                    try {
                        if (ttyOut.writable && !ttyOut.destroyed) {
                            ttyOut.write(msg, () => {
                                destroyStreams();
                            });
                        } else {
                            destroyStreams();
                        }
                    } catch {
                        destroyStreams();
                    }
                };

                const dismissPrompt = (outcome: 'remote_approved' | 'remote_denied' | 'canceled') => {
                    finishPrompt(outcome);
                };
                this.activeLocalPrompts.set(toolUseId, dismissPrompt);

                const onData = (data: Buffer | string) => {
                    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
                    const char = raw.toString('utf8');
                    const lower = char.trim().toLowerCase();

                    // Ctrl+C (0x03) or Escape (0x1b)
                    if (raw[0] === 3 || raw[0] === 27) {
                        finishPrompt('canceled');
                        callbacks.onDeny('Declined by user in terminal');
                        return;
                    }

                    if (lower === 'y' || lower === 'yes') {
                        finishPrompt('approved');
                        callbacks.onApprove(false);
                        return;
                    }

                    if (lower === 'a' || lower === 'always') {
                        finishPrompt('approved_for_session');
                        callbacks.onApprove(true);
                        return;
                    }

                    if (lower === 'n' || lower === 'no') {
                        finishPrompt('denied');
                        callbacks.onDeny('Declined by user in terminal');
                        return;
                    }
                };

                ttyIn.on('data', onData);

                const summary = formatToolCallSummary(toolName, input);
                const promptText = `\n\x1b[1;33m🔔 [HAPI Permission]\x1b[0m Approve \x1b[1m${summary}\x1b[0m?\n   \x1b[36m[y]\x1b[0mes  /  \x1b[31m[n]\x1b[0mo  /  \x1b[35m[a]\x1b[0mlways for session  \x1b[90m(or approve on phone)\x1b[0m: `;
                try {
                    ttyOut.write(promptText);
                } catch {
                    finishPrompt('canceled');
                }
            });
        };

        this.promptQueue.push(task);
        void this.processPromptQueue();
    }

    private async processPromptQueue(): Promise<void> {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;
        try {
            while (this.promptQueue.length > 0) {
                const nextTask = this.promptQueue.shift();
                if (nextTask) {
                    await nextTask();
                }
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    private dismissLocalPrompt(toolUseId: string, outcome: 'remote_approved' | 'remote_denied' | 'canceled'): void {
        const dismiss = this.activeLocalPrompts.get(toolUseId);
        if (dismiss) {
            this.activeLocalPrompts.delete(toolUseId);
            dismiss(outcome);
        }
    }

    private buildPermissionOverrides(allowTools?: string[], pendingCommandLine?: string): string[] {
        if (!allowTools || allowTools.length === 0) return [];
        const overrides: string[] = [];
        for (const tool of allowTools) {
            if (tool === 'run_command') {
                if (pendingCommandLine) {
                    overrides.push(`command(${pendingCommandLine})`);
                }
            } else if (tool.startsWith('command(')) {
                overrides.push(tool);
            } else {
                overrides.push(tool);
            }
        }
        return overrides;
    }

    private isCommandAllowed(command: string): boolean {
        if (this.allowedCommandLiterals.has(command)) {
            return true;
        }
        for (const prefix of this.allowedCommandPrefixes) {
            if (command.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private rememberCommandPermission(permission: string): void {
        const match = permission.match(/^command\((.+?)\)$/);
        if (!match) {
            this.sessionAllowedTools.add(permission);
            return;
        }
        const command = match[1];
        if (command === '*') {
            logger.debug(
                '[agyPermission] Ignoring command(*) in rememberCommandPermission — unbounded session allow not permitted'
            );
        } else if (command.endsWith(':*')) {
            this.allowedCommandPrefixes.add(command.slice(0, -2));
        } else {
            this.allowedCommandLiterals.add(command);
        }
    }
}
