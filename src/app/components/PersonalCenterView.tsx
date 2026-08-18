import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PersonnelProfileAttachment,
  PersonnelProfileRequest,
  PersonnelSelfProfile,
  PersonnelSelfProfileForm,
} from "../store";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  AlertTriangle,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  ContactRound,
  Eye,
  EyeOff,
  FileCheck2,
  FileText,
  KeyRound,
  Landmark,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { authHeaders, authJsonHeaders } from "../utils/authSession";
import { confirmWrite } from "../utils/writeConfirm";
import { getSites } from "../utils/sites";
import {
  emptyPersonnelSelfProfile,
  isPersonnelProfilePending,
  normalizePersonnelProfileAttachment,
  normalizePersonnelSelfProfileResult,
  PERSONNEL_PROFILE_FIELD_LABELS,
  personnelSelfProfileSubmission,
  PROFILE_ATTACHMENT_KINDS,
  validatePersonnelSelfProfile,
  type PersonnelProfileErrors,
  type PersonnelProfileField,
} from "../utils/personnelProfile";

const EDUCATION_LEVELS: Array<{ value: PersonnelSelfProfile["educationLevel"]; label: string }> = [
  { value: "high_school_or_below", label: "高中及以下" },
  { value: "college", label: "大专" },
  { value: "bachelor", label: "本科" },
  { value: "master", label: "硕士" },
  { value: "doctorate", label: "博士" },
];

const PROFILE_SECTIONS = [
  {
    id: "basic",
    elementId: "profile-basic-section",
    title: "基本资料",
    shortDescription: "身份基础信息",
    description: "填写姓名、性别、籍贯、出生年月和最高学历。",
    icon: UserRound,
    iconClassName: "bg-sky-100 text-sky-700",
  },
  {
    id: "documents",
    elementId: "profile-documents-section",
    title: "证件材料",
    shortDescription: "证件与学历证明",
    description: "维护身份证件号码、证件照片和学历证明。",
    icon: FileCheck2,
    iconClassName: "bg-indigo-100 text-indigo-700",
  },
  {
    id: "contact",
    elementId: "profile-contact-section",
    title: "联系信息",
    shortDescription: "电话与联系地址",
    description: "用于工作联络和档案联系。",
    icon: ContactRound,
    iconClassName: "bg-violet-100 text-violet-700",
  },
  {
    id: "bank",
    elementId: "profile-bank-section",
    title: "工资账户",
    shortDescription: "工资发放账户",
    description: "维护工资账户开户名、银行卡号和开户行。",
    icon: Landmark,
    iconClassName: "bg-emerald-100 text-emerald-700",
  },
  {
    id: "employment",
    elementId: "profile-employment-section",
    title: "任职与账号",
    shortDescription: "管理员维护信息",
    description: "查看任职、工作区域和系统账号信息。",
    icon: BriefcaseBusiness,
    iconClassName: "bg-slate-100 text-slate-700",
  },
  {
    id: "security",
    elementId: "profile-password-section",
    title: "账户安全",
    shortDescription: "独立修改密码",
    description: "验证原密码后修改当前登录账号的密码。",
    icon: KeyRound,
    iconClassName: "bg-orange-100 text-orange-700",
  },
  {
    id: "review",
    elementId: "profile-review-section",
    title: "检查并提交",
    shortDescription: "确认后发起审批",
    description: "检查本人资料完整性，再统一提交管理员审批。",
    icon: ShieldCheck,
    iconClassName: "bg-teal-100 text-teal-700",
  },
] as const;

type ProfileSectionId = typeof PROFILE_SECTIONS[number]["id"];
type EditableProfileSectionId = "basic" | "documents" | "contact" | "bank";
type SectionStatusKind = "complete" | "attention" | "pending" | "neutral";
type SectionStatus = { label: string; kind: SectionStatusKind; complete: boolean };

const EDITABLE_SECTION_FIELDS: Record<EditableProfileSectionId, PersonnelProfileField[]> = {
  basic: ["name", "gender", "nativePlace", "birthMonth", "educationLevel"],
  documents: ["idCardNo", "idCardFrontAttachment", "idCardBackAttachment", "educationProofAttachment"],
  contact: ["phone", "email", "wechat", "address"],
  bank: ["bankAccountName", "bankAccountNo", "bankName"],
};

const PROFILE_FIELD_SECTION: Record<PersonnelProfileField, EditableProfileSectionId> = {
  name: "basic",
  gender: "basic",
  nativePlace: "basic",
  birthMonth: "basic",
  educationLevel: "basic",
  idCardNo: "documents",
  idCardFrontAttachment: "documents",
  idCardBackAttachment: "documents",
  educationProofAttachment: "documents",
  phone: "contact",
  email: "contact",
  wechat: "contact",
  address: "contact",
  bankAccountName: "bank",
  bankAccountNo: "bank",
  bankName: "bank",
};

function formatDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.replace("T", " ").slice(0, 16)
    : date.toLocaleString("zh-CN", { hour12: false });
}

function attachmentDisplayName(attachment: PersonnelProfileAttachment): string {
  return attachment.originalName || "已上传附件";
}

