import path from "node:path";
import type ts from "typescript";

// The TypeScript parser is by far the largest dependency Xiu ships (about 0.4 s to load), so it
// is loaded the first time a source file is actually analyzed rather than when Xiu starts.
// Every helper below runs inside analyzeSource, after loadTypeScript() has assigned `api`.
let api: typeof ts;
async function loadTypeScript(): Promise<typeof ts> {
  if (!api) api = (await import("typescript")).default;
  return api;
}

export const MAX_SYMBOLS_PER_FILE = 500;
export const MAX_IMPORTS_PER_FILE = 300;
export const MAX_REFERENCES_PER_FILE = 2_000;
export const MAX_SIGNATURE_CHARACTERS = 240;

export type IndexedSymbolKind = "function" | "class" | "interface" | "type" | "enum" | "namespace" | "variable" | "method" | "property";
export type IndexedReferenceKind = "reference" | "call" | "construct" | "tag";
export type ImportBindingKind = "named" | "default" | "namespace";

export interface IndexedSymbol {
  name: string;
  kind: IndexedSymbolKind;
  line: number;
  column: number;
  container?: string;
  exported: boolean;
  defaultExport: boolean;
  signature: string;
}

export interface IndexedImportBinding {
  imported: string;
  local: string;
  kind: ImportBindingKind;
  line: number;
  column: number;
}

export interface IndexedImport {
  specifier: string;
  line: number;
  bindings: IndexedImportBinding[];
}

export interface IndexedReference {
  name: string;
  line: number;
  column: number;
  kind: IndexedReferenceKind;
  qualifier?: string;
  container?: string;
}

export interface SourceIntelligence {
  language: string;
  analyzed: boolean;
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
  references: IndexedReference[];
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function sourceLanguage(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".ts": return "TypeScript";
    case ".tsx": return "TypeScript JSX";
    case ".js": case ".mjs": case ".cjs": return "JavaScript";
    case ".jsx": return "JavaScript JSX";
    case ".py": return "Python";
    case ".go": return "Go";
    case ".rs": return "Rust";
    case ".java": return "Java";
    case ".kt": return "Kotlin";
    case ".cs": return "C#";
    case ".php": return "PHP";
    case ".rb": return "Ruby";
    case ".swift": return "Swift";
    case ".vue": return "Vue";
    case ".svelte": return "Svelte";
    case ".json": return "JSON";
    case ".md": return "Markdown";
    case ".html": return "HTML";
    case ".css": case ".scss": return "Stylesheet";
    default: return "Other";
  }
}

export function supportsAst(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function position(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: location.line + 1, column: location.character + 1 };
}

function bounded(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

function exported(node: ts.Node): boolean {
  const modifiers = api.canHaveModifiers(node) ? api.getModifiers(node) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === api.SyntaxKind.ExportKeyword || modifier.kind === api.SyntaxKind.DefaultKeyword)) return true;
  if (api.isVariableDeclaration(node) && api.isVariableDeclarationList(node.parent) && api.isVariableStatement(node.parent.parent)) return exported(node.parent.parent);
  return false;
}

function defaultExported(node: ts.Node): boolean {
  const modifiers = api.canHaveModifiers(node) ? api.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === api.SyntaxKind.DefaultKeyword));
}

function declarationSignature(source: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(source);
  const brace = text.indexOf("{");
  const firstLine = text.split(/\r?\n/, 1)[0];
  return bounded(brace >= 0 ? text.slice(0, brace) : firstLine, MAX_SIGNATURE_CHARACTERS);
}

