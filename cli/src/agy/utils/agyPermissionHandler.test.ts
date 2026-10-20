import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import {
    AgyPermissionHandler,
    formatToolCallSummary,
    type TtyStreams
} from './agyPermissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

function stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createMockTty(): {
    streams: TtyStreams;
    input: EventEmitter;
    getOutput: () => string;
} {
    const input = new EventEmitter() as EventEmitter & {
        isRaw?: boolean;
        setRawMode?: (mode: boolean) => void;
        unref?: () => void;
        destroy?: () => void;
    };
    input.isRaw = false;
    input.setRawMode = (raw: boolean) => {
        input.isRaw = raw;
    };
    input.unref = vi.fn();
    input.destroy = vi.fn();

    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => {
        written += chunk.toString('utf8');
    });

    const streams: TtyStreams = {
        ttyIn: input as any,
        ttyOut: output as any
    };

    return {
        streams,
        input,
        getOutput: () => written
    };
}

function createHarness(options: {
    getPermissionMode?: () => any;
    enableLocalPrompt?: boolean;
    ttyStreams?: TtyStreams | null;
} = {}) {
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };
    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();

    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        }
    };

    const handler = new AgyPermissionHandler(client as any, {
        getPermissionMode: options.getPermissionMode ?? (() => 'default'),
        enableLocalPrompt: options.enableLocalPrompt ?? true,
        ttyFactory: () => options.ttyStreams ?? null
    });

    return {
        handler,
        rpcHandlers,
        getAgentState: () => agentState
    };
}

describe('formatToolCallSummary', () => {
    it('formats run_command with CommandLine', () => {
        expect(formatToolCallSummary('run_command', { CommandLine: 'echo "hello"' }))
            .toBe('run_command ("echo "hello"")');
    });

    it('truncates long CommandLine in run_command', () => {
        const longCmd = 'echo ' + 'a'.repeat(80);
        const formatted = formatToolCallSummary('run_command', { CommandLine: longCmd });
        expect(formatted).toContain('run_command ("');
        expect(formatted).toContain('...');
        expect(formatted.length).toBeLessThan(80);
    });

    it('formats write_to_file and replace_file_content with TargetFile', () => {
        expect(formatToolCallSummary('write_to_file', { TargetFile: 'src/index.ts' }))
            .toBe('write_to_file (src/index.ts)');
        expect(formatToolCallSummary('replace_file_content', { TargetFile: 'src/index.ts' }))
            .toBe('replace_file_content (src/index.ts)');
    });

    it('formats other tools with recognizable fields', () => {
        expect(formatToolCallSummary('search_web', { query: 'bun runtime' }))
            .toBe('search_web ("bun runtime")');
        expect(formatToolCallSummary('read_url_content', { Url: 'https://example.com' }))
            .toBe('read_url_content (https://example.com)');
        expect(formatToolCallSummary('manage_task', { Action: 'list' }))
            .toBe('manage_task (list)');
    });
});

describe('AgyPermissionHandler auto-allow', () => {
    it('auto-allows read-only and native question tools without prompting', async () => {
        const mockTty = createMockTty();
        const { handler, getAgentState } = createHarness({ ttyStreams: mockTty.streams });

        const viewResult = await handler.requestDecision('view-1', 'view_file', { AbsolutePath: '/tmp/test' });
        expect(viewResult).toEqual({ permissionDecision: 'allow' });

        const questionResult = await handler.requestDecision('q-1', 'ask_question', { questions: [] });
        expect(questionResult).toEqual({ permissionDecision: 'allow' });

        // No pending requests registered
        expect(Object.keys(getAgentState().requests)).toHaveLength(0);
        // TTY output was not written to
        expect(mockTty.getOutput()).toBe('');
    });

    it('gates the network tools instead of auto-allowing them', async () => {
        const mockTty = createMockTty();
        const { handler, getAgentState } = createHarness({ ttyStreams: mockTty.streams });

        // `read_url_content` can carry workspace content out in the URL and
        // pulls untrusted text back in, so it must not short-circuit the
        // mode check the way the local read-only tools do.
        const pending = handler.requestDecision('url-1', 'read_url_content', {
            Url: 'https://example.com'
        });

        expect(getAgentState().requests['url-1']).toBeDefined();
        expect(stripAnsi(mockTty.getOutput())).toContain('Approve read_url_content');

        mockTty.input.emit('data', Buffer.from('y'));
        await expect(pending).resolves.toMatchObject({ permissionDecision: 'allow' });
    });

    it('still auto-allows the network tools under always-proceed', async () => {
        const mockTty = createMockTty();
        const { handler, getAgentState } = createHarness({
            getPermissionMode: () => 'always-proceed',
            ttyStreams: mockTty.streams
        });

        const result = await handler.requestDecision('web-1', 'search_web', { query: 'bun' });
        expect(result).toEqual({ permissionDecision: 'allow' });
        expect(Object.keys(getAgentState().requests)).toHaveLength(0);
        expect(mockTty.getOutput()).toBe('');
    });

    it('auto-allows everything in always-proceed mode', async () => {
        const mockTty = createMockTty();
        const { handler } = createHarness({
            getPermissionMode: () => 'always-proceed',
            ttyStreams: mockTty.streams
        });

        const result = await handler.requestDecision('cmd-1', 'run_command', { CommandLine: 'rm -rf /' });
        expect(result).toEqual({ permissionDecision: 'allow' });
        expect(mockTty.getOutput()).toBe('');
    });
});