function attachmentSizeLabel(size?: number): string {
  if (!Number.isFinite(size) || Number(size) < 0) return "";
  const bytes = Number(size);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function RequiredMark() {
  return (
    <>
      <span className="ml-0.5 text-red-500" aria-hidden="true">*</span>
      <span className="sr-only">（必填）</span>
    </>
  );
}

function FieldError({ field, error }: { field: PersonnelProfileField; error?: string }) {
  if (!error) return null;
  return <p id={`profile-${field}-error`} className="text-sm text-destructive" role="alert">{error}</p>;
}

function MaskedInput({
  id,
  value,
  onChange,
  visible,
  onToggle,
  toggleLabel,
  disabled,
  describedBy,
  invalid,
  autoComplete = "off",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  toggleLabel: string;
  disabled?: boolean;
  describedBy?: string;
  invalid?: boolean;
  autoComplete?: string;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-required="true"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete={autoComplete}
        spellCheck={false}
        className="h-11 pr-12"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0 top-0 size-11 rounded-l-none"
        onClick={onToggle}
        disabled={disabled}
        aria-label={toggleLabel}
        aria-pressed={visible}
        title={toggleLabel}
      >
        {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </Button>
    </div>
  );
}

function AttachmentField({
  field,
  title,
  description,
  attachment,
  uploading,
  disabled,
  error,
  onChoose,
  onPreview,
}: {
  field: "idCardFrontAttachment" | "idCardBackAttachment" | "educationProofAttachment";
  title: string;
  description: string;
  attachment: PersonnelProfileAttachment | null;
  uploading: boolean;
  disabled: boolean;
  error?: string;
  onChoose: (file: File) => void;
  onPreview: (attachment: PersonnelProfileAttachment) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = error ? `profile-${field}-error` : undefined;
  return (
    <div className="grid gap-3 rounded-xl border bg-muted/15 p-3" aria-busy={uploading}>
      <div>
        <Label htmlFor={`profile-${field}`} className="font-medium">{title}<RequiredMark /></Label>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {attachment ? (
        <div className="flex min-w-0 items-start gap-3 rounded-lg border bg-background p-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
            <FileCheck2 className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="break-all text-sm font-medium">{attachmentDisplayName(attachment)}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {[attachment.mime, attachmentSizeLabel(attachment.size)].filter(Boolean).join(" · ") || "附件已安全保存"}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-20 items-center justify-center rounded-lg border border-dashed bg-background text-sm text-muted-foreground">尚未上传</div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          id={`profile-${field}`}
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled || uploading}
          aria-required="true"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={errorId}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {uploading ? "上传中" : attachment ? "更换" : "上传"}
        </Button>
        <Button type="button" variant="ghost" className="min-h-11" disabled={!attachment || uploading} onClick={() => attachment && onPreview(attachment)}>
          <Eye className="size-4" />预览
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        className="hidden"
        disabled={disabled || uploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onChoose(file);
          event.target.value = "";
        }}
      />
      <FieldError field={field} error={error} />
    </div>
  );
}

function ReadonlyItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/15 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 min-h-5 break-words text-sm font-medium">{children || "—"}</div>
    </div>
  );
}

function SectionStatusBadge({ status }: { status: SectionStatus }) {
  const className = status.kind === "complete"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : status.kind === "attention"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : status.kind === "pending"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-slate-200 bg-slate-50 text-slate-700";
  const icon = status.kind === "complete"
    ? <CheckCircle2 aria-hidden="true" />
    : status.kind === "attention"
      ? <AlertTriangle aria-hidden="true" />
      : status.kind === "pending"
        ? <Clock3 aria-hidden="true" />
        : <ShieldCheck aria-hidden="true" />;
  return <Badge variant="outline" className={className}>{icon}{status.label}</Badge>;
}

function SectionHeader({
  titleId,
  title,
  description,
  icon,
  iconClassName,
  status,
  label,
}: {
  titleId: string;
  title: string;
  description: string;
  icon: ReactNode;
  iconClassName: string;
  status: SectionStatus;
  label?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${iconClassName}`}>{icon}</div>
        <div className="min-w-0">
          <h3 id={titleId}>{title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[3.25rem] sm:pl-0">
        {label && <Badge variant="outline">{label}</Badge>}
        <SectionStatusBadge status={status} />
      </div>
    </div>
  );
}

export function PersonalCenterView() {
  const { state, changePersonnelPassword } = useStore();
  const [activeSection, setActiveSection] = useState<ProfileSectionId>("basic");
  const [profile, setProfile] = useState<PersonnelSelfProfile>(emptyPersonnelSelfProfile);
  const [request, setRequest] = useState<PersonnelProfileRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [errors, setErrors] = useState<PersonnelProfileErrors>({});
  const [uploadingField, setUploadingField] = useState<PersonnelProfileField | null>(null);
  const [uploadErrors, setUploadErrors] = useState<PersonnelProfileErrors>({});
  const [showIdCard, setShowIdCard] = useState(false);
  const [showBankAccount, setShowBankAccount] = useState(false);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const requestedFieldFocus = useRef<PersonnelProfileField | null>(null);

  const [previewAttachment, setPreviewAttachment] = useState<PersonnelProfileAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMime, setPreviewMime] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const previewSequence = useRef(0);
  const previewUrlRef = useRef("");

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showOldPassword, setShowOldPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [passwordError, setPasswordError] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const sites = getSites(state);
  const siteNames = useMemo(() => new Map(sites.map((site) => [site.id, site.name])), [sites]);
  const workSiteNames = (profile.employment.siteIds ?? []).map((id) => siteNames.get(id) ?? id).filter(Boolean).join("、") || "未设置";
  const pending = isPersonnelProfilePending(request);
  const profileLocked = pending || submitting;
  const formBusy = submitting || Boolean(uploadingField);
  const currentErrors = useMemo(() => ({ ...errors, ...uploadErrors }), [errors, uploadErrors]);
  const profileValidation = useMemo(() => validatePersonnelSelfProfile(profile), [profile]);
  const reviewErrors = useMemo(() => {
    const next = { ...profileValidation };
    for (const [field, message] of Object.entries(uploadErrors) as Array<[PersonnelProfileField, string | undefined]>) {
      if (message && !profile[field]) next[field] = message;
    }
    return next;
  }, [profile, profileValidation, uploadErrors]);
  const missingCount = Object.keys(profileValidation).length;
  const sectionStatuses = useMemo<Record<ProfileSectionId, SectionStatus>>(() => {
    const statusForFields = (fields: PersonnelProfileField[]): SectionStatus => {
      const issueCount = fields.filter((field) => Boolean(reviewErrors[field])).length;
      return issueCount > 0
        ? { label: `待完善 ${issueCount} 项`, kind: "attention", complete: false }
        : { label: "已完成", kind: "complete", complete: true };
    };
    const employmentRequirements = [
      profile.personnelNo || profile.employment.personnelNo,
      profile.employment.department,
      profile.employment.role,
      profile.employment.hireDate,
      Boolean(profile.employment.siteIds?.length),
      profile.account.username || state.user?.username,
      profile.account.accountEnabled !== false,
    ];
    const employmentMissing = employmentRequirements.filter((value) => !value).length;
    const employmentStatus: SectionStatus = employmentMissing > 0
      ? { label: `管理员后续补充 ${employmentMissing} 项`, kind: "neutral", complete: false }
      : { label: "已登记", kind: "complete", complete: true };
    const accountAvailable = Boolean(profile.account.username || state.user?.username) && profile.account.accountEnabled !== false;
    return {
      basic: statusForFields(EDITABLE_SECTION_FIELDS.basic),
      documents: statusForFields(EDITABLE_SECTION_FIELDS.documents),
      contact: statusForFields(EDITABLE_SECTION_FIELDS.contact),
      bank: statusForFields(EDITABLE_SECTION_FIELDS.bank),
      employment: employmentStatus,
      security: accountAvailable
        ? { label: "可独立维护", kind: "neutral", complete: true }
        : { label: "需联系管理员", kind: "attention", complete: false },
      review: pending
        ? { label: "审批中", kind: "pending", complete: false }
        : Object.keys(reviewErrors).length > 0
          ? { label: `待检查 ${Object.keys(reviewErrors).length} 项`, kind: "attention", complete: false }
          : { label: "可以提交", kind: "complete", complete: true },
    };
  }, [pending, profile, reviewErrors, state.user?.username]);
  const completedEditableSectionCount = (["basic", "documents", "contact", "bank"] as const)
    .filter((section) => sectionStatuses[section].complete).length;

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/personnel/self-profile", { headers: authHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        throw new Error(response.status === 401 ? "登录已过期，请重新登录" : result.error || "本人资料加载失败");
      }
      const normalized = normalizePersonnelSelfProfileResult(result);
      if (!normalized.profile.profileRevision) throw new Error("档案版本缺失，请刷新后重试");
      setProfile(normalized.profile);
      setRequest(normalized.request);
      setErrors({});
      setUploadErrors({});
      setSubmitError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "本人资料加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const focusProfileElement = useCallback((field: PersonnelProfileField) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const target = document.getElementById(`profile-${field}`) as HTMLElement | null;
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
        target?.focus({ preventScroll: true });
      });
    });
  }, []);

  useEffect(() => { void loadProfile(); }, [loadProfile]);
  useEffect(() => () => {
    previewSequence.current += 1;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);
  useEffect(() => {
    const field = requestedFieldFocus.current;
    if (!field || PROFILE_FIELD_SECTION[field] !== activeSection) return;
    requestedFieldFocus.current = null;
    focusProfileElement(field);
  }, [activeSection, focusProfileElement]);

  const updateProfileField = <K extends keyof PersonnelSelfProfileForm,>(field: K, value: PersonnelSelfProfileForm[K]) => {
    setProfile((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setUploadErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSubmitError("");
  };

  const focusProfileField = (field: PersonnelProfileField) => {
    const section = PROFILE_FIELD_SECTION[field];
    setErrors(profileValidation);
    requestedFieldFocus.current = field;
    if (activeSection === section) {
      requestedFieldFocus.current = null;
      focusProfileElement(field);
      return;
    }
    setActiveSection(section);
  };

  const uploadAttachment = async (
    field: "idCardFrontAttachment" | "idCardBackAttachment" | "educationProofAttachment",
    file: File
  ) => {
    if (profileLocked || uploadingField) return;
    const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
    if (!allowedMimeTypes.has(file.type.toLowerCase())) {
      setUploadErrors((current) => ({ ...current, [field]: "仅支持 JPG、PNG、WebP、HEIC 或 HEIF 图片" }));
      return;
    }
    const kind = PROFILE_ATTACHMENT_KINDS[field];
    setUploadingField(field);
    setUploadErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    try {
      const response = await fetch(`/api/personnel/self-profile/attachment?kind=${encodeURIComponent(kind)}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        throw new Error(response.status === 401 ? "登录已过期，请重新登录" : result.error || "附件上传失败");
      }
      const attachment = normalizePersonnelProfileAttachment(result.attachment, kind);
      if (!attachment) throw new Error("附件上传响应不完整，请重试");
      updateProfileField(field, { ...attachment, originalName: attachment.originalName || file.name });
      toast.success(`${PERSONNEL_PROFILE_FIELD_LABELS[field]}已上传`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "附件上传失败";
      setUploadErrors((current) => ({ ...current, [field]: message }));
      toast.error(message);
    } finally {
      setUploadingField(null);
    }
  };

  const closePreview = () => {
    previewSequence.current += 1;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = "";
    setPreviewUrl("");
    setPreviewMime("");
    setPreviewError("");
    setPreviewLoading(false);
    setPreviewAttachment(null);
  };

  const previewProfileAttachment = async (attachment: PersonnelProfileAttachment) => {
    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = "";
    setPreviewAttachment(attachment);
    setPreviewUrl("");
    setPreviewMime("");
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const response = await fetch(`/api/personnel/attachments/${encodeURIComponent(attachment.id)}`, { headers: authHeaders() });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(response.status === 401 ? "登录已过期，请重新登录" : result.error || "附件预览加载失败");
      }
      const blob = await response.blob();
      if (previewSequence.current !== sequence) return;
      const objectUrl = URL.createObjectURL(blob);
      previewUrlRef.current = objectUrl;
      setPreviewUrl(objectUrl);
      setPreviewMime(blob.type || attachment.mime || "application/octet-stream");
    } catch (error) {
      if (previewSequence.current !== sequence) return;
      setPreviewError(error instanceof Error ? error.message : "附件预览加载失败");
    } finally {
      if (previewSequence.current === sequence) setPreviewLoading(false);
    }
  };

  const submitProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || formBusy) return;
    if (activeSection !== "review") {
      setActiveSection("review");
      return;
    }
    const nextErrors = validatePersonnelSelfProfile(profile);
    setErrors(nextErrors);
    setSubmitError("");
    if (Object.keys(nextErrors).length > 0) {
      window.requestAnimationFrame(() => errorSummaryRef.current?.focus());
      return;
    }
    if (!profile.profileRevision) {
      setSubmitError("档案版本缺失，请刷新页面后重试");
      return;
    }
    if (!confirmWrite(request?.status === "rejected" ? "重新提交" : "提交", "提交后将由管理员审核，审批期间资料不可修改。")) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/personnel/self-profile/submit", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(personnelSelfProfileSubmission(profile)),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        throw new Error(response.status === 401 ? "登录已过期，请重新登录" : result.error || "资料提交失败");
      }
      const nextRequest = normalizePersonnelSelfProfileResult({ profile, request: result.request }).request;
      if (!nextRequest || nextRequest.status !== "pending") throw new Error("审批申请响应不完整，请刷新后核对提交状态");
      setRequest(nextRequest);
      setErrors({});
      setUploadErrors({});
      toast.success("个人资料已提交审批");
    } catch (error) {
      const message = error instanceof Error ? error.message : "资料提交失败";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const changeOwnPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (changingPassword) return;
    const nextErrors: Record<string, string> = {};
    if (!oldPassword) nextErrors.oldPassword = "请输入原密码";
    if (!newPassword) nextErrors.newPassword = "请输入新密码";
    else if (newPassword.length < 6) nextErrors.newPassword = "新密码至少 6 位";
    if (!confirmPassword) nextErrors.confirmPassword = "请再次输入新密码";
    else if (newPassword !== confirmPassword) nextErrors.confirmPassword = "两次输入的新密码不一致";
    setPasswordErrors(nextErrors);
    setPasswordError("");
    if (Object.keys(nextErrors).length > 0) return;
    if (!confirmWrite("修改", "将修改当前登录账号的密码。")) return;
    setChangingPassword(true);
    const ok = await changePersonnelPassword({ oldPassword, newPassword });
    setChangingPassword(false);
    if (!ok) {
      setPasswordError("密码修改失败，请核对原密码后重试");
      return;
    }
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordErrors({});
    toast.success("密码已修改");
  };

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[45vh] w-full max-w-5xl items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />正在安全加载本人资料
      </div>
    );
  }

  if (loadError) {
    return (
      <Card className="mx-auto w-full max-w-2xl items-center p-6 text-center" role="alert">
        <AlertTriangle className="size-8 text-red-600" aria-hidden="true" />
        <div><h2 className="font-semibold">本人资料暂时无法加载</h2><p className="mt-1 text-sm text-muted-foreground">{loadError}</p></div>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void loadProfile()}><RefreshCw className="size-4" />重新加载</Button>
      </Card>
    );
  }

  const statusTone = pending
    ? "border-amber-200 bg-amber-50 text-amber-900"
    : request?.status === "rejected"
      ? "border-red-200 bg-red-50 text-red-900"
      : request?.status === "approved"
        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
        : missingCount === 0
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-sky-200 bg-sky-50 text-sky-900";
  const statusIcon = pending
    ? <Clock3 className="size-5" aria-hidden="true" />
    : request?.status === "rejected"
      ? <XCircle className="size-5" aria-hidden="true" />
      : request?.status === "approved"
        ? <CheckCircle2 className="size-5" aria-hidden="true" />
        : missingCount === 0
          ? <CheckCircle2 className="size-5" aria-hidden="true" />
          : <AlertTriangle className="size-5" aria-hidden="true" />;
  const activeSectionDefinition = PROFILE_SECTIONS.find((section) => section.id === activeSection) ?? PROFILE_SECTIONS[0];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 pb-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2>个人中心</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">按分区维护本人档案，检查完成后统一提交管理员审批</p>
        </div>
        <Badge variant="outline" className="w-fit">工号 {profile.personnelNo || profile.employment.personnelNo || "未设置"}</Badge>
      </header>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        <aside className="hidden lg:block">
          <Card className="sticky top-4 gap-2 p-2">
            <div className="border-b px-2 pb-3 pt-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">本人资料进度</span>
                <span className="text-muted-foreground">{completedEditableSectionCount}/4 区</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="本人资料分区完成进度" aria-valuemin={0} aria-valuemax={4} aria-valuenow={completedEditableSectionCount}>
                <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${completedEditableSectionCount * 25}%` }} />
              </div>
            </div>
            <nav aria-label="个人档案分区" className="grid gap-1">
              {PROFILE_SECTIONS.map((section) => {
                const Icon = section.icon;
                const status = sectionStatuses[section.id];
                const selected = activeSection === section.id;
                return (
                  <button
                    key={section.id}
                    id={`profile-section-tab-${section.id}`}
                    type="button"
                    aria-current={selected ? "step" : undefined}
                    aria-controls={section.elementId}
                    className={`flex min-h-16 w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary/30 bg-primary/5 shadow-sm" : "border-transparent hover:bg-muted/60"}`}
                    onClick={() => setActiveSection(section.id)}
                  >
                    <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${section.iconClassName}`}><Icon className="size-4" aria-hidden="true" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{section.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{status.label}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </Card>
        </aside>

        <section className="grid min-w-0 gap-3" aria-label="个人档案当前分区">
          <div className="grid gap-2 lg:hidden">
            <Label htmlFor="profile-section-selector">资料分区</Label>
            <Select value={activeSection} onValueChange={(value) => setActiveSection(value as ProfileSectionId)}>
              <SelectTrigger id="profile-section-selector" className="h-12 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PROFILE_SECTIONS.map((section) => <SelectItem key={section.id} value={section.id}>{section.title} · {sectionStatuses[section.id].label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className={`flex items-start gap-3 rounded-xl border p-4 ${statusTone}`} aria-live="polite">
            <div className="mt-0.5 shrink-0">{statusIcon}</div>
            <div className="min-w-0">
              <div className="font-semibold">
                {pending ? "资料正在审批" : request?.status === "rejected" ? "资料审核未通过" : request?.status === "approved" ? "资料已通过审核" : missingCount > 0 ? `还有 ${missingCount} 项待完善` : "本人资料已填写完整"}
              </div>
              <p className="mt-1 text-sm leading-6">
                {pending
                  ? `提交时间：${formatDateTime(request?.createdAt) || "已提交"}。审批期间资料不可编辑，但仍可独立修改密码。`
                  : request?.status === "rejected"
                    ? `驳回说明：${request.resolutionNote || "管理员未填写说明"}。请修改后重新提交。`
                    : request?.status === "approved"
                      ? `通过时间：${formatDateTime(request.resolvedAt) || "已通过"}。再次修改会生成新的审批申请。`
                      : "带星号项目均为必填；证件材料通过受保护接口单独保存。"}
              </p>
            </div>
          </div>

          {activeSection === "security" ? (
            <Card id="profile-password-section" role="region" aria-labelledby="profile-section-title-security" className="gap-5 p-4 sm:p-5">
              <SectionHeader
                titleId="profile-section-title-security"
                title="账户安全"
                description="密码修改独立生效，不进入个人资料审批；资料待审期间也可以修改密码。"
                icon={<KeyRound className="size-5" aria-hidden="true" />}
                iconClassName="bg-orange-100 text-orange-700"
                status={sectionStatuses.security}
                label="独立生效"
              />
              <form onSubmit={changeOwnPassword} className="grid gap-4 sm:grid-cols-3" aria-busy={changingPassword}>
                <div className="grid gap-2">
                  <Label htmlFor="profile-old-password">原密码<RequiredMark /></Label>
                  <MaskedInput id="profile-old-password" value={oldPassword} visible={showOldPassword} disabled={changingPassword} autoComplete="current-password" onToggle={() => setShowOldPassword((current) => !current)} toggleLabel={showOldPassword ? "隐藏原密码" : "显示原密码"} invalid={Boolean(passwordErrors.oldPassword)} describedBy={passwordErrors.oldPassword ? "profile-old-password-error" : undefined} onChange={(value) => { setOldPassword(value); setPasswordErrors((current) => ({ ...current, oldPassword: "" })); }} />
                  {passwordErrors.oldPassword && <p id="profile-old-password-error" className="text-sm text-destructive" role="alert">{passwordErrors.oldPassword}</p>}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-new-password">新密码<RequiredMark /></Label>
                  <MaskedInput id="profile-new-password" value={newPassword} visible={showNewPassword} disabled={changingPassword} autoComplete="new-password" onToggle={() => setShowNewPassword((current) => !current)} toggleLabel={showNewPassword ? "隐藏新密码" : "显示新密码"} invalid={Boolean(passwordErrors.newPassword)} describedBy={passwordErrors.newPassword ? "profile-new-password-error" : undefined} onChange={(value) => { setNewPassword(value); setPasswordErrors((current) => ({ ...current, newPassword: "" })); }} />
                  {passwordErrors.newPassword && <p id="profile-new-password-error" className="text-sm text-destructive" role="alert">{passwordErrors.newPassword}</p>}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-confirm-password">确认新密码<RequiredMark /></Label>
                  <MaskedInput id="profile-confirm-password" value={confirmPassword} visible={showConfirmPassword} disabled={changingPassword} autoComplete="new-password" onToggle={() => setShowConfirmPassword((current) => !current)} toggleLabel={showConfirmPassword ? "隐藏确认密码" : "显示确认密码"} invalid={Boolean(passwordErrors.confirmPassword)} describedBy={passwordErrors.confirmPassword ? "profile-confirm-password-error" : undefined} onChange={(value) => { setConfirmPassword(value); setPasswordErrors((current) => ({ ...current, confirmPassword: "" })); }} />
                  {passwordErrors.confirmPassword && <p id="profile-confirm-password-error" className="text-sm text-destructive" role="alert">{passwordErrors.confirmPassword}</p>}
                </div>
                <div className="sm:col-span-3">
                  {passwordError && <p className="mb-2 text-sm text-destructive" role="alert">{passwordError}</p>}
                  <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={changingPassword}>
                    {changingPassword ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                    {changingPassword ? "保存中" : "修改我的密码"}
                  </Button>
                </div>
              </form>
            </Card>
          ) : (
            <form noValidate onSubmit={submitProfile} aria-busy={formBusy}>
              {activeSection === "basic" && (
                <Card id="profile-basic-section" role="region" aria-labelledby="profile-section-title-basic" className="gap-5 p-4 sm:p-5">
                  <SectionHeader titleId="profile-section-title-basic" title="基本资料" description="用于身份核验。修改内容会与其他本人资料一起提交管理员审核。" icon={<UserRound className="size-5" aria-hidden="true" />} iconClassName="bg-sky-100 text-sky-700" status={sectionStatuses.basic} />
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="grid gap-2">
                      <Label htmlFor="profile-name">姓名<RequiredMark /></Label>
                      <Input id="profile-name" value={profile.name} disabled={profileLocked} maxLength={80} autoComplete="name" className="h-11" aria-required="true" aria-invalid={Boolean(currentErrors.name) || undefined} aria-describedby={currentErrors.name ? "profile-name-error" : undefined} onChange={(event) => updateProfileField("name", event.target.value)} />
                      <FieldError field="name" error={currentErrors.name} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="profile-gender">性别<RequiredMark /></Label>
                      <Select value={profile.gender || undefined} disabled={profileLocked} onValueChange={(value) => updateProfileField("gender", value as PersonnelSelfProfile["gender"])}>
                        <SelectTrigger id="profile-gender" className="h-11" aria-required="true" aria-invalid={Boolean(currentErrors.gender) || undefined} aria-describedby={currentErrors.gender ? "profile-gender-error" : undefined}><SelectValue placeholder="请选择" /></SelectTrigger>
                        <SelectContent><SelectItem value="male">男</SelectItem><SelectItem value="female">女</SelectItem><SelectItem value="other">其他</SelectItem></SelectContent>
                      </Select>
                      <FieldError field="gender" error={currentErrors.gender} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="profile-nativePlace">籍贯<RequiredMark /></Label>
                      <Input id="profile-nativePlace" value={profile.nativePlace} disabled={profileLocked} maxLength={120} className="h-11" aria-required="true" aria-invalid={Boolean(currentErrors.nativePlace) || undefined} aria-describedby={currentErrors.nativePlace ? "profile-nativePlace-error" : undefined} onChange={(event) => updateProfileField("nativePlace", event.target.value)} />
                      <FieldError field="nativePlace" error={currentErrors.nativePlace} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="profile-birthMonth">出生年月<RequiredMark /></Label>
                      <Input id="profile-birthMonth" type="month" value={profile.birthMonth} disabled={profileLocked} min="1900-01" max={new Date().toISOString().slice(0, 7)} className="h-11" aria-required="true" aria-invalid={Boolean(currentErrors.birthMonth) || undefined} aria-describedby={currentErrors.birthMonth ? "profile-birthMonth-error" : undefined} onChange={(event) => updateProfileField("birthMonth", event.target.value)} />
                      <FieldError field="birthMonth" error={currentErrors.birthMonth} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="profile-educationLevel">最高学历<RequiredMark /></Label>
                      <Select value={profile.educationLevel || undefined} disabled={profileLocked} onValueChange={(value) => updateProfileField("educationLevel", value as PersonnelSelfProfile["educationLevel"])}>
                        <SelectTrigger id="profile-educationLevel" className="h-11" aria-required="true" aria-invalid={Boolean(currentErrors.educationLevel) || undefined} aria-describedby={currentErrors.educationLevel ? "profile-educationLevel-error" : undefined}><SelectValue placeholder="请选择" /></SelectTrigger>
                        <SelectContent>{EDUCATION_LEVELS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                      </Select>
                      <FieldError field="educationLevel" error={currentErrors.educationLevel} />
                    </div>
                  </div>
                </Card>
              )}

              {activeSection === "documents" && (
                <Card id="profile-documents-section" role="region" aria-labelledby="profile-section-title-documents" className="gap-5 p-4 sm:p-5">
                  <SectionHeader titleId="profile-section-title-documents" title="证件材料" description="敏感字段默认遮蔽；附件仅支持安全图片，通过受保护接口读取。" icon={<FileCheck2 className="size-5" aria-hidden="true" />} iconClassName="bg-indigo-100 text-indigo-700" status={sectionStatuses.documents} />
                  <div className="grid max-w-xl gap-2">
                    <Label htmlFor="profile-idCardNo">身份证件号码<RequiredMark /></Label>
                    <MaskedInput id="profile-idCardNo" value={profile.idCardNo} disabled={profileLocked} visible={showIdCard} onToggle={() => setShowIdCard((current) => !current)} toggleLabel={showIdCard ? "隐藏身份证件号码" : "显示身份证件号码"} invalid={Boolean(currentErrors.idCardNo)} describedBy={currentErrors.idCardNo ? "profile-idCardNo-error" : undefined} onChange={(value) => updateProfileField("idCardNo", value)} />
                    <FieldError field="idCardNo" error={currentErrors.idCardNo} />
                  </div>
                  <div className="grid gap-3 xl:grid-cols-3">
                    <AttachmentField field="idCardFrontAttachment" title="身份证件正面" description="上传清晰完整的证件正面照片" attachment={profile.idCardFrontAttachment} uploading={uploadingField === "idCardFrontAttachment"} disabled={profileLocked || formBusy} error={currentErrors.idCardFrontAttachment} onChoose={(file) => void uploadAttachment("idCardFrontAttachment", file)} onPreview={(attachment) => void previewProfileAttachment(attachment)} />
                    <AttachmentField field="idCardBackAttachment" title="身份证件反面" description="上传清晰完整的证件反面照片" attachment={profile.idCardBackAttachment} uploading={uploadingField === "idCardBackAttachment"} disabled={profileLocked || formBusy} error={currentErrors.idCardBackAttachment} onChoose={(file) => void uploadAttachment("idCardBackAttachment", file)} onPreview={(attachment) => void previewProfileAttachment(attachment)} />
                    <AttachmentField field="educationProofAttachment" title="学历证明" description="上传学历证明照片或学信网截图" attachment={profile.educationProofAttachment} uploading={uploadingField === "educationProofAttachment"} disabled={profileLocked || formBusy} error={currentErrors.educationProofAttachment} onChoose={(file) => void uploadAttachment("educationProofAttachment", file)} onPreview={(attachment) => void previewProfileAttachment(attachment)} />
                  </div>
                </Card>
              )}

              {activeSection === "contact" && (
                <Card id="profile-contact-section" role="region" aria-labelledby="profile-section-title-contact" className="gap-5 p-4 sm:p-5">
                  <SectionHeader titleId="profile-section-title-contact" title="联系信息" description="用于日常工作联络和档案联系，请填写本人可用的联系方式。" icon={<ContactRound className="size-5" aria-hidden="true" />} iconClassName="bg-violet-100 text-violet-700" status={sectionStatuses.contact} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    {([
                      ["phone", "联系电话", "tel", "tel", "tel"],
                      ["email", "邮箱", "email", "email", "email"],
                      ["wechat", "微信号", "text", "text", "off"],
                    ] as const).map(([field, label, type, inputMode, autoComplete]) => (
                      <div key={field} className="grid gap-2">
                        <Label htmlFor={`profile-${field}`}>{label}<RequiredMark /></Label>
                        <Input id={`profile-${field}`} type={type} inputMode={inputMode} autoComplete={autoComplete} value={profile[field]} disabled={profileLocked} maxLength={field === "email" ? 120 : 80} className="h-11" aria-required="true" aria-invalid={Boolean(currentErrors[field]) || undefined} aria-describedby={currentErrors[field] ? `profile-${field}-error` : undefined} onChange={(event) => updateProfileField(field, event.target.value)} />
                        <FieldError field={field} error={currentErrors[field]} />
                      </div>
                    ))}
                    <div className="grid gap-2 sm:col-span-2">
                      <Label htmlFor="profile-address">联系地址<RequiredMark /></Label>
                      <Textarea id="profile-address" rows={4} value={profile.address} disabled={profileLocked} maxLength={240} aria-required="true" aria-invalid={Boolean(currentErrors.address) || undefined} aria-describedby={currentErrors.address ? "profile-address-error" : undefined} onChange={(event) => updateProfileField("address", event.target.value)} />
                      <FieldError field="address" error={currentErrors.address} />
                    </div>
                  </div>
                </Card>
              )}

              {activeSection === "bank" && (
                <Card id="profile-bank-section" role="region" aria-labelledby="profile-section-title-bank" className="gap-5 p-4 sm:p-5">
                  <SectionHeader titleId="profile-section-title-bank" title="工资账户" description="银行卡号默认遮蔽，仅本人和有权限的管理员可查看。" icon={<Landmark className="size-5" aria-hidden="true" />} iconClassName="bg-emerald-100 text-emerald-700" status={sectionStatuses.bank} />
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="grid gap-2">
                      <Label htmlFor="profile-bankAccountName">开户名<RequiredMark /></Label>
                      <Input id="profile-bankAccountName" value={profile.bankAccountName} disabled={profileLocked} maxLength={80} className="h-11" autoComplete="off" aria-required="true" aria-invalid={Boolean(currentErrors.bankAccountName) || undefined} aria-describedby={currentErrors.bankAccountName ? "profile-bankAccountName-error" : undefined} onChange={(event) => updateProfileField("bankAccountName", event.target.value)} />
                      <FieldError field="bankAccountName" error={currentErrors.bankAccountName} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="profile-bankAccountNo">银行卡号<RequiredMark /></Label>
                      <MaskedInput id="profile-bankAccountNo" value={profile.bankAccountNo} disabled={profileLocked} visible={showBankAccount} onToggle={() => setShowBankAccount((current) => !current)} toggleLabel={showBankAccount ? "隐藏工资银行卡号" : "显示工资银行卡号"} invalid={Boolean(currentErrors.bankAccountNo)} describedBy={currentErrors.bankAccountNo ? "profile-bankAccountNo-error" : undefined} onChange={(value) => updateProfileField("bankAccountNo", value.replace(/\s+/g, ""))} />
                      <FieldError field="bankAccountNo" error={currentErrors.bankAccountNo} />
                    </div>
                    <div className="grid gap-2 sm:col-span-2 lg:col-span-1">
                      <Label htmlFor="profile-bankName">开户行<RequiredMark /></Label>
                      <Input id="profile-bankName" value={profile.bankName} disabled={profileLocked} maxLength={120} className="h-11" autoComplete="off" placeholder="如：中国工商银行南京某支行" aria-required="true" aria-invalid={Boolean(currentErrors.bankName) || undefined} aria-describedby={currentErrors.bankName ? "profile-bankName-error" : undefined} onChange={(event) => updateProfileField("bankName", event.target.value)} />
                      <FieldError field="bankName" error={currentErrors.bankName} />
                    </div>
                  </div>
                </Card>
              )}

              {activeSection === "employment" && (
                <Card id="profile-employment-section" role="region" aria-labelledby="profile-section-title-employment" className="gap-5 p-4 sm:p-5">
                  <SectionHeader titleId="profile-section-title-employment" title="任职与账号" description="以下内容由管理员维护，可在本人资料审批后继续补充；发现信息有误时，请联系管理员处理。" icon={<BriefcaseBusiness className="size-5" aria-hidden="true" />} iconClassName="bg-slate-100 text-slate-700" status={sectionStatuses.employment} label="只读" />
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <ReadonlyItem label="人员工号">{profile.personnelNo || profile.employment.personnelNo}</ReadonlyItem>
                    <ReadonlyItem label="任职状态">{profile.employment.employmentStatus === "resigned" ? "已离职" : "在职"}</ReadonlyItem>
                    <ReadonlyItem label="所属部门 / 班组">{profile.employment.department}</ReadonlyItem>
                    <ReadonlyItem label="岗位">{profile.employment.role}</ReadonlyItem>
                    <ReadonlyItem label="入职日期">{profile.employment.hireDate}</ReadonlyItem>
                    <ReadonlyItem label="所属工作区域">{workSiteNames}</ReadonlyItem>
                    <ReadonlyItem label="登录账号">{profile.account.username || state.user?.username}</ReadonlyItem>
                    <ReadonlyItem label="账号角色">{profile.account.accessRole === "admin" ? "管理员" : "普通账号"}</ReadonlyItem>
                    <ReadonlyItem label="账号状态">{profile.account.accountEnabled === false ? "已停用" : "已启用"}</ReadonlyItem>
                  </div>
                </Card>
              )}

              {activeSection === "review" && (
                <Card id="profile-review-section" role="region" aria-labelledby="profile-section-title-review" className="gap-5 p-4 sm:p-5">
                  <SectionHeader titleId="profile-section-title-review" title="检查并提交" description="检查四个本人资料分区。提交后生成站内审批申请，管理员通过后正式生效。" icon={<ShieldCheck className="size-5" aria-hidden="true" />} iconClassName="bg-teal-100 text-teal-700" status={sectionStatuses.review} />

                  <div className="grid gap-3 sm:grid-cols-2">
                    {PROFILE_SECTIONS.slice(0, 4).map((section) => {
                      const Icon = section.icon;
                      const status = sectionStatuses[section.id];
                      return (
                        <button key={section.id} type="button" className="flex min-h-20 items-center gap-3 rounded-xl border bg-background p-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setActiveSection(section.id)}>
                          <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${section.iconClassName}`}><Icon className="size-5" aria-hidden="true" /></span>
                          <span className="min-w-0 flex-1"><span className="block font-medium">{section.title}</span><span className="mt-1 block text-xs text-muted-foreground">{status.complete ? "资料已就绪" : "点击进入并完善"}</span></span>
                          <SectionStatusBadge status={status} />
                        </button>
                      );
                    })}
                  </div>

                  {!pending && Object.keys(reviewErrors).length > 0 && (
                    <div ref={errorSummaryRef} tabIndex={-1} role="alert" aria-labelledby="profile-error-summary-title" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900 outline-none focus-visible:ring-2 focus-visible:ring-red-500">
                      <h3 id="profile-error-summary-title" className="font-semibold">提交前还需处理 {Object.keys(reviewErrors).length} 项</h3>
                      <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                        {(Object.entries(reviewErrors).filter((entry): entry is [PersonnelProfileField, string] => Boolean(entry[1]))).map(([field, message]) => (
                          <li key={field}>
                            <button type="button" className="min-h-9 rounded px-1 text-left underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-red-500" onClick={() => focusProfileField(field)}>{PERSONNEL_PROFILE_FIELD_LABELS[field]}：{message}</button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {!pending && Object.keys(reviewErrors).length === 0 && (
                    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900" role="status">
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                      <div><div className="font-semibold">本人资料已检查完整</div><p className="mt-1 text-sm leading-6">确认内容无误后即可提交；任职与账号、密码不包含在本次审批中，管理员字段为空也不影响提交和批准。</p></div>
                    </div>
                  )}

                  {pending && (
                    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
                      <Clock3 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                      <div><div className="font-semibold">本次资料已提交，正在等待审批</div><p className="mt-1 text-sm leading-6">审批结果会通过站内信通知。需要修改密码时，可前往“账户安全”。</p></div>
                    </div>
                  )}

                  <div className="border-t pt-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 text-sm text-muted-foreground">
                        {pending ? "资料审批中；需要修改时请等待管理员处理。" : uploadingField ? "附件上传完成后才能提交。" : "提交前会再次检查全部必填项。"}
                        {submitError && <p className="mt-1 text-sm text-destructive" role="alert">{submitError}</p>}
                      </div>
                      <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={pending || formBusy}>
                        {submitting ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                        {submitting ? "提交中" : pending ? "审批中，暂不可提交" : request?.status === "rejected" ? "重新提交审批" : "提交资料审批"}
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </form>
          )}

          <p className="px-1 text-xs text-muted-foreground lg:hidden" aria-live="polite">当前分区：{activeSectionDefinition.title} · {sectionStatuses[activeSection].label}</p>
        </section>
      </div>

      <Dialog open={Boolean(previewAttachment)} onOpenChange={(open) => !open && closePreview()}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{previewAttachment ? attachmentDisplayName(previewAttachment) : "附件预览"}</DialogTitle>
            <DialogDescription>附件通过受保护接口按需读取，关闭后会立即释放本地预览。</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-lg border bg-muted/20">
            {previewLoading ? (
              <div className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />正在加载附件</div>
            ) : previewError ? (
              <div className="p-6 text-center text-sm text-destructive" role="alert">{previewError}</div>
            ) : previewUrl && previewMime.startsWith("image/") ? (
              <img src={previewUrl} alt={previewAttachment ? attachmentDisplayName(previewAttachment) : "本人资料附件"} className="max-h-[68dvh] max-w-full object-contain" />
            ) : previewUrl ? (
              <div className="p-6 text-center text-sm text-muted-foreground"><FileText className="mx-auto mb-2 size-8" />此图片格式无法在当前浏览器内预览</div>
            ) : null}
          </div>
          <DialogFooter><Button type="button" variant="outline" className="min-h-11" onClick={closePreview}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
