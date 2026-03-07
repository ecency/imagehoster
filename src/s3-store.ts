import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
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
        const chunks: Buffer[] = []
        let settled = false
        const settle = (err: any, metadata?: any) => {
            if (settled || !done) return
            settled = true
            done(err, metadata)
        }
        passthrough.on('data', (chunk) => chunks.push(chunk))
        passthrough.on('end', () => {
            const body = Buffer.concat(chunks)
            this.s3.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: body,
            })).then(() => {
                settle(null, { key })
            }).catch((err) => {
                settle(err)
            })
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
}
