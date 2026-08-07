import path from "node:path";
import ts from "typescript";

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
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)) return true;
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)) return exported(node.parent.parent);
  return false;
}

function defaultExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function declarationSignature(source: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(source);
  const brace = text.indexOf("{");
  const firstLine = text.split(/\r?\n/, 1)[0];
  return bounded(brace >= 0 ? text.slice(0, brace) : firstLine, MAX_SIGNATURE_CHARACTERS);
}

function declarationName(node: ts.Node): ts.Identifier | undefined {
  const candidate = (node as ts.NamedDeclaration).name;
  return candidate && ts.isIdentifier(candidate) ? candidate : undefined;
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)
    || ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)
    || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
    || ts.isTypeParameterDeclaration(parent) || ts.isEnumMember(parent) || ts.isBindingElement(parent)) && parent.name === node) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isNamespaceImport(parent) && parent.name === node) return true;
  if (ts.isImportEqualsDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  return false;
}

function childContainer(node: ts.Node, container?: string): string | undefined {
  const name = declarationName(node)?.text;
  if (!name) return container;
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return container ? `${container}.${name}` : name;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return container ? `${container}.${name}` : name;
  return container;
}

function scriptKind(filename: string): ts.ScriptKind {
  switch (path.extname(filename).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js": case ".mjs": case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

export function analyzeSource(filename: string, content: string): SourceIntelligence {
  const language = sourceLanguage(filename);
  if (!supportsAst(filename)) return { language, analyzed: false, symbols: [], imports: [], references: [] };
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, scriptKind(filename));
  const symbols: IndexedSymbol[] = [];
  const imports: IndexedImport[] = [];

  const addSymbol = (name: ts.Identifier, kind: IndexedSymbolKind, node: ts.Node, container?: string, exportOverride?: boolean): void => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    symbols.push({ name: name.text, kind, ...position(source, name), ...(container ? { container } : {}), exported: exportOverride ?? exported(node), defaultExport: defaultExported(node), signature: declarationSignature(source, node) });
  };

  const collect = (node: ts.Node, container?: string): void => {
    const name = declarationName(node);
    if (name) {
      if (ts.isFunctionDeclaration(node)) addSymbol(name, "function", node, container);
      else if (ts.isClassDeclaration(node)) addSymbol(name, "class", node, container);
      else if (ts.isInterfaceDeclaration(node)) addSymbol(name, "interface", node, container);
      else if (ts.isTypeAliasDeclaration(node)) addSymbol(name, "type", node, container);
      else if (ts.isEnumDeclaration(node)) addSymbol(name, "enum", node, container);
      else if (ts.isModuleDeclaration(node)) addSymbol(name, "namespace", node, container);
      else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) addSymbol(name, "method", node, container, exported(node.parent));
      else if (ts.isPropertyDeclaration(node)) addSymbol(name, "property", node, container, exported(node.parent));
    }
    if (ts.isVariableDeclaration(node)) {
      for (const identifier of bindingNames(node.name)) addSymbol(identifier, "variable", node, container);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && imports.length < MAX_IMPORTS_PER_FILE) {
      const bindings: IndexedImportBinding[] = [];
      const clause = node.importClause;
      if (clause?.name) bindings.push({ imported: "default", local: clause.name.text, kind: "default", ...position(source, clause.name) });
      const namedBindings = clause?.namedBindings;
      if (namedBindings) {
        if (ts.isNamespaceImport(namedBindings)) bindings.push({ imported: "*", local: namedBindings.name.text, kind: "namespace", ...position(source, namedBindings.name) });
        else for (const element of namedBindings.elements) bindings.push({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text, kind: "named", ...position(source, element.name) });
      }
      imports.push({ specifier: node.moduleSpecifier.text, line: position(source, node).line, bindings });
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require"
      && node.initializer.arguments.length === 1 && ts.isStringLiteralLike(node.initializer.arguments[0]) && imports.length < MAX_IMPORTS_PER_FILE) {
      const bindings: IndexedImportBinding[] = [];
      if (ts.isIdentifier(node.name)) bindings.push({ imported: "*", local: node.name.text, kind: "namespace", ...position(source, node.name) });
      else for (const element of node.name.elements) {
        if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) continue;
        const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
        bindings.push({ imported, local: element.name.text, kind: "named", ...position(source, element.name) });
      }
      imports.push({ specifier: node.initializer.arguments[0].text, line: position(source, node).line, bindings });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]) && imports.length < MAX_IMPORTS_PER_FILE) {
      imports.push({ specifier: node.arguments[0].text, line: position(source, node).line, bindings: [] });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && imports.length < MAX_IMPORTS_PER_FILE) {
      const bindings = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((element): IndexedImportBinding => ({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text, kind: "named", ...position(source, element.name) }))
        : [];
      imports.push({ specifier: node.moduleSpecifier.text, line: position(source, node).line, bindings });
    }
    const nextContainer = childContainer(node, container);
    ts.forEachChild(node, (child) => collect(child, nextContainer));
  };
  collect(source);

  const callPositions = new Map<number, { kind: IndexedReferenceKind; qualifier?: string }>();
  const markCall = (expression: ts.Expression, kind: IndexedReferenceKind): void => {
    if (ts.isIdentifier(expression)) callPositions.set(expression.getStart(source), { kind });
    else if (ts.isPropertyAccessExpression(expression)) callPositions.set(expression.name.getStart(source), { kind, qualifier: bounded(expression.expression.getText(source), 80) });
  };
  const markCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) markCall(node.expression, "call");
    else if (ts.isNewExpression(node)) markCall(node.expression, "construct");
    else if (ts.isTaggedTemplateExpression(node)) markCall(node.tag, "tag");
    ts.forEachChild(node, markCalls);
  };
  markCalls(source);

  const references: IndexedReference[] = [];
  const collectReferences = (node: ts.Node, container?: string): void => {
    if (references.length >= MAX_REFERENCES_PER_FILE) return;
    if (ts.isIdentifier(node) && !isDeclarationIdentifier(node)) {
      const call = callPositions.get(node.getStart(source));
      const propertyQualifier = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? bounded(node.parent.expression.getText(source), 80) : undefined;
      references.push({ name: node.text, ...position(source, node), kind: call?.kind ?? "reference", ...(call?.qualifier || propertyQualifier ? { qualifier: call?.qualifier ?? propertyQualifier } : {}), ...(container ? { container } : {}) });
    }
    const nextContainer = childContainer(node, container);
    ts.forEachChild(node, (child) => collectReferences(child, nextContainer));
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
