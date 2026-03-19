import { config } from "./config.js";

const API = config.paperclipApiUrl;

/** Generic fetch wrapper for Paperclip API */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // In local_trusted or same-network mode, no auth needed for internal calls.
      // For authenticated mode, we use the service account cookie/token if needed.
      ...(process.env.PAPERCLIP_SERVICE_TOKEN
        ? { Authorization: `Bearer ${process.env.PAPERCLIP_SERVICE_TOKEN}` }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// --- Companies ---

export interface Company {
  id: string;
  name: string;
}

export async function listCompanies(): Promise<Company[]> {
  return api("GET", "/api/companies");
}

// --- Issues ---

export interface Issue {
  id: string;
  identifier: string;
  companyId: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
}

export interface IssueComment {
  id: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

export async function createIssue(companyId: string, data: {
  title: string;
  body?: string;
  status?: string;
}): Promise<Issue> {
  return api("POST", `/api/companies/${companyId}/issues`, data);
}

export async function createComment(companyId: string, issueId: string, data: {
  body: string;
}): Promise<IssueComment> {
  return api("POST", `/api/companies/${companyId}/issues/${issueId}/comments`, data);
}

export async function getIssue(companyId: string, issueId: string): Promise<Issue> {
  return api("GET", `/api/companies/${companyId}/issues/${issueId}`);
}

export async function listRecentIssues(companyId: string): Promise<Issue[]> {
  return api("GET", `/api/companies/${companyId}/issues?limit=20&sort=createdAt:desc`);
}

// --- Approvals ---

export interface Approval {
  id: string;
  companyId: string;
  approvalType: string;
  status: string;
  title: string;
  body: string | null;
  requestingAgentId: string | null;
  createdAt: string;
}

export async function approveApproval(companyId: string, approvalId: string): Promise<void> {
  await api("POST", `/api/companies/${companyId}/approvals/${approvalId}/approve`, {});
}

export async function rejectApproval(companyId: string, approvalId: string, reason?: string): Promise<void> {
  await api("POST", `/api/companies/${companyId}/approvals/${approvalId}/reject`, { reason });
}

// --- Agents ---

export interface Agent {
  id: string;
  name: string;
  companyId: string;
  status: string;
}

export async function listAgents(companyId: string): Promise<Agent[]> {
  return api("GET", `/api/companies/${companyId}/agents`);
}

// --- Health ---

export async function healthCheck(): Promise<{ status: string }> {
  return api("GET", "/api/health");
}
