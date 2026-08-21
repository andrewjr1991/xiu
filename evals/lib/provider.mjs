export class ScriptedEvaluationProvider {
  constructor(turns) {
    this.turns = structuredClone(turns);
    this.calls = 0;
  }

  async complete() {
    const turn = this.turns[this.calls++];
    if (!turn) throw new Error("Scripted Provider exhausted before Xiu completed the task.");
    return {
      text: String(turn.text ?? ""),
      toolCalls: Array.isArray(turn.toolCalls) ? turn.toolCalls.map((call, index) => ({ id: call.id ?? `eval-${this.calls}-${index + 1}`, name: call.name, input: call.input ?? {} })) : [],
      raw: { simulated: true, turn: this.calls },
      usage: {
        inputTokens: Number(turn.usage?.inputTokens ?? 100),
        outputTokens: Number(turn.usage?.outputTokens ?? 20),
        totalTokens: Number(turn.usage?.inputTokens ?? 100) + Number(turn.usage?.outputTokens ?? 20),
      },
    };
  }
}
