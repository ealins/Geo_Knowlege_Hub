// Finds an application / closing date in a page. Returns an ISO string or null.
// Order: schema.org JSON-LD (validThrough), then dates written next to words
// like "deadline", "closing date", "apply by", "Bewerbungsfrist".
const MONTHS = {
  jan: 1, january: 1, januar: 1, feb: 2, february: 2, februar: 2, mar: 3, march: 3, märz: 3, maerz: 3,
  apr: 4, april: 4, may: 5, mai: 5, jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, oktober: 10, okt: 10,
  nov: 11, november: 11, dec: 12, december: 12, dezember: 12, dez: 12,
};
const MON = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const KEY = /(deadline|closing date|closes|apply by|apply until|application (?:period|window|due)|applications? (?:close|are open until)|submit(?:ted)? by|until|bewerbungsfrist|bewerbungsschluss|frist|bewerben bis|bis zum)/i;

const iso = (y, m, d) => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d, 23, 59, 59);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// All dates in a snippet, as ISO strings. A date without a year takes the
// next occurrence after `now` (typical for yearly programme deadlines).
export function datesIn(snippet, now) {
  const out = [];
  const yearless = (m, d) => {
    let y = now.getUTCFullYear();
    let v = iso(y, m, d);
    if (v && Date.parse(v) < now.getTime()) v = iso(y + 1, m, d);
    return v;
  };
  let m;
  const reNum = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g; // 15.01.2027
  while ((m = reNum.exec(snippet))) out.push(iso(+m[3], +m[2], +m[1]));
  const reIso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = reIso.exec(snippet))) out.push(iso(+m[1], +m[2], +m[3]));
  const reDmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(${MON})\\.?,?\\s*(20\\d{2})?`, "gi"); // 15 January 2027 / 15 January
  while ((m = reDmy.exec(snippet))) {
    const mo = MONTHS[m[2].toLowerCase()];
    out.push(m[3] ? iso(+m[3], mo, +m[1]) : yearless(mo, +m[1]));
  }
  const reMdy = new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(20\\d{2})?`, "gi"); // January 15, 2027
  while ((m = reMdy.exec(snippet))) {
    const mo = MONTHS[m[1].toLowerCase()];
    out.push(m[3] ? iso(+m[3], mo, +m[2]) : yearless(mo, +m[2]));
  }
  return out.filter(Boolean);
}

export function findDeadline(html, now = new Date()) {
  for (const b of html.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (Array.isArray(n)) return n.map(walk).find(Boolean);
        if (n && typeof n === "object") {
          const v = n.validThrough || n.applicationDeadline;
          if (v && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
          return Object.values(n).map(walk).find(Boolean);
        }
      };
      const hit = walk(JSON.parse(b[1]));
      if (hit) return hit;
    } catch {}
  }
  const text = html
    .replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ");
  const found = [];
  for (const k of text.matchAll(new RegExp(KEY, "gi"))) {
    const snippet = text.slice(k.index, k.index + 90);
    found.push(...datesIn(snippet, now));
  }
  if (!found.length) return null;
  // Several dates: prefer the nearest one that is still ahead, else the latest.
  const future = found.filter((d) => Date.parse(d) >= now.getTime()).sort();
  return future[0] ?? found.sort().at(-1);
}
