// WKWebView puts styled HTML/RTF flavors on the pasteboard for DOM
// selections, so pastes carry BFD's background/text colors. Re-copy as
// plain text only. Inputs/textareas already copy plain natively and any
// editor/terminal widget that owns its clipboard focuses one, so those
// keep their default behavior.
document.addEventListener("copy", (e) => {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
  const text = window.getSelection()?.toString();
  if (!text || !e.clipboardData) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", text);
});

export {};
