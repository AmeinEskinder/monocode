import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  CloudUpload,
  GitBranch,
  GitPullRequest,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  WandSparkles,
} from "../../../shared/ui/icons";
import { MOD } from "../../../platform/tauri/platform";
import type {
  GitChangedFile,
  GitDiffIndex,
  GitFileDiff,
} from "../../../platform/tauri/fs";
import {
  loadChangesView,
  saveChangesView,
  type ChangesView,
} from "../../settings/model/appearance";
import {
  ChangeList,
  FileSection,
} from "../../source-control/ui/GitChangesPanel";
import { remoteRequest } from "../model/connections";
import type { RemoteProject } from "../model/remoteProjects";
import type { RemoteMachine } from "../model/protocol";
import { RemoteHostError } from "./RemoteHostError";
import {
  RemoteWorkspacePreview,
  type RemotePreview,
} from "./RemoteWorkspacePreview";

export function RemoteChanges({
  project,
  machine,
  cwd,
  index,
  error: loadError,
  refresh,
}: {
  project?: RemoteProject;
  machine?: RemoteMachine;
  cwd?: string;
  index: GitDiffIndex | null;
  error: string;
  refresh: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<RemotePreview>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [view, setView] = useState<ChangesView>(loadChangesView);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const staged = index?.files.filter((file) => file.staged) ?? [];
  const changes = index?.files.filter((file) => file.unstaged) ?? [];
  const canCommit = !!staged.length && !!message.trim() && !busy;

  useEffect(() => {
    const el = messageRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [message]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const request = async (name: string, path?: string) => {
    if (!project || !machine) throw new Error("Machine is not connected");
    return remoteRequest<string | null>(machine.id, "git.action", {
      projectId: project.projectId,
      cwd,
      action: name,
      path,
      message: name === "commit" ? message.trim() : undefined,
    });
  };
  const run = async (name: string, path?: string) => {
    if (busy) return;
    setBusy(path ?? name);
    setError("");
    try {
      const result = await request(name, path);
      if (name === "createPr" && result) await openUrl(result);
      refresh();
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setBusy(null);
    }
  };
  const commit = async (push = false, pr = false) => {
    if (!canCommit) return;
    setBusy("commit");
    setMenuOpen(false);
    setError("");
    try {
      await request("commit");
      setMessage("");
      refresh();
      if (push) await request("push");
      if (pr) {
        const url = await request("createPr");
        if (url) await openUrl(url);
      }
      refresh();
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setBusy(null);
    }
  };
  const discard = async (file?: GitChangedFile) => {
    if (busy) return;
    const label = file
      ? `Discard changes in ${file.relative}?`
      : "Discard all changes?";
    if (
      !(await ask(`${label} This cannot be undone.`, {
        title: "MonoCode",
        kind: "warning",
        okLabel: "Discard",
      }))
    )
      return;
    await run(file ? "discard" : "discardAll", file?.relative);
  };
  const open = async (path: string, kind: "staged" | "unstaged") => {
    if (!project || !machine) return;
    setError("");
    try {
      const diff = await remoteRequest<GitFileDiff>(
        machine.id,
        "git.fileDiff",
        {
          projectId: project.projectId,
          cwd,
          path,
          staged: kind === "staged",
        },
      );
      setPreview({
        title: path,
        original: diff.binary || diff.tooLarge ? undefined : diff.original,
        current: diff.binary
          ? "Binary file cannot be previewed"
          : diff.tooLarge
            ? "File is too large to preview"
            : diff.current,
      });
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    }
  };
  const toggleView = () => {
    const next = view === "list" ? "tree" : "list";
    setView(next);
    saveChangesView(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke px-3">
        <span className="text-[12px] font-medium text-content">Changes</span>
        {index?.branch ? (
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[11px] text-content/50">
            <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{index.branch}</span>
          </span>
        ) : (
          <span className="ml-auto" />
        )}
        <button
          type="button"
          title="Refresh changes"
          aria-label="Refresh changes"
          onClick={refresh}
          className="grid size-5 place-items-center rounded-md text-content/50 hover:bg-content/10"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
      </header>
      <div className="shrink-0 border-b border-stroke p-2">
        <div className="relative">
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            placeholder={`Message (${MOD}↩ to commit)`}
            disabled={!staged.length || !!busy}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                canCommit
              ) {
                event.preventDefault();
                void commit();
              }
            }}
            className="max-h-40 w-full resize-none overflow-y-auto rounded-md bg-content/10 py-1 pr-8 pl-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/35 disabled:opacity-40"
          />
          <button
            type="button"
            title="Generate commit message is unavailable on remote machines"
            aria-label="Generate commit message"
            disabled
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-content/10 text-content disabled:opacity-40"
          >
            <WandSparkles className="size-3" strokeWidth={1} />
          </button>
        </div>
        <div ref={menuRef} className="relative mt-1.5 flex">
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void commit()}
            className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md text-[12px] font-medium ${canCommit ? "bg-content text-background-base" : "bg-content/40 text-background-base"}`}
          >
            <Check className="size-3.5" strokeWidth={2} />
            Commit
          </button>
          <button
            type="button"
            title="Commit options"
            aria-label="Commit options"
            aria-expanded={menuOpen}
            disabled={!index?.branch || !!busy}
            onClick={() => setMenuOpen(!menuOpen)}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-r-md border-l border-background-base/10 ${canCommit ? "bg-content text-background-base hover:bg-content/80" : "bg-content/40 text-background-base hover:bg-content"} disabled:pointer-events-none`}
          >
            <ChevronDown className="size-3.5" strokeWidth={2} />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              aria-label="Commit options"
              className="absolute top-full right-0 z-30 mt-1 min-w-48 rounded-md border border-content/10 bg-background-base py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                disabled={!canCommit || !index?.remote}
                onClick={() => void commit(true)}
                className="flex h-7 w-full items-center px-3 text-left text-[12px] text-content hover:bg-content/10 disabled:opacity-40"
              >
                Commit &amp; Push
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!canCommit || !index?.remote}
                onClick={() => void commit(true, true)}
                className="flex h-7 w-full items-center px-3 text-left text-[12px] text-content hover:bg-content/10 disabled:opacity-40"
              >
                Commit, Push &amp; Create PR
              </button>
            </div>
          ) : null}
        </div>
        {index?.remote && index.branch ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {!index.upstream || index.ahead > 0 ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void run("push")}
                className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-content/10 px-2 text-[12px] font-medium text-content hover:bg-content/15 disabled:opacity-40"
              >
                {index.upstream ? (
                  <RefreshCw className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <CloudUpload className="size-3.5" strokeWidth={1.75} />
                )}
                {index.upstream ? "Push Changes" : "Publish Branch"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={
                !!busy ||
                !!index.files.length ||
                !index.defaultBranch ||
                index.branch === index.defaultBranch ||
                index.aheadOfDefault === 0
              }
              onClick={() => void run("createPr")}
              className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-content/10 px-2 text-[12px] font-medium text-content hover:bg-content/15 disabled:opacity-40"
            >
              <GitPullRequest className="size-3.5" strokeWidth={1.75} />
              Create PR
            </button>
          </div>
        ) : null}
      </div>
      {!machine ? (
        <p className="px-3 py-2 text-[12px] text-content/45">
          Connect this project’s machine to view changes.
        </p>
      ) : null}
      {error || loadError ? (
        <RemoteHostError
          message={error || loadError}
          canUpdate={!!machine?.ssh}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none py-1">
        {machine && !index && !error && !loadError ? (
          <p className="px-3 py-2 text-[12px] text-content/45">
            Loading changes…
          </p>
        ) : null}
        {index && !index.files.length && !error && !loadError ? (
          <p className="px-3 py-2 text-[12px] text-content/45">
            No uncommitted changes
          </p>
        ) : null}
        {staged.length ? (
          <FileSection
            title="Staged Changes"
            count={staged.length}
            open={stagedOpen}
            onToggle={() => setStagedOpen(!stagedOpen)}
            view={view}
            onToggleView={toggleView}
            headerActions={[
              {
                title: "Unstage All Changes",
                icon: <Minus className="size-3.5" strokeWidth={1.75} />,
                onClick: () => void run("unstageAll"),
              },
            ]}
          >
            <ChangeList
              files={staged}
              view={view}
              kind="staged"
              busy={busy}
              onOpenFile={(path) => void open(path, "staged")}
              onAction={(file, action) => void run(action, file.relative)}
            />
          </FileSection>
        ) : null}
        {changes.length ? (
          <FileSection
            title="Changes"
            count={changes.length}
            open={changesOpen}
            onToggle={() => setChangesOpen(!changesOpen)}
            view={view}
            onToggleView={toggleView}
            headerActions={[
              {
                title: "Discard All Changes",
                icon: <Undo2 className="size-3.5" strokeWidth={1.75} />,
                onClick: () => void discard(),
              },
              {
                title: "Stage All Changes",
                icon: <Plus className="size-3.5" strokeWidth={1.75} />,
                onClick: () => void run("stageAll"),
              },
            ]}
          >
            <ChangeList
              files={changes}
              view={view}
              kind="unstaged"
              busy={busy}
              onOpenFile={(path) => void open(path, "unstaged")}
              onAction={(file, action) =>
                action === "discard"
                  ? void discard(file)
                  : void run(action, file.relative)
              }
            />
          </FileSection>
        ) : null}
      </div>
      {preview ? (
        <RemoteWorkspacePreview
          preview={preview}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </div>
  );
}
