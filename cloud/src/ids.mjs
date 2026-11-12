// Ids, key secrets and project slugs, shared by the API and every repository.
import crypto from "node:crypto";

export const KEY_PREFIX = "imk_";

/** prj_..., run_..., key_..., usr_...: a kind prefix and 80 random bits. */
export const newId = (kind) => `${kind}_${crypto.randomBytes(10).toString("hex")}`;

/** A new upload key secret. It is shown once; only hashSecret(secret) is stored. */
export const newSecret = () => KEY_PREFIX + crypto.randomBytes(32).toString("base64url");

export const hashSecret = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");

/** "Fernwood App!" -> "fernwood-app". At most 40 characters; "project" when nothing is left. */
export const slugify = (name) => String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "project";

/** The slug to try on attempt n (0, 1, 2, ...): "fernwood", "fernwood-2", "fernwood-3". */
export const slugAttempt = (base, n) => (n === 0 ? base : `${base.slice(0, 36)}-${n + 1}`);
