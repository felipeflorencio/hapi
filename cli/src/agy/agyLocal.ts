import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { getAgentLaunchCommand, resolveExecutable } from '@/agent/agentLaunchCommand';

export type AgyLocalPtyControls = {
    sendKeys: (keys: string) => void;
};

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
    onPtyReady?: (controls: AgyLocalPtyControls | null) => void;
    onStdinIntercept?: (chunk: Buffer) => boolean;
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
    // Delegate tool permission gating to the HAPI PreToolUse hook carrier (or skip if always-proceed)
    // so agy does not double-prompt after HAPI has already approved the tool call.
    if (
        (opts.permissionMode === 'always-proceed' || Boolean(opts.hookCarrierDir)) &&
        !args.includes('--dangerously-skip-permissions')
    ) {
        args.push('--dangerously-skip-permissions');
    }

    const env: Record<string, string | undefined> = {
        ...process.env,
        ...(opts.hookPort ? { HAPI_AGY_HOOK_PORT: String(opts.hookPort) } : {}),
        ...(opts.hookToken ? { HAPI_AGY_HOOK_TOKEN: opts.hookToken } : {}),
        ...opts.agyEnvVars,
    };

    logger.debug(`[AgyLocal] Spawning agy at ${command} with args: ${JSON.stringify(args)}`);

    const canUseBunPty =
        typeof Bun !== 'undefined' &&
        typeof Bun.spawn === 'function' &&
        Boolean(process.stdin.isTTY) &&
        Boolean(process.stdout.isTTY);

    if (canUseBunPty) {
        const wasRaw = Boolean(process.stdin.isRaw);
        try {
            if (typeof process.stdin.setRawMode === 'function') {
                process.stdin.setRawMode(true);
            }
        } catch {}
        process.stdin.resume();

        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;

        const proc = Bun.spawn([command, ...args], {
            cwd: opts.path,
            env: env as Record<string, string>,
            terminal: {
                cols,
                rows,
                data(_terminal, data) {
                    process.stdout.write(data);
                }
            }
        });

        const onStdinData = (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (opts.onStdinIntercept?.(buf)) {
                return;
            }
            try {
                proc.terminal?.write(buf);
            } catch {}
        };

        const onResize = () => {
            try {
                if (process.stdout.columns && process.stdout.rows) {
                    proc.terminal?.resize(process.stdout.columns, process.stdout.rows);
                }
            } catch {}
        };

        const onAbort = () => {
            try {
                proc.kill();
            } catch {}
        };

        process.stdin.on('data', onStdinData);
        process.stdout.on('resize', onResize);
        opts.abort.addEventListener('abort', onAbort, { once: true });

        opts.onPtyReady?.({
            sendKeys: (keys: string) => {
                try {
                    proc.terminal?.write(keys);
                } catch {}
            }
        });

        try {
            const exitCode = await proc.exited;
            if (!opts.abort.aborted && typeof exitCode === 'number' && exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
                throw new Error(`Process exited with code: ${exitCode}`);
            }
        } finally {
            opts.onPtyReady?.(null);
            opts.abort.removeEventListener('abort', onAbort);
            process.stdout.removeListener('resize', onResize);
            process.stdin.removeListener('data', onStdinData);
            try {
                proc.terminal?.close();
            } catch {}
            try {
                if (typeof process.stdin.setRawMode === 'function') {
                    process.stdin.setRawMode(wasRaw);
                }
            } catch {}
            restoreTerminalState();
        }
        return;
    }

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
