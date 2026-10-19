/**
 * RFC 6570 URI Template expansion for MCP Resource Templates, limited to what a user can fill in
 * by hand: the simple (`{var}`), reserved (`{+var}`), fragment (`{#var}`), label (`{.var}`), path
 * (`{/var}`), path-parameter (`{;var}`), query (`{?var}`) and continuation (`{&var}`) operators
 * with plain variable lists. Explode (`*`) and prefix (`:n`) modifiers are refused rather than
 * guessed, and every variable must be supplied: the server decides what the URI means, so Xiu
 * never invents a default.
 */

const EXPRESSION = /\{([^{}]*)\}/;
const OPERATORS = new Set(["+", "#", ".", "/", ";", "?", "&"]);
const VARIABLE_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.]|%[0-9A-Fa-f]{2})*$/;
const MAX_TEMPLATE_LENGTH = 8_192;
const MAX_VARIABLES = 32;
const MAX_VALUE_LENGTH = 4_096;

interface Expression { operator: string; variables: string[] }

function parseExpression(raw: string): Expression {
  let body = raw;
  let operator = "";
  if (body.length && OPERATORS.has(body[0]!)) { operator = body[0]!; body = body.slice(1); }
  else if (body.startsWith("=") || body.startsWith(",") || body.startsWith("!") || body.startsWith("@") || body.startsWith("|")) {
    throw new Error(`Unsupported URI template operator in {${raw}}.`);
  }
  if (!body) throw new Error(`Empty URI template expression {${raw}}.`);
  const variables = body.split(",").map((variable) => {
    if (variable.includes("*") || variable.includes(":")) throw new Error(`Unsupported URI template modifier in {${raw}}; only plain variables are supported.`);
    if (!VARIABLE_NAME.test(variable)) throw new Error(`Invalid URI template variable name in {${raw}}.`);
    return variable;
  });
  return { operator, variables };
}

function parseTemplate(template: string): Array<string | Expression> {
  if (typeof template !== "string" || !template || template.length > MAX_TEMPLATE_LENGTH) throw new Error("Invalid URI template.");
  const parts: Array<string | Expression> = [];
  let last = 0;
  for (const match of template.matchAll(new RegExp(EXPRESSION.source, "g"))) {
    if (match.index! > last) parts.push(template.slice(last, match.index));
    parts.push(parseExpression(match[1]!));
    last = match.index! + match[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  const literal = parts.filter((part): part is string => typeof part === "string").join("");
  if (literal.includes("{") || literal.includes("}")) throw new Error("Unbalanced braces in URI template.");
  return parts;
}

/** Variable names in order of first appearance; a template without expressions has none. */
export function resourceTemplateVariables(template: string): string[] {
  const names: string[] = [];
  for (const part of parseTemplate(template)) {
    if (typeof part === "string") continue;
    for (const variable of part.variables) if (!names.includes(variable)) names.push(variable);
  }
  if (names.length > MAX_VARIABLES) throw new Error(`URI template declares more than ${MAX_VARIABLES} variables.`);
  return names;
}

/** True when the string contains at least one template expression, i.e. it is not a plain URI. */
export function isResourceTemplate(value: string): boolean {
  return EXPRESSION.test(value);
}

function encodeUnreserved(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeReserved(value: string): string {
  // Keep reserved characters and already-encoded triplets; encode everything else as unreserved.
  return value.split(/(%[0-9A-Fa-f]{2})/).map((piece, index) => index % 2 === 1 ? piece.toUpperCase() : encodeURI(piece).replace(/%25/g, "%")).join("");
}

/**
 * Expands `template` with `values`. Every variable the template names must be present (an empty
 * string is a value); unknown names in `values` are ignored. Throws for unsupported operators or
 * modifiers, missing variables and over-long values.
 */
export function expandResourceTemplate(template: string, values: Record<string, string>): string {
  const parts = parseTemplate(template);
  let output = "";
  for (const part of parts) {
    if (typeof part === "string") { output += part; continue; }
    const { operator, variables } = part;
    const entries = variables.map((name) => {
      const value = values[name];
      if (value === undefined) throw new Error(`URI template variable "${name}" has no value.`);
      if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH || value.includes("\0")) throw new Error(`URI template variable "${name}" has an invalid value.`);
      return { name, value };
    });
    const encode = operator === "+" || operator === "#" ? encodeReserved : encodeUnreserved;
    const named = operator === ";" || operator === "?" || operator === "&";
    const separator = ({ "": ",", "+": ",", "#": ",", ".": ".", "/": "/", ";": ";", "?": "&", "&": "&" } as Record<string, string>)[operator]!;
    const prefix = ({ "": "", "+": "", "#": "#", ".": ".", "/": "/", ";": ";", "?": "?", "&": "&" } as Record<string, string>)[operator]!;
    const rendered = entries.map(({ name, value }) => {
      if (!named) return encode(value);
      if (operator === ";" && value === "") return name;
      return `${name}=${encode(value)}`;
    });
    output += `${prefix}${rendered.join(separator)}`;
  }
  return output;
}
