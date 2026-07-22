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
const MSG_IN_FIELDS = /\.(?:error|warn|info|debug|fatal|trace)\(\s*\{[^{}]*\bmsg\s*:/

describe('logging', function() {
    it('never passes msg inside the logger fields object', function() {
        // mocha runs from the repo root; __dirname is unavailable when ts-node
        // treats the file as an ES module
        const srcDir = path.resolve(process.cwd(), 'src')
        const offenders: string[] = []

        for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
            const contents = fs.readFileSync(path.join(srcDir, file), 'utf8')
            // Match across line breaks: these calls are often wrapped over several lines
            const collapsed = contents.replace(/\r?\n\s*/g, ' ')
            if (MSG_IN_FIELDS.test(collapsed)) {
                offenders.push(file)
            }
        }

        assert.deepEqual(offenders, [],
            `pass the message as the second argument instead: ${offenders.join(', ')}`)
    })
})
