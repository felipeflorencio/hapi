import { describe, expect, it } from 'vitest'
import { parseAgyCommandOptions } from './agy'

describe('parseAgyCommandOptions', () => {
    it('defaults AGY to local mode for terminal runs', () => {
        expect(parseAgyCommandOptions([]).startingMode).toBe('local')
    })

    it('defaults AGY to remote mode when started by runner', () => {
        expect(parseAgyCommandOptions(['--started-by', 'runner']).startingMode).toBe('remote')
    })

    it('accepts explicit local mode', () => {
        expect(parseAgyCommandOptions(['--hapi-starting-mode', 'local']).startingMode).toBe('local')
    })

    it('accepts explicit remote mode', () => {
        expect(parseAgyCommandOptions(['--hapi-starting-mode', 'remote']).startingMode).toBe('remote')
    })

    it('rejects unsupported pty mode', () => {
        expect(() => parseAgyCommandOptions(['--hapi-starting-mode', 'pty'])).toThrow(
            'Invalid --hapi-starting-mode'
        )
    })
})
