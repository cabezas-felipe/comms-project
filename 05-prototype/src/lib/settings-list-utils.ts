export type AddResult = {
  nextItems: string[] | null;
  warning: string | null;
};

export function addCommaSeparated(draft: string, existing: string[], label: string): AddResult {
  const segments = draft.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  if (segments.length === 0) {
    return { nextItems: null, warning: `Enter at least one new ${label}.` };
  }

  const existingLower = new Set(existing.map((x) => x.toLowerCase()));
  const seenInBatch = new Set<string>();
  const newItems: string[] = [];
  let dupesDropped = 0;

  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (existingLower.has(lower) || seenInBatch.has(lower)) {
      dupesDropped++;
    } else {
      seenInBatch.add(lower);
      newItems.push(seg);
    }
  }

  if (newItems.length === 0) {
    return { nextItems: null, warning: "That's already on your list." };
  }

  const warning =
    dupesDropped > 0 ? "Some of those were already on your list. We added the rest." : null;
  return { nextItems: [...existing, ...newItems], warning };
}

export function addTraditional(draft: string, existing: string[]): AddResult {
  const v = draft.trim();
  if (!v) return { nextItems: null, warning: "Enter an outlet." };
  const existingLower = new Set(existing.map((x) => x.toLowerCase()));
  if (existingLower.has(v.toLowerCase())) {
    return { nextItems: null, warning: "That's already on your list." };
  }
  return { nextItems: [...existing, v], warning: null };
}

export function addSocial(draft: string, existing: string[]): AddResult {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("@")) {
    return { nextItems: null, warning: "Handles must start with @." };
  }
  const body = trimmed.slice(1).trim();
  if (!body) {
    return { nextItems: null, warning: "Enter a handle after @." };
  }
  const normalized = "@" + body;
  const existingLower = new Set(existing.map((x) => x.toLowerCase()));
  if (existingLower.has(normalized.toLowerCase())) {
    return { nextItems: null, warning: "That's already on your list." };
  }
  return { nextItems: [...existing, normalized], warning: null };
}
