import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, RotateCcw } from "../../../shared/ui/icons";
import { basename } from "../../../platform/tauri/fs";
import type { GitFileDiff } from "../../../platform/tauri/fs";
import {
  detectLineEnding,
  normalizeLineBreaks,
  restoreLineEnding,
  type LineEnding,
} from "../../files/editor/editorDoc";
import { CodeMirrorEditor } from "../../files/ui/FileEditor";
import { FilePreviewSearch } from "../../files/ui/FilePreviewSearch";
import { MarkdownDocumentPreview } from "../../sessions/ui/MarkdownDocumentPreview";
import {
  MarkdownViewShell,
  useMarkdownMode,
} from "../../sessions/ui/MarkdownModeToggle";
import type { EditorNavigationTarget } from "../../search/model/search";
import type { FilePaneTab } from "../../workspace/model/layout";
import { remoteRequest } from "../model/connections";

type RemoteFile = NonNullable<FilePaneTab["remoteFile"]>;

export function RemoteFileEditor({
  file,
  active,
  navigation,
  onDirtyChange,
  onErrorCountChange,
}: {
  file: FilePaneTab & { remoteFile: RemoteFile };
  active: boolean;
  navigation?: EditorNavigationTarget | null;
  onDirtyChange: (dirty: boolean) => void;
  onErrorCountChange: (count: number) => void;
}) {
  const [content, setContent] = useState<string>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [gitOriginal, setGitOriginal] = useState<string | null>(null);
  const [eolOnly, setEolOnly] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);
  const expected = useRef("");
  const lineEnding = useRef<LineEnding>("\n");
  const diffLineEnding = useRef<LineEnding>("\n");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const { machineId, projectId, relativePath } = file.remoteFile;
  const markdown = /\.(md|mdx|markdown)$/i.test(file.path);
  const [mode, setMode] = useMarkdownMode(file.path);
  const sourceNavigationToken = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (
      !navigation ||
      !markdown ||
      sourceNavigationToken.current === navigation.token
    )
      return;
    sourceNavigationToken.current = navigation.token;
    setMode("source");
  }, [navigation, markdown, setMode]);

  useEffect(() => {
    if (!file.review) {
      setGitOriginal(null);
      setEolOnly(false);
      return;
    }
    let disposed = false;
    setGitOriginal(null);
    setEolOnly(false);
    void remoteRequest<GitFileDiff>(machineId, "git.fileDiff", {
      projectId,
      cwd: file.cwd,
      path: relativePath,
      staged: file.changeKind === "staged",
    }).then(
      (diff) => {
        if (disposed || diff.binary || diff.tooLarge) return;
        const original = normalizeLineBreaks(diff.original);
        diffLineEnding.current = detectLineEnding(
          diff.original || diff.current,
        );
        setGitOriginal(original);
        setEolOnly(
          diff.original !== diff.current &&
            original === normalizeLineBreaks(diff.current),
        );
      },
      () => {
        if (!disposed) setGitOriginal(null);
      },
    );
    return () => {
      disposed = true;
    };
  }, [
    machineId,
    projectId,
    file.cwd,
    relativePath,
    file.review,
    file.changeKind,
    reloadKey,
    diffRevision,
  ]);

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
        const normalized = normalizeLineBreaks(raw);
        setContent(normalized);
        setDraft(normalized);
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
        if (file.review) setDiffRevision((current) => current + 1);
      });
      saveQueue.current = operation.catch(() => {});
      return operation.catch((reason) => {
        const message = String(reason).replace(/^Error: /, "");
        setSaveStatus(`Save failed: ${message}`);
        throw reason;
      });
    },
    [machineId, projectId, file.cwd, relativePath, file.review],
  );

  const stageGit = useCallback(
    async (contents: string) => {
      if (!file.review || file.changeKind !== "unstaged")
        throw new Error("Only unstaged changes can be staged");
      await remoteRequest(machineId, "git.action", {
        projectId,
        cwd: file.cwd,
        action: "stageContents",
        path: relativePath,
        content: restoreLineEnding(contents, diffLineEnding.current),
      });
      setDiffRevision((current) => current + 1);
    },
    [
      machineId,
      projectId,
      file.cwd,
      relativePath,
      file.review,
      file.changeKind,
    ],
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
  const editor = (
    <CodeMirrorEditor
      key={reloadKey}
      path={file.path}
      commentPath={relativePath}
      value={content}
      showDiff={!!file.review}
      gitOriginal={gitOriginal}
      active={active && (!markdown || mode === "source")}
      navigation={navigation}
      onDirtyChange={onDirtyChange}
      onErrorCountChange={onErrorCountChange}
      onSave={save}
      onStageGit={
        file.review && file.changeKind === "unstaged" ? stageGit : undefined
      }
      onDocChange={markdown ? setDraft : undefined}
      formatOnSave={false}
    />
  );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {file.review && eolOnly ? (
        <p
          role="status"
          className="shrink-0 border-b border-stroke px-3 py-1 text-[12px] text-content/60"
        >
          {file.changeKind === "staged" ? "Staged" : "Unstaged"} line-ending
          changes. Line breaks are normalized in this view.
        </p>
      ) : null}
      {markdown ? (
        <MarkdownViewShell
          mode={mode}
          onModeChange={setMode}
          preview={
            <FilePreviewSearch
              active={active && mode === "preview"}
              contentVersion={draft}
            >
              <MarkdownDocumentPreview
                text={draft}
                metadataLabel="Properties"
                cwd={file.cwd}
              />
            </FilePreviewSearch>
          }
          source={
            <div className="flex h-full min-h-0 min-w-0 flex-col">{editor}</div>
          }
        />
      ) : (
        editor
      )}
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
