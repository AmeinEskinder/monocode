import { createPortal } from "react-dom";
import { X } from "../../../shared/ui/icons";
import { LAYER } from "../../../shared/lib/layers";
import { useEffect, useState } from "react";

export type RemotePreview = {
  title: string;
  current: string;
  original?: string;
};

export function RemoteWorkspacePreview({
  preview,
  onClose,
  onSave,
}: {
  preview: RemotePreview;
  onClose: () => void;
  onSave?: (content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(preview.current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const save = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
      setEditing(false);
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setSaving(false);
    }
  };
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-6"
      style={{ zIndex: LAYER.dialog }}
    >
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={preview.title}
        className="relative flex h-[min(85vh,900px)] w-[min(90vw,1400px)] flex-col overflow-hidden rounded-xl border border-stroke bg-background-base shadow-2xl"
      >
        <header className="flex h-10 shrink-0 items-center gap-3 border-b border-stroke px-4">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
            {preview.title}
          </span>
          {onSave ? (
            editing ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(preview.current);
                  }}
                  className="text-[12px] text-content/60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving || draft === preview.current}
                  onClick={() => void save()}
                  className="rounded-md bg-selection px-2 py-1 text-[12px] disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md px-2 py-1 text-[12px] hover:bg-content/10"
              >
                Edit
              </button>
            )
          ) : null}
          <button
            type="button"
            aria-label="Close preview"
            onClick={onClose}
            className="grid size-6 place-items-center rounded-md hover:bg-content/10"
          >
            <X className="size-4" />
          </button>
        </header>
        {error ? (
          <p
            role="alert"
            className="border-b border-stroke px-4 py-2 text-[12px] text-red-400"
          >
            {error}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {preview.original !== undefined ? (
            <div className="flex min-w-0 flex-1 flex-col border-r border-stroke">
              <span className="border-b border-stroke px-4 py-1 text-[11px] text-content/50">
                Before
              </span>
              <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words">
                {preview.original}
              </pre>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            {preview.original !== undefined ? (
              <span className="border-b border-stroke px-4 py-1 text-[11px] text-content/50">
                After
              </span>
            ) : null}
            {editing ? (
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-5 outline-none"
              />
            ) : (
              <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words">
                {preview.current}
              </pre>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
