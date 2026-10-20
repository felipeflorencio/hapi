import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub out `@/configuration` so the helper considers our tmpdir HAPI-managed.
// Tests that exercise the non-managed branch override happyHomeDir explicitly.
vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir(): string {
            return (globalThis as { __hapiHomeStub?: string }).__hapiHomeStub ?? tmpdir();
        }
    }
}));

// `@/ui/logger` reads `configuration.logsDir` at module load. We only need the
// .debug / .warn surface here, so substitute spy shims — tests can assert
// against `loggerMock.warn` to lock in the warn-on-failure contract.
// `vi.hoisted` ensures the mocks exist when the hoisted `vi.mock` factory runs.
const loggerMock = vi.hoisted(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn()
}));
vi.mock('@/ui/logger', () => ({ logger: loggerMock }));

import { ensureOpencodeHookPlugin } from './hookPlugin';

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function setHapiHome(value: string): void {
    (globalThis as { __hapiHomeStub?: string }).__hapiHomeStub = value;
}

function resetHapiHome(): void {
    delete (globalThis as { __hapiHomeStub?: string }).__hapiHomeStub;
}

describe('buildPluginSource (via ensureOpencodeHookPlugin)', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = makeTempDir('hapi-hookplugin-src-');
    });

    afterEach(() => {
        rmSync(tempRoot, { recursive: true, force: true });
        resetHapiHome();
    });

    it('emits real newlines, not the literal two-character escape', () => {
        const pluginPath = ensureOpencodeHookPlugin(tempRoot, 'http://127.0.0.1:1/hook', 'tok');
        const source = readFileSync(pluginPath, 'utf-8');
        // Regression for the bug where `.join('\\n')` produced a single-line
        // file riddled with literal `\n` sequences and was silently dropped by
        // opencode's plugin loader as a syntax error.
        expect(source).not.toMatch(/\\n/);
        expect(source.split('\n').length).toBeGreaterThan(50);
    });

    it('encodes hook url and token without injection-via-quote', () => {
        const evilToken = 'a"; process.exit(1); //';
        const pluginPath = ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', evilToken);
        const source = readFileSync(pluginPath, 'utf-8');
        // The token must be JSON-escaped — embedding the raw string would let
        // a malicious caller terminate the literal and inject JS into the
        // generated plugin.
        expect(source).toContain(JSON.stringify(evilToken));
        expect(source).not.toContain(`= "${evilToken}";`);
    });

    it('preserves the file unchanged when called with identical inputs', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');
        const first = readFileSync(join(tempRoot, 'plugins', 'hapi-hook.ts'));
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');
        const second = readFileSync(join(tempRoot, 'plugins', 'hapi-hook.ts'));
        expect(second.equals(first)).toBe(true);
    });
});

type HookCall = { event: string; payload: unknown; sessionId: string | null };

/**
 * Load the generated plugin the way opencode does - as an ES module - and
 * drive its opencode 2.x entry point with a fake context. This is the only
 * place the generated translation logic is executable, so the v2 event
 * vocabulary is asserted here rather than by string matching.
 */
