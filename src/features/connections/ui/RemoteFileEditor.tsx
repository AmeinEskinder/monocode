import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, RotateCcw } from "../../../shared/ui/icons";
import { basename } from "../../../platform/tauri/fs";
import {
  detectLineEnding,
  normalizeLineBreaks,
  restoreLineEnding,
  type LineEnding,
} from "../../files/editor/editorDoc";
import { CodeMirrorEditor } from "../../files/ui/FileEditor";
import type { FilePaneTab } from "../../workspace/model/layout";
import { remoteRequest } from "../model/connections";

type RemoteFile = NonNullable<FilePaneTab["remoteFile"]>;

export function RemoteFileEditor({
  file,
  active,
  onDirtyChange,
  onErrorCountChange,
}: {
  file: FilePaneTab & { remoteFile: RemoteFile };
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onErrorCountChange: (count: number) => void;
}) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const expected = useRef("");
  const lineEnding = useRef<LineEnding>("\n");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const { machineId, projectId, relativePath } = file.remoteFile;

  useEffect(() => {
    let disposed = false;
    setContent(undefined);
    setError("");
    setSaveStatus("");
    void remoteRequest<string>(machineId, "files.read", {
      projectId,
      cwd: file.cwd,
      path: relativePath,
    }).then(
      (raw) => {
        if (disposed) return;
        expected.current = raw;
        lineEnding.current = detectLineEnding(raw);
        setContent(normalizeLineBreaks(raw));
      },
      (reason) => {
        if (!disposed) setError(String(reason).replace(/^Error: /, ""));
      },
    );
    return () => {
      disposed = true;
    };
  }, [machineId, projectId, file.cwd, relativePath, reloadKey]);

  const save = useCallback(
    (value: string) => {
      setSaveStatus("Saving…");
      const operation = saveQueue.current.then(async () => {
        const raw = restoreLineEnding(value, lineEnding.current);
        await remoteRequest(machineId, "files.write", {
          projectId,
          cwd: file.cwd,
          path: relativePath,
          expected: expected.current,
          content: raw,
        });
        expected.current = raw;
        setSaveStatus("Saved");
      });
      saveQueue.current = operation.catch(() => {});
      return operation.catch((reason) => {
        const message = String(reason).replace(/^Error: /, "");
        setSaveStatus(`Save failed: ${message}`);
        throw reason;
      });
    },
    [machineId, projectId, file.cwd, relativePath],
  );

  if (error)
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="mx-auto mb-3 size-5 text-red-400" />
          <p className="text-[13px] text-content">
            Couldn’t open {basename(file.path)}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-content/50">{error}</p>
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            className="mx-auto mt-4 flex h-7 items-center gap-1.5 rounded-md bg-content/10 px-2.5 text-[12px] text-content hover:bg-content/15"
          >
            <RotateCcw className="size-3" strokeWidth={1.75} />
            Retry
          </button>
        </div>
      </div>
    );
  if (content === undefined)
    return (
      <div className="grid h-full place-items-center text-[12px] text-content/45">
        Opening {basename(file.path)}…
      </div>
    );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <CodeMirrorEditor
        key={reloadKey}
        path={file.path}
        commentPath={relativePath}
        value={content}
        showDiff={false}
        gitOriginal={null}
        active={active}
        onDirtyChange={onDirtyChange}
        onErrorCountChange={onErrorCountChange}
        onSave={save}
        formatOnSave={false}
      />
      <footer className="flex h-6 shrink-0 items-center border-t border-stroke px-2.5 font-mono text-[10.5px] text-content/40">
        <span className="min-w-0 flex-1 truncate" title={file.path}>
          {relativePath}
        </span>
        <span
          className={
            saveStatus.startsWith("Save failed")
              ? "max-w-64 truncate text-red-400"
              : ""
          }
          title={saveStatus}
        >
          {saveStatus}
        </span>
      </footer>
    </div>
  );
}
