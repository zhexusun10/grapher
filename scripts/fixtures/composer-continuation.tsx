import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptBox } from "../../src/components/ui/chatgpt-prompt-input";

function Fixture() {
  const [working, setWorking] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const pending = new URLSearchParams(location.search).get("pending") === "1";
  (window as any).continuationFixture = { ...(window as any).continuationFixture, setWorking };
  return <>
    <button onClick={() => setWorking(value => !value)}>Toggle working</button>
    <button onClick={() => setDisabled(value => !value)}>Toggle disabled</button>
    <PromptBox isWorking={working} disabled={disabled}
      onInterrupt={() => setEvents(value => [...value, "interrupt"])}
      onContinue={() => {
        setEvents(value => [...value, "continue"]);
        if (pending) return new Promise<boolean>((resolve, reject) => {
          (window as any).continuationFixture.resolve = resolve;
          (window as any).continuationFixture.reject = reject;
        });
      }}
      onSubmit={text => { setEvents(value => [...value, `send:${text}`]); return true; }} />
    <output>{events.join("|")}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
