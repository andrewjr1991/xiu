import { exactChanges, fileIncludes } from "../../lib/assertions.mjs";
export default async ({ workspace, result }) => { await fileIncludes(workspace, "config.js", "port: 8080"); await fileIncludes(workspace, "server.js", "localhost:${config.port}"); exactChanges(result, ["config.js", "server.js"]); };
