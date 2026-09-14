function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function readCount(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

export function parseVoloGameInventory(rawText) {
  const text = normalizeText(rawText);

  const total = readCount(
    text,
    /\btotal\s+spot\(s\)\s+available\s*[:\-]?\s*(\d+)\b/i
  );
  const men = readCount(
    text,
    /\bmen(?:'s)?(?:\s+only)?\s*[:\-]?\s*(\d+)\b/i
  );
  const anyGender = readCount(
    text,
    /\bany\s+gender\s*[:\-]?\s*(\d+)\b/i
  );
  const openGender = readCount(
    text,
    /\bopen\s+gender\s*[:\-]?\s*(\d+)\b/i
  );
  const womenOnly = readCount(
    text,
    /\bwomen(?:'s)?\s+only\s*[:\-]?\s*(\d+)\b/i
  );

  if ([total, men, anyGender, openGender, womenOnly].some((value) => value !== null)) {
    return {
      total,
      men,
      anyGender,
      openGender,
      womenOnly,
      eligible: (men ?? 0) + (anyGender ?? 0) + (openGender ?? 0),
      source: "labeled-buckets",
    };
  }

  const sectionMatch = text.match(
    /\bWho needs a player\b([\s\S]*?)(?:\bWhat[’']?s a drop-in\b|$)/i
  );
  const teamSection = sectionMatch?.[1] ?? "";

  const teamSlotPattern =
    /\b(\d+)\s+spots?\b(?:\s*(?:[·•]|[-–—]|\|)?\s*(\d+)\s+(?:women|woman|female(?:s)?)\s*(?:&|and)\s*non[-\s]?binary\b)?/gi;

  let match;
  let teamTotal = 0;
  let restricted = 0;
  let foundTeamSlots = false;

  while ((match = teamSlotPattern.exec(teamSection)) !== null) {
    foundTeamSlots = true;
    teamTotal += Number(match[1]);
    restricted += match[2] == null ? 0 : Number(match[2]);
  }

  if (foundTeamSlots) {
    return {
      total: teamTotal,
      men: null,
      anyGender: null,
      openGender: null,
      womenOnly: restricted,
      eligible: Math.max(teamTotal - restricted, 0),
      source: "team-slot-reservations",
    };
  }

  return {
    total: null,
    men: null,
    anyGender: null,
    openGender: null,
    womenOnly: null,
    eligible: 0,
    source: "unknown",
  };
}
