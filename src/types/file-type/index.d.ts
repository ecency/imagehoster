// file-type >= 17 is ESM-only and publishes its types through `exports`, which
// `moduleResolution: node` does not read. Node 24 loads it through require()
// (the package exports a `module-sync` condition), so only the types are missing.
declare module 'file-type' {
    function fileTypeFromBuffer(buffer: Uint8Array | ArrayBuffer): Promise<{readonly ext: string, readonly mime: string} | undefined>
}
