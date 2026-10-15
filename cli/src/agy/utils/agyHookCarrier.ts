import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    unlinkSync,
    writeFileSync,
    renameSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { resolveHapiHomeDir } from '@/configuration';

export type AgyHookCarrier = {
    carrierDir: string;
};

export type AgyMcpServerEntry = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
};

const AGY_CARRIERS_DIRNAME = 'agy-carriers';
const OWNER_FILE_NAME = 'owner.json';
const CARRIER_DIR_PREFIX = 'hapi-agy-carrier-';

function agyCarriersRootDir(): string {
    return join(resolveHapiHomeDir(), AGY_CARRIERS_DIRNAME);
}

function writeOwnerMetadata(carrierDir: string): void {
    try {
        writeFileSync(
            join(carrierDir, OWNER_FILE_NAME),
            JSON.stringify({ pid: process.pid, time: Date.now() }),
            { mode: 0o600 }
        );
    } catch {
        // Best effort
    }
}

/**
 * Create an extra AGY workspace containing HAPI's session-local hook and MCP plugin.
 * The user's HOME, global hooks, and target project remain untouched.
 */
export function prepareAgyHookCarrier(
    hooksJsonContent: string,
    mcpServer?: AgyMcpServerEntry
): AgyHookCarrier | undefined {
    let carrierDir: string | undefined;
    try {
        const carriersRoot = agyCarriersRootDir();
        mkdirSync(carriersRoot, { recursive: true, mode: 0o700 });
        carrierDir = mkdtempSync(join(carriersRoot, CARRIER_DIR_PREFIX));
        writeOwnerMetadata(carrierDir);
        const agentsDir = join(carrierDir, '.agents');
        mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(agentsDir, 'hooks.json'), hooksJsonContent, { mode: 0o600 });
        if (mcpServer) {
            const pluginDir = join(agentsDir, 'plugins', 'hapi');
            mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
            writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'hapi' }), { mode: 0o600 });
            writeFileSync(
                join(pluginDir, 'mcp_config.json'),
                JSON.stringify({ mcpServers: { hapi: mcpServer } }),
                { mode: 0o600 }
            );
        }
        logger.debug(`[agyHookCarrier] prepared at ${carrierDir}`);
        return { carrierDir };
    } catch (error) {
        if (carrierDir) {
            try { rmSync(carrierDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        logger.debug('[agyHookCarrier] preparation failed', error);
        return undefined;
    }
}

export function agyHookCarrierIsIntact(carrierDir: string): boolean {
    return existsSync(join(carrierDir, '.agents', 'hooks.json'));
}

export function writeAgyHooksJsonAtomic(carrierDir: string, hooksJsonContent: string): void {
    const agentsDir = join(carrierDir, '.agents');
    const target = join(agentsDir, 'hooks.json');
    const tmpPath = join(agentsDir, `.hooks.json.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
        writeFileSync(tmpPath, hooksJsonContent, { mode: 0o600 });
        renameSync(tmpPath, target);
        renamed = true;
    } finally {
        if (!renamed) {
            try { unlinkSync(tmpPath); } catch { /* best-effort */ }
        }
    }
}

export function cleanupAgyHookCarrier(carrierDir: string | undefined): void {
    if (!carrierDir) return;
    try {
        rmSync(carrierDir, { recursive: true, force: true });
        logger.debug(`[agyHookCarrier] cleaned up ${carrierDir}`);
    } catch (error) {
        logger.debug(`[agyHookCarrier] cleanup failed for ${carrierDir}`, error);
    }
}
