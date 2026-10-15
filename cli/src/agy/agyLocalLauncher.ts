import { randomUUID } from 'node:crypto';
import { agyLocal } from './agyLocal';
import { AgySession } from './session';
import { createAgySessionScanner } from './utils/agySessionScanner';
import { AgyPermissionHandler } from './utils/agyPermissionHandler';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { startHookServer, extractToolName, extractToolInput, extractToolUseId } from '@/claude/utils/startHookServer';
import { buildAgyHooksJson } from '@/modules/common/hooks/generateHookSettings';
import { prepareAgyHookCarrier, cleanupAgyHookCarrier } from './utils/agyHookCarrier';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { shellJoin } from '@/modules/common/shellQuote';
import { logger } from '@/ui/logger';
import type { AgyTranscriptEntry, AgyToolCall } from './utils/agyTranscriptTypes';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

export async function agyLocalLauncher(session: AgySession): Promise<LocalLaunchExitReason> {
    const pendingToolCalls: AgyToolCall[] = [];

    // 1. Create transcript scanner to tail transcript_full.jsonl in real time
    const scanner = await createAgySessionScanner({
        resumeBrainUuid: session.sessionId ?? undefined,
        onEntry: (entry: AgyTranscriptEntry) => {
            // Buffer tool calls from planner response so we can pair them with action entries
            if (entry.type === 'PLANNER_RESPONSE' && entry.tool_calls && entry.tool_calls.length > 0) {
                pendingToolCalls.push(...entry.tool_calls);
            }

            let pairedToolCall: AgyToolCall | undefined;
            if (entry.type !== 'USER_INPUT' && entry.type !== 'PLANNER_RESPONSE' && pendingToolCalls.length > 0) {
                pairedToolCall = pendingToolCalls.shift();
            }

            session.client.sendAgySessionMessage(entry, scanner.getBrainUuid() ?? undefined, pairedToolCall);
        },
        onTitle: (title) => {
            if (title) {
                session.client.updateMetadata((metadata) => ({
                    ...metadata,
                    summary: {
                        text: title,
                        updatedAt: Date.now()
                    }
                }));
            }
        }
    });

    const handleSessionFound = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(handleSessionFound);

    // 2. Setup permission handler
    const permissionHandler = new AgyPermissionHandler(session.client, {
        getPermissionMode: () => session.getPermissionMode() as any,
        onModeChange: (mode) => session.setPermissionMode(mode as any)
    });

    let hookServer: Awaited<ReturnType<typeof startHookServer>> | null = null;
    let carrierDir: string | undefined;

    const launcher = new BaseLocalLauncher({
        label: 'local',
        failureLabel: 'Local Antigravity process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.mode,
        launch: async (abortSignal) => {
            // Start hook server for permission bridging and conversation discovery
            hookServer = await startHookServer({
                token: randomUUID(),
                onSessionHook: (sessionId) => {
                    session.onSessionFound(sessionId);
                },
                onPreToolUse: async (data) => {
                    if (data.conversationId) {
                        session.onSessionFound(data.conversationId);
                    }
                    const toolName = extractToolName(data) ?? '';
                    const toolInput = extractToolInput(data);
                    const toolUseId = extractToolUseId(data) ?? `${toolName}-${Date.now()}`;
                    return permissionHandler.requestDecision(toolUseId, toolName, toolInput);
                }
            });

            const { command, args } = getHappyCliCommand([
                'hook-forwarder',
                '--flavor', 'agy',
                '--from-env'
            ]);
            const preToolUseCmd = shellJoin([command, ...args]);

            const { command: discCmd, args: discArgs } = getHappyCliCommand([
                'hook-forwarder',
                '--flavor', 'agy',
                '--from-env',
                '--event', 'pre-invocation'
            ]);
            const preInvocationCmd = shellJoin([discCmd, ...discArgs]);

            const hooksJson = buildAgyHooksJson({
                preToolUseCommand: preToolUseCmd,
                preInvocationCommand: preInvocationCmd
            });

            const carrier = prepareAgyHookCarrier(hooksJson);
            carrierDir = carrier?.carrierDir;

            try {
                await agyLocal({
                    path: session.path,
                    abort: abortSignal,
                    sessionId: session.sessionId,
                    model: (session.getModel() as string) ?? undefined,
                    effort: (session.getEffort() as string) ?? undefined,
                    permissionMode: session.getPermissionMode(),
                    hookCarrierDir: carrierDir,
                    hookPort: hookServer.port,
                    hookToken: hookServer.token
                });
            } finally {
                cleanupAgyHookCarrier(carrierDir);
                hookServer?.stop();
            }
        },
        sendFailureMessage: (message) => {
            session.client.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    try {
        return await launcher.run();
    } finally {
        permissionHandler.cancelAll('Session ended');
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