describe('Dual-Approval: Local approval', () => {
    it('approves tool use when local user types y', async () => {
        const mockTty = createMockTty();
        const { handler, getAgentState } = createHarness({ ttyStreams: mockTty.streams });

        const promise = handler.requestDecision('call-1', 'run_command', {
            CommandLine: 'echo "test"'
        });

        // Prompt was displayed
        const output = stripAnsi(mockTty.getOutput());
        expect(output).toContain('Approve run_command ("echo "test"")?');
        expect(output).toContain('[y]es');
        // Remote agent state has the pending request
        expect(getAgentState().requests['call-1']).toBeDefined();

        // Local user presses 'y'
        mockTty.input.emit('data', Buffer.from('y'));

        const decision = await promise;
        expect(decision).toEqual({
            permissionDecision: 'allow',
            permissionOverrides: undefined
        });

        // Prompt shows approved locally
        expect(mockTty.getOutput()).toContain('Approved locally');
        // Remote agent state removed pending and marked completed
        expect(getAgentState().requests['call-1']).toBeUndefined();
        expect(getAgentState().completedRequests['call-1']).toMatchObject({
            status: 'approved',
            decision: 'approved'
        });
    });

    it('approves for session when local user types a', async () => {
        const mockTty = createMockTty();
        const { handler, getAgentState } = createHarness({ ttyStreams: mockTty.streams });

        const promise = handler.requestDecision('call-2', 'run_command', {
            CommandLine: 'git status'
        });

        // User presses 'a' for always
        mockTty.input.emit('data', Buffer.from('a'));

        const decision = await promise;
        expect(decision.permissionDecision).toBe('allow');
        expect(decision.permissionOverrides).toEqual(['command(git status)']);

        expect(mockTty.getOutput()).toContain('Approved for session locally');
        expect(getAgentState().completedRequests['call-2']).toMatchObject({
            status: 'approved',
            decision: 'approved_for_session'
        });

        // Subsequent call with same command should auto-allow without prompt
        const secondCall = await handler.requestDecision('call-3', 'run_command', {
            CommandLine: 'git status'
        });
        expect(secondCall).toEqual({ permissionDecision: 'allow' });
    });

    it('denies tool use when local user types n', async () => {
        const mockTty = createMockTty();
        const { handler, getAgentState } = createHarness({ ttyStreams: mockTty.streams });

        const promise = handler.requestDecision('call-4', 'run_command', {
            CommandLine: 'npm install'
        });

        mockTty.input.emit('data', Buffer.from('n'));

        const decision = await promise;
        expect(decision.permissionDecision).toBe('deny');
        expect(decision.reason).toContain('Declined by user in terminal');

        expect(mockTty.getOutput()).toContain('Declined locally');
        expect(getAgentState().completedRequests['call-4']).toMatchObject({
            status: 'denied',
            decision: 'denied'
        });
    });

    it('denies tool use when local user presses Ctrl+C (0x03) or Escape (0x1b)', async () => {
        const mockTty = createMockTty();
        const { handler } = createHarness({ ttyStreams: mockTty.streams });

        const promise = handler.requestDecision('call-5', 'run_command', {
            CommandLine: 'npm publish'
        });

        mockTty.input.emit('data', Buffer.from([3])); // Ctrl+C

        const decision = await promise;
        expect(decision.permissionDecision).toBe('deny');
        expect(mockTty.getOutput()).toContain('Declined locally');
    });
});

describe('Dual-Approval: Remote approval wins', () => {
    it('resolves tool use and dismisses local prompt when remote user approves', async () => {
        const mockTty = createMockTty();
        const { handler, rpcHandlers, getAgentState } = createHarness({ ttyStreams: mockTty.streams });

        const promise = handler.requestDecision('call-6', 'run_command', {
            CommandLine: 'docker build .'
        });

        expect(mockTty.getOutput()).toContain('run_command ("docker build .")');

        // Remote user sends approval via RPC
        const rpcHandler = rpcHandlers.get(RPC_METHODS.Permission);
        expect(rpcHandler).toBeDefined();

        await rpcHandler!({
            id: 'call-6',
            approved: true,
            decision: 'approved'
        });

        const decision = await promise;
        expect(decision.permissionDecision).toBe('allow');

        // Local prompt was updated with remote approval notice
        expect(mockTty.getOutput()).toContain('Approved via remote (mobile/web)');
        expect(getAgentState().completedRequests['call-6']).toMatchObject({
            status: 'approved'
        });
    });

    it('denies tool use and dismisses local prompt when remote user denies', async () => {
        const mockTty = createMockTty();
        const { handler, rpcHandlers } = createHarness({ ttyStreams: mockTty.streams });

        const promise = handler.requestDecision('call-7', 'write_to_file', {
            TargetFile: 'secrets.env'
        });

        const rpcHandler = rpcHandlers.get(RPC_METHODS.Permission);
        await rpcHandler!({
            id: 'call-7',
            approved: false,
            decision: 'denied',
            reason: 'Do not touch secrets'
        });

        const decision = await promise;
        expect(decision.permissionDecision).toBe('deny');
        expect(decision.reason).toBe('Do not touch secrets');

        expect(mockTty.getOutput()).toContain('Declined via remote');
    });
});

describe('Dual-Approval: Graceful fallback without TTY', () => {
    it('operates via remote only if TTY is unavailable', async () => {
        const { handler, rpcHandlers, getAgentState } = createHarness({ ttyStreams: null });

        const promise = handler.requestDecision('call-8', 'run_command', {
            CommandLine: 'echo "headless"'
        });

        expect(getAgentState().requests['call-8']).toBeDefined();

        const rpcHandler = rpcHandlers.get(RPC_METHODS.Permission);
        await rpcHandler!({
            id: 'call-8',
            approved: true
        });

        const decision = await promise;
        expect(decision.permissionDecision).toBe('allow');
    });
});
