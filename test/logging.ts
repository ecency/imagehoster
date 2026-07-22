import 'mocha'
import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Bunyan takes the message as its second argument. A `msg` key inside the
 * fields object is overwritten by the (empty) message, so the text never
 * reaches the log record — the line is emitted as `"msg":""` and becomes
 * invisible to log search and to anything alerting on it.
 */
const LOG_CALL = /\.(?:error|warn|info|debug|fatal|trace)\(\s*\{/g

/**
 * Walk the object literal that starts at `start` (the index of its `{`) and
 * report whether it has a top-level `msg` key. Nested objects are skipped by
 * depth rather than by a character class, so `{ info: { a: 1 }, msg: 'x' }` is
 * still caught, and `msg` inside a string or a nested object is not.
 */
function hasTopLevelMsgKey(source: string, start: number): boolean {
    let depth = 0
    let quote: string | null = null

    for (let i = start; i < source.length; i++) {
        const char = source[i]

        if (quote) {
            if (char === '\\') { i++ } else if (char === quote) { quote = null }
            continue
        }

        if (char === '"' || char === "'" || char === '`') { quote = char; continue }
        if (char === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i === -1) { return false } ; continue }
        if (char === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i); if (i === -1) { return false } ; i++; continue }
        if (char === '{' || char === '(' || char === '[') { depth++; continue }
        if (char === '}' || char === ')' || char === ']') {
            depth--
            if (depth === 0) { return false } // end of the fields object
            continue
        }

        if (depth === 1 && /msg/.test(source.slice(i, i + 3)) && /^\s*:/.test(source.slice(i + 3))) {
            // only a standalone key, not a suffix like `errMsg:`
            const before = source[i - 1] || ''
            if (!/[A-Za-z0-9_$]/.test(before)) { return true }
        }
    }

    return false
}

function collectSourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { return collectSourceFiles(full) }
        return entry.isFile() && full.endsWith('.ts') ? [full] : []
    })
}

describe('logging', function() {
    it('never passes msg inside the logger fields object', function() {
        // mocha runs from the repo root; __dirname is unavailable when ts-node
        // treats the file as an ES module
        const srcDir = path.resolve(process.cwd(), 'src')
        const offenders: string[] = []

        for (const file of collectSourceFiles(srcDir)) {
            const contents = fs.readFileSync(file, 'utf8')
            LOG_CALL.lastIndex = 0
            let match = LOG_CALL.exec(contents)
            while (match !== null) {
                if (hasTopLevelMsgKey(contents, match.index + match[0].length - 1)) {
                    offenders.push(path.relative(srcDir, file))
                    break
                }
                match = LOG_CALL.exec(contents)
            }
        }

        assert.deepEqual(offenders, [],
            `pass the message as the second argument instead: ${offenders.join(', ')}`)
    })
})
