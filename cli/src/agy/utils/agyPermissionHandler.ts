/**
 * Permission bridge for PTY-mode agy (Antigravity CLI) sessions.
 *
 * Adapts AGY hook permission requests to HAPI's shared permission RPC.
 * agy uses a PreToolUse hook (camelCase schema) instead of the claude SDK
 * canUseTool callback. We auto-allow read-only tools and route everything
 * else to the web approval modal — reusing the same `state.requests` +
 * shared `permission` RPC machinery.
 */

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
    'list_permissions'
]);

export type AgyPermissionHandlerOptions = {
    /** Reads the session's current permission mode. */
    getPermissionMode: () => PermissionMode | undefined;
    /** Propagate a mode change chosen via the web approval. */
    onModeChange?: (mode: PermissionMode) => void;
};

export class AgyPermissionHandler extends BasePermissionHandler<PermissionResponse, AgyPermissionDecision> {
    private readonly options: AgyPermissionHandlerOptions;
    private readonly sessionAllowedTools = new Set<string>();
    private readonly allowedCommandLiterals = new Set<string>();
    private readonly allowedCommandPrefixes = new Set<string>();

    constructor(client: PermissionHandlerClient, options: AgyPermissionHandlerOptions) {
        super(client);
        this.options = options;
    }

    /**
     * Decide whether an agy tool call may proceed. Resolves immediately for
     * auto-allowed tools/modes; otherwise registers a pending request that
     * resolves when the user answers in the web modal.
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

        // 2. Pure read-only tools — never gated.
        if (AGY_AUTO_ALLOW_TOOLS.has(toolName)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 3. Mode-based auto-approval. agy's only auto-allow mode is 'always-proceed',
        // which resolveToolAutoApprovalDecision maps to 'approved_for_session'.
        if (resolveToolAutoApprovalDecision(mode, toolName, toolUseId)) {
            return Promise.resolve({ permissionDecision: 'allow' });
        }

        // 4. Ask the user via the web approval modal.
        return new Promise<AgyPermissionDecision>((resolve, reject) => {
            this.addPendingRequest(toolUseId, toolName, input, { resolve, reject });
            logger.debug(`[agyPermission] Awaiting web approval for ${toolName} (${toolUseId})`);
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
            logger.debug('[agyPermission] Ignoring command(*) in rememberCommandPermission — unbounded session allow not permitted');
        } else if (command.endsWith(':*')) {
            this.allowedCommandPrefixes.add(command.slice(0, -2));
        } else {
            this.allowedCommandLiterals.add(command);
        }
    }
}
