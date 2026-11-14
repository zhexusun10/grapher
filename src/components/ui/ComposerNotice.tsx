import { X } from "lucide-react";
import { t } from "../../i18n";
import "./composer-commands.css";

export function ComposerNotice({ text, error, onClose }: { text: string; error?: boolean; onClose: () => void }) {
  return <div className={`prompt-command-popover prompt-command-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
    <pre>{text.split(/(https?:\/\/[^\s]+)/g).map((part, index) => /^https?:\/\//.test(part)
      ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part)}</pre>
    <button type="button" className="prompt-command-notice-close" onClick={onClose} aria-label={t("关闭提示")}><X size={13} /></button>
  </div>;
}
