import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { GitPickerTrigger } from "../../source-control/ui/GitPickerTrigger";
import { Popover } from "../../../shared/ui/Popover";
import {
  Check,
  FolderTree,
  GitBranch,
  Plus,
  Search,
} from "../../../shared/ui/icons";
import { remoteRequest } from "../model/connections";
import type {
  HostBranches,
  HostWorktree,
  HostWorktrees,
  RemoteMachine,
} from "../model/protocol";
import type { RemoteProject } from "../model/remoteProjects";

export function RemoteWorktreePicker({
  machine,
  project,
  cwd,
  branches,
  online,
  busy,
  onSelect,
}: {
  machine: RemoteMachine;
  project: RemoteProject;
  cwd: string;
  branches?: HostBranches;
  online: boolean;
  busy: boolean;
  onSelect: (tree: HostWorktree) => Promise<void> | void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<HostWorktrees>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [base, setBase] = useState("HEAD");
  const [existing, setExisting] = useState(false);

  const load = useCallback(async () => {
    try {
      const value = await remoteRequest<HostWorktrees>(
        machine.id,
        "git.worktrees",
        {
          projectId: project.projectId,
        },
      );
      setData(value);
      setError("");
    } catch (reason) {
      const message = String(reason);
      setError(
        message.includes("Unsupported host method")
          ? "Update MonoCode Host on this machine to use worktrees."
          : message,
      );
    }
  }, [machine.id, project.projectId]);
  useEffect(() => {
    if (open && online) void load();
  }, [open, online, load]);
  useEffect(() => {
    if (!online || busy) setOpen(false);
  }, [online, busy]);

  const select = async (tree: HostWorktree) => {
    if (working || tree.missing) return;
    setWorking(true);
    setError("");
    try {
      await onSelect(tree);
      setOpen(false);
      setCreating(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setWorking(false);
    }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (working || !name.trim()) return;
    setWorking(true);
    setError("");
    try {
      const tree = await remoteRequest<HostWorktree>(
        machine.id,
        "git.worktreeCreate",
        {
          projectId: project.projectId,
          cwd,
          branch: name.trim(),
          base,
          existing,
        },
      );
      setData(
        await remoteRequest<HostWorktrees>(machine.id, "git.worktrees", {
          projectId: project.projectId,
        }),
      );
      await onSelect(tree);
      setOpen(false);
      setCreating(false);
      setName("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setWorking(false);
    }
  };
  const rows =
    data?.worktrees.filter((tree) =>
      `${tree.branch ?? "detached"} ${tree.path}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div ref={anchor} className="relative flex min-w-0 shrink">
      <GitPickerTrigger
        title={`Working copy on ${machine.name}: ${cwd}`}
        aria-label="Choose remote working copy"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={!online || busy}
        worktree={cwd !== project.cwd}
        label={cwd === project.cwd ? "Current checkout" : "Worktree"}
        onClick={() => {
          setOpen((value) => !value);
          setError("");
        }}
      />
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="start"
          width={330}
          maxHeight={400}
          constrainHeight
          role="dialog"
          aria-label="Remote working copies"
          className="flex flex-col overflow-hidden"
          onDismiss={() => {
            if (!working) setOpen(false);
          }}
        >
          {creating ? (
            <form
              onSubmit={(event) => void create(event)}
              className="flex flex-col gap-3 p-3 text-[12px]"
            >
              <p className="font-medium">Create worktree on {machine.name}</p>
              <label className="flex items-center gap-2">
                <span>Branch</span>
                <select
                  aria-label="Branch type"
                  value={existing ? "existing" : "new"}
                  disabled={working}
                  onChange={(event) => {
                    setExisting(event.target.value === "existing");
                    setName("");
                  }}
                  className="min-w-0 flex-1 rounded-md border border-content/10 bg-background-base p-1"
                >
                  <option value="new">Create a new branch</option>
                  <option value="existing">Use an existing branch</option>
                </select>
              </label>
              {existing ? (
                <select
                  aria-label="Existing branch"
                  value={name}
                  disabled={working}
                  onChange={(event) => setName(event.target.value)}
                  className="rounded-md border border-content/10 bg-background-base p-2"
                >
                  <option value="">Choose a branch…</option>
                  {branches?.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    aria-label="New worktree branch"
                    placeholder="feature/my-task"
                    value={name}
                    disabled={working}
                    onChange={(event) => setName(event.target.value)}
                    className="rounded-md border border-content/10 bg-background-base p-2 outline-none"
                  />
                  <label className="flex items-center gap-2">
                    <span>Start from</span>
                    <select
                      aria-label="Worktree base"
                      value={base}
                      disabled={working}
                      onChange={(event) => setBase(event.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-content/10 bg-background-base p-1"
                    >
                      <option value="HEAD">Current commit</option>
                      {branches?.branches.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                      {branches?.remotes?.map((branch) => (
                        <option
                          key={`${branch.remote}/${branch.name}`}
                          value={`${branch.remote}/${branch.name}`}
                        >
                          {branch.remote}/{branch.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {data?.defaultRoot ? (
                <p className="break-all text-content/45">
                  Created in {data.defaultRoot}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-red-400">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={working}
                  onClick={() => {
                    setCreating(false);
                    setError("");
                  }}
                  className="rounded-md px-2 py-1 hover:bg-content/8"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={working || !name.trim()}
                  className="rounded-md bg-content px-2 py-1 text-background-base disabled:opacity-40"
                >
                  Create worktree
                </button>
              </div>
            </form>
          ) : (
            <>
              <label className="flex items-center gap-2 border-b border-stroke px-3 py-2">
                <Search className="size-3.5 text-content/40" />
                <input
                  aria-label="Search remote working copies"
                  placeholder="Search working copies…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                />
              </label>
              <div
                role="listbox"
                aria-label="Remote working copies"
                className="min-h-0 overflow-y-auto p-1"
              >
                {!data && !error ? (
                  <p className="p-2 text-[12px] text-content/50">
                    Loading working copies…
                  </p>
                ) : null}
                {rows.map((tree) => (
                  <button
                    key={tree.path}
                    type="button"
                    role="option"
                    aria-selected={tree.path === cwd}
                    disabled={working || tree.missing}
                    title={tree.path}
                    onClick={() => void select(tree)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] hover:bg-content/8 disabled:opacity-40"
                  >
                    {tree.isMain ? (
                      <GitBranch className="size-3.5 shrink-0" />
                    ) : (
                      <FolderTree className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {tree.branch ?? `Detached ${tree.head.slice(0, 7)}`}
                      </span>
                      <span className="block truncate text-[10px] text-content/45">
                        {tree.path}
                        {tree.missing ? " · Missing" : ""}
                      </span>
                    </span>
                    {tree.path === cwd ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : null}
                  </button>
                ))}
                {data && !rows.length ? (
                  <p className="p-2 text-[12px] text-content/50">
                    No matching working copies
                  </p>
                ) : null}
                {error ? (
                  <p role="alert" className="p-2 text-[11px] text-red-400">
                    {error}
                  </p>
                ) : null}
              </div>
              <div className="border-t border-stroke p-1">
                <button
                  type="button"
                  disabled={working}
                  onClick={() => {
                    setCreating(true);
                    setError("");
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] hover:bg-content/8"
                >
                  <Plus className="size-3.5" />
                  Create worktree…
                </button>
              </div>
            </>
          )}
        </Popover>
      ) : null}
    </div>
  );
}
