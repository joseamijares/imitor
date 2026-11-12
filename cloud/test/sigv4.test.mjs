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

test("head and delete send signed HEAD and DELETE requests and read the answers", async () => {
  const calls = [];
  const fetch = async (url, { method }) => {
    calls.push([method, new URL(url).pathname, new URL(url).searchParams.has("X-Amz-Signature")]);
    if (method === "HEAD") return new Response(null, { status: url.includes("missing") ? 404 : 200, headers: { "content-length": "42", "content-type": "image/png" } });
    return new Response(null, { status: 204 });
  };
  const storage = s3Storage({ ...AWS_EXAMPLE, bucket: "b", endpoint: "http://127.0.0.1:9000", fetch });
  assert.deepEqual(await storage.head("p/r/x.png"), { size: 42, contentType: "image/png" });
  assert.equal(await storage.head("p/r/missing.png"), null);
  await storage.delete(["p/r/x.png", "p/r/y.png"]);
  assert.deepEqual(calls, [["HEAD", "/b/p/r/x.png", true], ["HEAD", "/b/p/r/missing.png", true], ["DELETE", "/b/p/r/x.png", true], ["DELETE", "/b/p/r/y.png", true]]);
});