async function runV2Plugin(events: unknown[], root: string): Promise<HookCall[]> {
    const pluginPath = ensureOpencodeHookPlugin(root, 'http://127.0.0.1:1/hook', 'tok');
    const calls: HookCall[] = [];
    const fetchStub = vi.fn(async (_url: string, init: { body: string }) => {
        calls.push(JSON.parse(init.body) as HookCall);
        return { ok: true } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchStub);

    const module = await import(/* @vite-ignore */ pluginPath) as {
        default: { id: string; setup: (context: unknown) => Promise<void> };
    };

    let drained = false;
    const context = {
        event: {
            subscribe: () => (async function* () {
                for (const event of events) {
                    yield event;
                }
                drained = true;
            })()
        }
    };

    await module.default.setup(context);
    // setup detaches the consumer on purpose, so wait for the generator to
    // finish instead of assuming a single microtask is enough.
    for (let i = 0; i < 200 && !drained; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.unstubAllGlobals();
    return calls;
}

function v2(type: string, data: Record<string, unknown>, durable?: Record<string, unknown>): unknown {
    return { id: `evt_${type}`, created: 1, type, ...(durable ? { durable } : {}), data };
}

describe('generated plugin: opencode loader contract', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = makeTempDir('hapi-hookplugin-shape-');
    });

    afterEach(() => {
        rmSync(tempRoot, { recursive: true, force: true });
        resetHapiHome();
    });

    it('exports a default definition carrying an id and a setup function', () => {
        const source = readFileSync(ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't'), 'utf-8');
        // opencode 2.x rejects the module outright without this: its loader
        // requires `export default` with an id plus setup/effect. The 1.x
        // named export alone produced
        // `PluginModule.LoadError: Missing key at ["default"]`.
        expect(source).toContain('export default {');
        expect(source).toContain("id: 'hapi-hook'");
        expect(source).toContain('setup: async (context) => {');
    });

    it('keeps the opencode 1.x named export so one file serves both majors', () => {
        const source = readFileSync(ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't'), 'utf-8');
        expect(source).toContain('export const HapiHookPlugin = async () => {');
    });
});

