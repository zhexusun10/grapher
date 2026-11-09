import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptBox } from "../../src/components/ui/chatgpt-prompt-input";

function Fixture() {
  const [working, setWorking] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  return <>
    <button onClick={() => setWorking(value => !value)}>Toggle working</button>
    <button onClick={() => setDisabled(value => !value)}>Toggle disabled</button>
    <PromptBox isWorking={working} disabled={disabled}
      onInterrupt={() => setEvents(value => [...value, "interrupt"])}
      onContinue={() => setEvents(value => [...value, "continue"])}
      onSubmit={text => { setEvents(value => [...value, `send:${text}`]); return true; }} />
    <output>{events.join("|")}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
