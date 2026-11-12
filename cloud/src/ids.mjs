// Ids and key secrets, shared by the API and every repository.
import crypto from "node:crypto";

export const KEY_PREFIX = "imk_";

/** prj_..., run_..., key_...: a kind prefix and 80 random bits. */
export const newId = (kind) => `${kind}_${crypto.randomBytes(10).toString("hex")}`;

/** A new upload key secret. It is shown once; only hashSecret(secret) is stored. */
export const newSecret = () => KEY_PREFIX + crypto.randomBytes(32).toString("base64url");

export const hashSecret = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");
