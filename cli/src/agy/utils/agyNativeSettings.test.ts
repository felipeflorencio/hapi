import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgyNativeSettings } from './agyNativeSettings';

describe('readAgyNativeSettings', () => {
    it('reads toolPermission: always-proceed and model from settings.json', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-settings-test-'));
        try {
            const path = join(dir, 'settings.json');
            writeFileSync(path, JSON.stringify({
                toolPermission: 'always-proceed',
                model: 'Gemini 4 Argon (High)'
            }));

            const settings = readAgyNativeSettings(path);
            expect(settings.toolPermission).toBe('always-proceed');
            expect(settings.rawToolPermission).toBe('always-proceed');
            expect(settings.model).toBe('Gemini 4 Argon (High)');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('maps request-review and agent-decides to request-review', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-settings-test-'));
        try {
            const path = join(dir, 'settings.json');
            writeFileSync(path, JSON.stringify({ toolPermission: 'agent-decides' }));
            expect(readAgyNativeSettings(path).toolPermission).toBe('request-review');

            writeFileSync(path, JSON.stringify({ toolPermission: 'request-review' }));
            expect(readAgyNativeSettings(path).toolPermission).toBe('request-review');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns empty object when file does not exist or is invalid JSON', () => {
        expect(readAgyNativeSettings('/nonexistent/path/settings.json')).toEqual({});
    });
});