describe('generated plugin: opencode 2.x event translation', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = makeTempDir('hapi-hookplugin-v2-');
    });

    afterEach(() => {
        rmSync(tempRoot, { recursive: true, force: true });
        resetHapiHome();
    });

    it('stays inert when the context exposes no event surface', async () => {
        const pluginPath = ensureOpencodeHookPlugin(tempRoot, 'http://127.0.0.1:1/hook', 'tok');
        const module = await import(/* @vite-ignore */ pluginPath) as {
            default: { setup: (context: unknown) => Promise<void> };
        };
        // Throwing here would be reported as a load failure on every
        // reconnect; the storage scanner still carries messages.
        await expect(module.default.setup({})).resolves.toBeUndefined();
    });

    it('translates session lifecycle events into the launcher vocabulary', async () => {
        const calls = await runV2Plugin([
            v2('session.created', { sessionID: 'ses_1', info: { id: 'ses_1', title: 'x' } }),
            v2('session.renamed', { sessionID: 'ses_1', info: { id: 'ses_1', title: 'y' } })
        ], tempRoot);

        expect(calls.map((call) => call.event)).toEqual(['session.created', 'session.updated']);
        expect(calls[0].sessionId).toBe('ses_1');
        expect(calls[0].payload).toEqual({ info: { id: 'ses_1', title: 'x' } });
    });

    it('translates streamed text into message.part.updated with the delta', async () => {
        const calls = await runV2Plugin([
            v2('session.text.delta', {
                sessionID: 'ses_1', assistantMessageID: 'msg_1', textID: 'txt_1', delta: 'hel'
            }),
            v2('session.text.ended', {
                sessionID: 'ses_1', assistantMessageID: 'msg_1', textID: 'txt_1'
            })
        ], tempRoot);

        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual({
            event: 'message.part.updated',
            payload: { part: { type: 'text', id: 'txt_1', messageID: 'msg_1' }, delta: 'hel' },
            sessionId: 'ses_1'
        });
        expect(calls[1].payload).toEqual({ part: { type: 'text', id: 'txt_1', messageID: 'msg_1' } });
    });

    it('carries the tool name from called through to the success event', async () => {
        const calls = await runV2Plugin([
            v2('session.tool.input.started', {
                sessionID: 'ses_1', assistantMessageID: 'msg_1', callID: 'call_1', name: 'read'
            }),
            v2('session.tool.called', {
                sessionID: 'ses_1', assistantMessageID: 'msg_1', callID: 'call_1',
                tool: 'read', input: { filePath: 'a.txt' }
            }),
            v2('session.tool.success', {
                sessionID: 'ses_1', assistantMessageID: 'msg_1', callID: 'call_1', result: 'contents'
            })
        ], tempRoot);

        expect(calls.map((call) => call.event)).toEqual(['tool.execute.before', 'tool.execute.after']);
        expect(calls[0].payload).toEqual({
            tool: { id: 'call_1', name: 'read', input: { filePath: 'a.txt' } }
        });
        // `session.tool.success` carries only the callID; the launcher drops
        // nameless tool events, so the name has to survive from `.called`.
        expect(calls[1].payload).toMatchObject({
            tool: { id: 'call_1', name: 'read', input: { filePath: 'a.txt' } },
            output: 'contents'
        });
    });

    it('reports a failed tool as tool.execute.after with the error', async () => {
        const calls = await runV2Plugin([
            v2('session.tool.called', {
                sessionID: 'ses_1', callID: 'call_2', tool: 'bash', input: { command: 'false' }
            }),
            v2('session.tool.failed', {
                sessionID: 'ses_1', callID: 'call_2', error: { name: 'UnknownError' }
            })
        ], tempRoot);

        expect(calls[1].event).toBe('tool.execute.after');
        expect(calls[1].payload).toMatchObject({ error: { name: 'UnknownError' } });
    });

    it('drops a tool result whose call was never announced', async () => {
        const calls = await runV2Plugin([
            v2('session.tool.success', { sessionID: 'ses_1', callID: 'unknown', result: 'x' })
        ], tempRoot);

        expect(calls).toEqual([]);
    });

    it('accepts the session.next.* spelling of the same events', async () => {
        const calls = await runV2Plugin([
            v2('session.next.text.delta', {
                sessionID: 'ses_1', assistantMessageID: 'msg_1', textID: 'txt_1', delta: 'hi'
            })
        ], tempRoot);

        expect(calls.map((call) => call.event)).toEqual(['message.part.updated']);
    });

    it('ignores the domain reconciliation firehose', async () => {
        // subscribe() delivers every event regardless of the type argument,
        // so these arrive on every startup and must not reach the hook.
        const calls = await runV2Plugin([
            v2('model.updated', {}),
            v2('skill.updated', {}),
            v2('plugin.updated', {}),
            v2('session.usage.updated', { sessionID: 'ses_1', cost: 0 }),
            v2('location.shutdown', {})
        ], tempRoot);

        expect(calls).toEqual([]);
    });

    it('falls back to the durable aggregate id when data carries no sessionID', async () => {
        const calls = await runV2Plugin([
            v2('session.created', { info: { id: 'ses_9' } }, { aggregateID: 'ses_9', seq: 0, version: 1 })
        ], tempRoot);

        expect(calls[0].sessionId).toBe('ses_9');
    });

    it('passes permission events through unchanged', async () => {
        const calls = await runV2Plugin([
            v2('permission.asked', { sessionID: 'ses_1', id: 'perm_1' }),
            v2('permission.replied', { sessionID: 'ses_1', id: 'perm_1', response: 'once' })
        ], tempRoot);

        expect(calls.map((call) => call.event)).toEqual(['permission.asked', 'permission.replied']);
        expect(calls[0].payload).toMatchObject({ id: 'perm_1' });
    });
});

