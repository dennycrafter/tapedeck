/**
 * Split a multi-statement SQL file (supabase/schema.sql) into single
 * statements so each can run through `sql.unsafe` on postgres.js, whose
 * extended protocol does not accept multi-statement strings (SPEC 4.1, 8.12).
 *
 * The splitter understands the three constructs the schema uses:
 * `--` line comments, single-quoted strings (with '' escapes) and
 * dollar-quoted blocks (`$$` / `$tag$`), so `;` inside them never splits.
 * Comments are preserved inside the statements they belong to.
 */
export function splitStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  // Active dollar-quote tag (e.g. "$" or "$body$"), or "" when not inside one.
  let dollarTag = "";

  while (i < sqlText.length) {
    const char = sqlText[i];
    const rest = sqlText.slice(i);

    if (dollarTag !== "") {
      if (rest.startsWith(dollarTag)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = "";
      } else {
        current += char;
        i += 1;
      }
      continue;
    }

    if (char === "-" && sqlText[i + 1] === "-") {
      // Line comment: copy through the newline; a `;` inside must not split.
      const end = sqlText.indexOf("\n", i);
      const stop = end === -1 ? sqlText.length : end;
      current += sqlText.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === "'") {
      // Single-quoted string with '' escapes; a `;` inside must not split.
      current += char;
      i += 1;
      while (i < sqlText.length) {
        current += sqlText[i];
        if (sqlText[i] === "'") {
          if (sqlText[i + 1] === "'") {
            current += "'";
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          i += 1;
        }
      }
      continue;
    }

    const dollarMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest);
    if (dollarMatch) {
      dollarTag = dollarMatch[0];
      current += dollarTag;
      i += dollarTag.length;
      continue;
    }

    if (char === ";") {
      const statement = current.trim();
      if (statement !== "") statements.push(statement);
      current = "";
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  const last = current.trim();
  if (last !== "") statements.push(last);
  return statements;
}
