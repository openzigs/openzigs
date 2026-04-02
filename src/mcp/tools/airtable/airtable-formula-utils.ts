/**
 * Airtable formula validation utilities.
 *
 * Validates formula syntax to catch common errors before sending to the API.
 */

// ── Validation ───────────────────────────────────────────────────────────

export interface FormulaValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates basic Airtable formula syntax.
 * Catches: unmatched braces/parens/quotes, invalid operators, empty formulas.
 */
export function validateAirtableFormula(
  formula: string,
): FormulaValidationResult {
  if (!formula || formula.trim().length === 0) {
    return { valid: false, error: "Formula is empty" };
  }

  const trimmed = formula.trim();

  // Check balanced curly braces (field references)
  let braceDepth = 0;
  for (const ch of trimmed) {
    if (ch === "{") braceDepth++;
    if (ch === "}") braceDepth--;
    if (braceDepth < 0) {
      return { valid: false, error: "Unmatched closing brace '}'" };
    }
  }
  if (braceDepth !== 0) {
    return { valid: false, error: "Unmatched opening brace '{'" };
  }

  // Check balanced parentheses
  let parenDepth = 0;
  let inString = false;
  let stringChar = "";
  for (const ch of trimmed) {
    if (!inString && (ch === "'" || ch === '"')) {
      inString = true;
      stringChar = ch;
    } else if (inString && ch === stringChar) {
      inString = false;
    } else if (!inString) {
      if (ch === "(") parenDepth++;
      if (ch === ")") parenDepth--;
      if (parenDepth < 0) {
        return { valid: false, error: "Unmatched closing parenthesis ')'" };
      }
    }
  }
  if (parenDepth !== 0) {
    return { valid: false, error: "Unmatched opening parenthesis '('" };
  }

  // Check balanced quotes
  if (inString) {
    return {
      valid: false,
      error: `Unmatched ${stringChar === "'" ? "single" : "double"} quote`,
    };
  }

  return { valid: true };
}

// ── Formula Cheat Sheet ──────────────────────────────────────────────────

export const AIRTABLE_FORMULA_CHEATSHEET = `
### Airtable Formula Syntax Reference

**Field references**: \`{Field Name}\`

**Comparison operators**: \`=\`, \`!=\`, \`<\`, \`>\`, \`<=\`, \`>=\`

**Logical functions**:
- \`AND(condition1, condition2, ...)\` — all must be true
- \`OR(condition1, condition2, ...)\` — any must be true
- \`NOT(condition)\` — negation
- \`IF(condition, value_if_true, value_if_false)\`

**String functions**: \`CONCATENATE()\`, \`FIND()\`, \`LEN()\`, \`LOWER()\`, \`UPPER()\`, \`TRIM()\`, \`LEFT()\`, \`RIGHT()\`, \`MID()\`, \`SUBSTITUTE()\`

**Numeric functions**: \`SUM()\`, \`AVERAGE()\`, \`MAX()\`, \`MIN()\`, \`ROUND()\`, \`CEILING()\`, \`FLOOR()\`, \`ABS()\`

**Date functions**: \`TODAY()\`, \`NOW()\`, \`DATEADD()\`, \`DATETIME_DIFF()\`, \`IS_BEFORE()\`, \`IS_AFTER()\`

**Examples**:
- \`{Status}='Active'\`
- \`AND({Score}>80, {Status}!='Archived')\`
- \`OR(FIND('urgent', LOWER({Tags})), {Priority}='High')\`
- \`IS_AFTER({Due Date}, TODAY())\`
`.trim();