describe('ensurePluginRuntime (via ensureOpencodeHookPlugin)', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = makeTempDir('hapi-hookplugin-rt-');
        loggerMock.warn.mockClear();
    });

    afterEach(() => {
        rmSync(tempRoot, { recursive: true, force: true });
        resetHapiHome();
    });

    it('writes a minimal package.json pinned to a tested @opencode-ai/plugin version', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        const pkg = JSON.parse(readFileSync(join(tempRoot, 'package.json'), 'utf-8'));
        // Pinned (`^1.14.0`) rather than `*` — a wildcard would let a registry
        // change pull a moving target into a code-execution-adjacent path.
        const declared = pkg.dependencies['@opencode-ai/plugin'];
        expect(declared).toMatch(/^[\^~]?\d/);
        expect(declared).not.toBe('*');
    });

    it('preserves an existing package.json that already declares @opencode-ai/plugin', () => {
        const existing = JSON.stringify({
            dependencies: { '@opencode-ai/plugin': '1.14.30', somethingElse: '^2.0.0' }
        }, null, 2) + '\n';
        writeFileSync(join(tempRoot, 'package.json'), existing, 'utf-8');

        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        const actual = readFileSync(join(tempRoot, 'package.json'), 'utf-8');
        expect(actual).toBe(existing);
    });

    it('overwrites an existing package.json that does NOT declare @opencode-ai/plugin', () => {
        // Regression: short-circuiting on plain presence would silently re-create
        // the broken state — package.json sits there but plugin discovery fails.
        const unrelated = JSON.stringify({
            dependencies: { 'some-other-package': '^1.0.0' }
        }, null, 2) + '\n';
        writeFileSync(join(tempRoot, 'package.json'), unrelated, 'utf-8');

        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        const pkg = JSON.parse(readFileSync(join(tempRoot, 'package.json'), 'utf-8'));
        expect(pkg.dependencies['@opencode-ai/plugin']).toBeDefined();
    });

    it('does NOT write to a non-HAPI-managed dir (user-supplied OPENCODE_CONFIG_DIR)', () => {
        // Simulate a user pointing OPENCODE_CONFIG_DIR at their own ~/.config/opencode.
        // Even though it's empty, HAPI must not pollute it with a placeholder.
        const userOwned = makeTempDir('hapi-not-managed-');
        try {
            setHapiHome(makeTempDir('hapi-home-elsewhere-'));

            ensureOpencodeHookPlugin(userOwned, 'http://h/hook', 't');

            expect(existsSync(join(userOwned, 'package.json'))).toBe(false);
            // Plugin file is still written — that's HAPI's contract — but the
            // package.json side effect is gated.
            expect(existsSync(join(userOwned, 'plugins', 'hapi-hook.ts'))).toBe(true);
        } finally {
            rmSync(userOwned, { recursive: true, force: true });
            resetHapiHome();
        }
    });

    it('does not touch node_modules or package-lock.json (opencode materializes them)', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        expect(existsSync(join(tempRoot, 'node_modules'))).toBe(false);
        expect(existsSync(join(tempRoot, 'package-lock.json'))).toBe(false);
    });

    it('preserves existing node_modules and package-lock.json across launches', () => {
        // Real-world: opencode has run once, installed deps, and we are launching
        // again. The previous install's artifacts must survive our write.
        const placeholderNm = join(tempRoot, 'node_modules');
        const placeholderLock = join(tempRoot, 'package-lock.json');
        // Use directories/files we can checksum after the call.
        writeFileSync(placeholderLock, '{"name":"sentinel"}', 'utf-8');
        const lockBefore = readFileSync(placeholderLock, 'utf-8');

        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');

        expect(readFileSync(placeholderLock, 'utf-8')).toBe(lockBefore);
        // node_modules wasn't pre-staged in this case, so it should still be absent.
        expect(existsSync(placeholderNm)).toBe(false);
    });

    it('emits a warn (not a throw) when package.json cannot be written', async () => {
        // Pre-create a directory named `package.json` inside rootPath. The
        // subsequent writeFileSync will throw EISDIR / EPERM on every
        // platform. The launcher must keep going (scanner channel #589 is
        // the documented fallback) and surface the failure via logger.warn.
        const fs = await import('node:fs');
        fs.mkdirSync(join(tempRoot, 'package.json'));

        // Must not throw.
        expect(() => ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't')).not.toThrow();

        // Plugin file should still be written (that path is independent).
        expect(existsSync(join(tempRoot, 'plugins', 'hapi-hook.ts'))).toBe(true);

        // The failure must be surfaced — silent failure was the pre-#589
        // bug shape we are explicitly *not* repeating.
        expect(loggerMock.warn).toHaveBeenCalledTimes(1);
        expect(loggerMock.warn.mock.calls[0][0]).toMatch(/Failed to materialize/);
    });

    it('does not warn on the happy path', () => {
        ensureOpencodeHookPlugin(tempRoot, 'http://h/hook', 't');
        expect(loggerMock.warn).not.toHaveBeenCalled();
    });
});
