import { useState, type ComponentType } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi, type OrgNode } from "../api/agents";
import { accessApi, type CompanyUser } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { HUMAN_ORG_ROLES, HUMAN_ORG_ROLE_LABELS } from "@paperclipai/shared";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Bot,
  Code,
  Gem,
  MousePointer2,
  Sparkles,
  Terminal,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";

type AdvancedAdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "openclaw_gateway";

const ADVANCED_ADAPTER_OPTIONS: Array<{
  value: AdvancedAdapterType;
  label: string;
  desc: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
}> = [
  {
    value: "claude_local",
    label: "Claude Code",
    icon: Sparkles,
    desc: "Local Claude agent",
    recommended: true,
  },
  {
    value: "codex_local",
    label: "Codex",
    icon: Code,
    desc: "Local Codex agent",
    recommended: true,
  },
  {
    value: "gemini_local",
    label: "Gemini CLI",
    icon: Gem,
    desc: "Local Gemini agent",
  },
  {
    value: "opencode_local",
    label: "OpenCode",
    icon: OpenCodeLogoIcon,
    desc: "Local multi-provider agent",
  },
  {
    value: "pi_local",
    label: "Pi",
    icon: Terminal,
    desc: "Local Pi agent",
  },
  {
    value: "cursor",
    label: "Cursor",
    icon: MousePointer2,
    desc: "Local Cursor agent",
  },
  {
    value: "openclaw_gateway",
    label: "OpenClaw Gateway",
    icon: Bot,
    desc: "Invoke OpenClaw via gateway protocol",
  },
];

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"main" | "advanced" | "add-member">("main");

  // Form state for add-member
  const [memberMode, setMemberMode] = useState<"existing" | "placeholder">("placeholder");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [placeholderName, setPlaceholderName] = useState("");
  const [selectedOrgRole, setSelectedOrgRole] = useState<string>("board");
  const [selectedReportsTo, setSelectedReportsTo] = useState<string>("");
  const [orgTitle, setOrgTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const flattenOrg = (nodes: OrgNode[]): Array<{ id: string; name: string; role: string; kind: string }> => {
    const result: Array<{ id: string; name: string; role: string; kind: string }> = [];
    for (const node of nodes) {
      result.push({ id: node.id, name: node.name, role: node.role, kind: node.kind ?? "agent" });
      if (node.reports?.length) result.push(...flattenOrg(node.reports));
    }
    return result;
  };
  const orgMembers = flattenOrg(orgTree ?? []);

  const { data: users } = useQuery({
    queryKey: queryKeys.access.users(selectedCompanyId!),
    queryFn: () => accessApi.listUsers(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen && view === "add-member",
  });

  const { data: members } = useQuery({
    queryKey: ["access", "members", selectedCompanyId!],
    queryFn: () =>
      accessApi.listUsers(selectedCompanyId!).then(() =>
        // We need the membership IDs; use the members endpoint
        fetch(`/api/companies/${selectedCompanyId}/members`, { credentials: "include" }).then((r) =>
          r.ok ? r.json() : [],
        ),
      ),
    enabled: !!selectedCompanyId && newAgentOpen && view === "add-member",
  });

  const ceoAgent = (agents ?? []).find((a) => a.role === "ceo");

  function resetState() {
    setView("main");
    setMemberMode("placeholder");
    setSelectedUserId("");
    setPlaceholderName("");
    setSelectedOrgRole("board");
    setSelectedReportsTo("");
    setOrgTitle("");
    setSubmitting(false);
  }

  function handleAskCeo() {
    closeNewAgent();
    resetState();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: "Create a new agent",
      description: "(type in what kind of agent you want here)",
    });
  }

  function handleAdvancedAdapterPick(adapterType: AdvancedAdapterType) {
    closeNewAgent();
    resetState();
    navigate(`/agents/new?adapterType=${encodeURIComponent(adapterType)}`);
  }

  async function handleAddMember() {
    if (!selectedCompanyId) return;

    setSubmitting(true);
    try {
      if (memberMode === "existing") {
        if (!selectedUserId) return;
        const membershipList = (members ?? []) as Array<{ id: string; principalId: string; principalType: string }>;
        const membership = membershipList.find(
          (m) => m.principalType === "user" && m.principalId === selectedUserId,
        );
        if (!membership) return;
        await accessApi.updateMemberOrgPosition(selectedCompanyId, membership.id, {
          orgRole: selectedOrgRole,
          orgReportsTo: selectedReportsTo || null,
          orgTitle: orgTitle || null,
        });
      } else {
        if (!placeholderName.trim()) return;
        await accessApi.createPlaceholderMember(selectedCompanyId, {
          displayName: placeholderName.trim(),
          orgRole: selectedOrgRole,
          orgReportsTo: selectedReportsTo || null,
          orgTitle: orgTitle || null,
        });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      closeNewAgent();
      resetState();
    } catch {
      // silently fail for now
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          resetState();
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md p-0 gap-0 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">
            {view === "add-member" ? "Add team member to org chart" : "Add a new agent"}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => {
              resetState();
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-6">
          {view === "main" && (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Sparkles className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  We recommend letting your CEO handle agent setup — they know the
                  org structure and can configure reporting, permissions, and
                  adapters.
                </p>
              </div>

              <Button className="w-full" size="lg" onClick={handleAskCeo}>
                <Bot className="h-4 w-4 mr-2" />
                Ask the CEO to create a new agent
              </Button>

              {/* Secondary actions */}
              <div className="flex flex-col items-center gap-2">
                <button
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                  onClick={() => setView("advanced")}
                >
                  I want advanced configuration myself
                </button>
                <button
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                  onClick={() => setView("add-member")}
                >
                  <UserPlus className="h-3 w-3" />
                  Add a team member to org chart
                </button>
              </div>
            </>
          )}

          {view === "advanced" && (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setView("main")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <p className="text-sm text-muted-foreground">
                  Choose your adapter type for advanced setup.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {ADVANCED_ADAPTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs transition-colors hover:bg-accent/50 relative"
                    )}
                    onClick={() => handleAdvancedAdapterPick(opt.value)}
                  >
                    {opt.recommended && (
                      <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                        Recommended
                      </span>
                    )}
                    <opt.icon className="h-4 w-4" />
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {view === "add-member" && (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setView("main")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <p className="text-sm text-muted-foreground">
                  Place a team member in the org chart.
                </p>
              </div>

              <div className="space-y-4">
                {/* Mode toggle */}
                <div className="flex border border-border rounded-md overflow-hidden">
                  <button
                    className={cn(
                      "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                      memberMode === "placeholder" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                    )}
                    onClick={() => setMemberMode("placeholder")}
                  >
                    New person
                  </button>
                  <button
                    className={cn(
                      "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                      memberMode === "existing" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                    )}
                    onClick={() => setMemberMode("existing")}
                  >
                    Existing account
                  </button>
                </div>

                {/* Name input or user select */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">
                    {memberMode === "placeholder" ? "Name" : "Team member"}
                  </label>
                  {memberMode === "placeholder" ? (
                    <input
                      type="text"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      placeholder="e.g. John, Priya, Alex"
                      value={placeholderName}
                      onChange={(e) => setPlaceholderName(e.target.value)}
                    />
                  ) : (
                    <select
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      value={selectedUserId}
                      onChange={(e) => setSelectedUserId(e.target.value)}
                    >
                      <option value="">Select a member...</option>
                      {(users ?? []).map((u: CompanyUser) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Org role */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Org role</label>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={selectedOrgRole}
                    onChange={(e) => setSelectedOrgRole(e.target.value)}
                  >
                    {HUMAN_ORG_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {(HUMAN_ORG_ROLE_LABELS as Record<string, string>)[role]}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Reports to */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Reports to</label>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={selectedReportsTo}
                    onChange={(e) => setSelectedReportsTo(e.target.value)}
                  >
                    <option value="">None (top-level)</option>
                    {orgMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.kind === "human" ? m.role : m.role})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Custom title */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Custom title (optional)</label>
                  <input
                    type="text"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    placeholder="e.g. Board Chair, VP Engineering"
                    value={orgTitle}
                    onChange={(e) => setOrgTitle(e.target.value)}
                  />
                </div>

                <Button
                  className="w-full"
                  size="lg"
                  disabled={(memberMode === "existing" ? !selectedUserId : !placeholderName.trim()) || submitting}
                  onClick={handleAddMember}
                >
                  <UserPlus className="h-4 w-4 mr-2" />
                  {submitting ? "Adding..." : "Add to org chart"}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
