import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, Loader2, MessageCircle, Send, Sparkles, TriangleAlert } from "lucide-react";
import { useStore } from "../store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { Textarea } from "./ui/textarea";
import { authJsonHeaders } from "../utils/authSession";

const API = "/api";
const quickPrompts = [
  "今天库存有什么风险？",
  "列出需要优先处理的订单和发货。",
  "最近损耗情况怎么样？",
  "哪些缸位需要重点养护？",
];

type AssistantConfig = {
  aiConfigured: boolean;
  aiModel: string | null;
  feishuWebhookConfigured: boolean;
  feishuAppConfigured: boolean;
};

type AssistantMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  meta?: string;
};

function messageId() {
  return `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function statusBadge(config: AssistantConfig | null) {
  if (!config) return { label: "连接中", tone: "secondary" as const };
  if (config.aiConfigured) return { label: config.aiModel ?? "AI 已配置", tone: "secondary" as const };
  return { label: "AI 未配置", tone: "secondary" as const };
}

export function AIAssistantPanel() {
  const { state, activeSiteId } = useStore();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "可以问我库存、订单、发货、损耗和养护情况。我会基于当前系统数据回答。",
    },
  ]);
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [notifyFeishu, setNotifyFeishu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const badge = useMemo(() => statusBadge(config), [config]);
  const feishuLabel = config?.feishuAppConfigured
    ? "飞书问答已接入"
    : config?.feishuWebhookConfigured
      ? "飞书通知已接入"
      : "飞书未配置";
  const canNotifyFeishu = Boolean(config?.feishuWebhookConfigured);

  useEffect(() => {
    if (!open || config) return;
    fetch(`${API}/assistant/config`, { headers: authJsonHeaders() })
      .then((response) => response.json())
      .then((nextConfig) => setConfig(nextConfig))
      .catch(() => setConfig({
        aiConfigured: false,
        aiModel: null,
        feishuWebhookConfigured: false,
        feishuAppConfigured: false,
      }));
  }, [open, config]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    if (!canNotifyFeishu && notifyFeishu) setNotifyFeishu(false);
  }, [canNotifyFeishu, notifyFeishu]);

  const sendMessage = async (text: string) => {
    const message = text.trim();
    if (!message || loading) return;

    setInput("");
    setError("");
    setLoading(true);
    setMessages((current) => [
      ...current,
      { id: messageId(), role: "user", content: message },
    ]);

    try {
      const response = await fetch(`${API}/assistant/chat`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          message,
          siteId: activeSiteId,
          operator: state.user?.username ?? "system",
          notifyFeishu: notifyFeishu && canNotifyFeishu,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      setMessages((current) => [
        ...current,
        {
          id: messageId(),
          role: "assistant",
          content: String(result.answer ?? ""),
          meta: result.feishuNotified ? "已同步到飞书" : undefined,
        },
      ]);
      if (result.feishuError) setError(String(result.feishuError));
    } catch (nextError) {
      const messageText = nextError instanceof Error ? nextError.message : "AI 助手请求失败";
      setError(messageText);
      setMessages((current) => [
        ...current,
        { id: messageId(), role: "assistant", content: `请求失败：${messageText}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="icon"
        className="fixed bottom-4 right-4 z-40 size-12 rounded-full bg-sky-600 shadow-lg hover:bg-sky-700"
        onClick={() => setOpen(true)}
        title="AI 助手"
      >
        <Bot className="size-5" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-[92vw] max-w-[440px] gap-0 p-0">
          <SheetHeader className="border-b pr-12">
            <div className="flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-md bg-sky-100 text-sky-700">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0">
                <SheetTitle>AI 助手</SheetTitle>
                <SheetDescription className="truncate">
                  当前场地数据问答
                </SheetDescription>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Badge variant={badge.tone}>{badge.label}</Badge>
              <Badge variant="secondary" className="gap-1">
                {config?.feishuAppConfigured || config?.feishuWebhookConfigured ? (
                  <CheckCircle2 className="size-3" />
                ) : (
                  <TriangleAlert className="size-3" />
                )}
                {feishuLabel}
              </Badge>
            </div>
          </SheetHeader>

          <div ref={listRef} className="flex-1 overflow-y-auto bg-slate-50 p-4">
            <div className="flex flex-col gap-3">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={[
                    "max-w-[88%] rounded-md px-3 py-2 text-sm leading-6 shadow-sm",
                    message.role === "user"
                      ? "ml-auto bg-sky-600 text-white"
                      : "mr-auto border bg-white text-foreground",
                  ].join(" ")}
                >
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                  {message.meta && (
                    <div className={message.role === "user" ? "mt-1 text-xs text-sky-100" : "mt-1 text-xs text-muted-foreground"}>
                      {message.meta}
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="mr-auto flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm text-muted-foreground shadow-sm">
                  <Loader2 className="size-4 animate-spin" />
                  正在分析数据…
                </div>
              )}
            </div>
          </div>

          <div className="border-t bg-white p-3">
            <div className="mb-3 grid grid-cols-2 gap-2">
              {quickPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto justify-start whitespace-normal px-3 py-2 text-left text-xs leading-5"
                  onClick={() => void sendMessage(prompt)}
                  disabled={loading}
                >
                  {prompt}
                </Button>
              ))}
            </div>

            <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入问题，例如：今天哪些订单还没发？"
                className="max-h-32 min-h-20"
                disabled={loading}
              />
              <div className="flex items-center justify-between gap-3">
                <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-sky-600"
                    checked={notifyFeishu && canNotifyFeishu}
                    onChange={(event) => setNotifyFeishu(event.target.checked)}
                    disabled={!canNotifyFeishu || loading}
                  />
                  <span className="truncate">同步到飞书</span>
                </label>
                <Button type="submit" disabled={!input.trim() || loading}>
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  发送
                </Button>
              </div>
              {error && (
                <div className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                  <MessageCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="break-words">{error}</span>
                </div>
              )}
            </form>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
