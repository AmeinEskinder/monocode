import { OPEN_CONNECTIONS_EVENT } from "../model/connections";

export function RemoteHostError({
  message,
  canUpdate,
}: {
  message: string;
  canUpdate: boolean;
}) {
  if (
    message.includes("Unsupported host method") ||
    message.includes("Update MonoCode Host")
  ) {
    return (
      <div className="px-3 py-2 text-[12px] text-content/55">
        <p>This machine needs a host update for Explorer and Changes.</p>
        {canUpdate ? (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new Event(OPEN_CONNECTIONS_EVENT))
            }
            className="mt-2 rounded-md bg-content/10 px-2 py-1 text-content hover:bg-content/15"
          >
            Open connection settings
          </button>
        ) : (
          <p className="mt-1">
            Update MonoCode Host on the machine, then reconnect.
          </p>
        )}
      </div>
    );
  }
  return (
    <p role="alert" className="px-3 py-2 text-[12px] text-red-400">
      {message}
    </p>
  );
}
