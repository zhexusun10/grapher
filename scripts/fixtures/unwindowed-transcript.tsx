import React from "react";
import type { TranscriptItem } from "../../src/types";
import { ToolCallCard } from "../../src/components/ToolCallCard";
import { EditableUserBubble } from "../../src/components/views/ChatBubbles";

/** Performance-only reference for the former all-rows inline layout. It receives
 * the identical synthetic records, without copying the production JSONL parser.
 */
export function UnwindowedTranscript({ items }: { items: TranscriptItem[] }) {
  return <div className="virtualized-transcript-container transcript-inline">
    <div className="transcript-scroll-area">
      {items.map(item => <div key={item.id} data-transcript-id={item.id} style={{ display: "flow-root" }}>
        {item.type === "tool_call" ? <div className="transcript-row tool-row"><ToolCallCard item={item} /></div> :
          <div className="transcript-row text-row user"><EditableUserBubble text={item.content || ""} editing={false} draft="" onDraftChange={() => {}} onCancel={() => {}} onSend={() => {}} /></div>}
      </div>)}
    </div>
  </div>;
}
