// Share module downloads between navigation prewarming and the actual mount.
// Import completion never selects a Run or publishes a snapshot.
let pending: Promise<typeof import("../components/views/AppGraphWorkbench")> | undefined;

export function loadWorkbench() {
  return pending ??= import("../components/views/AppGraphWorkbench").catch(error => {
    pending = undefined;
    throw error;
  });
}

export function preloadWorkbench(): void {
  // Speculation must not create an unhandled rejection. The mount owns the
  // visible error/reload UI if the user actually opens a conversation.
  void loadWorkbench().catch(() => {});
}
