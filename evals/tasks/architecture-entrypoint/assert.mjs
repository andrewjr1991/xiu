import { answerIncludes, exactChanges } from "../../lib/assertions.mjs";
export default async ({ answer, result }) => { answerIncludes(answer, "src/index.js"); answerIncludes(answer, "run"); answerIncludes(answer, "src/runner.js"); exactChanges(result, []); };
