/**
 * Sharded filesystem blob store.
 *
 * Distributes files into subdirectories based on the first 4 characters
 * of the key. This limits each directory to a manageable number of files
 * instead of millions in one flat dir.
 *
 * Backwards-compatible: reads check sharded path first, then flat path.
 * When a flat file is found, it is migrated to the sharded path via
 * link() + unlink() (safe for concurrent readers, never overwrites newer data).
 */

import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'

import { logger } from './logger'

function shardDir(key: string): string {
    // Keys look like 'UQmXyz...' (base58, ~195k buckets) or 'Uabcdef...' (hex, ~4k buckets)
    // Take first 4 chars as shard directory to keep ~10-50 files per dir at scale
    if (key.length >= 4) {
        return key.slice(0, 4)
    }
    return '_misc'
}

function shardedPath(root: string, key: string): string {
    return path.join(root, shardDir(key), key)
}

function flatPath(root: string, key: string): string {
    return path.join(root, key)
}

export class ShardedFsStore {
    readonly path: string
    private ensuredDirs = new Set<string>()

    constructor(rootPath: string) {
        this.path = rootPath
    }

    private ensureDir(dirPath: string, cb: (err?: any) => void) {
        if (this.ensuredDirs.has(dirPath)) {
            return cb()
        }
        fs.mkdir(dirPath, { recursive: true }, (err) => {
            if (err && err.code !== 'EEXIST') return cb(err)
            this.ensuredDirs.add(dirPath)
            cb()
        })
    }

    /**
     * Migrate a flat file to its sharded location.
     * Uses link() + unlink() instead of rename() to avoid two races:
     * - link() is a no-op if sPath already exists (EEXIST) → never overwrites newer data
     * - unlink() on fPath doesn't affect open file descriptors → no ENOENT for concurrent readers
     */
    private migrateToShard(key: string, fPath: string, sPath: string) {
        const dir = path.dirname(sPath)
        this.ensureDir(dir, (err) => {
            if (err) return
            fs.link(fPath, sPath, (linkErr) => {
                if (linkErr && linkErr.code !== 'EEXIST' && linkErr.code !== 'ENOENT') {
                    logger.warn({ err: linkErr, key }, 'shard migration link failed')
                    return
                }
                // Remove flat file — safe even if other readers have open fds (Unix semantics)
                fs.unlink(fPath, () => {})
            })
        })
    }

    createReadStream(opts: any): Readable {
        const key = typeof opts === 'string' ? opts : opts.key
        const sPath = shardedPath(this.path, key)
        const fPath = flatPath(this.path, key)

        // Try sharded path first — fast path for new/migrated files
        try {
            fs.accessSync(sPath, fs.constants.R_OK)
            return fs.createReadStream(sPath)
        } catch (_e) {
            // not in sharded location
        }

        // Fall back to flat path — migrate in background after stream is open
        const stream = fs.createReadStream(fPath)
        stream.once('open', () => {
            this.migrateToShard(key, fPath, sPath)
        })
        return stream
    }

    createWriteStream(opts: any, done?: (error: any, metadata?: any) => void) {
        const key = typeof opts === 'string' ? opts : opts.key
        const sPath = shardedPath(this.path, key)
        const dir = path.dirname(sPath)

        const { PassThrough } = require('stream')
        const proxy = new PassThrough()

        this.ensureDir(dir, (err) => {
            if (err) {
                if (done) done(err)
                else proxy.destroy(err)
                return
            }
            const ws = fs.createWriteStream(sPath)
            proxy.pipe(ws)
            ws.on('finish', () => { if (done) done(null, { key }) })
            ws.on('error', (writeErr) => { if (done) done(writeErr); else proxy.destroy(writeErr) })
        })

        return proxy
    }

    async putBuffer(key: string, data: Buffer): Promise<void> {
        const sPath = shardedPath(this.path, key)
        const dir = path.dirname(sPath)
        await fs.promises.mkdir(dir, { recursive: true })
        this.ensuredDirs.add(dir)
        await fs.promises.writeFile(sPath, data)
    }

    exists(opts: any, done: (error: any, exists?: boolean) => void) {
        const key = typeof opts === 'string' ? opts : opts.key
        const sPath = shardedPath(this.path, key)

        fs.stat(sPath, (err, stat) => {
            if (!err && stat) return done(null, true)
            // Check flat path
            fs.stat(flatPath(this.path, key), (err2, stat2) => {
                if (err2 && err2.code !== 'ENOENT') return done(err2)
                done(null, !!stat2)
            })
        })
    }

    remove(opts: any, done: (error: any) => void) {
        const key = typeof opts === 'string' ? opts : opts.key
        const sPath = shardedPath(this.path, key)

        fs.unlink(sPath, (err) => {
            // Always try flat path too — file may exist in either or both locations
            fs.unlink(flatPath(this.path, key), (err2) => {
                // Success if either unlink succeeded
                if (!err || !err2) return done(null)
                // Both failed — report if it's not just ENOENT
                if (err2.code !== 'ENOENT') return done(err2)
                if (err.code !== 'ENOENT') return done(err)
                done(null)
            })
        })
    }

    async removeByPrefix(prefix: string): Promise<number> {
        let count = 0

        // Always remove from flat root (legacy files)
        count += await this.removePrefixInDir(this.path, prefix)

        // For sharded files: if prefix is long enough to determine the shard,
        // scan only that shard. Otherwise scan all shard directories.
        if (prefix.length >= 4) {
            const shardPath = path.join(this.path, shardDir(prefix))
            count += await this.removePrefixInDir(shardPath, prefix)
        } else {
            count += await this.removePrefixInAllShards(prefix)
        }

        return count
    }

    private async removePrefixInDir(dirPath: string, prefix: string): Promise<number> {
        let dir
        try {
            dir = await fs.promises.opendir(dirPath)
        } catch (err: any) {
            if (err && err.code === 'ENOENT') return 0
            throw err
        }
        let count = 0
        for await (const entry of dir) {
            if (entry.isFile() && entry.name.startsWith(prefix)) {
                try {
                    await fs.promises.unlink(path.join(dirPath, entry.name))
                    count++
                } catch (err) {
                    logger.error({ err, key: entry.name }, 'failed to remove key during prefix deletion')
                }
            }
        }
        return count
    }

    private async removePrefixInAllShards(prefix: string): Promise<number> {
        let count = 0
        let rootDir
        try {
            rootDir = await fs.promises.opendir(this.path)
        } catch (err: any) {
            if (err && err.code === 'ENOENT') return 0
            throw err
        }
        for await (const entry of rootDir) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const shardPath = path.join(this.path, entry.name)
                count += await this.removePrefixInDir(shardPath, prefix)
            }
        }
        return count
    }
}
