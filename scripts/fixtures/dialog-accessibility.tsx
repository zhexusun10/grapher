import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence } from "motion/react";
import { ConfirmModal } from "../../src/components/modals/ConfirmModal";
import { EditorModal } from "../../src/components/modals/EditorModal";
import { ApprovalModal } from "../../src/components/modals/ApprovalModal";
import { SettingsModal } from "../../src/components/modals/SettingsModal";
import { defaultConfig, emptyGraph, emptySnapshot } from "../../src/types";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const audit = ((window as any).dialogs = { confirms: 0, saves: 0, closedCallbacks: 0 });
const config = { ...defaultConfig, repository: "/fixture" };

function Fixture() {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [longDetail, setLongDetail] = useState(false);
  audit.setBusy = setBusy;
  audit.setLongDetail = setLongDetail;
  const close = () => setOpen(null);
  return <main style={{ padding: 24 }}>
    {["confirm", "editor", "approval", "settings"].map(kind =>
      <button key={kind} onClick={() => setOpen(kind)}>Open {kind}</button>)}
    <input aria-label="Background input" defaultValue="Retained draft" />
    {/* Closed-but-mounted dialogs must not consume the page's Escape key. */}
    <ConfirmModal config={null} onClose={() => { audit.closedCallbacks += 1; }} />
    <AnimatePresence>
      {open === "confirm" && <ConfirmModal key="confirm" onClose={close} config={{
        title: "Delete conversation?",
        message: "This operation cannot be undone.",
        detail: longDetail ? ("/workspace/" + "very-long-path".repeat(50) + "\n").repeat(20) : "The project files will be kept.",
        confirmText: "Delete conversation",
        danger: true,
        onConfirm: () => { audit.confirms += 1; },
      }} />}
      {open === "editor" && <EditorModal key="editor" isOpen onClose={close} initialGraph={emptyGraph}
        busy={busy} active={false} onSave={() => { audit.saves += 1; }} onError={() => {}} />}
      {open === "approval" && <ApprovalModal key="approval" isOpen onClose={close}
        state={emptySnapshot} config={config} busy={busy} onAdjustPlan={() => {}} onApprove={() => {}} />}
      {open === "settings" && <SettingsModal key="settings" isOpen onClose={close} config={config}
        dataPath="/fixture/data" onSaveConfig={() => { audit.saves += 1; close(); }} />}
    </AnimatePresence>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
