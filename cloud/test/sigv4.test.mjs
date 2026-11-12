import assert from "node:assert/strict";
import test from "node:test";
import { encodeKey, hexToBase64, presign, s3Storage, signingKey } from "../src/storage/s3.mjs";

// AWS's published example credentials (they sign nothing real).
const AWS_EXAMPLE = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };

test("signingKey matches AWS's published derivation example", () => {
  // "Examples of how to derive a signing key for Signature Version 4" (IAM, 20120215, us-east-1).
  const key = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
  assert.equal(key.toString("hex"), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
});

test("presign reproduces AWS's documented presigned GET example for examplebucket/test.txt", () => {
  // Amazon S3 API reference, "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)", example.
  const signed = presign({ ...AWS_EXAMPLE, method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", expiresIn: 86400, date: new Date("2013-05-24T00:00:00Z") });
  assert.equal(signed.canonicalRequest, [
    "GET",
    "/test.txt",
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
    "host:examplebucket.s3.amazonaws.com",
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n"));
  assert.equal(signed.stringToSign, "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04");
  assert.equal(signed.signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  assert.equal(signed.url, "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

test("s3Storage gives the same URL for the example, virtual-hosted on the AWS endpoint", async () => {
  const storage = s3Storage({ ...AWS_EXAMPLE, bucket: "examplebucket", endpoint: "https://s3.amazonaws.com", pathStyle: false, now: () => new Date("2013-05-24T00:00:00Z") });
  assert.match(await storage.presignGet("test.txt", { expiresIn: 86400 }), /^https:\/\/examplebucket\.s3\.amazonaws\.com\/test\.txt\?.*X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test("presignPut signs content-length, content-type and the SHA-256 checksum into a path-style URL", async () => {
  const storage = s3Storage({ ...AWS_EXAMPLE, region: "auto", bucket: "imitor-runs", endpoint: "https://accountid.r2.cloudflarestorage.com", now: () => new Date("2026-11-12T10:00:00Z") });
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const put = await storage.presignPut("prj_1/run_1/screens/a photo (1).png", { size: 1234, sha256: sha, contentType: "image/png" });
  const u = new URL(put.url);
  assert.equal(u.origin + u.pathname, "https://accountid.r2.cloudflarestorage.com/imitor-runs/prj_1/run_1/screens/a%20photo%20%281%29.png");
  assert.equal(u.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host;x-amz-checksum-sha256");
  assert.equal(u.searchParams.get("X-Amz-Expires"), "900");
  assert.deepEqual(put.headers, { "content-length": "1234", "content-type": "image/png", "x-amz-checksum-sha256": "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" });
  assert.equal(hexToBase64(sha), "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  assert.equal(encodeKey("a/b c/d!e*f"), "a/b%20c/d%21e%2Af");

  const loose = s3Storage({ ...AWS_EXAMPLE, bucket: "b", endpoint: "http://127.0.0.1:9000", checksums: false });
  const plain = await loose.presignPut("k.png", { size: 1, sha256: sha, contentType: "image/png" });
  assert.equal(new URL(plain.url).searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
});

test("head asks for the stored SHA-256 with a signed x-amz-checksum-mode and reads size, type and checksum", async () => {
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const calls = [];
  const answers = { "x.png": hexToBase64(sha), "multipart.png": `${hexToBase64(sha)}-3`, "plain.png": null };
  const fetch = async (url, { method, headers }) => {
    const u = new URL(url);
    calls.push([method, u.pathname, u.searchParams.get("X-Amz-SignedHeaders"), headers?.["x-amz-checksum-mode"]]);
    const name = u.pathname.split("/").pop();
    if (!(name in answers)) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { "content-length": "42", "content-type": "image/png", ...(answers[name] ? { "x-amz-checksum-sha256": answers[name] } : {}) } });
  };
  const storage = s3Storage({ ...AWS_EXAMPLE, bucket: "b", endpoint: "http://127.0.0.1:9000", fetch });
  assert.deepEqual(await storage.head("p/r/x.png"), { size: 42, contentType: "image/png", sha256: sha });
  assert.deepEqual(await storage.head("p/r/multipart.png"), { size: 42, contentType: "image/png", sha256: null }, "a composite checksum is not the file's SHA-256");
  assert.deepEqual(await storage.head("p/r/plain.png"), { size: 42, contentType: "image/png", sha256: null });
  assert.equal(await storage.head("p/r/missing.png"), null);
  assert.deepEqual(calls[0], ["HEAD", "/b/p/r/x.png", "host;x-amz-checksum-mode", "ENABLED"]);
});

test("delete sends signed DELETEs at most 16 at a time", async () => {
  let inFlight = 0;
  let most = 0;
  const deleted = [];
  const fetch = async (url, { method }) => {
    assert.equal(method, "DELETE");
    assert.ok(new URL(url).searchParams.has("X-Amz-Signature"));
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    deleted.push(new URL(url).pathname);
    return new Response(null, { status: url.includes("gone") ? 404 : 204 });
  };
  const storage = s3Storage({ ...AWS_EXAMPLE, bucket: "b", endpoint: "http://127.0.0.1:9000", fetch });
  const keys = Array.from({ length: 40 }, (_, i) => `p/r/${i}.png`).concat("p/r/gone.png");
  await storage.delete(keys);
  assert.deepEqual(deleted.sort(), keys.map((k) => `/b/${k}`).sort());
  assert.equal(most, 16);
  const failing = s3Storage({ ...AWS_EXAMPLE, bucket: "b", endpoint: "http://127.0.0.1:9000", fetch: async () => new Response(null, { status: 503 }) });
  await assert.rejects(failing.delete(["p/r/x.png"]), /storage DELETE p\/r\/x\.png answered 503/);
});

test("list signs a ListObjectsV2 request offline and follows continuation tokens", async () => {
  const date = new Date("2026-11-12T10:00:00Z");
  const signed = presign({ ...AWS_EXAMPLE, method: "GET", url: "http://127.0.0.1:9000/b", query: { "list-type": "2", prefix: "prj_1/run_1/" }, expiresIn: 60, date });
  assert.equal(signed.canonicalRequest, [
    "GET",
    "/b",
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261112%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261112T100000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&list-type=2&prefix=prj_1%2Frun_1%2F",
    "host:127.0.0.1:9000",
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n"));
  assert.equal(signed.url, `http://127.0.0.1:9000/b?${signed.canonicalRequest.split("\n")[2]}&X-Amz-Signature=${signed.signature}`);

  const pages = [
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><Prefix>prj_1/run_1/</Prefix><IsTruncated>true</IsTruncated><NextContinuationToken>1/tok+en&amp;=</NextContinuationToken><Contents><Key>prj_1/run_1/screens/a.png</Key><Size>42</Size><ChecksumAlgorithm>SHA256</ChecksumAlgorithm></Contents><Contents><Key>prj_1/run_1/screens/Tom &amp; Jerry.png</Key><Size>7</Size></Contents></ListBucketResult>`,
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>prj_1/run_1/screens/b.webm</Key><Size>1000</Size></Contents></ListBucketResult>`,
  ];
  const urls = [];
  const fetch = async (url, { method }) => {
    assert.equal(method, "GET");
    urls.push(url);
    return new Response(pages[urls.length - 1], { status: 200, headers: { "content-type": "application/xml" } });
  };
  const storage = s3Storage({ ...AWS_EXAMPLE, bucket: "b", endpoint: "http://127.0.0.1:9000", fetch, now: () => date });
  assert.deepEqual(await storage.list("prj_1/run_1/"), [
    { key: "prj_1/run_1/screens/a.png", size: 42 },
    { key: "prj_1/run_1/screens/Tom & Jerry.png", size: 7 },
    { key: "prj_1/run_1/screens/b.webm", size: 1000 },
  ]);
  assert.equal(urls[0], signed.url, "the first page is exactly the request signed above");
  const second = new URL(urls[1]);
  assert.equal(second.searchParams.get("continuation-token"), "1/tok+en&=");
  assert.equal(urls[1], presign({ ...AWS_EXAMPLE, method: "GET", url: "http://127.0.0.1:9000/b", query: { "list-type": "2", prefix: "prj_1/run_1/", "continuation-token": "1/tok+en&=" }, expiresIn: 60, date }).url);
  assert.match(urls[1], /&continuation-token=1%2Ftok%2Ben%26%3D&list-type=2&prefix=/, "parameters in canonical order, RFC 3986 encoded");

  const virtual = s3Storage({ ...AWS_EXAMPLE, bucket: "examplebucket", endpoint: "https://s3.amazonaws.com", pathStyle: false, fetch: async (url) => (urls.push(url), new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")), now: () => date });
  assert.deepEqual(await virtual.list("p/"), []);
  assert.match(urls.at(-1), /^https:\/\/examplebucket\.s3\.amazonaws\.com\/\?X-Amz-Algorithm=/);
  const refused = s3Storage({ ...AWS_EXAMPLE, bucket: "b", endpoint: "http://127.0.0.1:9000", fetch: async () => new Response("AccessDenied", { status: 403 }) });
  await assert.rejects(refused.list("p/"), /storage LIST p\/ answered 403/);
});
