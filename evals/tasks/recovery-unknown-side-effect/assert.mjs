import { answerIncludes, exactChanges } from "../../lib/assertions.mjs";
export default async ({ answer, result }) => { answerIncludes(answer, "Never replay unknown operations automatically"); if (result.recovery?.pendingSideEffects !== 1 || result.recovery?.replayed !== false) throw new Error("Unknown side effect was not preserved without replay."); exactChanges(result, []); };
