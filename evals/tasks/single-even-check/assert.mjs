import { exactChanges, fileIncludes } from "../../lib/assertions.mjs";
export default async ({ workspace, result }) => { await fileIncludes(workspace, "parity.js", "value % 2 === 0"); exactChanges(result, ["parity.js"]); };
