// Just enough of JSON Schema (draft 2020-12) to check src/schema/*.json against sample bodies in tests, without a
// dependency: type, const, enum, required, properties, additionalProperties: false, items, pattern, maxLength,
// minimum, maximum, maxItems. A keyword it does not know fails loudly, so the schema cannot quietly outgrow it.
const KNOWN = new Set(["$schema", "$id", "title", "description", "type", "const", "enum", "required", "properties", "additionalProperties", "items", "pattern", "maxLength", "minimum", "maximum", "maxItems"]);

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => typeOf(v) === t || (t === "number" && typeof v === "number");

/** Errors for `value` against `schema`, as "path: what" strings; empty when valid. */
export function validate(schema, value, at = "$", errors = []) {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`jsonschema.mjs does not support "${k}" (at ${at})`);
  const fail = (what) => errors.push(`${at}: ${what}`);
  if (schema.type && !isType(value, schema.type)) return fail(`must be ${schema.type}`), errors;
  if ("const" in schema && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.maxLength != null && [...value].length > schema.maxLength) fail(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) fail(`does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) fail(`below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) fail(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errors));
  }
  if (typeOf(value) === "object") {
    for (const k of schema.required || []) if (!(k in value)) fail(`missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) fail(`unknown field ${k}`);
    }
  }
  return errors;
}
