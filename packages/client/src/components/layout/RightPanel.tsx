// ──────────────────────────────────────────────
// Layout: Right Panel (polished with panel transitions)
// ──────────────────────────────────────────────
import { X, Users, BookOpen, FileText, Link, Sparkles, Settings, UserCircle } from "lucide-react";
import { useUIStore } from "../../stores/ui.store";
import { CharactersPanel } from "../panels/CharactersPanel";
import { LorebooksPanel } from "../panels/LorebooksPanel";
import { PresetsPanel } from "../panels/PresetsPanel";
import { ConnectionsPanel } from "../panels/ConnectionsPanel";
import { AgentsPanel } from "../panels/AgentsPanel";
import { PersonasPanel } from "../panels/PersonasPanel";
import { SettingsPanel } from "../panels/SettingsPanel";

const PANEL_CONFIG: Record<string, { title: string; icon: React.ReactNode; gradient: string }> = {
  characters: { title: "Characters", icon: <Users size={14} />, gradient: "from-pink-400 to-rose-500" },
  lorebooks: { title: "Lorebooks", icon: <BookOpen size={14} />, gradient: "from-amber-400 to-orange-500" },
  presets: { title: "Presets", icon: <FileText size={14} />, gradient: "from-purple-400 to-violet-500" },
  connections: { title: "Connections", icon: <Link size={14} />, gradient: "from-sky-400 to-blue-500" },
  agents: { title: "Agents", icon: <Sparkles size={14} />, gradient: "from-pink-300 to-purple-400" },
  personas: { title: "Personas", icon: <UserCircle size={14} />, gradient: "from-emerald-400 to-teal-500" },
  settings: { title: "Settings", icon: <Settings size={14} />, gradient: "from-gray-400 to-gray-500" },
};

const PANELS: Record<string, React.FC> = {
  characters: CharactersPanel,
  lorebooks: LorebooksPanel,
  presets: PresetsPanel,
  connections: ConnectionsPanel,
  agents: AgentsPanel,
  personas: PersonasPanel,
  settings: SettingsPanel,
};

export function RightPanel() {
  const panel = useUIStore((s) => s.rightPanel);
  const close = useUIStore((s) => s.closeRightPanel);

  const PanelComponent = PANELS[panel];
  const config = PANEL_CONFIG[panel] ?? { title: "Panel", icon: null, gradient: "from-slate-400 to-slate-500" };

  return (
    <div className="flex h-full flex-col">
      {/* Header - OS window style */}
      <div className="relative flex h-12 flex-shrink-0 items-center justify-between px-4">
        <div className="absolute inset-x-0 bottom-0 h-px bg-[var(--border)]/30" />
        <div className="flex items-center gap-2.5">
          <div
            className={`flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br ${config.gradient} text-white shadow-sm`}
          >
            {config.icon}
          </div>
          <h2 className="text-sm font-semibold text-[var(--y2k-lavender)]">{config.title}</h2>
        </div>
        <button
          onClick={close}
          className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-all hover:bg-[var(--accent)] hover:text-[var(--y2k-pink)] active:scale-90"
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="relative flex-1 overflow-y-auto">{PanelComponent ? <PanelComponent /> : null}</div>
    </div>
  );
}
