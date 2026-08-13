/** Canonical form shared by configured phrases, sections and recorded searches. */
export function normalizeSearchValue(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Search terms must retain at least two letters/digits after normalization. */
export function isValidNormalizedSearchTerm(value: string): boolean {
  return normalizeSearchValue(value).replaceAll(' ', '').length >= 2;
}
