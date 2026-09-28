import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader } from "../../../shared/ui/icons";
import type {
  GitChangedFile,
  GitDiffIndex,
  GitFileDiff,
} from "../../../platform/tauri/fs";
import { forEachConcurrent } from "../../../shared/lib/concurrent";
import { stageChunkText } from "../../files/editor/editorGit";
import {
  prioritizeWorkingTreeDiffEntries,
  workingTreeDiffEntries,
  workingTreeDiffEntryLabel,
  workingTreeDiffFocusId,
} from "../../source-control/model/workingTreeDiff";
import {
  buildUnifiedFile,
  type UnifiedFileDiff,
} from "../../source-control/model/unifiedDiff";
import {
  UnifiedDiffView,
  type UnifiedDiffFileModel,
} from "../../source-control/ui/UnifiedDiffView";
import type { FilePaneTab } from "../../workspace/model/layout";
import { remoteRequest } from "../model/connections";

type LoadedDiff = {
  binary: boolean;
  tooLarge: boolean;
  original: string;
  current: string;
  unified: UnifiedFileDiff | null;
  error?: string;
};

export function RemoteWorkingTreeDiff({ file }: { file: FilePaneTab }) {
  const remote = file.remoteFile!;
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [diffs, setDiffs] = useState<Map<string, LoadedDiff>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const index = await remoteRequest<GitDiffIndex>(
          remote.machineId,
          "git.index",
          {
            projectId: remote.projectId,
            cwd: file.cwd,
          },
        );
        if (disposed || current !== generation) return;
        setFiles(index.files);
        setDiffs(new Map());
        setError(null);
        const entries = prioritizeWorkingTreeDiffEntries(
          workingTreeDiffEntries(index.files),
          file.path,
          file.changeKind,
        );
        await forEachConcurrent(
          entries,
          4,
          async (entry) => {
            let loaded: LoadedDiff;
            try {
              const diff = await remoteRequest<GitFileDiff>(
                remote.machineId,
                "git.fileDiff",
                {
                  projectId: remote.projectId,
                  cwd: file.cwd,
                  path: entry.file.relative,
                  staged: entry.kind === "staged",
                },
              );
              loaded = {
                binary: diff.binary,
                tooLarge: diff.tooLarge,
                original: diff.original,
                current: diff.current,
                unified:
                  diff.binary || diff.tooLarge
                    ? null
                    : buildUnifiedFile(diff.original, diff.current),
              };
            } catch (reason) {
              loaded = {
                binary: false,
                tooLarge: false,
                original: "",
                current: "",
                unified: null,
                error: String(reason).replace(/^Error: /, ""),
              };
            }
            if (disposed || current !== generation) return;
            setDiffs((previous) => new Map(previous).set(entry.id, loaded));
          },
          () => !disposed && current === generation,
        );
      } catch (reason) {
        if (disposed || current !== generation) return;
        setError(String(reason).replace(/^Error: /, ""));
        setFiles([]);
      }
    };
    void load();
    const onFocus = () => {
      if (!document.hidden) void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [remote.machineId, remote.projectId, file.cwd, revision]);

  const entries = useMemo(() => workingTreeDiffEntries(files ?? []), [files]);
  const models = useMemo<UnifiedDiffFileModel[]>(
    () =>
      entries.map((entry) => {
        const loaded = diffs.get(entry.id);
        const unified = loaded?.unified;
        const unchanged =
          unified && unified.additions === 0 && unified.deletions === 0;
        const canUseIndexCounts =
          loaded &&
          !loaded.error &&
          !(entry.file.staged && entry.file.unstaged);
        return {
          id: entry.id,
          path: entry.file.path,
          label: workingTreeDiffEntryLabel(entry),
          binary: loaded?.binary,
          tooLarge: loaded?.tooLarge,
          emptyMessage: !loaded
            ? "Loading…"
            : loaded.error
              ? `Couldn’t load diff: ${loaded.error}`
              : unchanged
                ? entry.kind === "staged"
                  ? "No staged changes"
                  : "No unstaged changes"
                : undefined,
          additions:
            unified?.additions ??
            (canUseIndexCounts ? entry.file.additions : 0),
          deletions:
            unified?.deletions ??
            (canUseIndexCounts ? entry.file.deletions : 0),
          blocks: unchanged ? [] : (unified?.blocks ?? []),
          canStage: entry.kind === "unstaged",
          canDiscard: entry.kind === "unstaged",
          canStageHunk:
            entry.kind === "unstaged" && !loaded?.binary && !loaded?.tooLarge,
        };
      }),
    [diffs, entries],
  );
  const totals = useMemo(
    () =>
      models.reduce(
        (sum, model) => ({
          additions: sum.additions + model.additions,
          deletions: sum.deletions + model.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [models],
  );
  const focusId = workingTreeDiffFocusId(entries, file.path, file.changeKind);

  const action = useCallback(
    async (id: string, name: "stage" | "discard") => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.kind !== "unstaged") return;
      setBusyId(id);
      try {
        await remoteRequest(remote.machineId, "git.action", {
          projectId: remote.projectId,
          cwd: file.cwd,
          action: name,
          path: entry.file.relative,
        });
        setRevision((current) => current + 1);
      } catch (reason) {
        setError(String(reason).replace(/^Error: /, ""));
      } finally {
        setBusyId(null);
      }
    },
    [entries, remote.machineId, remote.projectId, file.cwd],
  );

  const stageHunk = useCallback(
    async (id: string, pos: number) => {
      const entry = entries.find((candidate) => candidate.id === id);
      const loaded = diffs.get(id);
      if (!entry || entry.kind !== "unstaged" || !loaded) return;
      const contents = stageChunkText(loaded.original, loaded.current, pos);
      if (contents == null) return;
      setBusyId(id);
      try {
        await remoteRequest(remote.machineId, "git.action", {
          projectId: remote.projectId,
          cwd: file.cwd,
          action: "stageContents",
          path: entry.file.relative,
          content: contents,
        });
        setRevision((current) => current + 1);
      } catch (reason) {
        setError(String(reason).replace(/^Error: /, ""));
      } finally {
        setBusyId(null);
      }
    },
    [diffs, entries, remote.machineId, remote.projectId, file.cwd],
  );

  if (error)
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <AlertCircle className="mx-auto mb-3 size-5 text-red-400" />
          <p className="text-[13px] text-content">Couldn’t load changes</p>
          <p className="mt-1 text-[12px] text-content/50">{error}</p>
        </div>
      </div>
    );
  if (files == null)
    return (
      <div className="grid h-full place-items-center text-content/40">
        <Loader className="size-4 animate-spin" strokeWidth={1.75} />
      </div>
    );
  return (
    <UnifiedDiffView
      files={models}
      fileCount={files.length}
      focusId={focusId}
      busyId={busyId}
      totals={totals}
      onStageFile={(id) => void action(id, "stage")}
      onDiscardFile={(id) => void action(id, "discard")}
      onStageHunk={(id, pos) => void stageHunk(id, pos)}
    />
  );
}
