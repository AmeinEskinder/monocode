import { useEffect, useState, type ReactNode } from "react";
import {
  findMachine,
  rememberedMachine,
  rememberMachine,
  rememberRemoteTab,
  remoteTabFor,
  useRemoteMachines,
  type RememberedMachine,
} from "../model/connections";
import { MachinePicker } from "./MachinePicker";
import { RemoteSessionPane } from "./RemoteSessionPane";

const initialChoice = (
  cwd: string,
  shellId: string,
): RememberedMachine | undefined =>
  remoteTabFor(shellId) ?? rememberedMachine(cwd);

/** Chooses where a new session runs. Local sessions always render the same
 * `local` element, so sending the first message (which makes the session
 * no longer choosable) never remounts the local pane. */
export function SessionMachineRouter({
  cwd,
  shellId,
  choosable,
  local,
}: {
  cwd: string;
  shellId: string;
  choosable: boolean;
  local: (machineControl?: ReactNode) => ReactNode;
}) {
  const { machines, loaded } = useRemoteMachines(choosable);
  const [choice, setChoice] = useState(() => ({
    cwd,
    shellId,
    machine: choosable ? initialChoice(cwd, shellId) : undefined,
  }));
  if (choosable && (choice.cwd !== cwd || choice.shellId !== shellId))
    setChoice({ cwd, shellId, machine: initialChoice(cwd, shellId) });
  const selected = choosable ? choice.machine : undefined;
  const machine = findMachine(machines, selected);
  // A machine that was removed and added again has a new local ID. Rebind
  // this tab (and its remote session) to it instead of showing it as gone.
  useEffect(() => {
    if (!machine || !selected || machine.id === selected.machineId) return;
    const tab = remoteTabFor(shellId);
    if (tab?.machineId === selected.machineId)
      rememberRemoteTab(shellId, machine, tab.sessionId);
    if (rememberedMachine(cwd)?.machineId === selected.machineId)
      rememberMachine(cwd, machine);
    setChoice({
      cwd,
      shellId,
      machine: { machineId: machine.id, environmentId: machine.environmentId },
    });
  }, [machine, selected, cwd, shellId]);
  const picker = choosable ? (
    <MachinePicker
      machines={machines}
      selected={machine?.id ?? selected?.machineId}
      onSelect={(id) => {
        const next = machines.find((candidate) => candidate.id === id);
        rememberMachine(cwd, next);
        rememberRemoteTab(shellId, next);
        setChoice({
          cwd,
          shellId,
          machine: next
            ? { machineId: next.id, environmentId: next.environmentId }
            : undefined,
        });
      }}
    />
  ) : undefined;
  if (!selected) return local(picker);
  if (!machine)
    return (
      <div className="flex h-full flex-col items-start gap-4 p-6">
        {picker}
        <p className="text-[13px] text-content/50">
          {loaded
            ? "This machine is no longer connected. Add it again to open its sessions, or choose another machine."
            : "Loading machine…"}
        </p>
      </div>
    );
  return (
    <RemoteSessionPane
      key={`${machine.id}:${shellId}`}
      machine={machine}
      project={cwd}
      shellId={shellId}
      machinePicker={picker}
    />
  );
}
