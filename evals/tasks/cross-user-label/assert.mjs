import { exactChanges, fileIncludes } from "../../lib/assertions.mjs";
export default async ({ workspace, result }) => { await fileIncludes(workspace, "lib/user.js", "function userLabel"); await fileIncludes(workspace, "app.js", "userLabel(user)"); exactChanges(result, ["app.js", "lib/user.js"]); };
