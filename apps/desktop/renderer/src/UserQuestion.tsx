import { useState } from "react";

export function UserQuestion({ question, busy, onAnswer }: { question: string; busy: boolean; onAnswer: (answer: string) => Promise<void> }) {
  const [answer, setAnswer] = useState("");
  return <section className="user-question" role="region" aria-label="等待你的回答">
    <strong>需要你的回答</strong><p>{question}</p>
    <p className="question-note">任务已暂停，不会继续消耗模型请求。回答不会授予执行权限，后续操作仍遵守审批规则。</p>
    <form onSubmit={event => { event.preventDefault(); if (answer.trim() && !busy) void onAnswer(answer.trim()); }}>
      <textarea aria-label="你的回答" placeholder="请输入你的选择或补充信息…" value={answer} disabled={busy} onChange={event => setAnswer(event.target.value)} />
      <button className="primary-button compact" disabled={busy || !answer.trim()}>回答并继续</button>
    </form>
  </section>;
}
