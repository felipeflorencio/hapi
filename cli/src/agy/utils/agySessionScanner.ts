import { open, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { BaseSessionScanner } from "@/modules/common/session/BaseSessionScanner"
import { logger } from "@/lib"
import type { AgyTranscriptEntry } from "./agyTranscriptTypes"
import { resolveAgyTurnModels } from "./agyConversationModel"
import { readAgyConversationTitle, type ReadAgyConversationTitle } from "./agySessionTitle"

const AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain')
const LOG_REL_PATH = join('.system_generated', 'logs', 'transcript_full.jsonl')

const MODEL_SETTLING_RETRY_DELAYS_MS = [100, 200, 300] as const

type ResolveModels = typeof resolveAgyTurnModels
type Sleep = (delayMs: number, signal?: AbortSignal) => Promise<void>

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
        const timeout = setTimeout(done, delayMs)
        signal?.addEventListener('abort', done, { once: true })
        function done() {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', done)
            resolve()
        }
    })
}

export async function emitAgyEntriesWithModels(
    entries: AgyTranscriptEntry[],
    onEntry: (entry: AgyTranscriptEntry) => void,
    brainUuid: string | null,
    options: {
        resolveModels?: ResolveModels
        retryDelaysMs?: readonly number[]
        sleep?: Sleep
        signal?: AbortSignal
    } = {},
): Promise<void> {
    const resolveModels = options.resolveModels ?? resolveAgyTurnModels
    const retryDelaysMs = options.retryDelaysMs ?? MODEL_SETTLING_RETRY_DELAYS_MS
    const sleep = options.sleep ?? abortableSleep
    const unresolvedEntries = new Map(
        entries
            .filter((entry) => entry.type === 'PLANNER_RESPONSE' && !entry.model)
            .map((entry) => [entry.step_index, entry]),
    )
    let unresolved = [...unresolvedEntries.keys()]

    for (let attempt = 0; unresolved.length > 0; attempt++) {
        const models = await resolveModels(brainUuid, unresolved)
        const stillUnresolved: number[] = []
        for (const stepIndex of unresolved) {
            const model = models.get(stepIndex)
            const entry = unresolvedEntries.get(stepIndex)
            if (model && entry) entry.model = model
            else stillUnresolved.push(stepIndex)
        }
        unresolved = stillUnresolved
        if (unresolved.length === 0 || attempt >= retryDelaysMs.length || options.signal?.aborted) break
        await sleep(retryDelaysMs[attempt], options.signal)
        if (options.signal?.aborted) break
    }

    for (const entry of entries) onEntry(entry)
}

function brainLogPath(uuid: string): string {
    return join(AGY_BRAIN_DIR, uuid, LOG_REL_PATH)
}

type CreateAgySessionScannerOpts = {
    onEntry: (entry: AgyTranscriptEntry) => void
    /** Called with the current native title while the known brain is scanned. */
    onTitle?: (title: string | null) => void
    /** Injectable for tests; production reads Anti-Gravity's summary database. */
    readTitle?: ReadAgyConversationTitle
    /**
     * When set, the scanner seeds the existing transcript as processed and
     * uses this brain UUID directly. Used on resume: the launcher knows the
     * brain UUID from the previous session and passes it here so prior turns
     * are not re-emitted.
     */
    resumeBrainUuid?: string
}

export async function createAgySessionScanner(opts: CreateAgySessionScannerOpts) {
    const scanner = new AgySessionScanner(opts)
    await scanner.start()
    return {
        cleanup: async () => {
            await scanner.cleanup()
        },
        onNewSession: (uuid: string) => {
            scanner.onNewSession(uuid)
        },
        getBrainUuid: () => scanner.getBrainUuid(),
    }
}

export type AgySessionScannerHandle = Awaited<ReturnType<typeof createAgySessionScanner>>

class AgySessionScanner extends BaseSessionScanner<AgyTranscriptEntry> {
    private readonly onEntry: (entry: AgyTranscriptEntry) => void
    private readonly onTitle?: (title: string | null) => void
    private readonly readTitle: ReadAgyConversationTitle
    private foundBrainUuid: string | null = null
    private readonly modelSettlingAbortController = new AbortController()

    constructor(opts: CreateAgySessionScannerOpts) {
        super({ intervalMs: 500 })
        this.onEntry = opts.onEntry
        this.onTitle = opts.onTitle
        this.readTitle = opts.readTitle ?? readAgyConversationTitle
        if (opts.resumeBrainUuid) {
            this.foundBrainUuid = opts.resumeBrainUuid
            logger.debug(`[agy-scanner] resume: pre-seeded brain UUID ${opts.resumeBrainUuid}`)
        }
    }

