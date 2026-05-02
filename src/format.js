const AMOUNT_PATTERN = /^(-?\d+(?:\.\d+)?)([kmbt])?$/i;
const MULTIPLIERS = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  t: 1_000_000_000_000
};

export function normalizeUsername(username) {
  if (!username) return "";
  return String(username).trim().replace(/^@+/, "");
}

export function parseAmount(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Amount must be a valid number.");
    return Math.round(value);
  }

  const cleaned = String(value ?? "").trim().replace(/,/g, "");
  if (!cleaned) return 0;

  const match = cleaned.match(AMOUNT_PATTERN);
  if (!match) {
    throw new Error("Use a number like 50000, 100k, or 1.5m.");
  }

  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  return Math.round(amount * (suffix ? MULTIPLIERS[suffix] : 1));
}

export function formatAmount(value) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat("en").format(amount);
}

export function memberLabel(member) {
  if (member.username) return `@${member.username}`;
  const fullName = [member.firstName, member.lastName].filter(Boolean).join(" ");
  return fullName || "Unknown user";
}

export function memberTag(member) {
  const tag = String(member.tag || "").trim();
  return tag ? `[${tag}]` : "";
}
