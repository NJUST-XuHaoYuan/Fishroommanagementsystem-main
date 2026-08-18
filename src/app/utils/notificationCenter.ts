export type LatestRequestToken = Readonly<{
  notificationId: string;
  sequence: number;
  signal: AbortSignal;
}>;

export type LatestRequestCoordinator = {
  begin: (notificationId: string) => LatestRequestToken;
  cancel: () => void;
  isCurrent: (token: LatestRequestToken) => boolean;
};

export function createLatestRequestCoordinator(): LatestRequestCoordinator {
  let sequence = 0;
  let activeNotificationId = "";
  let activeController: AbortController | null = null;

  return {
    begin(notificationId) {
      activeController?.abort();
      sequence += 1;
      activeNotificationId = String(notificationId ?? "").trim();
      activeController = new AbortController();
      return {
        notificationId: activeNotificationId,
        sequence,
        signal: activeController.signal,
      };
    },
    cancel() {
      activeController?.abort();
      activeController = null;
      activeNotificationId = "";
      sequence += 1;
    },
    isCurrent(token) {
      return Boolean(
        token &&
        activeController &&
        !token.signal.aborted &&
        token.signal === activeController.signal &&
        token.sequence === sequence &&
        token.notificationId === activeNotificationId
      );
    },
  };
}

export type ProfileAttachmentChangeKind = "added" | "replaced" | "removed" | "unchanged";

function attachmentId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String((value as { id?: unknown }).id ?? "").trim();
}

export function profileAttachmentChangeKind(
  beforeAttachment: unknown,
  afterAttachment: unknown
): ProfileAttachmentChangeKind {
  const beforeId = attachmentId(beforeAttachment);
  const afterId = attachmentId(afterAttachment);
  if (!beforeId && afterId) return "added";
  if (beforeId && !afterId) return "removed";
  if (beforeId && afterId && beforeId !== afterId) return "replaced";
  return "unchanged";
}

export function profileApprovalDetailsReady({
  selectedNotificationId,
  loadedNotificationId,
  profileChanges,
}: {
  selectedNotificationId?: unknown;
  loadedNotificationId?: unknown;
  profileChanges?: unknown;
}): boolean {
  const selectedId = String(selectedNotificationId ?? "").trim();
  const loadedId = String(loadedNotificationId ?? "").trim();
  return Boolean(
    selectedId &&
    selectedId === loadedId &&
    Array.isArray(profileChanges) &&
    profileChanges.length > 0
  );
}

export function profileApprovalActionReady({
  profileRequestId,
  decision,
  processing,
  loadingDetails,
  detailError,
  detailsReady,
  note,
}: {
  profileRequestId?: unknown;
  decision?: unknown;
  processing?: boolean;
  loadingDetails?: boolean;
  detailError?: unknown;
  detailsReady?: boolean;
  note?: unknown;
}): boolean {
  const normalizedDecision = String(decision ?? "").trim();
  if (!String(profileRequestId ?? "").trim()) return false;
  if (normalizedDecision !== "approve" && normalizedDecision !== "reject") return false;
  if (processing || loadingDetails || Boolean(detailError) || !detailsReady) return false;
  return normalizedDecision === "approve" || Boolean(String(note ?? "").trim());
}
