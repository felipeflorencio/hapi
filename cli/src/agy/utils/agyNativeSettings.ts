import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '../types';

export type AgyNativeSettings = {
    toolPermission?: PermissionMode;
    rawToolPermission?: string;
    model?: string;
};

/**
 * Whether a `toolPermission` read from the native settings file may be applied
 * to a session that is already running. Only tightening is allowed: the file
 * is writable by anything running as this user, so honouring a loosening edit
 * mid-session would silently retire approval prompts the session started
 * under. Loosening stays a deliberate HAPI-side action.
 */
export function isTighteningNativeMode(mode: PermissionMode | undefined): boolean {
    return mode === 'request-review';
}

export function getAgySettingsPath(): string {
    const baseDir = process.env.AGY_HOME || join(homedir(), '.gemini', 'antigravity-cli');
    return join(baseDir, 'settings.json');
}

/**
 * Reads Antigravity CLI's native `~/.gemini/antigravity-cli/settings.json` so
 * HAPI respects the user's configured `toolPermission` (e.g. `always-proceed`)
 * and `model` by default when no explicit CLI override was passed.
 */
export function readAgyNativeSettings(settingsPath?: string): AgyNativeSettings {
    if (!settingsPath && process.env.VITEST) {
        return {};
    }
    const targetPath = settingsPath ?? getAgySettingsPath();
    try {
        const raw = readFileSync(targetPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const result: AgyNativeSettings = {};

        if (typeof parsed.toolPermission === 'string') {
            result.rawToolPermission = parsed.toolPermission;
            if (parsed.toolPermission === 'always-proceed') {
                result.toolPermission = 'always-proceed';
            } else if (parsed.toolPermission === 'request-review' || parsed.toolPermission === 'agent-decides') {
                result.toolPermission = 'request-review';
            }
        }

        if (typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
            result.model = parsed.model.trim();
        }

        return result;
    } catch {
        return {};
    }
}
