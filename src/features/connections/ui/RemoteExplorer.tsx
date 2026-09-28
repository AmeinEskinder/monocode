import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderPlus,
  FoldVertical,
  Search,
} from "../../../shared/ui/icons";
import { FileTypeIcon } from "../../files/ui/FileTypeIcon";
import { NameRow } from "../../files/ui/FileTree";
import { wellFormedFileName } from "../../files/model/fileName";
import {
  loadShowExcludedFiles,
  subscribeShowExcludedFiles,
} from "../../settings/model/appearance";
import { remoteRequest } from "../model/connections";
import type { RemoteFileTarget } from "../model/remoteFiles";
import type { RemoteProject } from "../model/remoteProjects";
import type { RemoteMachine } from "../model/protocol";
import { RemoteHostError } from "./RemoteHostError";

type Entry = { name: string; path: string; isDir: boolean; ignored: boolean };
type Creating = { id: number; parent: string; isDir: boolean };
const cachedDirs = new Map<string, Record<string, Entry[]>>();
const cachedExpanded = new Map<string, Set<string>>();

export function RemoteExplorer({
  project,
  machine,
  cwd,
  enabled,
  statuses,
  onOpenFile,
  onSearchOpen,
}: {
  project?: RemoteProject;
  machine?: RemoteMachine;
  cwd?: string;
  enabled: boolean;
  statuses: Map<string, string>;
  onOpenFile?: (target: RemoteFileTarget) => void;
  onSearchOpen?: () => void;
}) {
  const workspaceCwd = cwd ?? project?.cwd;
  const treeKey = JSON.stringify([machine?.id, project?.key, workspaceCwd]);
  const activeTreeKey = useRef(treeKey);
  activeTreeKey.current = treeKey;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => cachedExpanded.get(treeKey) ?? new Set([""]),
  );
  const [dirs, setDirs] = useState<Record<string, Entry[]>>(
    () => cachedDirs.get(treeKey) ?? {},
  );
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState<Creating | null>(null);
  const [generation, setGeneration] = useState(0);
  const showExcludedFiles = useSyncExternalStore(
    subscribeShowExcludedFiles,
    loadShowExcludedFiles,
    loadShowExcludedFiles,
  );
  const rootName =
    workspaceCwd?.split(/[\\/]/).filter(Boolean).pop() || "Explorer";
  const rootOpen = expanded.has("");

  useEffect(() => {
    setDirs(cachedDirs.get(treeKey) ?? {});
    setExpanded(cachedExpanded.get(treeKey) ?? new Set([""]));
    setSelected(undefined);
    setCreating(null);
  }, [treeKey]);

  const load = useCallback(
    async (path: string) => {
      if (!project || !machine) return;
      try {
        const entries = await remoteRequest<Entry[]>(machine.id, "files.list", {
          projectId: project.projectId,
          cwd: workspaceCwd,
          path,
        });
        const next = { ...(cachedDirs.get(treeKey) ?? {}), [path]: entries };
        cachedDirs.set(treeKey, next);
        if (activeTreeKey.current === treeKey) {
          setDirs(next);
          setError("");
        }
      } catch (reason) {
        if (activeTreeKey.current === treeKey)
          setError(String(reason).replace(/^Error: /, ""));
      }
    },
    [project?.projectId, machine?.id, workspaceCwd, treeKey],
  );

  useEffect(() => {
    if (!enabled || !project || !machine) return;
    for (const path of expanded) void load(path);
  }, [enabled, load, generation]);

  useEffect(() => {
    if (!enabled || !project || !machine) return;
    const timer = setInterval(() => {
      if (!document.hidden) setGeneration((value) => value + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, [enabled, project?.projectId, machine?.id]);

  const changeExpanded = (update: (old: Set<string>) => Set<string>) => {
    setExpanded((old) => {
      const next = update(old);
      cachedExpanded.set(treeKey, next);
      return next;
    });
  };

  const toggle = (path: string) => {
    if (!expanded.has(path) && !dirs[path]) void load(path);
    changeExpanded((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const startCreate = (isDir: boolean) => {
    const entry = Object.values(dirs)
      .flat()
      .find((item) => item.path === selected);
    const parent = selected
      ? entry?.isDir
        ? selected
        : selected.split("/").slice(0, -1).join("/")
      : "";
    changeExpanded((old) => new Set([...old, "", parent]));
    if (parent && !dirs[parent]) void load(parent);
    setCreating({ id: Date.now(), parent, isDir });
  };

  const commitCreate = async (id: number, raw: string) => {
    if (!creating || creating.id !== id || !project || !machine) return;
    const asFolder = creating.isDir || /[\\/]$/.test(raw);
    const name = wellFormedFileName(raw);
    const created = await remoteRequest<string>(machine.id, "files.create", {
      projectId: project.projectId,
      cwd: workspaceCwd,
      parent: creating.parent,
      name,
      isDir: asFolder,
    });
    const parts = created.split("/");
    const parents = parts
      .slice(0, -1)
      .map((_, index) => parts.slice(0, index + 1).join("/"));
    changeExpanded((old) => new Set([...old, "", ...parents]));
    setCreating(null);
    setSelected(created);
    await Promise.all([creating.parent, ...parents].map((path) => load(path)));
    if (!asFolder) open(created);
  };

  const open = (path: string) => {
    if (!project || !machine || !onOpenFile) return;
    setSelected(path);
    onOpenFile({
      machineId: machine.id,
      projectId: project.projectId,
      projectKey: project.key,
      cwd: workspaceCwd ?? project.cwd,
      relativePath: path,
    });
  };

  const rows = (path: string, depth: number): ReactNode => {
    const entries = (dirs[path] ?? []).filter(
      (entry) => showExcludedFiles || !entry.ignored,
    );
    const row =
      creating?.parent === path ? (
        <NameRow
          key={creating.id}
          depth={depth}
          isDir={creating.isDir}
          siblings={entries.map((entry) => entry.name)}
          onCommit={(raw) => commitCreate(creating.id, raw)}
          onCancel={() => setCreating(null)}
        />
      ) : null;
    const renderEntries = (subset: Entry[]) =>
      subset.map((entry) => (
        <div key={entry.path}>
          <button
            type="button"
            role="treeitem"
            title={entry.path}
            aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}
            onClick={() =>
              entry.isDir ? toggle(entry.path) : open(entry.path)
            }
            className={`flex h-7.5 w-full cursor-default items-center gap-1 pr-2 text-left text-[14px] leading-none ${selected === entry.path ? "bg-selection text-content" : "text-content hover:bg-content/5"}`}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            <span className="grid size-4 shrink-0 place-items-center text-content/50">
              {entry.isDir ? (
                expanded.has(entry.path) ? (
                  <ChevronDown className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <ChevronRight className="size-3.5" strokeWidth={1.75} />
                )
              ) : null}
            </span>
            <span className="shrink-0">
              <FileTypeIcon
                name={entry.name}
                isDir={entry.isDir}
                isOpen={expanded.has(entry.path)}
              />
            </span>
            <span
              className={`min-w-0 truncate ${entry.ignored ? "italic text-content/50" : statusColor(statuses.get(entry.path))}`}
            >
              {entry.name}
            </span>
          </button>
          {entry.isDir && expanded.has(entry.path)
            ? rows(entry.path, depth + 1)
            : null}
        </div>
      ));
    return (
      <>
        {creating?.parent === path && creating.isDir ? row : null}
        {renderEntries(entries.filter((entry) => entry.isDir))}
        {creating?.parent === path && !creating.isDir ? row : null}
        {renderEntries(entries.filter((entry) => !entry.isDir))}
      </>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-px overflow-visible border-b border-stroke px-2">
        <button
          type="button"
          title="New File"
          aria-label="New File"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => startCreate(false)}
          className="flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <FilePlus className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="New Folder"
          aria-label="New Folder"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => startCreate(true)}
          className="flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <FolderPlus className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Collapse All"
          aria-label="Collapse All"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setCreating(null);
            changeExpanded(() => new Set([""]));
          }}
          className="flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <FoldVertical className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Search in files"
          aria-label="Search in files"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onSearchOpen}
          className="flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <Search className="size-3.5" strokeWidth={1.75} />
        </button>
      </header>
      <div className="flex h-8 shrink-0 items-center">
        <button
          type="button"
          aria-expanded={rootOpen}
          title={workspaceCwd}
          onClick={() => {
            setSelected("");
            toggle("");
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1 pl-2 text-left"
        >
          <span className="grid size-4 shrink-0 place-items-center text-content/50">
            {rootOpen ? (
              <ChevronDown className="size-3.5" strokeWidth={1.75} />
            ) : (
              <ChevronRight className="size-3.5" strokeWidth={1.75} />
            )}
          </span>
          <span className="min-w-0 truncate text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
            {rootName}
          </span>
        </button>
      </div>
      {!machine ? (
        <p className="p-3 text-[12px] text-content/50">
          Connect this project’s machine to browse files.
        </p>
      ) : null}
      {error ? (
        <RemoteHostError message={error} canUpdate={!!machine?.ssh} />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {rootOpen ? (
          <div role="tree" aria-label={`${rootName} files`}>
            {rows("", 0)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function statusColor(status?: string) {
  if (status === "modified") return "text-amber-400";
  if (status === "added" || status === "untracked") return "text-emerald-400";
  if (status === "deleted") return "text-red-400";
  return "";
}
