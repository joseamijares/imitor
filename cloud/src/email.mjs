// What counts as an email address here: the members form (web.mjs) and the mail module (mail/) must agree on it.
// ASCII only, so lowercasing here and lower() in Postgres agree on what one address is.
export const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
