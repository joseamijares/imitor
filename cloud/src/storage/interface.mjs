// The storage contract the API is written against. Two implementations: memory.mjs (tests and local runs) and
// s3.mjs (anything that speaks the S3 API). Objects are stored under keys the server chooses,
// "<projectId>/<runId>/<path>"; a client never names a key.

/**
 * @typedef {object} Upload  A presigned upload the client performs as is.
 * @property {"PUT"} method
 * @property {string} url
 * @property {Record<string, string>} headers  Signed into the URL: send them with exactly these values. content-length
 *   is listed for completeness; fetch sets it from the body.
 */

/**
 * @typedef {object} Storage
 * @property {(key: string, file: { size: number, sha256: string, contentType: string, expiresIn?: number }) => Promise<Upload>} presignPut
 *   An upload URL that only accepts exactly `size` bytes of `contentType` (and, where the store supports it, only
 *   bytes whose SHA-256 is `sha256`, given as 64 hex digits).
 * @property {(key: string, opts?: { expiresIn?: number }) => Promise<string>} presignGet  A short-lived download URL.
 * @property {(key: string) => Promise<{ size: number, contentType?: string } | null>} head  null when there is no object.
 * @property {(keys: string[]) => Promise<void>} delete  Missing keys are not an error.
 */

export {};
