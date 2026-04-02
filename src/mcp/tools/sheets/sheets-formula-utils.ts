/**
 * Google Sheets formula and range utilities.
 *
 * Re-exports validateA1Notation from the client for convenience and adds NL
 * helpers such as a function cheatsheet and column letter ↔ number conversion.
 */

export { validateA1Notation } from "./sheets-client.js";

// ── Column Helpers ───────────────────────────────────────────────────────

/** Convert a 1-based column number to A1-style letters (1 → A, 27 → AA). */
export function columnToLetter(col: number): string {
  if (col < 1) throw new RangeError("Column number must be ≥ 1");
  let result = "";
  let n = col;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/** Convert A1-style column letters to 1-based number (A → 1, AA → 27). */
export function letterToColumn(letters: string): number {
  const upper = letters.toUpperCase();
  if (!/^[A-Z]+$/.test(upper)) {
    throw new RangeError("Column letters must be A-Z only");
  }
  let result = 0;
  for (const ch of upper) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result;
}

// ── Cheatsheet ───────────────────────────────────────────────────────────

export const SHEETS_FORMULA_CHEATSHEET = `
### Google Sheets Range & Formula Reference

**A1 notation**: \`Sheet1!A1:D10\`, \`A1\`, \`A:D\` (whole columns), \`1:5\` (rows 1-5)

**Common functions**:
- **Math**: \`=SUM(A1:A10)\`, \`=AVERAGE()\`, \`=MAX()\`, \`=MIN()\`, \`=ROUND()\`
- **Lookup**: \`=VLOOKUP(key, range, col, FALSE)\`, \`=HLOOKUP()\`, \`=INDEX(MATCH())\`
- **Text**: \`=CONCATENATE()\`, \`=LEFT()\`, \`=RIGHT()\`, \`=MID()\`, \`=TRIM()\`, \`=LOWER()\`, \`=UPPER()\`
- **Date**: \`=TODAY()\`, \`=NOW()\`, \`=DATE(y,m,d)\`, \`=DATEDIF(start,end,"D")\`
- **Logic**: \`=IF(cond, true_val, false_val)\`, \`=AND()\`, \`=OR()\`, \`=IFERROR()\`
- **Array**: \`=FILTER(range, condition)\`, \`=SORT(range, col, asc)\`, \`=UNIQUE()\`, \`=ARRAYFORMULA()\`
- **Import**: \`=IMPORTRANGE("spreadsheet_url", "Sheet1!A:D")\`

**Input value options for write operations**:
- RAW — values stored as-is (no parsing)
- USER_ENTERED — values parsed as if typed into the UI (formulas evaluated)
`.trim();
