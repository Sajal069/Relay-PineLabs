export type SessionUser =
  | { role: "owner"; name: string }
  | { role: "merchant"; id: string; name: string };

export function workspaceHome(role: SessionUser["role"]) {
  return role === "owner" ? "/manager" : "/applications";
}

export type InboxItem = {
  id: number;
  applicationId: string;
  applicationName: string;
  field: string;
  reason: string;
  requestedAt: number;
  open: boolean;
};

export type InboxData = { items: InboxItem[]; openCount: number };