    getBrainUuid(): string | null {
        return this.foundBrainUuid
    }

    public override async cleanup(): Promise<void> {
        this.modelSettlingAbortController.abort()
        await super.cleanup()
    }

    onNewSession(uuid: string): void {
        if (this.foundBrainUuid === uuid) return
        logger.debug(`[agy-scanner] onNewSession: switching brain to ${uuid}`)
        this.foundBrainUuid = uuid
        this.invalidate()
    }

    protected shouldScan(): boolean {
        return this.foundBrainUuid !== null
    }

    protected async beforeScan(): Promise<void> {
        if (!this.foundBrainUuid || !this.onTitle) return
        this.onTitle(await this.readTitle(this.foundBrainUuid))
    }

    protected async initialize(): Promise<void> {
        if (!this.foundBrainUuid) return
        const logPath = brainLogPath(this.foundBrainUuid)
        const { events, nextCursor } = await readBrainLog(logPath, 0)
        if (events.length > 0) {
            logger.debug(`[agy-scanner] seeding ${events.length} existing events from brain ${this.foundBrainUuid} as processed`)
            const keys = events.map((e) => generateKey(e.event))
            this.seedProcessedKeys(keys)
        }
        this.setCursor(logPath, nextCursor)
    }

    protected async findSessionFiles(): Promise<string[]> {
        if (this.foundBrainUuid) {
            return [brainLogPath(this.foundBrainUuid)]
        }
        return []
    }

    protected async parseSessionFile(filePath: string, cursor: number) {
        return readBrainLog(filePath, cursor)
    }

    protected generateEventKey(
        entry: AgyTranscriptEntry,
        _context: { filePath: string; lineIndex?: number },
    ): string {
        return generateKey(entry)
    }

    protected async handleFileScan(stats: {
        filePath: string
        events: AgyTranscriptEntry[]
        parsedCount: number
        newCount: number
        skippedCount: number
        cursor: number
        nextCursor: number
    }): Promise<void> {
        await emitAgyEntriesWithModels(stats.events, this.onEntry, this.foundBrainUuid, {
            signal: this.modelSettlingAbortController.signal,
        })
    }
}

function generateKey(entry: AgyTranscriptEntry): string {
    return `${entry.step_index}:${entry.type}`
}

export function extractBodyText(text: string): string {
    const separatorIndex = text.indexOf('\n\n')
    if (separatorIndex === -1) return text
    const prefix = text.slice(0, separatorIndex)
    if (!/^@\S+( @\S+)*$/.test(prefix)) return text
    return text.slice(separatorIndex + 2)
}

export function extractUserRequest(content: string): string | null {
    const open = '<USER_REQUEST>'
    const close = '</USER_REQUEST>'
    const start = content.indexOf(open)
    if (start === -1) return null
    const contentStart = start + open.length
    const end = content.indexOf(close, contentStart)
    if (end === -1) return null
    let request = content.slice(contentStart, end)
    if (request.startsWith('\n')) request = request.slice(1)
    if (request.endsWith('\n')) request = request.slice(0, -1)
    return request
}

export function normalizeUserInput(value: string): string {
    return value.replace(/\r\n/g, '\n').trim()
}

async function readBrainLog(
    filePath: string,
    cursor: number,
): Promise<{ events: { event: AgyTranscriptEntry; lineIndex?: number }[]; nextCursor: number }> {
    let size: number
    try {
        size = (await stat(filePath)).size
    } catch {
        return { events: [], nextCursor: cursor }
    }

    let from = cursor
    if (from > size) from = 0
    if (from >= size) return { events: [], nextCursor: size }

    let chunk: Buffer
    const fd = await open(filePath, 'r')
    try {
        const length = size - from
        chunk = Buffer.allocUnsafe(length)
        await fd.read(chunk, 0, length, from)
    } finally {
        await fd.close()
    }

    const lastNewline = chunk.lastIndexOf(0x0a)
    if (lastNewline === -1) return { events: [], nextCursor: from }
    const nextCursor = from + lastNewline + 1
    const text = chunk.subarray(0, lastNewline).toString('utf-8')

    const events: { event: AgyTranscriptEntry; lineIndex?: number }[] = []
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
            const entry = JSON.parse(line) as AgyTranscriptEntry & { type?: string }
            if (!entry.type || entry.type === 'CONVERSATION_HISTORY') continue
            events.push({ event: entry as AgyTranscriptEntry })
        } catch {
            continue
        }
    }

    return { events, nextCursor }
}
