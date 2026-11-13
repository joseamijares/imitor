// The storage contract the API is written against. Three implementations: memory.mjs (tests and local runs),
// s3.mjs (anything that speaks the S3 API) and blob.mjs (a private Vercel Blob store). Objects are stored under keys the server chooses,
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
 *   bytes whose SHA-256 is `sha256`, given as 64 hex digits). Vercel Blob only caps the size at `size`; `head` then
 *   reports what was really stored.
 * @property {(key: string, opts?: { expiresIn?: number }) => Promise<string>} presignGet  A short-lived download URL.
 * @property {(key: string) => Promise<{ size: number, contentType: string | null, sha256: string | null } | null>} head
 *   null when there is no object. sha256 (64 hex digits) is the checksum the store keeps for the object, or null when
 *   it keeps none (S3_CHECKSUMS=off; blob.mjs hashes the bytes itself); the API compares all three with what the run declared.
 * @property {(prefix: string) => Promise<{ key: string, size: number }[]>} list  Every object whose key starts with
 *   `prefix`, in one call per 1000 objects, so finding a run's missing files does not take a call per file.
 * @property {(keys: string[]) => Promise<void>} delete  Missing keys are not an error; any other failure throws.
 */

export {};
