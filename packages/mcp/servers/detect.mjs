// Detecting the identifiers that must not be stored as they are
// (docs/sensitivity.md): Danish CPR numbers, payment card numbers and IBANs.
//
// Plain JavaScript with no imports, so the stdio servers (memory, knowledge)
// import it by relative path and the web app and @ai-hub/db through the
// package's `./detect` export — one detector, so "refused in memory" and
// "masked at rest" can never disagree about what counts.
//
// Each detector checks the number, not only its shape: a CPR number must be a
// real date, a card number must pass Luhn, an IBAN must pass mod-97. A bare
// regex would mask every ten-digit order number and teach people to ignore
// the hub's refusals. The cost is the other way round: a CPR number written
// with a date that does not exist is not caught. That is the right side to
// err on for a guard rail that refuses work.
//
// Names are deliberately not detected here: a name is not an identifier on its
// own, and "find everything about a name" (Admin → People's data) is the tool
// for a request about one.

/** What each kind is called in a sentence. */
export const IDENTIFIER_NAMES = {
  cpr: "a CPR number",
  card: "a payment card number",
  iban: "a bank account number (IBAN)",
};

/** What a match is replaced with at rest. */
export const IDENTIFIER_MASKS = {
  cpr: "[CPR number removed]",
  card: "[card number removed]",
  iban: "[IBAN removed]",
};

// --- CPR -------------------------------------------------------------------
//
// DDMMYY-SSSS. The seventh digit, with the year, gives the century (CPR
// register's own table), so 29 February is checked against the right year.
// Since 2007 the modulus-11 check no longer holds for every number, so it is
// not used: the date is the check.

const CPR = /(?<![\dA-Za-z])(\d{2})(\d{2})(\d{2})[-‐–\s]?(\d)(\d{3})(?![\dA-Za-z])/g;

function cprCentury(yy, d7) {
  if (d7 <= 3) return 1900;
  if (d7 === 4 || d7 === 9) return yy <= 36 ? 2000 : 1900;
  return yy <= 57 ? 2000 : 1800;
}

function isCprDate(dd, mm, yy, d7) {
  if (mm < 1 || mm > 12 || dd < 1) return false;
  const year = cprCentury(yy, d7) + yy;
  const days = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return dd <= days;
}

// --- cards -----------------------------------------------------------------
//
// 13–19 digits written together, in groups of four, or as American Express
// writes them (4-6-5). Mixed groupings ("12 34 56 78") are phone numbers far
// more often than cards, so they are not read as one number.

const CARD = /(?<![\d])(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{4,5})(?![\d])/g;

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// The networks a card number starts with: 2 and 5 Mastercard, 3 Amex/Diners/
// JCB, 4 Visa, 6 Discover/Maestro. A Luhn-valid number starting otherwise is
// an account or reference number, not a card.
const isCard = (digits) => digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhn(digits);

// --- IBAN ------------------------------------------------------------------
//
// Upper case, written together or in groups of four, as banks print them.
// Lengths for the countries a Danish firm meets most; any other country only
// has to be a plausible length. Mod-97 is what makes it an IBAN.

const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)(?![A-Za-z0-9])/g;

const IBAN_LENGTHS = { DK: 18, NO: 15, SE: 24, FI: 18, DE: 22, GB: 22, NL: 18, FR: 27, ES: 24, IS: 26, PL: 28, CH: 21, BE: 16, IE: 22, IT: 27, AT: 20, FO: 18, GL: 18, EE: 20, LT: 20, LV: 21 };

function isIban(compact) {
  const country = compact.slice(0, 2);
  const expected = IBAN_LENGTHS[country];
  if (expected ? compact.length !== expected : compact.length < 15 || compact.length > 34) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch;
    for (const digit of value) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// --- finding ----------------------------------------------------------------

/**
 * Every identifier in a text, as { kind, start, end }, in order and never
 * overlapping. Cards and IBANs are found first: a CPR-shaped window inside
 * either is part of that number, not a second one.
 */
export function findIdentifiers(text) {
  if (typeof text !== "string" || text.length < 10) return [];
  const spans = [];
  const overlaps = (s, e) => spans.some((x) => s < x.end && e > x.start);
  for (const m of text.matchAll(IBAN)) {
    if (isIban(m[0].replace(/ /g, ""))) spans.push({ kind: "iban", start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(CARD)) {
    const s = m.index;
    const e = s + m[0].length;
    if (!overlaps(s, e) && isCard(m[0].replace(/[ -]/g, ""))) spans.push({ kind: "card", start: s, end: e });
  }
  for (const m of text.matchAll(CPR)) {
    const s = m.index;
    const e = s + m[0].length;
    if (overlaps(s, e)) continue;
    if (isCprDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]))) spans.push({ kind: "cpr", start: s, end: e });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** How many of each kind. */
export function countIdentifiers(text) {
  const counts = { cpr: 0, card: 0, iban: 0 };
  for (const s of findIdentifiers(text)) counts[s.kind]++;
  return counts;
}

/** The text with every identifier replaced by its mask, and how many were. */
export function maskIdentifiers(text) {
  const spans = findIdentifiers(text);
  if (!spans.length) return { text, masked: 0 };
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + IDENTIFIER_MASKS[s.kind];
    at = s.end;
  }
  return { text: out + text.slice(at), masked: spans.length };
}

/**
 * Every string inside a JSON-shaped value masked (a transcript: messages,
 * tool inputs, tool results). Keys are left alone; nothing else changes shape.
 */
export function maskDeep(value) {
  let masked = 0;
  const walk = (v) => {
    if (typeof v === "string") {
      const r = maskIdentifiers(v);
      masked += r.masked;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  const out = walk(value);
  return { value: out, masked };
}

/**
 * Why a text may not be remembered, or null when it may. Said to the agent,
 * so it can write the fact without the number ("the client's IBAN is on
 * file in the ERP") rather than give up.
 */
export function identifierRefusal(text) {
  const spans = findIdentifiers(text);
  if (!spans.length) return null;
  const kinds = [...new Set(spans.map((s) => s.kind))].map((k) => IDENTIFIER_NAMES[k]);
  const list = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}`;
  return (
    `Not remembered: it contains ${list}. The hub never keeps those in memory. ` +
    "Write the fact without the number — say where it is kept instead — or leave it out."
  );
}
