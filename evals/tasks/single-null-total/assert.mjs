import { exactChanges, fileIncludes } from "../../lib/assertions.mjs";
export default async ({ workspace, result }) => { await fileIncludes(workspace, "calculator.js", "return left + right;"); exactChanges(result, ["calculator.js"]); };
