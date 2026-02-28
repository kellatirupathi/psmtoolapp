const isEmptyLike = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toUpperCase();
  return normalized.length === 0 || ["N/A", "NAN", "NONE", "NULL"].includes(normalized);
};

const normalizeSingle = (value: unknown): string | null => {
  if (isEmptyLike(value)) return null;
  return String(value)
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

export const forceEnumFormat = (value: unknown): string => {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeSingle).filter((entry): entry is string => Boolean(entry));
    return normalized.length > 0 ? normalized.join(", ") : "N/A";
  }

  const normalized = normalizeSingle(value);
  return normalized && normalized.length > 0 ? normalized : "N/A";
};
