import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { getAgentLaunchCommand, resolveExecutable } from '@/agent/agentLaunchCommand';

export type AgyLocalOptions = {
    path: string;
    abort: AbortSignal;
    sessionId?: string | null;
    model?: string;
    effort?: string;
    permissionMode?: string;
    hookCarrierDir?: string;
    hookPort?: number;
    hookToken?: string;
    agyArgs?: string[];
    agyEnvVars?: Record<string, string>;
};

export async function agyLocal(opts: AgyLocalOptions): Promise<void> {
    if (opts.abort.aborted) {
        logger.debug('[AgyLocal] Abort already signaled; skipping launch');
        return;
    }

    const command = resolveExecutable(getAgentLaunchCommand('agy')) ?? 'agy';
    const args: string[] = [];

    if (opts.agyArgs) {
        args.push(...opts.agyArgs);
    }
    if (opts.hookCarrierDir) {
        args.push('--add-dir', opts.hookCarrierDir);
    }
    if (opts.sessionId) {
        args.push('--conversation', opts.sessionId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.effort) {
        args.push('--effort', opts.effort);
    }
    if (opts.permissionMode === 'always-proceed') {
        args.push('--dangerously-skip-permissions');
    }

    const env: Record<string, string | undefined> = {
        ...process.env,
        ...(opts.hookPort ? { HAPI_AGY_HOOK_PORT: String(opts.hookPort) } : {}),
        ...(opts.hookToken ? { HAPI_AGY_HOOK_TOKEN: opts.hookToken } : {}),
        ...opts.agyEnvVars,
    };

    logger.debug(`[AgyLocal] Spawning agy at ${command} with args: ${JSON.stringify(args)}`);

    await spawnWithTerminalGuard({
        command,
        args,
        cwd: opts.path,
        env: env as Record<string, string>,
        signal: opts.abort,
        logLabel: 'AgyLocal',
        spawnName: 'agy',
        installHint: 'Install Antigravity CLI via agy'
    });
}
