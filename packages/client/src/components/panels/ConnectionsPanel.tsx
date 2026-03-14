// ──────────────────────────────────────────────
// Panel: API Connections (polished)
// ──────────────────────────────────────────────
import {
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useTestConnection,
  useUpdateConnection,
} from "../../hooks/use-connections";
import { useUpdateChat } from "../../hooks/use-chats";
import { useChatStore } from "../../stores/chat.store";
import { useUIStore } from "../../stores/ui.store";
import { Plus, Trash2, Link, CheckCircle, Loader2, Check, Shuffle, ExternalLink, X } from "lucide-react";
import { cn } from "../../lib/utils";

export function ConnectionsPanel() {
  const { data: connections, isLoading } = useConnections();
  const createConnection = useCreateConnection();
  const deleteConnection = useDeleteConnection();
  const updateConnection = useUpdateConnection();
  const testConnection = useTestConnection();
  const activeChat = useChatStore((s) => s.activeChat);
  const updateChat = useUpdateChat();

  const activeConnectionId = activeChat?.connectionId ?? null;
  const openConnectionDetail = useUIStore((s) => s.openConnectionDetail);
  const linkApiBannerDismissed = useUIStore((s) => s.linkApiBannerDismissed);
  const dismissLinkApiBanner = useUIStore((s) => s.dismissLinkApiBanner);

  const selectConnection = (connId: string) => {
    if (!activeChat) return;
    const newId = activeConnectionId === connId ? null : connId;
    updateChat.mutate({ id: activeChat.id, connectionId: newId });
  };

  const handleCreate = () => {
    createConnection.mutate(
      { name: "New Connection", provider: "openai", apiKey: "" },
      {
        onSuccess: (data: any) => {
          if (data?.id) openConnectionDetail(data.id);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      <button
        onClick={handleCreate}
        disabled={createConnection.isPending}
        className="flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-medium transition-all active:scale-[0.98] bg-gradient-to-r from-sky-400 to-blue-500 text-white shadow-md shadow-sky-400/15 hover:shadow-lg hover:shadow-sky-400/25 disabled:opacity-50"
      >
        {createConnection.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        Add Connection
      </button>

      {isLoading && (
        <div className="flex flex-col gap-2 py-2">
          {[1, 2].map((i) => (
            <div key={i} className="shimmer h-14 rounded-xl" />
          ))}
        </div>
      )}

      {!isLoading && (!connections || (connections as unknown[]).length === 0) && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <div className="animate-float flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400/20 to-blue-500/20">
            <Link size={20} className="text-sky-400" />
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">No connections yet</p>
        </div>
      )}

      {/* LinkAPI recommendation banner */}
      {!isLoading && (!connections || (connections as unknown[]).length === 0) && !linkApiBannerDismissed && (
        <div className="rounded-xl border border-sky-400/20 bg-gradient-to-br from-sky-400/5 to-blue-500/5 p-3 flex flex-col gap-2">
          <p className="text-xs text-[var(--muted-foreground)]">
            Looking to try new models from a trusted provider? Consider checking out{" "}
            <a
              href="https://linkapi.ai/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sky-400 underline decoration-sky-400/30 hover:text-sky-300 transition-colors"
            >
              LinkAPI
            </a>
            !
          </p>
          <div className="flex gap-2">
            <a
              href="https://linkapi.ai/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg bg-sky-400/15 px-3 py-1.5 text-xs font-medium text-sky-400 transition-all hover:bg-sky-400/25"
            >
              <ExternalLink size={12} />
              Visit LinkAPI
            </a>
            <button
              onClick={dismissLinkApiBanner}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-all hover:bg-[var(--secondary)]"
            >
              <X size={12} />
              Dismiss permanently
            </button>
          </div>
        </div>
      )}

      <div className="stagger-children flex flex-col gap-1">
        {(
          connections as Array<{ id: string; name: string; provider: string; model: string; useForRandom?: string }>
        )?.map((conn) => {
          const isSelected = activeConnectionId === conn.id;
          const inRandomPool = conn.useForRandom === "true";
          return (
            <div
              key={conn.id}
              onClick={() => openConnectionDetail(conn.id)}
              className={cn(
                "group flex cursor-pointer items-center gap-3 rounded-xl p-2.5 transition-all hover:bg-[var(--sidebar-accent)]",
                isSelected && "ring-1 ring-sky-400/40 bg-sky-400/5",
              )}
            >
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-500 text-white shadow-sm">
                <Link size={16} />
                {isSelected && (
                  <div className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-sky-400 shadow-sm">
                    <Check size={10} className="text-white" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{conn.name}</div>
                <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                  {conn.provider} • {conn.model || "No model set"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    updateConnection.mutate({ id: conn.id, useForRandom: !inRandomPool });
                  }}
                  className={cn(
                    "rounded-lg p-1.5 transition-all active:scale-90",
                    inRandomPool
                      ? "bg-amber-400/15 text-amber-400"
                      : "text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:bg-amber-400/10 hover:text-amber-400",
                  )}
                  title={inRandomPool ? "In random pool (click to remove)" : "Add to random pool"}
                >
                  <Shuffle size={13} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    testConnection.mutate(conn.id);
                  }}
                  className="rounded-lg p-1.5 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 transition-all hover:bg-sky-400/10 active:scale-90"
                  title="Test connection"
                >
                  {testConnection.isPending ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <CheckCircle size={13} />
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    selectConnection(conn.id);
                  }}
                  className={cn(
                    "rounded-lg px-2 py-1 text-[10px] font-medium transition-all active:scale-95",
                    isSelected
                      ? "bg-sky-400/15 text-sky-400"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:bg-sky-400/10 hover:text-sky-400",
                  )}
                  title={isSelected ? "Active for this chat" : "Use for this chat"}
                >
                  {isSelected ? "Active" : "Use"}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConnection.mutate(conn.id);
                  }}
                  className="rounded-lg p-1.5 opacity-0 transition-all hover:bg-[var(--destructive)]/15 group-hover:opacity-100 active:scale-90"
                >
                  <Trash2 size={13} className="text-[var(--destructive)]" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {activeChat && (
        <p className="px-1 text-[10px] text-[var(--muted-foreground)]/60">
          Click to edit · &quot;Use&quot; to set as active connection for this chat
        </p>
      )}
    </div>
  );
}