function declarationName(node: ts.Node): ts.Identifier | undefined {
  const candidate = (node as ts.NamedDeclaration).name;
  return candidate && api.isIdentifier(candidate) ? candidate : undefined;
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (api.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => api.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((api.isVariableDeclaration(parent) || api.isParameter(parent) || api.isFunctionDeclaration(parent) || api.isFunctionExpression(parent)
    || api.isClassDeclaration(parent) || api.isClassExpression(parent) || api.isInterfaceDeclaration(parent) || api.isTypeAliasDeclaration(parent)
    || api.isEnumDeclaration(parent) || api.isModuleDeclaration(parent) || api.isMethodDeclaration(parent) || api.isMethodSignature(parent)
    || api.isPropertyDeclaration(parent) || api.isPropertySignature(parent) || api.isGetAccessorDeclaration(parent) || api.isSetAccessorDeclaration(parent)
    || api.isTypeParameterDeclaration(parent) || api.isEnumMember(parent) || api.isBindingElement(parent)) && parent.name === node) return true;
  if (api.isImportClause(parent) && parent.name === node) return true;
  if (api.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (api.isNamespaceImport(parent) && parent.name === node) return true;
  if (api.isImportEqualsDeclaration(parent) && parent.name === node) return true;
  if (api.isPropertyAssignment(parent) && parent.name === node) return true;
  return false;
}

function childContainer(node: ts.Node, container?: string): string | undefined {
  const name = declarationName(node)?.text;
  if (!name) return container;
  if (api.isFunctionDeclaration(node) || api.isClassDeclaration(node)) return container ? `${container}.${name}` : name;
  if (api.isMethodDeclaration(node) || api.isGetAccessorDeclaration(node) || api.isSetAccessorDeclaration(node)) return container ? `${container}.${name}` : name;
  return container;
}

function scriptKind(filename: string): ts.ScriptKind {
  switch (path.extname(filename).toLowerCase()) {
    case ".tsx": return api.ScriptKind.TSX;
    case ".jsx": return api.ScriptKind.JSX;
    case ".js": case ".mjs": case ".cjs": return api.ScriptKind.JS;
    default: return api.ScriptKind.TS;
  }
}

export async function analyzeSource(filename: string, content: string): Promise<SourceIntelligence> {
  const language = sourceLanguage(filename);
  if (!supportsAst(filename)) return { language, analyzed: false, symbols: [], imports: [], references: [] };
  const ts = await loadTypeScript();
  const source = ts.createSourceFile(filename, content, api.ScriptTarget.Latest, true, scriptKind(filename));
  const symbols: IndexedSymbol[] = [];
  const imports: IndexedImport[] = [];

  const addSymbol = (name: ts.Identifier, kind: IndexedSymbolKind, node: ts.Node, container?: string, exportOverride?: boolean): void => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    symbols.push({ name: name.text, kind, ...position(source, name), ...(container ? { container } : {}), exported: exportOverride ?? exported(node), defaultExport: defaultExported(node), signature: declarationSignature(source, node) });
  };

  const collect = (node: ts.Node, container?: string): void => {
    const name = declarationName(node);
    if (name) {
      if (api.isFunctionDeclaration(node)) addSymbol(name, "function", node, container);
      else if (api.isClassDeclaration(node)) addSymbol(name, "class", node, container);
      else if (api.isInterfaceDeclaration(node)) addSymbol(name, "interface", node, container);
      else if (api.isTypeAliasDeclaration(node)) addSymbol(name, "type", node, container);
      else if (api.isEnumDeclaration(node)) addSymbol(name, "enum", node, container);
      else if (api.isModuleDeclaration(node)) addSymbol(name, "namespace", node, container);
      else if (api.isMethodDeclaration(node) || api.isGetAccessorDeclaration(node) || api.isSetAccessorDeclaration(node)) addSymbol(name, "method", node, container, exported(node.parent));
      else if (api.isPropertyDeclaration(node)) addSymbol(name, "property", node, container, exported(node.parent));
    }
    if (api.isVariableDeclaration(node)) {
      for (const identifier of bindingNames(node.name)) addSymbol(identifier, "variable", node, container);
    }
    if (api.isImportDeclaration(node) && api.isStringLiteralLike(node.moduleSpecifier) && imports.length < MAX_IMPORTS_PER_FILE) {
      const bindings: IndexedImportBinding[] = [];
      const clause = node.importClause;
      if (clause?.name) bindings.push({ imported: "default", local: clause.name.text, kind: "default", ...position(source, clause.name) });
      const namedBindings = clause?.namedBindings;
      if (namedBindings) {
        if (api.isNamespaceImport(namedBindings)) bindings.push({ imported: "*", local: namedBindings.name.text, kind: "namespace", ...position(source, namedBindings.name) });
        else for (const element of namedBindings.elements) bindings.push({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text, kind: "named", ...position(source, element.name) });
      }
      imports.push({ specifier: node.moduleSpecifier.text, line: position(source, node).line, bindings });
    }
    if (api.isVariableDeclaration(node) && node.initializer && api.isCallExpression(node.initializer)
      && api.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require"
      && node.initializer.arguments.length === 1 && api.isStringLiteralLike(node.initializer.arguments[0]) && imports.length < MAX_IMPORTS_PER_FILE) {
      const bindings: IndexedImportBinding[] = [];
      if (api.isIdentifier(node.name)) bindings.push({ imported: "*", local: node.name.text, kind: "namespace", ...position(source, node.name) });
      else for (const element of node.name.elements) {
        if (api.isOmittedExpression(element) || !api.isIdentifier(element.name)) continue;
        const imported = element.propertyName && api.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
        bindings.push({ imported, local: element.name.text, kind: "named", ...position(source, element.name) });
      }
      imports.push({ specifier: node.initializer.arguments[0].text, line: position(source, node).line, bindings });
    }
    if (api.isCallExpression(node) && node.expression.kind === api.SyntaxKind.ImportKeyword && node.arguments.length === 1
      && api.isStringLiteralLike(node.arguments[0]) && imports.length < MAX_IMPORTS_PER_FILE) {
      imports.push({ specifier: node.arguments[0].text, line: position(source, node).line, bindings: [] });
    }
    if (api.isExportDeclaration(node) && node.moduleSpecifier && api.isStringLiteralLike(node.moduleSpecifier) && imports.length < MAX_IMPORTS_PER_FILE) {
      const bindings = node.exportClause && api.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((element): IndexedImportBinding => ({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text, kind: "named", ...position(source, element.name) }))
        : [];
      imports.push({ specifier: node.moduleSpecifier.text, line: position(source, node).line, bindings });
    }
    const nextContainer = childContainer(node, container);
    api.forEachChild(node, (child) => collect(child, nextContainer));
  };
  collect(source);

  const callPositions = new Map<number, { kind: IndexedReferenceKind; qualifier?: string }>();
  const markCall = (expression: ts.Expression, kind: IndexedReferenceKind): void => {
    if (api.isIdentifier(expression)) callPositions.set(expression.getStart(source), { kind });
    else if (api.isPropertyAccessExpression(expression)) callPositions.set(expression.name.getStart(source), { kind, qualifier: bounded(expression.expression.getText(source), 80) });
  };
  const markCalls = (node: ts.Node): void => {
    if (api.isCallExpression(node)) markCall(node.expression, "call");
    else if (api.isNewExpression(node)) markCall(node.expression, "construct");
    else if (api.isTaggedTemplateExpression(node)) markCall(node.tag, "tag");
    api.forEachChild(node, markCalls);
  };
  markCalls(source);

  const references: IndexedReference[] = [];
  const collectReferences = (node: ts.Node, container?: string): void => {
    if (references.length >= MAX_REFERENCES_PER_FILE) return;
    if (api.isIdentifier(node) && !isDeclarationIdentifier(node)) {
      const call = callPositions.get(node.getStart(source));
      const propertyQualifier = api.isPropertyAccessExpression(node.parent) && node.parent.name === node ? bounded(node.parent.expression.getText(source), 80) : undefined;
      references.push({ name: node.text, ...position(source, node), kind: call?.kind ?? "reference", ...(call?.qualifier || propertyQualifier ? { qualifier: call?.qualifier ?? propertyQualifier } : {}), ...(container ? { container } : {}) });
    }
    const nextContainer = childContainer(node, container);
    api.forEachChild(node, (child) => collectReferences(child, nextContainer));
  };
  collectReferences(source);
  return { language, analyzed: true, symbols, imports, references };
}

export function resolveModuleSpecifier(fromPath: string, specifier: string, available: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const clean = specifier.replace(/[?#].*$/, "");
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), clean));
  if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return undefined;
  const extension = path.posix.extname(base);
  const withoutExtension = extension ? base.slice(0, -extension.length) : base;
  const candidates = [base];
  if (extension) candidates.push(...RESOLUTION_EXTENSIONS.map((candidate) => `${withoutExtension}${candidate}`));
  else candidates.push(...RESOLUTION_EXTENSIONS.map((candidate) => `${base}${candidate}`));
  candidates.push(...RESOLUTION_EXTENSIONS.map((candidate) => `${base}/index${candidate}`));
  return candidates.find((candidate) => available.has(candidate));
}
