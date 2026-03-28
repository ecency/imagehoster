/**
 * Sharded filesystem blob store.
 *
 * Distributes files into subdirectories based on the first 6 characters
 * of the key (e.g. 'U5dqrE'). Proxy keys share a common 'U5d' prefix
 * so only characters 4-6 provide entropy — 6 chars gives ~3,364 buckets.
 *
 * Backwards-compatible: reads check 6-char shard first, then flat path.
 * When a flat file is found, it is migrated to the shard via link() + unlink().
 */

import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'

import { logger } from './logger'

const SHARD_LEN = 6

function shardDir(key: string): string {
    if (key.length >= SHARD_LEN) {
        return key.slice(0, SHARD_LEN)
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

    private migrateToShard(key: string, oldPath: string, newPath: string) {
        const dir = path.dirname(newPath)
        this.ensureDir(dir, (err) => {
            if (err) return
            fs.link(oldPath, newPath, (linkErr) => {
                if (linkErr && linkErr.code !== 'EEXIST' && linkErr.code !== 'ENOENT') {
                    logger.warn({ err: linkErr, key }, 'shard migration link failed')
                    return
                }
                fs.unlink(oldPath, () => {})
            })
        })
    }

    createReadStream(opts: any): Readable {
        const key = typeof opts === 'string' ? opts : opts.key
        const sPath = shardedPath(this.path, key)

        try {
            fs.accessSync(sPath, fs.constants.R_OK)
            return fs.createReadStream(sPath)
        } catch (_e) {}

        // Fall back to flat path — migrate in background
        const fPath = flatPath(this.path, key)
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
            fs.unlink(flatPath(this.path, key), (err2) => {
                if (!err || !err2) return done(null)
                if (err2.code !== 'ENOENT') return done(err2)
                if (err.code !== 'ENOENT') return done(err)
                done(null)
            })
        })
    }

    async removeByPrefix(prefix: string): Promise<number> {
        let count = 0

        count += await this.removePrefixInDir(this.path, prefix)

        if (prefix.length >= SHARD_LEN) {
            count += await this.removePrefixInDir(path.join(this.path, shardDir(prefix)), prefix)
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
