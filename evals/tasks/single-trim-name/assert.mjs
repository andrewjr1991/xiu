import { exactChanges, fileIncludes } from "../../lib/assertions.mjs";
export default async ({ workspace, result }) => { await fileIncludes(workspace, "names.js", "return input.trim();"); exactChanges(result, ["names.js"]); };
