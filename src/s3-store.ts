import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { Readable, PassThrough } from 'stream'

export interface S3StoreOptions {
    client: S3Client
    bucket: string
}

export class S3BlobStore {
    private s3: S3Client
    private bucket: string

    constructor(opts: S3StoreOptions) {
        this.s3 = opts.client
        this.bucket = opts.bucket
    }

    createReadStream(opts: any): Readable {
        const key = typeof opts === 'string' ? opts : opts.key
        const passthrough = new PassThrough()
        this.s3.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        })).then((res) => {
            if (!res.Body || typeof (res.Body as any).pipe !== 'function') {
                passthrough.destroy(new Error('S3 response body is not a readable stream'))
                return
            }
            const body = res.Body as Readable
            body.on('error', (err) => passthrough.destroy(err))
            body.pipe(passthrough)
        }).catch((err) => {
            passthrough.destroy(err)
        })
        return passthrough
    }

    /** Direct buffer upload — no streaming overhead. */
    async putBuffer(key: string, data: Buffer): Promise<void> {
        await this.s3.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: data,
        }))
    }

    createWriteStream(opts: any, done?: (error: any, metadata?: any) => void): PassThrough {
        const key = typeof opts === 'string' ? opts : opts.key
        const passthrough = new PassThrough()
        let settled = false
        const settle = (err: any, metadata?: any) => {
            if (settled || !done) return
            settled = true
            done(err, metadata)
        }
        this.s3.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: passthrough,
        })).then(() => {
            settle(null, { key })
        }).catch((err) => {
            settle(err)
        })
        passthrough.on('error', (err) => {
            settle(err)
        })
        return passthrough
    }

    exists(opts: any, done: (error: any, exists?: boolean) => void) {
        const key = typeof opts === 'string' ? opts : opts.key
        this.s3.send(new HeadObjectCommand({
            Bucket: this.bucket,
            Key: key,
        })).then(() => {
            done(null, true)
        }).catch((err) => {
            if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                done(null, false)
            } else {
                done(err)
            }
        })
    }

    remove(opts: any, done: (error: any) => void) {
        const key = typeof opts === 'string' ? opts : opts.key
        this.s3.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
        })).then(() => {
            done(null)
        }).catch(done)
    }

    async removeByPrefix(prefix: string): Promise<number> {
        let count = 0
        let chunk: string[] = []
        let continuationToken: string | undefined

        do {
            const res = await this.s3.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }))
            for (const item of res.Contents || []) {
                if (item.Key) {
                    chunk.push(item.Key)
                    if (chunk.length >= 1000) {
                        await this.s3.send(new DeleteObjectsCommand({
                            Bucket: this.bucket,
                            Delete: { Objects: chunk.map((Key) => ({ Key })) },
                        }))
                        count += chunk.length
                        chunk = []
                    }
                }
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
        } while (continuationToken)

        if (chunk.length > 0) {
            await this.s3.send(new DeleteObjectsCommand({
                Bucket: this.bucket,
                Delete: { Objects: chunk.map((Key) => ({ Key })) },
            }))
            count += chunk.length
        }

        return count
    }
}
