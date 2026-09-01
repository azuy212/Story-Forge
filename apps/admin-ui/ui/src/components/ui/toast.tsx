import { Toaster as SonnerToaster, toast as sonnerToast } from "sonner";

export const toast = {
  success: (message: string, description?: string) =>
    sonnerToast.success(description ? `${message} — ${description}` : message),
  info: (message: string, description?: string) =>
    sonnerToast.info(description ? `${message} — ${description}` : message),
  warning: (message: string, description?: string) =>
    sonnerToast.warning(description ? `${message} — ${description}` : message),
  error: (message: string, description?: string) =>
    sonnerToast.error(description ? `${message} — ${description}` : message),
  loading: (message: string) => sonnerToast.loading(message),
  promise: <T,>(
    promise: Promise<T>,
    messages: { loading: string; success: string; error: string },
  ) =>
    sonnerToast.promise(promise, {
      loading: messages.loading,
      success: messages.success,
      error: messages.error,
    }) as unknown as Promise<T>,
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      theme="dark"
      richColors={false}
      closeButton
      duration={5000}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
    />
  );
}
