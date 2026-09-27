import { useState, type ReactNode } from "react";
import {
  rememberedMachine,
  rememberMachine,
  rememberRemoteTab,
  remoteTabFor,
  useRemoteMachines,
} from "../model/connections";
import { MachinePicker } from "./MachinePicker";
import { RemoteSessionPane } from "./RemoteSessionPane";

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
    machineId: choosable
      ? (remoteTabFor(shellId)?.machineId ?? rememberedMachine(cwd))
      : undefined,
  }));
  if (choosable && (choice.cwd !== cwd || choice.shellId !== shellId))
    setChoice({
      cwd,
      shellId,
      machineId: remoteTabFor(shellId)?.machineId ?? rememberedMachine(cwd),
    });
  const machineId = choosable ? choice.machineId : undefined;
  const picker = choosable ? (
    <MachinePicker
      machines={machines}
      selected={machineId}
      onSelect={(id) => {
        rememberMachine(cwd, id);
        rememberRemoteTab(shellId, id);
        setChoice({ cwd, shellId, machineId: id });
      }}
    />
  ) : undefined;
  if (!machineId) return local(picker);
  const machine = machines.find((machine) => machine.id === machineId);
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
