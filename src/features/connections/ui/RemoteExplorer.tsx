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
  FoldVertical,
  RefreshCw,
  Search,
  X,
} from "../../../shared/ui/icons";
import { FileTypeIcon } from "../../files/ui/FileTypeIcon";
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

export function RemoteExplorer({
  project,
  machine,
  cwd,
  enabled,
  statuses,
  onOpenFile,
  rootLabel,
  searchOpen,
  onSearchOpen,
  onSearchClose,
  searchFocusToken,
}: {
  project?: RemoteProject;
  machine?: RemoteMachine;
  cwd?: string;
  enabled: boolean;
  statuses: Map<string, string>;
  onOpenFile?: (target: RemoteFileTarget) => void;
  rootLabel?: string;
  searchOpen: boolean;
  onSearchOpen?: () => void;
  onSearchClose: () => void;
  searchFocusToken?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [dirs, setDirs] = useState<Record<string, Entry[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Entry[]>([]);
  const searchInput = useRef<HTMLInputElement>(null);
  const showExcludedFiles = useSyncExternalStore(
    subscribeShowExcludedFiles,
    loadShowExcludedFiles,
    loadShowExcludedFiles,
  );
  const rootName =
    rootLabel?.trim() ||
    (cwd ?? project?.cwd)?.split(/[\\/]/).pop() ||
    "Explorer";
  const rootOpen = expanded.has("");

  useEffect(() => {
    setDirs({});
    setExpanded(new Set([""]));
    setSelected(undefined);
  }, [project?.key, machine?.id, cwd]);

  const load = useCallback(
    async (path: string) => {
      if (!project || !machine) return;
      setBusy(true);
      try {
        const entries = await remoteRequest<Entry[]>(machine.id, "files.list", {
          projectId: project.projectId,
          cwd,
          path,
        });
        setDirs((old) => ({ ...old, [path]: entries }));
        setError("");
      } catch (reason) {
        setError(String(reason).replace(/^Error: /, ""));
      } finally {
        setBusy(false);
      }
    },
    [project?.projectId, machine?.id, cwd],
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

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
    else {
      setQuery("");
      setResults([]);
    }
  }, [searchOpen, searchFocusToken]);

  useEffect(() => {
    if (!searchOpen || !machine || !project || !query.trim()) {
      setResults([]);
      return;
    }
    let disposed = false;
    const timer = setTimeout(() => {
      void remoteRequest<Entry[]>(machine.id, "files.search", {
        projectId: project.projectId,
        cwd,
        query,
      })
        .then((entries) => {
          if (!disposed) {
            setResults(entries);
            setError("");
          }
        })
        .catch((reason) => {
          if (!disposed) setError(String(reason).replace(/^Error: /, ""));
        });
    }, 150);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [searchOpen, query, project?.projectId, machine?.id, cwd]);

  const toggle = (path: string) => {
    if (!expanded.has(path) && !dirs[path]) void load(path);
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const open = (path: string) => {
    if (!project || !machine || !onOpenFile) return;
    setSelected(path);
    onOpenFile({
      machineId: machine.id,
      projectId: project.projectId,
      projectKey: project.key,
      cwd: cwd ?? project.cwd,
      relativePath: path,
    });
  };

  const rows = (path: string, depth: number): ReactNode =>
    (dirs[path] ?? [])
      .filter((entry) => showExcludedFiles || !entry.ignored)
      .map((entry) => (
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
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-px overflow-visible border-b border-stroke px-2">
        <button
          type="button"
          title="Collapse All"
          aria-label="Collapse All"
          onClick={() => setExpanded(new Set([""]))}
          className="flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <FoldVertical className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Find file"
          aria-label="Find file"
          onClick={searchOpen ? onSearchClose : onSearchOpen}
          className="flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <Search className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Refresh files"
          aria-label="Refresh files"
          disabled={busy || !machine}
          onClick={() => setGeneration((value) => value + 1)}
          className="flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <RefreshCw
            className={`size-3.5 ${busy ? "animate-spin" : ""}`}
            strokeWidth={1.75}
          />
        </button>
      </header>
      <div className="flex h-8 shrink-0 items-center">
        <button
          type="button"
          aria-expanded={rootOpen}
          title={cwd ?? project?.cwd}
          onClick={() => toggle("")}
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
      {searchOpen ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onSearchClose();
            }}
            placeholder="Find a file on this machine"
            aria-label="Find remote file"
            className="min-w-0 flex-1 bg-transparent px-1 text-[12px] outline-none placeholder:text-content/40"
          />
          <button
            type="button"
            aria-label="Close file search"
            onClick={onSearchClose}
            className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/8"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {!machine ? (
        <p className="p-3 text-[12px] text-content/50">
          Connect this project’s machine to browse files.
        </p>
      ) : null}
      {error ? (
        <RemoteHostError message={error} canUpdate={!!machine?.ssh} />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {searchOpen ? (
          results.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => open(entry.path)}
              className="flex h-7.5 w-full items-center gap-2 overflow-hidden px-3 text-left text-[14px] hover:bg-content/5"
            >
              <FileTypeIcon name={entry.name} isDir={false} size={16} />
              <span className="shrink-0 font-medium">{entry.name}</span>
              <span className="min-w-0 truncate text-content/45">
                {entry.path}
              </span>
            </button>
          ))
        ) : rootOpen ? (
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
