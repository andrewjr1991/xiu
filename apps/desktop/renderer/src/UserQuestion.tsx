import { useState, type ReactNode } from "react";

export function UserQuestion({ question, busy, onAnswer, attachments, hasAttachments = false, onChooseAttachments, onImportFiles }: {
  question: string;
  busy: boolean;
  onAnswer: (answer: string) => Promise<void>;
  attachments?: ReactNode;
  hasAttachments?: boolean;
  onChooseAttachments: () => void;
  onImportFiles: (files: File[]) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  return <section className="user-question" role="region" aria-label="等待你的回答">
    <strong>需要你的回答</strong><p>{question}</p>
    <p className="question-note">任务已暂停，不会继续消耗模型请求。回答不会授予执行权限，后续操作仍遵守审批规则。</p>
    <form onSubmit={event => { event.preventDefault(); if ((answer.trim() || hasAttachments) && !busy) void onAnswer(answer.trim()); }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? "none" : "copy"; }}
      onDrop={event => { event.preventDefault(); if (!busy) void onImportFiles([...event.dataTransfer.files]); }}>
      {attachments}
      <textarea aria-label="你的回答" placeholder="请输入补充信息，也可粘贴或拖入截图…" value={answer} disabled={busy} onChange={event => setAnswer(event.target.value)}
        onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); if (!busy) void onImportFiles(files); } }} />
      <div className="question-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onChooseAttachments}>＋ 添加图片或文件</button>
      <button type="submit" className="primary-button compact" disabled={busy || (!answer.trim() && !hasAttachments)}>回答并继续</button></div>
    </form>
  </section>;
}
