import { useCallback, useRef, useState } from "react";
import { cleanError } from "../constants";
import type { ConfirmOptions, ConfirmResult, DialogTone, MessageOptions, PromptOptions, ToastItem } from "../Dialog";

/// Centralized imperative controllers for top-layer Message, Confirm, Prompt
/// dialogs and floating Toasts. Keeps App.tsx uncluttered.
export function useDialogs() {
  const [messageModal, setMessageModal] = useState<{ options: MessageOptions; resolve: () => void } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ options: ConfirmOptions; resolve: (res: ConfirmResult) => void } | null>(null);
  const [promptModal, setPromptModal] = useState<{ options: PromptOptions; resolve: (values: Record<string, string> | null) => void } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const lastPollError = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const showToast = useCallback((text: string, tone: DialogTone = "success") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, tone, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3400);
  }, []);

  /// Deduplicate repeated background polling errors (at most once per 15s for identical text).
  const showThrottledError = useCallback((err: unknown) => {
    const text = cleanError(err);
    const now = Date.now();
    if (lastPollError.current.text === text && now - lastPollError.current.at < 15000) return;
    lastPollError.current = { text, at: now };
    showToast(text, "error");
  }, [showToast]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showMessage = useCallback((options: MessageOptions): Promise<void> => {
    return new Promise((resolve) => setMessageModal({ options, resolve }));
  }, []);

  const showError = useCallback((err: unknown, title = "操作失败") => {
    void showMessage({ tone: "error", title, message: cleanError(err) });
  }, [showMessage]);

  const showConfirm = useCallback((options: ConfirmOptions): Promise<ConfirmResult> => {
    return new Promise((resolve) => setConfirmModal({ options, resolve }));
  }, []);

  const showPrompt = useCallback((options: PromptOptions): Promise<Record<string, string> | null> => {
    return new Promise((resolve) => setPromptModal({ options, resolve }));
  }, []);

  return {
    messageModal,
    confirmModal,
    promptModal,
    toasts,
    showToast,
    showThrottledError,
    dismissToast,
    showMessage,
    showError,
    showConfirm,
    showPrompt,
    closeMessage: () => {
      if (!messageModal) return;
      const { resolve } = messageModal;
      setMessageModal(null);
      resolve();
    },
    resolveConfirm: (result: ConfirmResult) => {
      if (!confirmModal) return;
      const { resolve } = confirmModal;
      setConfirmModal(null);
      resolve(result);
    },
    resolvePrompt: (values: Record<string, string> | null) => {
      if (!promptModal) return;
      const { resolve } = promptModal;
      setPromptModal(null);
      resolve(values);
    },
  };
}
