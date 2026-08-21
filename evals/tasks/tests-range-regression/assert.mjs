import { exactChanges, fileIncludes } from "../../lib/assertions.mjs";
export default async ({ workspace, result }) => { await fileIncludes(workspace, "test/range.test.js", "inRange(3, 1, 3)"); exactChanges(result, ["test/range.test.js"]); };
