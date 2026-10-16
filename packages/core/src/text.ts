/** Text matching shared by trigger and wait rules. */

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/** Whole-word (or whole-phrase), case-insensitive. Empty keyword list matches everything. */
export const matchesKeywords = (text: string, keywords: readonly string[]): boolean => {
  if (keywords.length === 0) return true;
  const t = normalize(text);
  return keywords.some((k) => {
    const kw = normalize(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return kw.length > 0 && new RegExp(`(^|[^\\p{L}\\p{N}])${kw}($|[^\\p{L}\\p{N}])`, "u").test(t);
  });
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const extractEmail = (text: string): string | null => text.match(EMAIL)?.[0]?.toLowerCase() ?? null;
