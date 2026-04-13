/**
 * Content Intelligence (#846)
 *
 * - SimHash-based near-duplicate detection (O(n) per page)
 * - Thin content identification (< 300 words)
 * - Keyword density analysis per page
 * - Content similarity grouping
 * - Recommendations (merge, differentiate, canonical, noindex)
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface ContentPage {
  url: string;
  title: string;
  bodyText: string;
  wordCount: number;
}

export interface DuplicateGroup {
  urls: string[];
  similarity: number;
  recommendation: "merge" | "differentiate" | "canonical" | "noindex";
}

export interface ThinContentPage {
  url: string;
  title: string;
  wordCount: number;
}

export interface KeywordDensityEntry {
  url: string;
  keyword: string;
  count: number;
  density: number; // percentage
}

export interface ContentAnalysisResult {
  duplicateGroups: DuplicateGroup[];
  thinContentPages: ThinContentPage[];
  keywordDensity: KeywordDensityEntry[];
}

// ── SimHash implementation ───────────────────────────────────────────────

/**
 * Compute a 64-bit SimHash represented as a BigInt.
 * Uses 3-word shingles for better accuracy.
 */
export function simhash(text: string, bits = 64): bigint {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0n;

  // Create shingles (3-grams of tokens)
  const shingles: string[] = [];
  for (let i = 0; i <= tokens.length - 3; i++) {
    shingles.push(tokens.slice(i, i + 3).join(" "));
  }
  // Fallback to individual tokens if text is too short
  if (shingles.length === 0) {
    shingles.push(...tokens);
  }

  const v = new Array(bits).fill(0);

  for (const shingle of shingles) {
    const hash = fnv1a64(shingle);
    for (let i = 0; i < bits; i++) {
      if ((hash >> BigInt(i)) & 1n) {
        v[i]++;
      } else {
        v[i]--;
      }
    }
  }

  let result = 0n;
  for (let i = 0; i < bits; i++) {
    if (v[i] > 0) {
      result |= 1n << BigInt(i);
    }
  }
  return result;
}

/**
 * Compute Hamming distance between two SimHashes.
 */
export function hammingDistance(a: bigint, b: bigint, bits = 64): number {
  let xor = a ^ b;
  let dist = 0;
  for (let i = 0; i < bits; i++) {
    if (xor & 1n) dist++;
    xor >>= 1n;
  }
  return dist;
}

/**
 * Compute similarity (0–1) from two SimHashes.
 */
export function simhashSimilarity(a: bigint, b: bigint, bits = 64): number {
  const distance = hammingDistance(a, b, bits);
  return 1 - distance / bits;
}

// ── Tokenizer ────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// ── FNV-1a 64-bit hash ──────────────────────────────────────────────────

function fnv1a64(str: string): bigint {
  let hash = 14695981039346656037n; // FNV offset basis
  const prime = 1099511628211n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & ((1n << 64n) - 1n); // keep 64 bits
  }
  return hash;
}

// ── Content analysis ─────────────────────────────────────────────────────

const DUPLICATE_THRESHOLD = 0.85; // 85% similarity
const THIN_CONTENT_THRESHOLD = 300; // words

export function analyzeContent(pages: ContentPage[]): ContentAnalysisResult {
  // 1. Compute SimHashes
  const hashes = pages.map((p) => ({
    url: p.url,
    hash: simhash(p.bodyText),
    page: p,
  }));

  // 2. Find duplicate groups
  const duplicateGroups = findDuplicateGroups(hashes);

  // 3. Thin content pages
  const thinContentPages: ThinContentPage[] = pages
    .filter((p) => p.wordCount < THIN_CONTENT_THRESHOLD)
    .map((p) => ({ url: p.url, title: p.title, wordCount: p.wordCount }));

  // 4. Keyword density
  const keywordDensity = computeKeywordDensity(pages);

  return { duplicateGroups, thinContentPages, keywordDensity };
}

function findDuplicateGroups(
  hashes: Array<{ url: string; hash: bigint; page: ContentPage }>,
): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < hashes.length; i++) {
    if (assigned.has(i)) continue;

    const group: number[] = [i];
    let maxSimilarity = 0;

    for (let j = i + 1; j < hashes.length; j++) {
      if (assigned.has(j)) continue;
      const sim = simhashSimilarity(hashes[i].hash, hashes[j].hash);
      if (sim >= DUPLICATE_THRESHOLD) {
        group.push(j);
        maxSimilarity = Math.max(maxSimilarity, sim);
      }
    }

    if (group.length > 1) {
      for (const idx of group) assigned.add(idx);
      const similarity = Math.round(maxSimilarity * 100);

      let recommendation: DuplicateGroup["recommendation"];
      if (similarity >= 95) recommendation = "canonical";
      else if (similarity >= 90) recommendation = "merge";
      else recommendation = "differentiate";

      groups.push({
        urls: group.map((idx) => hashes[idx].url),
        similarity,
        recommendation,
      });
    }
  }

  return groups;
}

function computeKeywordDensity(pages: ContentPage[]): KeywordDensityEntry[] {
  const results: KeywordDensityEntry[] = [];

  for (const page of pages) {
    const words = tokenize(page.bodyText);
    if (words.length === 0) continue;

    const freqMap = new Map<string, number>();
    for (const word of words) {
      freqMap.set(word, (freqMap.get(word) ?? 0) + 1);
    }

    // Top 5 keywords by frequency
    const sorted = Array.from(freqMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [keyword, count] of sorted) {
      results.push({
        url: page.url,
        keyword,
        count,
        density: Math.round((count / words.length) * 10000) / 100,
      });
    }
  }

  return results;
}

// ── Over-optimized keywords ──────────────────────────────────────────────

const OVER_OPTIMIZED_THRESHOLD = 3; // > 3% density

export interface OverOptimizedKeyword {
  url: string;
  keyword: string;
  density: number;
}

export function findOverOptimizedKeywords(
  densities: KeywordDensityEntry[],
): OverOptimizedKeyword[] {
  return densities
    .filter((d) => d.density > OVER_OPTIMIZED_THRESHOLD)
    .map((d) => ({ url: d.url, keyword: d.keyword, density: d.density }));
}

// ── CSV exports ──────────────────────────────────────────────────────────

function escapeCsv(value: string | number): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportDuplicatesCsv(groups: DuplicateGroup[]): string {
  const rows: string[] = ["Group,URLs,Similarity,Recommendation"];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    rows.push(
      [
        escapeCsv(i + 1),
        escapeCsv(g.urls.join(" | ")),
        escapeCsv(`${g.similarity}%`),
        escapeCsv(g.recommendation),
      ].join(","),
    );
  }
  return rows.join("\n");
}

export function exportThinContentCsv(pages: ThinContentPage[]): string {
  const rows: string[] = ["URL,Title,Word Count"];
  for (const p of pages) {
    rows.push(
      [escapeCsv(p.url), escapeCsv(p.title), escapeCsv(p.wordCount)].join(","),
    );
  }
  return rows.join("\n");
}
