import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { agyLocal, type AgyLocalPtyControls } from './agyLocal';
import { AgySession } from './session';
import { createAgySessionScanner } from './utils/agySessionScanner';
import { AgyPermissionHandler } from './utils/agyPermissionHandler';
import { buildCanonicalAskUserQuestionInput, isAgyAskQuestionToolCall } from './utils/agyAskQuestion';
import { buildAgyQuestionKeys } from './utils/agyQuestionKeys';
import { readAgyNativeSettings } from './utils/agyNativeSettings';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { startHookServer, extractToolName, extractToolInput, extractToolUseId } from '@/claude/utils/startHookServer';
import { buildAgyHooksJson } from '@/modules/common/hooks/generateHookSettings';
import { prepareAgyHookCarrier, cleanupAgyHookCarrier } from './utils/agyHookCarrier';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { shellJoin } from '@/modules/common/shellQuote';
import { logger } from '@/ui/logger';
import type { AgyTranscriptEntry, AgyToolCall } from './utils/agyTranscriptTypes';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

const AGY_NON_TOOL_ACTION_TYPES = new Set<string>([
    'ERROR_MESSAGE',
    'SYSTEM_MESSAGE',
]);

export async function agyLocalLauncher(session: AgySession): Promise<LocalLaunchExitReason> {
    let pendingToolCalls: AgyToolCall[] = [];
    let ptyControls: AgyLocalPtyControls | null = null;
    const localPromptInput = new PassThrough();

    // Track native settings.json so live changes via `/settings` inside agy are picked up
    let lastObservedNativeMode = readAgyNativeSettings().toolPermission;

    // 1. Setup permission handler with Dual-Approval (local TTY + remote web/mobile)
    const permissionHandler = new AgyPermissionHandler(session.client, {
        getPermissionMode: () => {
            const currentNativeMode = readAgyNativeSettings().toolPermission;
            if (currentNativeMode && currentNativeMode !== lastObservedNativeMode) {
                lastObservedNativeMode = currentNativeMode;
                session.setPermissionMode(currentNativeMode);
            }
            return session.getPermissionMode() as any;
        },
        onModeChange: (mode) => session.setPermissionMode(mode as any),
        enableLocalPrompt: session.mode !== 'remote',
        ttyFactory: () => {
            if (!process.stdout.isTTY) {
                return null;
            }
            return {
                ttyIn: localPromptInput as any,
                ttyOut: process.stdout as any,
                closeOnFinish: false
            };
        }
    });

    const handleAskQuestion = (toolCall: AgyToolCall, stepIndex: number | undefined, callIndex: number, brainUuid?: string) => {
        const canonical = buildCanonicalAskUserQuestionInput(toolCall.args);
        if (canonical.questions.length === 0) {
            logger.debug('[agyLocalLauncher] ask_question tool_call had no parseable questions; skipping');
            return;
        }

        const toolUseId = brainUuid
            ? `${brainUuid}:${stepIndex ?? 'unknown'}:ask${callIndex}`
            : `local:${stepIndex ?? 'unknown'}:ask${callIndex}:${Date.now()}`;

        permissionHandler
            .registerQuestionRequest(toolUseId, canonical)
            .then((answers) => {
                const keys = buildAgyQuestionKeys(canonical.questions, answers);
                if (keys && ptyControls) {
                    ptyControls.sendKeys(keys);
                }
            })
            .catch((err) => {
                logger.debug('[agyLocalLauncher] ask_question pending request canceled or answered locally', { err });
            });
    };

    // 2. Create transcript scanner to tail transcript_full.jsonl in real time
    const scanner = await createAgySessionScanner({
        resumeBrainUuid: session.sessionId ?? undefined,
        onEntry: (entry: AgyTranscriptEntry) => {
            const brainUuid = scanner.getBrainUuid() ?? undefined;

            if (entry.type === 'USER_INPUT') {
                // If an ask_question form was pending on remote HAPI and the user answered
                // in the terminal, dismiss the remote question form now.
                permissionHandler.cancelPendingQuestions('Answered in terminal');
                session.client.sendAgySessionMessage(entry, brainUuid);
                return;
            }

            const hasText = (entry.content ?? '').trim().length > 0;
            const hasToolCalls = (entry.tool_calls?.length ?? 0) > 0;
            if (!hasText && !hasToolCalls) {
                return;
            }

            if (entry.type === 'PLANNER_RESPONSE') {
                const allToolCalls = entry.tool_calls ?? [];
                // Buffer non-question tool calls so we can pair them with action entries
                pendingToolCalls = allToolCalls.filter((tc) => !isAgyAskQuestionToolCall(tc));
                allToolCalls.forEach((toolCall, callIndex) => {
                    if (isAgyAskQuestionToolCall(toolCall)) {
                        handleAskQuestion(toolCall, entry.step_index, callIndex, brainUuid);
                    }
                });
                if (hasText) {
                    session.client.sendAgySessionMessage(entry, brainUuid);
                }
                return;
            }

            const pairedToolCall = AGY_NON_TOOL_ACTION_TYPES.has(entry.type)
                ? undefined
                : pendingToolCalls.shift();

            session.client.sendAgySessionMessage(entry, brainUuid, pairedToolCall);
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
                    hookToken: hookServer.token,
                    onPtyReady: (controls) => {
                        ptyControls = controls;
                    },
                    onStdinIntercept: (chunk) => {
                        if (permissionHandler.hasActiveLocalPrompt()) {
                            localPromptInput.write(chunk);
                            return true;
                        }
                        return false;
                    }
                });
            } finally {
                ptyControls = null;
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
        localPromptInput.destroy();
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
